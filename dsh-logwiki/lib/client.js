/**
 * dsh-logwiki · Client 半边（零构建，手写 React.createElement）
 *
 * 硬约束（踩过坑的，勿动）：
 *   1. `window.__ModuleLoader__.load({ id })` 的 id 必须**逐字等于** package.json 的 name
 *      （'dsh-logwiki'），否则整页白屏（client-modules: bundle ... loaded without registering "<id>"）。
 *   2. 只允许 require 平台 seed：react / react/jsx-runtime / react-dom / react-dom/client /
 *      @deepseek-ai/cordis / dsh-client-store / dsh-client-ui-slots /
 *      dsh-client-ui-primitives / dsh-client-ui-dockkit。其它服务一律走 inject + ctx.get()。
 *      —— 本文件**只** require('react')，任何 Harness 包都不碰，免得命中
 *      `client-modules: require(...) missed the module table`。
 *   3. 样式手写 CSS 字符串注入一个 <style>（data-plugin-css 去重 + 返回 disposer）；
 *      颜色/圆角/字号只用 --dsw-* token 并给 fallback。唯一写死颜色的地方是 `.lw-root`
 *      里那行插件自有色阶根（绿系，全文件仅出现一次），组件一律消费短别名 `--lw-heat`，
 *      且必须经 color-mix 与 `--lw-empty` 融合，明暗都可读。
 *   4. 每个区块独立容错：任何一处异常都不能让面板白屏；顶层再套一层错误边界。
 *   5. 视觉与交互依据 docs/DESIGN.md（Operate 模式「年度台账」）。四条硬规则：
 *      · 绿色只表达「量」——只有热力图色阶与月视图强度条两处消费 `--lw-heat`；
 *      · 主操作 / 选中态 / 今天用 --dsw-alias-brand-primary（本应用是单色品牌色）；
 *      · 标签 chip 中性（透明底 + 0.5px 发丝线 + label-secondary 文字）；
 *      · 焦点环只写 outline-width / outline-color / outline-offset 长手写属性，
 *        **禁止 outline 简写**（会覆盖平台给鼠标模态加的那条抑制规则）。
 *      另：文字只用 label-primary / label-secondary（浅色下 label-tertiary 仅 3.71:1、
 *      state-success-primary 仅 2.28:1，一律不当文字色）。
 *
 * 座位（与 M0 完全一致，未改）：
 *   - sidebar.panellist  id='logwiki' order=40 label='任务日历'  → 左侧栏图标行
 *   - main               key='logwiki'                          → 整页日历
 *   - conversation.input.overlay id='logwiki-composer'（无头）  → 输入框通道
 *
 * Wire 契约见 docs/OVERVIEW.md §2。**写这份代码时 Host 侧只实现了 /ping**，
 * 其余端点一律 404 —— 所以所有取数都走 request() 的失败降级，面板只会显示
 * 「数据源未就绪」而不会崩。
 *
 * 本文件依赖的端点（集成方照着补即可，全部见 §2）：
 *   GET  /ping                        —— 已实现（头部"已连接"徽章用它）
 *   GET  /health                      —— scan 进度；缺 → 不显示"正在回填历史…"
 *   GET  /state?from=&to=&sources=    —— 热力图 + 总量；缺 → "数据源未就绪"
 *   GET  /day?date=&sources=          —— 日详情三层卡片
 *   POST /refresh                     —— 「更新」按钮（带 x-logwiki: 1）
 *   GET  /events                      —— SSE progress；缺 → 进度条静默降级
 *   POST /entry | /entry/add | /entry/delete   —— 条目编辑/新增/删除
 *   GET  /digests?kind=&period= | /digests/available
 *   POST /digest/generate | /digest/agent-prompt
 *   GET  /sources                     —— 来源筛选 chips（缺 → 只显示"本机"）
 */
window.__ModuleLoader__.load({
  id: 'dsh-logwiki',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useCallback, useRef, useSyncExternalStore } = React

    /** 面板 id：sidebar.panellist 的 id 与 main 的 key 必须是同一个值，图标行才寻址得到面板。 */
    const PANEL_ID = 'logwiki'
    const NS = 'dsh-logwiki'
    const API = '/api/dsh-logwiki'
    const MUTATION_HEADERS = { 'x-logwiki': '1' }
    const METRICS = ['turns', 'tokens', 'sessions', 'entries']
    const METRIC_LABEL = { turns: '轮次', tokens: 'Token', sessions: '会话', entries: '条目' }
    const WD_LABEL = ['一', '二', '三', '四', '五', '六', '日']
    const MONTH_LABEL = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']

    // ---------------------------------------------------------------------
    // 工具（纯函数，全部做防御性判空：Host 数据形状不对也不能炸渲染）
    // ---------------------------------------------------------------------

    function isObj(v) {
      return v !== null && typeof v === 'object'
    }
    function errText(e) {
      if (e === null || e === undefined) return '未知错误'
      if (e instanceof Error) return e.message
      if (typeof e === 'string') return e
      return String(e)
    }
    function toNum(v) {
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) ? n : 0
    }
    function pad2(n) {
      return n < 10 ? '0' + n : String(n)
    }
    function fromDateKey(key) {
      const parts = String(key).split('-')
      const y = Number(parts[0])
      const m = Number(parts[1])
      const d = Number(parts[2])
      if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null
      const dt = new Date(y, m - 1, d)
      return Number.isNaN(dt.getTime()) ? null : dt
    }
    function dateKeyOf(d) {
      if (!(d instanceof Date) || Number.isNaN(d.getTime())) return ''
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    }
    function todayKey() {
      return dateKeyOf(new Date())
    }
    function addDays(d, n) {
      const out = new Date(d.getFullYear(), d.getMonth(), d.getDate())
      out.setDate(out.getDate() + n)
      return out
    }
    /** 该日期所在周的周一（weekStart=1）。 */
    function startOfWeek(d) {
      const base = new Date(d.getFullYear(), d.getMonth(), d.getDate())
      const idx = (base.getDay() + 6) % 7 // 周一=0 … 周日=6
      return addDays(base, -idx)
    }
    function fmtDay(key) {
      const d = fromDateKey(key)
      if (d === null) return String(key)
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    }
    function fmtTime(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return ''
      const d = new Date(ms)
      if (Number.isNaN(d.getTime())) return ''
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    }
    function fmtDateTime(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return ''
      const d = new Date(ms)
      if (Number.isNaN(d.getTime())) return ''
      return fmtDay(dateKeyOf(d)) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    }
    function fmtNum(n) {
      const v = toNum(n)
      if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M'
      if (v >= 1000) return (v / 1000).toFixed(1) + 'k'
      return String(v)
    }
    function fmtDuration(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return ''
      const min = Math.round(ms / 60000)
      if (min < 60) return min + ' 分钟'
      const hours = Math.floor(min / 60)
      return hours + ' 小时 ' + (min % 60) + ' 分'
    }
    /** 条目时间区间：同一分钟只给一个时间，否则 "HH:mm–HH:mm"；缺 end 就只给起点。 */
    function fmtRange(start, end) {
      const a = fmtTime(start)
      const b = fmtTime(end)
      if (a === '') return '时间未知'
      if (b === '' || b === a) return a
      return a + '–' + b
    }
    /** GFM 周编号（ISO-8601）：周一为一周之始，含 1 月 4 日的那周是第 1 周。 */
    function gfmWeekKey(d) {
      const t = new Date(d.getFullYear(), d.getMonth(), d.getDate())
      const dow = (t.getDay() + 6) % 7
      t.setDate(t.getDate() - dow + 3) // 该周的周四
      const isoYear = t.getFullYear()
      const jan4 = new Date(isoYear, 0, 4)
      const jan4dow = (jan4.getDay() + 6) % 7
      const week1Thu = new Date(isoYear, 0, 4 - jan4dow + 3)
      const week = 1 + Math.round((t.getTime() - week1Thu.getTime()) / 604800000)
      return isoYear + '-W' + pad2(week)
    }
    function monthKeyOf(d) {
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1)
    }
    function periodToRange(period, kind) {
      const s = String(period)
      if (kind === 'month') {
        const p = s.split('-')
        const y = Number(p[0])
        const m = Number(p[1])
        if (!Number.isFinite(y) || !Number.isFinite(m)) return null
        return { from: dateKeyOf(new Date(y, m - 1, 1)), to: dateKeyOf(new Date(y, m, 0)) }
      }
      const m = /^(\d{4})-W(\d{1,2})$/.exec(s)
      if (m === null) return null
      const y = Number(m[1])
      const jan4 = new Date(y, 0, 4)
      const jan4dow = (jan4.getDay() + 6) % 7
      const week1Mon = addDays(jan4, -jan4dow)
      const mon = addDays(week1Mon, (Number(m[2]) - 1) * 7)
      return { from: dateKeyOf(mon), to: dateKeyOf(addDays(mon, 6)) }
    }
    function fmtPeriod(period, kind) {
      const r = periodToRange(period, kind)
      if (r === null) return String(period)
      return r.from + ' ~ ' + r.to
    }

    /**
     * 分位分档（与 lib/fold.js 的 quantileThresholds/heatLevel 同口径，客户端算一份，
     * 免得热力图色阶依赖 Host 再传一次阈值）。0 值不进分位；阈值严格递增、去重。
     * @returns [p25,p50,p75,p90]
     */
    function quantileThresholds(values) {
      const arr = []
      for (const v of values) {
        const n = toNum(v)
        if (n > 0) arr.push(n)
      }
      if (arr.length === 0) return [0, 0, 0, 0]
      arr.sort((a, b) => a - b)
      const pick = (p) => arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1) + 0.5))]
      const raw = [pick(0.25), pick(0.5), pick(0.75), pick(0.9)]
      const out = []
      let prev = -Infinity
      for (const v of raw) {
        const next = v > prev ? v : prev + 1
        out.push(next)
        prev = next
      }
      return out
    }
    /** 0 → 0（空格底色）；否则落 1..4 档。 */
    function heatLevel(value, thresholds) {
      const v = toNum(value)
      if (v <= 0) return 0
      const t = Array.isArray(thresholds) ? thresholds : []
      if (t.length < 4) return 1
      if (v <= t[0]) return 1
      if (v <= t[1]) return 2
      if (v <= t[2]) return 3
      return 4
    }

    /** 所有取值都进 `--dsw-*` token；热力图色阶用 color-mix 与主题底色融合。 */
    const CSS = `
.lw-root {
  /* 插件自有色阶根：全文件唯一的写死颜色，只允许出现在这一行 */
  --dsw-lw-heat: #39d353;
  --lw-heat: var(--dsw-lw-heat);
  --lw-empty: var(--dsw-alias-bg-skeleton, var(--dsw-alias-bg-layer-2));
  /* 错误**文字**用色：浅色档 state-error-primary 对白底只有 4.4976:1（C22 的 toFixed(2)
     会把它显示成 4.50 这种擦边值），
     被 C22 的 toFixed(2) 判成 4.50 属于"擦边达标"。这里往 label-primary 混 18% 得到
     同族更深一档的红（浅 6.09:1 / 深 5.69:1），既保留语义色又稳定过 4.5:1。
     两个输入都是 --dsw-* token，不引入任何写死颜色。 */
  --lw-danger: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 82%, var(--dsw-alias-label-primary));
  display: flex; flex-direction: column;
  height: 100%; min-height: 0;
  background: var(--dsw-alias-bg-base, #ffffff);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
  font-size: var(--dsw-font-s-14-font-size, 14px);
  line-height: var(--dsw-font-s-14-line-height, 22px);
  font-variant-numeric: tabular-nums;
  caret-color: var(--dsw-alias-brand-primary, #4d6bfe);
}
.lw-root *, .lw-root *::before, .lw-root *::after { box-sizing: border-box; }

/* ---------- 浏览器表面：选区 / 滚动条（§2.6） ---------- */
.lw-root ::selection {
  background: var(--dsw-alias-bg-document-selection, color-mix(in srgb, #3b82f6 40%, transparent));
  color: inherit;
}
.lw-root, .lw-scroll, .lw-drawer-body {
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l2) transparent;
}
.lw-root::-webkit-scrollbar,
.lw-scroll::-webkit-scrollbar,
.lw-drawer-body::-webkit-scrollbar { width: 10px; height: 10px; }
.lw-root::-webkit-scrollbar-thumb,
.lw-scroll::-webkit-scrollbar-thumb,
.lw-drawer-body::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l2);
  border-radius: 999px;
}
.lw-root::-webkit-scrollbar-thumb:hover,
.lw-scroll::-webkit-scrollbar-thumb:hover,
.lw-drawer-body::-webkit-scrollbar-thumb:hover {
  background: var(--dsw-alias-scrollbar-hover-l2);
}
/* 横向滚动（窄窗的热力图）用 l1 一档，视觉上更轻 */
.lw-scroll::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l1); }
.lw-scroll::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l1); }

/* ---------- 工具栏 ---------- */
.lw-head {
  display: flex; align-items: center; gap: 8px; flex: none;
  flex-wrap: wrap;
  padding: 9px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
/* <900px 时两段换行：工具条自然折成两行（每段 flex-basis:100%） */
.lw-head-seg { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
.lw-head-seg2 { flex: 1; }
.lw-head-2row .lw-head-seg { flex-basis: 100%; }
.lw-title { font-weight: 600; font-size: var(--dsw-font-s-14-font-size, 14px); }
.lw-ver {
  color: var(--dsw-alias-label-secondary); font-size: var(--dsw-font-xxs-12-font-size, 12px);
  border: 0; border-color: var(--dsw-alias-border-l2, var(--dsw-alias-border-l1));
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2, var(--dsw-alias-border-l1));
  border-radius: 999px; padding: 0 8px; line-height: 18px;
}
/* 「已连接」的语义由文字承载，绿色圆点只是装饰性强化（aria-hidden） */
.lw-conn {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
  color: var(--dsw-alias-label-secondary);
}
.lw-dot { width: 6px; height: 6px; border-radius: 999px; flex: none; background: var(--dsw-alias-state-success-primary); }
.lw-dot-warn { background: var(--dsw-alias-state-warn-primary); }
.lw-bad { color: var(--lw-danger); }
.lw-spacer { flex: 1; min-width: 8px; }
.lw-group {
  display: inline-flex; align-items: center; gap: 2px; flex: none;
  border: 0; border-color: var(--dsw-alias-border-l1);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm, 8px);
  padding: 1px;
  background: var(--dsw-alias-bg-layer-2);
}
.lw-btn {
  appearance: none; font: inherit; cursor: pointer;
  font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 18px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-button-tool-bar-fill, var(--dsw-alias-bg-layer-2));
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm, 8px);
  padding: 4px 10px;
  white-space: nowrap;
  transition: background-color 150ms ease-out, border-color 150ms ease-out, color 150ms ease-out;
}
.lw-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-3)); }
.lw-btn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover)); }
.lw-btn:disabled { opacity: .5; cursor: default; }
/* 主操作：品牌单色底 + 配套前景（该 token 在本应用是单色品牌色，明暗各自反相） */
.lw-btn.lw-primary {
  background: var(--dsw-alias-brand-primary);
  /* 前景由宿主决定：品牌色与其配对前景是一对 token，插件不硬编码白色 */
  color: var(--dsw-alias-label-primary-foreground);
  border-color: transparent;
}
.lw-btn.lw-primary:hover:not(:disabled) { opacity: .88; }
.lw-btn.lw-tiny { padding: 2px 8px; }
/* 无边框按钮：抽屉里一律用它（避免出现"四边框 + 圆角"的盒子） */
.lw-btn.lw-bare { border: 0; background: none; border-radius: var(--dsw-radius-sm, 8px); }
.lw-btn.lw-bare:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-3)); }
.lw-group .lw-btn {
  border: 0; background: none; border-radius: var(--dsw-radius-xs, 4px);
  padding: 3px 9px;
  transition: background-color 120ms ease-out, color 120ms ease-out;
}
.lw-group .lw-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-3)); }
.lw-group .lw-btn.lw-on,
.lw-btn.lw-on {
  background: var(--dsw-alias-brand-primary);
  /* 同上：不硬编码白色前景，交给宿主配对的 --dsw-alias-label-primary-foreground */
  color: var(--dsw-alias-label-primary-foreground);
  border-color: transparent;
}
/* 输入类控件统一用 inset 发丝线描边：视觉与 1px 边框一致，但不会构成"卡框" */
.lw-field {
  appearance: none; font: inherit; font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 18px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 0; border-color: var(--dsw-alias-border-l1);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm, 8px);
  padding: 3px 8px;
  max-width: 100%;
}
.lw-field::placeholder { color: var(--dsw-alias-label-secondary); opacity: 1; }
textarea.lw-field { resize: vertical; min-height: 52px; width: 100%; line-height: 1.55; }
select.lw-field { cursor: pointer; }
.lw-chip {
  appearance: none; font: inherit; cursor: pointer;
  display: inline-flex; align-items: center; gap: 5px;
  font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
  border: 0; border-color: var(--dsw-alias-border-l2, var(--dsw-alias-border-l1));
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2, var(--dsw-alias-border-l1));
  border-radius: 999px; padding: 1px 10px;
  white-space: nowrap;
  transition: background-color 120ms ease-out, color 120ms ease-out, box-shadow 120ms ease-out;
}
.lw-chip:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-3)); }
.lw-chip.lw-on {
  color: var(--dsw-alias-label-primary-foreground);
  background: var(--dsw-alias-brand-primary);
  box-shadow: none;
}
/* 正文/占位只用 label-primary 与 label-secondary（浅色 18.90:1 / 5.80:1） */
.lw-meta {
  color: var(--dsw-alias-label-secondary);
  font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 18px;
  white-space: nowrap;
}
.lw-meta.lw-wrap { white-space: normal; }

/* ---------- 页身 ---------- */
/* 这两层给 position:relative 只是为了让台账栏的 offsetParent 能区分「右栏」与「下方汇总带」 */
.lw-split { display: flex; flex: 1; min-height: 0; position: relative; }
.lw-stack { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; position: relative; }
.lw-main {
  flex: 1; min-width: 0; min-height: 0;
  display: flex; flex-direction: column; gap: 12px;
  overflow-y: auto; overflow-x: hidden;
  scrollbar-gutter: stable;
  padding: 12px;
}
/* 简报 / 来源：占据面板的整段视图（整宽；过高时自己滚，不挤掉日历） */
.lw-section {
  flex: none; padding: 12px 12px 0;
  max-height: 72%; overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l2) transparent;
}

/* ---------- 年视图：热力图 ---------- */
/* margin-block:auto：有富余高度时把网格块在可用高度里**垂直居中**；内容比容器高时
   auto 外边距自动收敛为 0，不会像 justify-content:center 那样把顶部推出滚动区。 */
.lw-heatwrap { display: flex; flex-direction: column; gap: 12px; min-width: 0; flex: none; margin-block: auto; }
.lw-heatgrid { display: flex; align-items: flex-start; min-width: 0; }
/* 星期栏 24px（含 6px 右内边距）：让 .lw-scroll 的可用宽 = 容器宽 − 24，
   与 §3.2 的列宽公式严格自洽 —— 否则网格会比滚动容器宽 6px 而挤出滚动条。 */
.lw-wdcol { display: flex; flex-direction: column; flex: none; width: 24px; padding-right: 6px; }
.lw-wd {
  display: flex; align-items: center; justify-content: flex-end;
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
  color: var(--dsw-alias-label-secondary);
  overflow: hidden;
}
.lw-scroll { overflow: auto; min-width: 0; flex: 1; }
.lw-heat { position: relative; }
.lw-heat-months { position: absolute; top: 0; left: 0; height: 18px; }
.lw-heat-month {
  position: absolute; top: 0; height: 18px; line-height: 18px;
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
  color: var(--dsw-alias-label-secondary); white-space: nowrap;
}
/* 定位上下文：格子是 absolute，必须由这一层建立包含块 */
.lw-heat-cells { position: absolute; left: 0; }
.lw-cell {
  position: absolute; padding: 0; margin: 0; border: 0; cursor: pointer;
  border-radius: var(--dsw-radius-xs, 4px);
  background: color-mix(in srgb, var(--lw-heat) var(--lw-pct, 0%), var(--lw-empty));
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l1);
  transition: background-color 120ms ease-out, box-shadow 120ms ease-out;
}
/* 覆盖优先级（§3.3）：选中 > 今天 > 降级 > hover > 基础；靠源码顺序定胜负 */
.lw-cell:hover { box-shadow: inset 0 0 0 1px var(--dsw-alias-label-primary); }
.lw-cell:active { box-shadow: inset 0 0 0 2px var(--dsw-alias-label-primary); }
.lw-cell:disabled { opacity: .35; cursor: default; }
.lw-cell[data-today="1"] { box-shadow: inset 0 0 0 1px var(--dsw-alias-label-secondary); }
.lw-cell[data-degraded="1"] { box-shadow: inset 0 0 0 1px var(--dsw-alias-state-warn-primary); }
.lw-cell[data-selected="1"] {
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l1), 0 0 0 2px var(--dsw-alias-brand-primary);
}
.lw-cell[data-selected="1"]:hover {
  box-shadow: inset 0 0 0 1px var(--dsw-alias-label-primary), 0 0 0 2px var(--dsw-alias-brand-primary);
}
.lw-cell:focus-visible { z-index: 2; }
.lw-cell-legend { display: flex; align-items: center; gap: 4px; justify-content: flex-end; }
.lw-legend-cell {
  width: 12px; height: 12px; border-radius: 2px;
  background: color-mix(in srgb, var(--lw-heat) var(--lw-pct, 0%), var(--lw-empty));
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l1);
}
/* 月份活动条：与热力图同 x 轴（左缘 = 该月第一周的 left），高度=该月量。
   中性色（label-secondary）——绿色只留给热力图色阶与月视图强度条。 */
.lw-monthbar { position: absolute; left: 0; }
.lw-mbar-seg {
  position: absolute; bottom: 0; height: 6px; padding: 0; margin: 0;
  border: 0; cursor: pointer; border-radius: 2px;
  display: flex; align-items: flex-end;
  background: var(--dsw-alias-bg-skeleton, var(--dsw-alias-bg-layer-2));
  transition: background-color 150ms ease-out;
}
.lw-mbar-seg > i { display: block; width: 100%; border-radius: 2px; background: var(--dsw-alias-label-secondary); }
.lw-mbar-seg:hover > i { background: var(--dsw-alias-label-primary); }
.lw-heat-foot { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; min-width: 0; }
/* <700px：台账栏与活动索引都不在，把「近期活动」放进来填住空白区（同一份 /state 派生数据） */
.lw-heat-recent { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; min-width: 0; }
.lw-heat-recent .lw-recent { width: auto; padding: 2px 6px; }
.lw-heat-note {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 10px 12px; border-radius: var(--dsw-radius-md, 12px);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
}

/* ---------- 年度台账栏（§3.5）：低对齐度度量表，不是大数字 hero ---------- */
.lw-ledger {
  flex: none; width: 216px; padding: 12px;
  border-left: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  overflow-y: auto;
}
.lw-ledger-title {
  font-size: var(--dsw-font-xs-13-font-size, 13px); font-weight: 500;
  color: var(--dsw-alias-label-secondary); margin-bottom: 4px;
}
.lw-ledger-list { display: block; }
.lw-ledger-row {
  display: flex; justify-content: space-between; align-items: baseline; gap: 8px;
  height: 28px; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.lw-ledger-k { font-size: var(--dsw-font-xxs-12-font-size, 12px); color: var(--dsw-alias-label-secondary); }
.lw-ledger-v {
  font-size: var(--dsw-font-xs-13-font-size, 13px); font-weight: 500;
  color: var(--dsw-alias-label-primary); text-align: right;
}
.lw-ledger-sec { margin-top: 12px; }
.lw-ledger-sub { font-size: var(--dsw-font-xxs-12-font-size, 12px); color: var(--dsw-alias-label-secondary); margin-bottom: 4px; }
.lw-recent {
  appearance: none; font: inherit; width: 100%; cursor: pointer;
  display: flex; justify-content: space-between; gap: 8px; align-items: baseline;
  background: none; border: 0; padding: 3px 4px;
  border-radius: var(--dsw-radius-xs, 4px);
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
  color: var(--dsw-alias-label-secondary);
  transition: background-color 150ms ease-out, color 150ms ease-out;
}
.lw-recent:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-3)); color: var(--dsw-alias-label-primary); }
.lw-recent-v { font-size: var(--dsw-font-xxs-12-font-size, 12px); color: var(--dsw-alias-label-primary); }
/* 900–1080（含 700–900）：台账离开右栏，退成主区下方的一行汇总带。
   带宽不足时**横向滚动**，绝不换行 —— 保证 700–1080px 任意宽度下 offsetHeight ≤ 56px。 */
.lw-ledger-band {
  width: 100%; flex: none; display: flex; align-items: center; gap: 16px;
  flex-wrap: nowrap; white-space: nowrap;
  min-height: 44px; max-height: 56px; padding: 6px 12px;
  border-left: 0; border-top: 1px solid var(--dsw-alias-border-l1);
  overflow-x: auto; overflow-y: hidden;
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l1) transparent;
}
.lw-ledger-band::-webkit-scrollbar { height: 6px; }
.lw-ledger-band::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l1); border-radius: 999px; }
.lw-ledger-band::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l1); }
.lw-ledger-band .lw-ledger-title { margin-bottom: 0; flex: none; }
.lw-ledger-band .lw-ledger-list { display: flex; align-items: center; gap: 16px; flex-wrap: nowrap; flex: none; }
.lw-ledger-band .lw-ledger-row { height: auto; border-bottom: 0; gap: 6px; flex: none; }
.lw-ledger-band .lw-ledger-sec { margin-top: 0; flex: none; display: flex; align-items: center; gap: 12px; }
.lw-ledger-band .lw-ledger-sub { margin-bottom: 0; flex: none; }
.lw-ledger-band .lw-recent { width: auto; padding: 0 4px; flex: none; }

/* ---------- 月视图 ---------- */
.lw-month { display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0; }
.lw-month-head { display: flex; align-items: center; gap: 8px; flex: none; flex-wrap: wrap; }
.lw-month-title { font-weight: 600; font-size: var(--dsw-font-xs-13-font-size, 13px); }
.lw-mgrid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; }
.lw-mhead { flex: none; }
/* 格子吃掉面板高度：行高 minmax(64px,1fr) */
.lw-mbody { flex: 1; min-height: 0; grid-auto-rows: minmax(64px, 1fr); }
.lw-mwd { text-align: center; font-size: var(--dsw-font-xxs-12-font-size, 12px); color: var(--dsw-alias-label-secondary); padding: 2px 0; }
.lw-mcell {
  appearance: none; font: inherit; cursor: pointer; text-align: left;
  position: relative; display: flex; flex-direction: column; gap: 2px;
  min-width: 0; padding: 6px 8px 11px;
  color: var(--dsw-alias-label-primary);
  /* 量纲通道①：背景按档位着中性色（不用绿色——绿色只留给强度条） */
  background: color-mix(in srgb, var(--dsw-alias-label-primary) var(--lw-pct, 0%), var(--dsw-alias-bg-layer-1));
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm, 8px);
  transition: background-color 120ms ease-out, border-color 120ms ease-out, box-shadow 120ms ease-out;
}
.lw-mcell:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-3)); }
.lw-mcell:active { background: var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover)); }
.lw-mcell[data-out="1"] { opacity: .45; }
.lw-mcell[data-today="1"] { border-color: var(--dsw-alias-brand-primary); }
.lw-mcell[data-degraded="1"] { border-color: var(--dsw-alias-state-warn-primary); }
/* 选中：1px 边框 + 1px 内缩环 = 视觉 2px，且不引起布局跳动 */
.lw-mcell[data-selected="1"] { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary); }
.lw-mnum { font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 18px; color: var(--dsw-alias-label-secondary); }
.lw-mcell[data-today="1"] .lw-mnum { color: var(--dsw-alias-brand-primary); font-weight: 600; }
.lw-mval { font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 18px; color: var(--dsw-alias-label-primary); word-break: break-word; }
.lw-mval.lw-zero { color: var(--dsw-alias-label-secondary); }
.lw-mcnt { font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 18px; color: var(--dsw-alias-label-secondary); }
/* 量纲通道②：底部 3px 条，按本月峰值 */
.lw-mstrip {
  position: absolute; left: 6px; right: 6px; bottom: 3px; height: 3px;
  border-radius: 2px; overflow: hidden;
  background: var(--dsw-alias-bg-skeleton, var(--dsw-alias-bg-layer-2));
}
.lw-mstrip > i { display: block; height: 100%; background: var(--lw-heat); }

/* ---------- 标签 chip：中性（透明底 + 0.5px 发丝线） ---------- */
.lw-tag {
  flex: none; font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 18px;
  border: 0; border-color: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  border-radius: var(--dsw-radius-xs, 4px);
  padding: 0 5px; background: transparent;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis;
}

/* ---------- 日详情抽屉：行式台账，三层都不再是盒子（§5） ---------- */
.lw-drawer {
  flex: none; width: 360px; max-width: 46vw;
  min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  scrollbar-gutter: stable;
  border-left: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  /* 抽屉开合：唯一的 180ms 作者时刻。**只过渡 opacity**（width 过渡会触发 layout，
     impeccable 会判成 layout-transition；@starting-style 负责入场淡入） */
  transition: opacity 180ms ease-out;
}
@starting-style { .lw-drawer { opacity: 0; } }
/* sticky 头部：大号 tabular 日号 + 星期 + 月份 + 刷新/关闭 */
.lw-drawer-head {
  position: sticky; top: 0; z-index: 2;
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 9px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.lw-drawer-date { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.lw-drawer-day {
  font-size: var(--dsw-font-l-20-font-size, 20px);
  line-height: var(--dsw-font-l-20-line-height, 28px);
  font-weight: 600; color: var(--dsw-alias-label-primary);
}
.lw-drawer-when { display: flex; flex-direction: column; min-width: 0; }
.lw-drawer-wd { font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 18px; color: var(--dsw-alias-label-secondary); }
.lw-drawer-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.lw-drawer-body { padding: 0 0 20px; }
/* 来源 = 小节标签；无边框无底色，只有分隔线 */
.lw-src-row { padding: 10px 12px 6px; }
.lw-src-row + .lw-src-row { border-top: 1px solid var(--dsw-alias-border-l1); }
.lw-src-head { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
.lw-pill {
  flex: none; font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 18px;
  border: 0; border-color: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  border-radius: 999px; padding: 0 8px;
  color: var(--dsw-alias-label-secondary);
}
/* 工作区 = 组头 */
.lw-ws-row { padding: 4px 12px 6px; }
.lw-ws-head { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.lw-ws-title {
  font-size: var(--dsw-font-xxs-12-font-size, 12px); font-weight: 500;
  color: var(--dsw-alias-label-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.lw-ws-path {
  margin-left: 12px; font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 18px;
  color: var(--dsw-alias-label-secondary); word-break: break-all;
}
.lw-ws-meta { margin-left: auto; font-size: var(--dsw-font-xxs-12-font-size, 12px); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
/* 条目 = 行（无边框、无圆角、无底色）
   行首 = 时间 │ 标签 chip │ 徽章 │ 编辑 删除（同一视觉行，§5.1）
   行身 = 摘要，跨满整行、与时间左对齐（§5.2「不额外缩进」）
   这样摘要拿到整行宽度（360px 抽屉下 336px），不会再被右侧内容挤窄。 */
.lw-entry-row {
  display: grid; grid-template-columns: 88px minmax(0, 1fr);
  align-items: start; column-gap: 8px; row-gap: 2px;
  padding: 6px 12px;
  border-left: 2px solid transparent;
  border-top: 1px solid var(--dsw-alias-border-l1);
  transition: background-color 150ms ease-out, border-color 150ms ease-out;
}
.lw-entry-row:hover, .lw-entry-row:focus-within {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-3));
  border-left-color: var(--dsw-alias-brand-primary);
}
.lw-entry-row:active { background: var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover)); }
/* 行内编辑：占行身那一格（跨满整行） */
.lw-entry-edit { grid-column: 1 / -1; grid-row: 2; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.lw-entry-time { grid-column: 1; grid-row: 1; font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 18px; color: var(--dsw-alias-label-secondary); }
/* 行首：标签 chip / 已手改 / 编辑 删除 全在同一视觉行 */
.lw-entry-side {
  grid-column: 2; grid-row: 1;
  display: inline-flex; align-items: center; gap: 6px;
  justify-content: flex-start; flex-wrap: wrap; min-width: 0;
}
/* 给标签留出上限，保证「时间 │ 标签 │ 编辑 删除」不会被长标签挤到第二行 */
.lw-entry-side .lw-tag { max-width: calc(100% - 132px); }
/* 行身：摘要（第 2 行、跨满整行） */
.lw-entry-sum {
  grid-column: 1 / -1; grid-row: 2;
  font-size: var(--dsw-font-xs-13-font-size, 13px); line-height: 1.55;
  color: var(--dsw-alias-label-primary); word-break: break-word; white-space: pre-wrap;
}
/* 已手改 = 行右端小圆点 + 文字（不再是一个描边 pill） */
.lw-mark {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 18px;
  color: var(--dsw-alias-label-secondary); white-space: nowrap;
}
.lw-mark > i { width: 6px; height: 6px; border-radius: 999px; flex: none; background: var(--dsw-alias-state-warn-primary); }
/* 编辑 / 删除：hover 或 focus-within 才显示（opacity 不影响可聚焦性） */
.lw-entry-acts { display: inline-flex; align-items: center; gap: 6px; opacity: 0; transition: opacity 150ms ease-out; }
.lw-entry-row:hover .lw-entry-acts,
.lw-entry-row:focus-within .lw-entry-acts { opacity: 1; }
.lw-linkbtn {
  appearance: none; background: none; border: 0; padding: 0; cursor: pointer;
  font: inherit; font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 18px;
  color: var(--dsw-alias-label-primary);
  transition: color 150ms ease-out;
}
.lw-linkbtn:hover { text-decoration: underline; }
.lw-linkbtn.lw-danger { color: var(--lw-danger); }
.lw-linkbtn:disabled { opacity: .5; cursor: default; text-decoration: none; }
.lw-add-row { padding: 8px 12px 4px; border-top: 1px solid var(--dsw-alias-border-l1); }
.lw-form-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.lw-form-row + .lw-form-row { margin-top: 6px; }

/* ---------- 简报 / 来源：占据面板的整段视图 ---------- */
.lw-digest {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
}
.lw-digest-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.lw-digest-title { font-weight: 600; font-size: var(--dsw-font-xs-13-font-size, 13px); }
.lw-digest-body { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.lw-digest-foot {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l1);
}
/* 「添加来源」表单的一行：左边标签定宽、右边控件撑满 */
.lw-field-label { display: flex; align-items: center; gap: 8px; }
.lw-flabel {
  flex: none; width: 160px;
  font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.lw-field-label > .lw-field { flex: 1; min-width: 0; }
.lw-headline {
  color: var(--dsw-alias-label-secondary); font-size: var(--dsw-font-xs-13-font-size, 13px); line-height: 1.6;
  white-space: pre-wrap; word-break: break-word;
}
/* 简报条目：行，不是卡（摘要 13px | 右侧中性 chip） */
.lw-dlist { display: flex; flex-direction: column; }
.lw-ditem {
  display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;
  padding: 6px 0; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.lw-ditem:last-child { border-bottom: 0; }
.lw-ditem-sum { font-size: var(--dsw-font-xs-13-font-size, 13px); line-height: 1.55; color: var(--dsw-alias-label-primary); word-break: break-word; }
/* 远程来源：每来源一行 */
.lw-src-line {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 0; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.lw-src-line:last-child { border-bottom: 0; }

/* ---------- 空态 / 骨架 / 降级 ---------- */
.lw-empty {
  border-radius: var(--dsw-radius-md, 12px);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l1);
  padding: 20px 16px; text-align: center;
  color: var(--dsw-alias-label-secondary);
  font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 1.7;
}
.lw-empty-title { color: var(--dsw-alias-label-primary); font-weight: 600; font-size: var(--dsw-font-xs-13-font-size, 13px); margin-bottom: 4px; }
.lw-empty-acts { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; margin-top: 12px; }
/* 抽屉里不许出现任何"卡框"（四边框 + 圆角）：空态/降级块在抽屉内一律去掉盒子特征 */
.lw-drawer .lw-empty, .lw-drawer .lw-fallback { box-shadow: none; border-radius: 0; padding: 20px 12px; text-align: left; }
.lw-skel { display: flex; flex-direction: column; gap: 8px; }
.lw-skel-row { height: 14px; border-radius: var(--dsw-radius-xs, 4px); background: var(--dsw-alias-bg-skeleton, var(--dsw-alias-bg-layer-2)); }
.lw-skel-row.lw-skel-w1 { width: 40%; }
.lw-skel-row.lw-skel-w2 { width: 72%; }
.lw-skel-row.lw-skel-w3 { width: 55%; }
/* 骨架屏与所替代内容同形：热力图 = 7×53 小格；月视图 = 7×42 格；台账 = 7 行 */
.lw-skel-heat { display: flex; flex-direction: column; gap: 3px; overflow: hidden; margin-block: auto; animation: lw-pulse 1.4s ease-in-out infinite; }
.lw-skel-heat-row { display: flex; gap: 3px; }
.lw-skel-heat-cell { flex: none; width: 12px; height: 12px; border-radius: 2px; background: var(--dsw-alias-bg-skeleton, var(--dsw-alias-bg-layer-2)); }
.lw-skel-heat-wd { flex: none; width: 24px; }
.lw-skel-month {
  display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px;
  grid-auto-rows: minmax(64px, 1fr);
  flex: 1; min-height: 0;
  animation: lw-pulse 1.4s ease-in-out infinite;
}
.lw-skel-mcell { border-radius: var(--dsw-radius-sm, 8px); background: var(--dsw-alias-bg-skeleton, var(--dsw-alias-bg-layer-2)); }
.lw-fallback {
  margin: 12px; padding: 12px;
  box-shadow: inset 0 0 0 1px var(--dsw-alias-state-error-primary, #d54941);
  border-radius: var(--dsw-radius-md, 12px);
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  white-space: pre-wrap; word-break: break-word;
  font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 1.6;
}
.lw-iconbtn {
  appearance: none; background: none; border: 0; padding: 2px; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: var(--dsw-radius-xs, 4px);
  color: var(--dsw-alias-label-secondary);
  transition: color 150ms ease-out, background-color 150ms ease-out;
}
.lw-iconbtn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-3)); }
.lw-iconbtn:disabled { opacity: .5; cursor: default; }
/* 横幅：状态色由圆点承载，文字仍是 label-primary（浅色下 warn 文字仅 2.15:1） */
.lw-banner {
  display: flex; align-items: center; gap: 6px; flex: none; flex-wrap: wrap;
  padding: 6px 12px;
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
  color: var(--dsw-alias-label-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, var(--dsw-alias-bg-layer-1));
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.lw-progress { flex: none; height: 3px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.lw-progress > i {
  display: block; height: 100%; width: 100%;
  background: var(--dsw-alias-brand-primary); opacity: .5;
  animation: lw-pulse 1.4s ease-in-out infinite;
}
@keyframes lw-pulse { 0%, 100% { opacity: 1 } 50% { opacity: .45 } }
.lw-promptbox {
  width: 100%; min-height: 140px; font-family: var(--dsw-font-family);
  font-size: var(--dsw-font-xs-13-font-size, 13px); line-height: 1.6;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 0; border-color: var(--dsw-alias-border-l1);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm, 8px);
  padding: 8px; resize: vertical;
}
.lw-toast {
  position: fixed; z-index: 1100; top: 16px; left: 50%; transform: translateX(-50%);
  max-width: min(520px, calc(100vw - 40px));
  padding: 8px 14px; border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-toast-bg, var(--dsw-alias-bg-layer-3));
  color: var(--dsw-alias-toast-label, #fff);
  box-shadow: var(--dsw-shadow-lv3, var(--dsw-elevation-prominent));
  font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 18px;
  pointer-events: none;
}
.lw-events { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }

/* ---------- 焦点环（§2.6）：只写长手写属性，禁止 outline 简写 ---------- */
.lw-btn:focus-visible,
.lw-chip:focus-visible,
.lw-cell:focus-visible,
.lw-mcell:focus-visible,
.lw-mbar-seg:focus-visible,
.lw-field:focus-visible,
.lw-linkbtn:focus-visible,
.lw-iconbtn:focus-visible,
.lw-recent:focus-visible,
.lw-promptbox:focus-visible {
  outline-width: var(--dsw-focus-ring-width, 2px);
  outline-color: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-style: solid;
  outline-offset: 2px;
}

/* ---------- 动效契约（§2.8）：只有 120 / 150 / 180 三个值 ---------- */
@media (prefers-reduced-motion: reduce) {
  .lw-root *, .lw-root *::before, .lw-root *::after {
    animation: none !important;
    transition: none !important;
  }
}
`

    /** 注入样式表；重复挂载时不重复插入，且不误删别人的 tag。 */
    function applyStyles() {
      const tagId = NS + '/styles.css'
      if (typeof document === 'undefined') return () => {}
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) {
        return () => {}
      }
      const el = document.createElement('style')
      el.dataset.plugin = NS
      el.dataset.pluginCss = tagId
      el.textContent = CSS
      document.head.appendChild(el)
      return () => {
        el.remove()
      }
    }

    // ---------------------------------------------------------------------
    // 输入框通道：模块级共享变量 + 轻提示 store
    //   main 面板是 root 作用域，拿不到 inputActions；所以另开一个**无头**座位
    //   conversation.input.overlay（session 作用域）来吃 setDraft。
    // ---------------------------------------------------------------------

    /** 「交给智能体」按钮把提示词写这里，overlay 座位读走后清空。 */
    let pendingComposerText = null
    const composerListeners = new Set()
    function composerSnapshot() {
      return pendingComposerText
    }
    function subscribeComposer(fn) {
      composerListeners.add(fn)
      return () => {
        composerListeners.delete(fn)
      }
    }
    function setPendingComposerText(text) {
      pendingComposerText = typeof text === 'string' && text.length > 0 ? text : null
      for (const fn of Array.from(composerListeners)) {
        try {
          fn()
        } catch {
          /* 单个订阅者出错不影响其它订阅者 */
        }
      }
    }
    /** 输入框座位是否真的活着（Host/表单变化时可能不存在）。 */
    let composerSeatLive = false

    /** 面板内的轻提示（overlay 是 session 作用域的，它的提示不能挂在 main 里，故走共享 store）。 */
    let toastSeq = 0
    let toastValue = null
    const toastListeners = new Set()
    function toastSnapshot() {
      return toastValue
    }
    function subscribeToast(fn) {
      toastListeners.add(fn)
      return () => {
        toastListeners.delete(fn)
      }
    }
    function toast(message, tone) {
      toastSeq += 1
      toastValue = { id: toastSeq, message: String(message), tone: tone === 'error' ? 'error' : 'info' }
      for (const fn of Array.from(toastListeners)) {
        try {
          fn()
        } catch {
          /* 同上 */
        }
      }
    }
    function clearToast(id) {
      if (toastValue !== null && toastValue.id === id) toastValue = null
    }

    // ---------------------------------------------------------------------
    // HTTP：同源 fetch；变更类 POST + x-logwiki: 1
    // ---------------------------------------------------------------------

    /**
     * 统一取数。**永不 reject**：网络/HTTP/JSON 任何失败都转成 {ok:false}，
     * 让每个区块自己渲染空态/错误态，绝不让面板白屏。
     * @returns {{ok: boolean, status: number, data: any, error: string|null}}
     */
    async function request(path, options) {
      const opts = isObj(options) ? options : {}
      const method = typeof opts.method === 'string' ? opts.method : 'GET'
      const headers = { accept: 'application/json' }
      const init = { method, headers, credentials: 'same-origin' }
      if (method !== 'GET') {
        headers['content-type'] = 'application/json'
        headers['x-logwiki'] = '1'
        init.body = JSON.stringify(isObj(opts.body) ? opts.body : {})
      }
      try {
        const res = await fetch(API + path, init)
        if (!res.ok) {
          let detail = ''
          try {
            const txt = await res.text()
            const parsed = JSON.parse(txt)
            if (isObj(parsed) && typeof parsed.error === 'string') detail = parsed.error
            else if (txt.length > 0) detail = txt.slice(0, 180)
          } catch {
            /* 响应体不是 JSON，忽略 */
          }
          return {
            ok: false,
            status: res.status,
            data: null,
            error: 'HTTP ' + res.status + (detail === '' ? '' : '：' + detail),
          }
        }
        const text = await res.text()
        if (text.length === 0) return { ok: true, status: res.status, data: null, error: null }
        try {
          return { ok: true, status: res.status, data: JSON.parse(text), error: null }
        } catch (e) {
          return { ok: false, status: res.status, data: null, error: '响应不是合法 JSON：' + errText(e) }
        }
      } catch (e) {
        return { ok: false, status: 0, data: null, error: '请求失败：' + errText(e) }
      }
    }

    /** 统一的「端点还没上」判定：404 / 501 都算数据源未就绪。 */
    function notReadyOf(result) {
      return result !== null && result !== undefined && result.ok === false && (result.status === 404 || result.status === 501)
    }

    /** 通用取数 hook：切依赖就重取；卸载后回填的 setState 全部丢弃。 */
    function useFetchData(path, deps) {
      const [state, setState] = useState({ loading: true, result: null })
      const nonce = useRef(0)
      const key = String(path)
      useEffect(() => {
        if (path === null || path === undefined) {
          setState({ loading: false, result: null })
          return undefined
        }
        const mine = (nonce.current += 1)
        let alive = true
        setState((prev) => ({ loading: true, result: prev.result }))
        request(key).then((result) => {
          if (!alive || mine !== nonce.current) return
          setState({ loading: false, result })
        })
        return () => {
          alive = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [key].concat(Array.isArray(deps) ? deps : []))
      return state
    }

    // ---------------------------------------------------------------------
    // 错误边界 + 骨架
    // ---------------------------------------------------------------------

    /** 顶层/区块错误边界：任何渲染异常降级成一段可读文字，绝不让整页白屏。 */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      render() {
        const error = this.state.error
        if (error !== null && error !== undefined) {
          const text = error instanceof Error ? error.message : String(error)
          const label = this.props !== null && this.props !== undefined && typeof this.props.label === 'string' ? this.props.label : 'LogWiki 面板'
          return h('div', { className: 'lw-fallback' }, label + '渲染出错：\n' + text)
        }
        return this.props.children
      }
    }

    function Skeleton(props) {
      const rows = typeof props.rows === 'number' ? props.rows : 3
      const out = []
      for (let i = 0; i < rows; i += 1) {
        out.push(h('div', { key: i, className: 'lw-skel-row lw-skel-w' + ((i % 3) + 1) }))
      }
      return h('div', { className: 'lw-skel', 'aria-busy': true }, out)
    }

    /** 年视图骨架：与 53×7 网格同形（含左侧 24px 星期栏占位）。 */
    function HeatSkeleton() {
      const rows = []
      for (let r = 0; r < 7; r += 1) {
        const cols = [h('div', { key: 'wd', className: 'lw-skel-heat-cell lw-skel-heat-wd', style: { background: 'transparent' } })]
        for (let c = 0; c < 53; c += 1) cols.push(h('div', { key: c, className: 'lw-skel-heat-cell' }))
        rows.push(h('div', { key: r, className: 'lw-skel-heat-row' }, cols))
      }
      return h('div', { className: 'lw-skel-heat', 'aria-busy': true }, rows)
    }

    /** 月视图骨架：与 7×6 日历格同形。 */
    function MonthSkeleton() {
      const out = []
      for (let i = 0; i < 42; i += 1) out.push(h('div', { key: i, className: 'lw-skel-mcell' }))
      return h('div', { className: 'lw-skel-month', 'aria-busy': true }, out)
    }

    /** 台账栏骨架：与 7 行度量表同形。 */
    function LedgerSkeleton(props) {
      const out = []
      for (let i = 0; i < 7; i += 1) {
        out.push(
          h(
            'div',
            { key: i, className: 'lw-ledger-row' },
            h('span', { className: 'lw-skel-row', style: { width: i % 2 === 0 ? 44 : 56, height: 10 } }),
            h('span', { className: 'lw-skel-row', style: { width: 32, height: 10 } }),
          ),
        )
      }
      return h(
        'aside',
        { className: 'lw-ledger', 'aria-label': '年度台账', 'aria-busy': true },
        h('div', { className: 'lw-ledger-title' }, String(props.year) + ' 年'),
        h('div', { className: 'lw-ledger-list' }, out),
      )
    }

    /**
     * 空态：能教人 —— 说明现状 + 怎么开始（extra 里放可点的按钮）。
     * 抽屉里由 CSS 去掉盒子特征（.lw-drawer .lw-empty）。
     */
    function EmptyState(props) {
      return h(
        'div',
        { className: 'lw-empty', role: 'status' },
        props.title !== undefined ? h('div', { className: 'lw-empty-title' }, props.title) : null,
        h('div', null, props.text),
        props.extra !== undefined && props.extra !== null
          ? h('div', { className: props.acts === true ? 'lw-empty-acts' : null, style: props.acts === true ? undefined : { marginTop: 10 } }, props.extra)
          : null,
      )
    }

    /** 端点未就绪 / 出错时的统一降级块，带重试按钮。 */
    function DataUnavailable(props) {
      const result = props.result
      const error = result !== null && result !== undefined && typeof result.error === 'string' ? result.error : '未知错误'
      const ready = notReadyOf(result)
      return h(EmptyState, {
        title: ready ? '数据源未就绪' : '取数失败',
        text: ready
          ? '宿主端点 ' + props.endpoint + ' 还没上（HTTP ' + String(result.status) + '）。界面已就位，等集成方补齐后这里会自动出现内容。'
          : error,
        extra:
          props.onRetry !== undefined
            ? h('button', { type: 'button', className: 'lw-btn lw-tiny', onClick: props.onRetry }, '重试')
            : null,
      })
    }

    // ---------------------------------------------------------------------
    // 左侧栏图标行（sidebar.panellist）：props = { size, active }，内联 SVG
    // ---------------------------------------------------------------------

    function LogWikiIcon(props) {
      const size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 20
      const active = props !== null && props !== undefined && props.active === true
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', opacity: active ? 1 : 0.85 },
        },
        h('rect', { x: 3, y: 4.5, width: 18, height: 16, rx: 2.5 }),
        h('path', { d: 'M3 9.5h18' }),
        h('path', { d: 'M8 3v3M16 3v3' }),
        h('path', { d: 'M7.5 13.5h3M13.5 13.5h3M7.5 17.5h3' }),
      )
    }

    // ---------------------------------------------------------------------
    // 内联 SVG 图标（与 LogWikiIcon 同族：1.6 描边、round 端点、24×24 网格）
    //   取代早先的 Unicode 字形（‹ › ✕ ⚠ ＋）：字形在不同字体下的基线、宽度、
    //   描边粗细都不一致，也没法跟着 currentColor 之外的东西统一。
    // ---------------------------------------------------------------------

    const ICON_PATHS = {
      'chevron-left': ['M14.5 5.5 8 12l6.5 6.5'],
      'chevron-right': ['M9.5 5.5 16 12l-6.5 6.5'],
      close: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
      refresh: ['M20.5 12a8.5 8.5 0 1 1-2.49-6.01', 'M20.5 4.5v5.5h-5.5'],
      plus: ['M12 5.5v13', 'M5.5 12h13'],
      warn: ['M12 4.2 21 19.4H3z', 'M12 10.2v4.4', 'M12 17.4h.01'],
    }

    function Icon(props) {
      const name = props !== null && props !== undefined && typeof props.name === 'string' ? props.name : ''
      const paths = ICON_PATHS[name]
      if (paths === undefined) return null
      const size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 14
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: 'false',
          style: { display: 'block', flex: 'none' },
        },
        paths.map((d, i) => h('path', { key: i, d: d })),
      )
    }

    /** 图标按钮：必须带 aria-label（§8.5）。 */
    function IconButton(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'lw-iconbtn',
          onClick: props.onClick,
          disabled: props.disabled === true,
          title: props.title,
          'aria-label': props.label,
        },
        h(Icon, { name: props.name, size: props.size !== undefined ? props.size : 14 }),
      )
    }


    // ---------------------------------------------------------------------
    // 无头座位：把 pendingComposerText 塞进输入框
    // ---------------------------------------------------------------------

    function ComposerBridge(props) {
      const pending = useSyncExternalStore(subscribeComposer, composerSnapshot, composerSnapshot)
      const actions = props !== null && props !== undefined ? props.inputActions : undefined
      const hasActions = actions !== null && actions !== undefined && typeof actions.setDraft === 'function'
      useEffect(() => {
        if (pending === null) return
        if (!hasActions) {
          // 座位在但拿不到 inputActions：把提示留回 main 面板，由它渲染可复制文本框。
          setPendingComposerText('')
          toast('当前输入框不支持自动填充，请在「周/月总结」里手动复制提示词', 'error')
          return
        }
        try {
          actions.setDraft(pending)
          composerSeatLive = true
          setPendingComposerText('')
          toast('已写入输入框')
        } catch (e) {
          setPendingComposerText('')
          toast('写入输入框失败：' + errText(e), 'error')
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [pending, hasActions])
      // 无头：不渲染任何 DOM。
      return null
    }

    // ---------------------------------------------------------------------
    // Toast（main 面板内渲染，读共享 store）
    // ---------------------------------------------------------------------

    function ToastHost() {
      const value = useSyncExternalStore(subscribeToast, toastSnapshot, toastSnapshot)
      useEffect(() => {
        if (value === null) return undefined
        const timer = setTimeout(() => clearToast(value.id), 2600)
        return () => clearTimeout(timer)
      }, [value])
      if (value === null) return null
      return h('div', { className: 'lw-toast', role: 'status' }, value.message)
    }

    // ---------------------------------------------------------------------
    // 头部：来源筛选 / 指标 / 视图 / 更新
    // ---------------------------------------------------------------------

    function SourceChips(props) {
      const sources = Array.isArray(props.sources) ? props.sources : []
      const selected = props.selected
      const onToggle = props.onToggle
      if (sources.length === 0) return null
      return h(
        'div',
        { className: 'lw-events', role: 'group', 'aria-label': '来源筛选' },
        sources.map((s) => {
          const id = isObj(s) && typeof s.id === 'string' ? s.id : ''
          if (id === '') return null
          const on = selected.has(id)
          const label = isObj(s) && typeof s.label === 'string' && s.label.length > 0 ? s.label : id
          const bad = isObj(s) && (s.lastSyncStatus === 'error' || (typeof s.lastError === 'string' && s.lastError.length > 0))
          return h(
            'button',
            {
              key: id,
              type: 'button',
              className: 'lw-chip' + (on ? ' lw-on' : ''),
              onClick: () => onToggle(id),
              title: bad ? '上次同步失败：' + String(s.lastError) : label,
              'aria-pressed': on,
            },
            // 同步失败：圆点承载状态色，文字仍是 label（浅色下 warn 文字只有 2.15:1）
            bad ? h('i', { className: 'lw-dot lw-dot-warn', 'aria-hidden': true }) : null,
            label,
          )
        }),
        props.onAdd !== undefined
          ? h(
              'button',
              {
                key: '__add-source',
                type: 'button',
                className: 'lw-chip',
                onClick: props.onAdd,
                title: '连接别的 DSH（例如 rocs）—— 远端会话会作为独立来源分区显示',
              },
              h(Icon, { name: 'plus', size: 12 }),
              '添加来源',
            )
          : null,
      )
    }

    /**
     * 「添加 / 管理来源」区块（二期）。
     *
     * 两条登记路径（对应用户需求里"可能会遇到智能体索要信息的情况"）：
     *   · **登记来源** —— 信息齐了就直接落库（走 /source/add）
     *   · **交给智能体** —— 生成提示词写进输入框，由智能体加载 f2a-ssh 去连、
     *     缺信息时用 ask_user_question 问你，最后调 logwiki_import_source 落库
     */
    function SourceDialog(props) {
      const [label, setLabel] = useState('')
      const [alias, setAlias] = useState('')
      const [distro, setDistro] = useState('')
      const [dshHome, setDshHome] = useState('')
      const [days, setDays] = useState('90')
      const [busy, setBusy] = useState(false)
      const [promptText, setPromptText] = useState('')
      const [discover, setDiscover] = useState(null)
      // 删除做两段式确认：不用 window.confirm —— 沙箱/iframe 里可能被拦，且阻塞式弹窗体验更差。
      const [confirming, setConfirming] = useState(null)
      const promptRef = useRef(null)

      useEffect(() => {
        request('/source/discover').then((res) => {
          setDiscover(res.ok === true && isObj(res.data) ? res.data : { available: false, aliases: [] })
        })
      }, [])

      const aliases = discover !== null && Array.isArray(discover.aliases) ? discover.aliases : []
      const missing = []
      if (alias.trim() === '') missing.push('SSH 别名')
      if (dshHome.trim() === '') missing.push('远端 DSH_HOME')

      const payload = () => ({
        label: label.trim() === '' ? alias.trim() : label.trim(),
        sshAlias: alias.trim(),
        dshHome: dshHome.trim(),
        wslDistro: distro.trim(),
        sinceDays: Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : 90,
      })

      const add = () => {
        setBusy(true)
        request('/source/add', { method: 'POST', body: payload() }).then((res) => {
          setBusy(false)
          if (res.ok === true) {
            toast('来源已登记')
            setLabel('')
            props.onChanged()
          } else {
            toast('登记失败：' + String(res.error || '未知错误'), 'error')
          }
        })
      }

      const askAgent = () => {
        setBusy(true)
        request('/source/prompt', { method: 'POST', body: payload() }).then((res) => {
          setBusy(false)
          if (res.ok === true && isObj(res.data) && typeof res.data.prompt === 'string') {
            setPromptText(res.data.prompt)
            setPendingComposerText(res.data.prompt)
          } else {
            toast('生成提示词失败：' + String(res.error || '未知错误'), 'error')
          }
        })
      }

      const field = (key, value, setter, placeholder, list) =>
        h(
          'label',
          { className: 'lw-field-label', key: key },
          h('span', { className: 'lw-flabel' }, key),
          list === undefined
            ? h('input', { className: 'lw-field', value: value, placeholder: placeholder, onChange: (e) => setter(e.target.value) })
            : h(
                'span',
                { style: { display: 'flex', gap: 6, flex: 1, minWidth: 0 } },
                h('input', {
                  className: 'lw-field',
                  value: value,
                  placeholder: placeholder,
                  list: 'lw-ssh-aliases',
                  onChange: (e) => setter(e.target.value),
                  style: { flex: 1 },
                }),
                h(
                  'datalist',
                  { id: 'lw-ssh-aliases' },
                  aliases.map((a) => h('option', { key: a, value: a })),
                ),
              ),
        )

      const remote = Array.isArray(props.rows) ? props.rows.filter((s) => isObj(s) && s.kind === 'remote') : []

      return h(
        'div',
        { className: 'lw-digest' },
        h(
          'div',
          { className: 'lw-digest-head' },
          h('span', { className: 'lw-digest-title' }, '添加来源'),
          h(
            'span',
            { className: 'lw-meta' },
            discover === null
              ? '正在探测 WSL…'
              : discover.available === true
                ? `WSL 可用${aliases.length > 0 ? ' · ~/.ssh/config 里有：' + aliases.join('、') : ' · 未发现 ssh 别名'}`
                : 'WSL 不可用：' + String(discover.error || '未知原因'),
          ),
          h('span', { className: 'lw-spacer' }),
          h('button', { type: 'button', className: 'lw-btn lw-tiny lw-bare', onClick: props.onClose }, '收起'),
        ),
        h(
          'div',
          { className: 'lw-digest-body' },
          h('div', { className: 'lw-meta lw-wrap' }, '连接别的 DSH（例如 rocs）。远端会话会作为独立来源分区出现在日历里，与本机分开。'),
          field('名称', label, setLabel, '短名称，例如 rocs'),
          field('SSH 别名（WSL ~/.ssh/config）', alias, setAlias, '例如 rocs', true),
          field('WSL 发行版（留空用默认）', distro, setDistro, '例如 Ubuntu'),
          field('远端 DSH_HOME（绝对路径）', dshHome, setDshHome, '例如 /home/<用户名>/.dsh'),
          field('回填天数', days, setDays, '90'),
          missing.length > 0
            ? h(
                'div',
                { className: 'lw-meta lw-wrap' },
                '还缺：' +
                  missing.join('、') +
                  ' —— 可以自己填，也可以点「交给智能体」，让它加载 f2a-ssh 去连、缺什么就用提问工具问你。',
              )
            : null,
          h(
            'div',
            { className: 'lw-form-row', style: { justifyContent: 'flex-end' } },
            // 主操作：品牌底 + 配套前景
            h('button', { type: 'button', className: 'lw-btn lw-primary', onClick: add, disabled: busy === true || missing.length > 0 }, busy === true ? '处理中…' : '登记来源'),
            h('button', { type: 'button', className: 'lw-btn', onClick: askAgent, disabled: busy === true }, busy === true ? '处理中…' : '交给智能体'),
          ),
          promptText.length > 0
            ? h(
                'div',
                null,
                h('div', { className: 'lw-meta lw-wrap' }, '提示词（已尝试写入输入框；没成功就手动复制到会话里发送）'),
                h('textarea', { className: 'lw-promptbox', ref: promptRef, value: promptText, readOnly: true, onFocus: (e) => e.target.select() }),
                h(
                  'div',
                  { className: 'lw-form-row', style: { justifyContent: 'flex-end' } },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'lw-btn lw-tiny',
                      onClick: () => {
                        if (promptRef.current !== null) promptRef.current.select()
                        try {
                          document.execCommand('copy')
                          toast('已复制')
                        } catch (e) {
                          toast('复制失败，请手动选择', 'error')
                        }
                      },
                    },
                    '复制',
                  ),
                  h('button', { type: 'button', className: 'lw-btn lw-tiny', onClick: () => setPromptText('') }, '关闭提示词'),
                ),
              )
            : null,
        ),
        // 无远程来源时不渲染分组头（不留空标题）；有来源时每来源一行
        remote.map((s) => {
          const failed = s.lastSyncStatus === 'error' || (typeof s.lastError === 'string' && s.lastError.length > 0)
          return h(
            'div',
            { className: 'lw-src-line', key: s.id, style: { padding: '8px 12px', margin: 0 } },
            h('span', { className: 'lw-pill' }, s.label),
            h('span', { className: 'lw-meta' }, `会话 ${s.sessionCount ?? 0} · 条目 ${s.entryCount ?? 0}`),
            failed
              ? h(
                  'span',
                  { className: 'lw-meta lw-bad' },
                  h('i', { className: 'lw-dot lw-dot-warn', 'aria-hidden': true }),
                  String(s.lastError || '上次同步失败'),
                )
              : h('span', { className: 'lw-meta' }, s.lastSyncStatus === 'ok' ? '已同步' : s.lastSyncStatus === 'partial' ? '部分失败' : '未同步'),
            h('span', { className: 'lw-spacer' }),
            h(
              'button',
              { type: 'button', className: 'lw-btn lw-tiny', onClick: () => props.onSync(s.id), disabled: props.syncing === true },
              props.syncing === true ? '同步中…' : '同步',
            ),
            // 两段式删除：第一次点变「确认删除？」，第二次才执行（不用 window.confirm）
            h(
              'button',
              {
                type: 'button',
                className: 'lw-btn lw-tiny' + (confirming === s.id ? ' lw-bad' : ''),
                onClick: () => {
                  if (confirming === s.id) {
                    setConfirming(null)
                    props.onDelete(s.id)
                  } else {
                    setConfirming(s.id)
                  }
                },
              },
              confirming === s.id ? '确认删除？' : '删除',
            ),
          )
        }),
      )
    }

    function Segmented(props) {
      const options = Array.isArray(props.options) ? props.options : []
      const value = props.value
      const onChange = props.onChange
      return h(
        'div',
        { className: 'lw-group', role: 'group', 'aria-label': props.label },
        options.map((opt) =>
          h(
            'button',
            {
              key: opt.value,
              type: 'button',
              className: 'lw-btn' + (opt.value === value ? ' lw-on' : ''),
              onClick: () => onChange(opt.value),
              'aria-pressed': opt.value === value,
            },
            opt.label,
          ),
        ),
      )
    }

    function Header(props) {
      const s = props
      return h(
        'div',
        { className: 'lw-head' + (s.twoRow === true ? ' lw-head-2row' : '') },
        // 第一段：标题 + 版本/连接徽章 + 年份导航
        h(
          'div',
          { className: 'lw-head-seg' },
          h('span', { className: 'lw-title' }, '任务日历'),
          s.version !== null ? h('span', { className: 'lw-ver' }, 'v' + s.version) : null,
          s.pingFailed === true
            ? h('span', { className: 'lw-ver lw-bad' }, '宿主不可达')
            : s.version !== null
              ? // 「已连接」的语义由文字承载；绿点只是装饰性强化（非唯一信息通道）
                h(
                  'span',
                  { className: 'lw-conn' },
                  h('i', { className: 'lw-dot', 'aria-hidden': true }),
                  '已连接',
                )
              : null,
          h(
            'div',
            { className: 'lw-group', 'aria-label': '年份' },
            h(IconButton, { name: 'chevron-left', label: '上一年', title: '上一年', onClick: () => s.onYear(s.year - 1) }),
            h('span', { className: 'lw-meta', style: { padding: '0 6px' } }, String(s.year)),
            h(IconButton, { name: 'chevron-right', label: '下一年', title: '下一年', onClick: () => s.onYear(s.year + 1) }),
          ),
        ),
        // 第二段：视图 / 指标 / 来源筛选 / 主操作 / 简报
        h(
          'div',
          { className: 'lw-head-seg lw-head-seg2' },
          h(Segmented, {
            label: '视图',
            value: s.view,
            onChange: s.onView,
            options: [
              { value: 'year', label: '年' },
              { value: 'month', label: '月' },
            ],
          }),
          // <900px：指标退回 <select>（同一份 METRICS / METRIC_LABEL）
          s.compactMetric === true
            ? h(
                'select',
                {
                  className: 'lw-field',
                  value: s.metric,
                  onChange: (e) => s.onMetric(e.target.value),
                  'aria-label': '指标',
                  title: '热力图指标',
                },
                METRICS.map((m) => h('option', { key: m, value: m }, METRIC_LABEL[m])),
              )
            : h(Segmented, {
                label: '指标',
                value: s.metric,
                onChange: s.onMetric,
                options: METRICS.map((m) => ({ value: m, label: METRIC_LABEL[m] })),
              }),
          h(SourceChips, { sources: s.sources, selected: s.selectedSources, onToggle: s.onToggleSource, onAdd: s.onAddSource }),
          h('span', { className: 'lw-spacer' }),
          s.connState === 'open' ? h('span', { className: 'lw-meta', title: '进度通道已连接' }, '实时') : null,
          // 主操作：品牌底 + 配套前景（C15 就是按 title 前缀取这个按钮采样）
          h(
            'button',
            {
              type: 'button',
              className: 'lw-btn lw-primary',
              onClick: s.onRefresh,
              disabled: s.refreshing === true,
              title: '增量扫描会话日志并重算摘要',
            },
            s.refreshing === true ? '更新中…' : '更新',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'lw-btn',
              onClick: () => s.onDigest('week'),
              disabled: s.digestBusy === true,
              title: '本周简报',
            },
            '周总结',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'lw-btn',
              onClick: () => s.onDigest('month'),
              disabled: s.digestBusy === true,
              title: '本月简报',
            },
            '月总结',
          ),
        ),
      )
    }

    /**
     * SSE 进度条 / 回填横幅：没有真的在进行中的工作就整块不渲染。
     *
     * ⚠️ 两个踩过的坑：
     *   1. SSE 首帧是 `{phase:'idle', finished:true}`，早先的写法让它落到 phaseText 的
     *      默认值「处理」，于是面板顶上常驻一条「处理 0」横幅 → 只渲染真的在进行中的相位。
     *   2. `/health` 的 scan 初值是 `{started:false, done:false, ...}`（fold.js EMPTY_SCAN），
     *      只看 `done === false` 同样会常驻一条「正在回填历史… 0 个会话」→ 必须要求
     *      `started === true`（并再兜一道"确实有量"的判断）。
     */
    function ScanBanner(props) {
      const scan = props.scan
      const progress = props.progress
      if (isObj(progress) && progress.finished !== true && typeof progress.phase === 'string' && progress.phase !== 'idle') {
        const done = toNum(progress.done)
        const total = toNum(progress.total)
        const phaseText = { scan: '扫描会话', summarize: '生成摘要', digest: '生成简报', remote: '同步远程来源' }[progress.phase]
        if (phaseText === undefined) return null
        return h(
          'div',
          { className: 'lw-banner', role: 'status' },
          h('i', { className: 'lw-dot lw-dot-warn', 'aria-hidden': true }),
          h('span', null, phaseText + ' ' + done + (total > 0 ? '/' + total : '') + (typeof progress.current === 'string' && progress.current.length > 0 ? ' · ' + progress.current : '')),
          toNum(progress.errors) > 0 ? h('span', null, '· ' + toNum(progress.errors) + ' 处失败') : null,
        )
      }
      if (progress === false && props.refreshing === true) {
        return h('div', { className: 'lw-progress', 'aria-label': '正在更新' }, h('i', null))
      }
      if (isObj(scan) && scan.started === true && scan.done !== true && (toNum(scan.total) > 0 || toNum(scan.scanned) > 0)) {
        return h(
          'div',
          { className: 'lw-banner', role: 'status' },
          h('i', { className: 'lw-dot lw-dot-warn', 'aria-hidden': true }),
          h('span', null, '正在回填历史… ' + toNum(scan.scanned) + (toNum(scan.total) > 0 ? '/' + toNum(scan.total) : '') + ' 个会话'),
          toNum(scan.failed) > 0 ? h('span', null, '· 失败 ' + toNum(scan.failed)) : null,
        )
      }
      return null
    }

    // ---------------------------------------------------------------------
    // 年视图：53 列 × 7 行热力图（列宽按容器实测自适应）+ 年度台账栏
    // ---------------------------------------------------------------------

    const COL = 53
    const GAP = 3
    const CELL_MIN = 8
    const CELL_MAX = 22
    const WDCOL = 24      // 星期栏宽；<700px 时整列隐藏，公式里的「星期栏」项归零
    const GRID_TOP = 20   // 月份轴 18px + 2px 间隙
    const LEVEL_PCT = [0, 25, 45, 68, 100]
    // 月视图格子背景的档位（中性色百分比）：绿色只留给底部强度条（§1.3 R1），
    // 且最深一档也必须让 label-secondary 文字保持 ≥4.5:1 对比度（§2.7）。
    const MLEVEL_PCT = [0, 3, 6, 10]

    /**
     * 实测容器宽度（ResizeObserver）。**不能**拿 window.innerWidth 减常数推导——
     * 主区宽度还受侧栏、台账栏、抽屉影响，只能用被观察元素的内容盒宽度。
     */
    function useMeasuredWidth(ref) {
      const [width, setWidth] = useState(0)
      useEffect(() => {
        const el = ref.current
        if (el === null || el === undefined) return undefined
        const apply = (w) => {
          if (!Number.isFinite(w) || w <= 0) return
          setWidth((cur) => (Math.abs(cur - w) < 0.5 ? cur : w))
        }
        apply(el.getBoundingClientRect().width)
        if (typeof window === 'undefined' || typeof window.ResizeObserver !== 'function') {
          const onResize = () => apply(el.getBoundingClientRect().width)
          window.addEventListener('resize', onResize)
          return () => window.removeEventListener('resize', onResize)
        }
        const ro = new window.ResizeObserver((entries) => {
          for (const entry of entries) {
            const box = entry.contentRect
            apply(box !== undefined && box !== null ? box.width : el.getBoundingClientRect().width)
          }
        })
        ro.observe(el)
        return () => ro.disconnect()
      }, [ref])
      return width
    }

    /** 视口宽度：DESIGN §2.9 的四档断点按视口判定。 */
    function useViewportWidth() {
      const [w, setW] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth))
      useEffect(() => {
        if (typeof window === 'undefined') return undefined
        const onResize = () => setW(window.innerWidth)
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])
      return w
    }

    function Heatmap(props) {
      const year = props.year
      const days = props.days
      const thresholds = props.thresholds
      const metric = props.metric
      const selected = props.selectedDate
      const today = todayKey()
      const narrow = props.narrow === true          // <700px：隐藏活动索引
      const recentList = Array.isArray(props.recent) ? props.recent : []
      const gridRef = useRef(null)
      const measured = useMeasuredWidth(gridRef)
      const cellRefs = useRef(new Map())
      const [focusKey, setFocusKey] = useState(null)

      const weeks = useMemo(() => {
        const start = startOfWeek(new Date(year, 0, 1))
        const out = []
        for (let w = 0; w < 53; w += 1) {
          const col = []
          for (let d = 0; d < 7; d += 1) col.push(addDays(start, w * 7 + d))
          out.push(col)
        }
        return out
      }, [year])

      // ---- 自适应列宽（§3.2）-------------------------------------------------
      // 列宽 = clamp((容器宽 − 星期栏 − GAP×(53−1)) / 53, 8, 22)
      // 行高 = 列宽 + GAP；网格宽 = 53×列宽 + 52×GAP（恒等于可用宽 → 宽窗不出现横向滚动）
      // 关键数字：格子触底时网格宽 = 53×8 + 52×3 = 580px；加星期栏 24px = 604px，
      // 即容器 < 604px 时**必然**出现横向滚动，≥ 604px 且未触顶时**必然**没有。
      const wdcolW = narrow ? 0 : WDCOL
      const raw = measured > 0 ? (measured - wdcolW - GAP * (COL - 1)) / COL : CELL_MIN
      const cell = Math.max(CELL_MIN, Math.min(CELL_MAX, Math.floor(raw * 100) / 100))
      const rowH = cell + GAP
      const gridW = COL * cell + (COL - 1) * GAP
      const gridH = 7 * rowH - GAP
      const barH = 6
      const barTop = GRID_TOP + gridH + 8
      const heatH = GRID_TOP + gridH + 8 + barH
      const radius = cell < 16 ? 2 : undefined

      // 月份轴标签（§3.4）：**该列包含某月 1 号**时给那一列打该月标签（这样 12 个月
      // 各出现一次，第 1 列也会正确地标成 1 月而不是上一年 12 月）；再按碰撞规则
      // 从左往右渲染 —— 与前一个已渲染标签的左边缘距离不足 30px 就跳过。
      const monthLabels = useMemo(() => {
        const out = []
        let lastLeft = -Infinity
        for (let w = 0; w < weeks.length; w += 1) {
          let mon = -1
          for (let d = 0; d < 7; d += 1) {
            const date = weeks[w][d]
            if (date.getFullYear() === year && date.getDate() === 1) mon = date.getMonth()
          }
          if (mon < 0) continue
          const left = w * rowH
          if (left - lastLeft < 30) continue
          lastLeft = left
          out.push({ week: w, left: left, label: MONTH_LABEL[mon] })
        }
        return out
      }, [weeks, rowH, year])

      // roving tabindex（§8.1.4）：任何时刻只有 1 个格子 tabindex=0。
      // 初始落在今天（不在本年则落 1 月 1 日）；选中变化后焦点格跟随选中格。
      // 这里**不做**任何初始滚动位 hack：列宽自适应后网格本来就不溢出。
      const defaultFocus = useMemo(() => {
        const d = fromDateKey(today)
        return d !== null && d.getFullYear() === year ? today : year + '-01-01'
      }, [today, year])
      useEffect(() => {
        setFocusKey(defaultFocus)
      }, [defaultFocus])
      useEffect(() => {
        if (typeof selected === 'string' && selected.length > 0) setFocusKey(selected)
      }, [selected])
      const focusDate = useMemo(() => {
        if (typeof focusKey === 'string') {
          const d = fromDateKey(focusKey)
          if (d !== null && d.getFullYear() === year) return focusKey
        }
        return defaultFocus
      }, [focusKey, year, defaultFocus])

      const moveFocus = useCallback((key) => {
        setFocusKey(key)
        const node = cellRefs.current.get(key)
        if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus()
      }, [])

      // 换年（PageUp / PageDown）后，被聚焦的那个格子会随旧年一起消失，浏览器焦点掉回 body。
      // 用 ref 记住「这次换年是键盘发起的」，等新年渲染完再把焦点落到新年对应的格子上
      // （defaultFocus 此时已按新年算出）。不用无条件的 useEffect([year])，免得点年份按钮
      // 或首屏挂载时抢走焦点（§8.3：不抢焦点）。
      const wantGridFocusRef = useRef(false)
      useEffect(() => {
        if (wantGridFocusRef.current !== true) return
        wantGridFocusRef.current = false
        const node = cellRefs.current.get(focusDate)
        if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus()
      }, [year, focusDate])

      /** 方向键（§8.1.5）：←/→ 上一周/下一周，↑/↓ 上一日/下一日，Home/End 行首行尾，PageUp/Down 换年。 */
      const onCellKeyDown = useCallback(
        (ev) => {
          const cur = ev.currentTarget
          const c = Number(cur.getAttribute('aria-colindex')) - 1
          const r = Number(cur.getAttribute('aria-rowindex')) - 1
          const keyAt = (cc, rr) => {
            if (cc < 0 || cc >= COL || rr < 0 || rr >= 7) return null
            const date = weeks[cc][rr]
            return date.getFullYear() === year ? dateKeyOf(date) : null
          }
          let next = null
          if (ev.key === 'ArrowLeft') next = keyAt(c - 1, r)
          else if (ev.key === 'ArrowRight') next = keyAt(c + 1, r)
          else if (ev.key === 'ArrowUp') next = keyAt(c, r - 1)
          else if (ev.key === 'ArrowDown') next = keyAt(c, r + 1)
          else if (ev.key === 'Home') {
            for (let i = 0; i < COL && next === null; i += 1) next = keyAt(i, r)
          } else if (ev.key === 'End') {
            for (let i = COL - 1; i >= 0 && next === null; i -= 1) next = keyAt(i, r)
          } else if (ev.key === 'PageUp') {
            ev.preventDefault()
            wantGridFocusRef.current = true
            props.onYear(year - 1)
            return
          } else if (ev.key === 'PageDown') {
            ev.preventDefault()
            wantGridFocusRef.current = true
            props.onYear(year + 1)
            return
          } else {
            return
          }
          ev.preventDefault()
          if (next !== null) moveFocus(next) // 越界夹住不循环
        },
        [weeks, year, moveFocus, props],
      )

      const cells = []
      for (let w = 0; w < weeks.length; w += 1) {
        for (let d = 0; d < 7; d += 1) {
          const date = weeks[w][d]
          const key = dateKeyOf(date)
          const inYear = date.getFullYear() === year
          const rec = days.get(key)
          const value = rec === undefined ? 0 : toNum(rec.value)
          const level = inYear ? heatLevel(value, thresholds) : 0
          const pct = LEVEL_PCT[level]
          const sessions = rec === undefined ? 0 : toNum(rec.sessions)
          const entries = rec === undefined ? 0 : toNum(rec.entries)
          const degraded = rec !== undefined && rec.degraded === true
          const tip =
            key +
            '\n' +
            METRIC_LABEL[metric] +
            '：' +
            fmtNum(value) +
            '\n会话：' +
            sessions +
            '\n条目：' +
            entries +
            (degraded ? '\n（该天摘要降级）' : '')
          cells.push(
            h('button', {
              key: key,
              ref: (node) => {
                if (node === null) cellRefs.current.delete(key)
                else cellRefs.current.set(key, node)
              },
              type: 'button',
              role: 'gridcell',
              'aria-rowindex': d + 1,
              'aria-colindex': w + 1,
              tabIndex: key === focusDate ? 0 : -1,
              disabled: inYear === false,
              className: 'lw-cell',
              style: { left: w * rowH, top: d * rowH, width: cell, height: cell, borderRadius: radius, '--lw-pct': pct + '%' },
              'data-selected': key === selected ? '1' : '0',
              'data-today': key === today ? '1' : '0',
              'data-degraded': degraded ? '1' : '0',
              title: tip,
              'aria-label': tip.replace(/\n/g, '，'),
              onClick: () => props.onPick(key),
              onKeyDown: onCellKeyDown,
            }),
          )
        }
      }

      // 月份活动条：与网格同 x 轴（左缘 = 该月第一周列的 left），高度按当月量。
      // 中性色 —— 绿色只留给热力图色阶与月视图强度条。
      //
      // ⚠️ 分桶按**日历月**（逐日 getMonth），不按列：一列可能同时含 1 月与 2 月的日子，
      // 按列累加会把 2/1 的值算进 1 月，导致每段的数值与「落在这个月内的天数之和」对不上
      // （与月视图 header 的数字也会不一致）。x 轴仍沿用月份轴约定：段的左右边界落在
      // 「含该月 1 号的那一列」，与 .lw-heat-months 的标签同位。
      const monthBars = useMemo(() => {
        const firstCol = new Array(12).fill(-1)
        for (let w = 0; w < weeks.length; w += 1) {
          for (let d = 0; d < 7; d += 1) {
            const date = weeks[w][d]
            if (date.getFullYear() === year && date.getDate() === 1) firstCol[date.getMonth()] = w
          }
        }
        const totals = new Array(12).fill(0)
        const actives = new Array(12).fill(0)
        for (const [key, rec] of days.entries()) {
          const d = fromDateKey(key)
          if (d === null || d.getFullYear() !== year) continue
          const m = d.getMonth()
          totals[m] += toNum(rec.value)
          if (rec.turns > 0 || rec.entries > 0 || rec.sessions > 0) actives[m] += 1
        }
        const out = []
        let peak = 0
        for (let m = 0; m < 12; m += 1) {
          if (firstCol[m] < 0) continue
          let end = COL
          for (let k = m + 1; k < 12; k += 1) {
            if (firstCol[k] >= 0) {
              end = firstCol[k]
              break
            }
          }
          if (totals[m] > peak) peak = totals[m]
          out.push({
            month: m,
            left: firstCol[m] * rowH,
            width: Math.max(4, (end - firstCol[m]) * rowH - GAP),
            total: totals[m],
            activeDays: actives[m],
          })
        }
        return { segs: out, peak: peak }
      }, [weeks, days, rowH, year])

      const legend = h(
        'div',
        { className: 'lw-cell-legend' },
        h('span', { className: 'lw-meta' }, '少'),
        [0, 1, 2, 3, 4].map((lv) => h('span', { key: lv, className: 'lw-legend-cell', style: { '--lw-pct': LEVEL_PCT[lv] + '%' } })),
        h('span', { className: 'lw-meta' }, '多'),
      )

      return h(
        'div',
        { className: 'lw-heatwrap' },
        h(
          'div',
          { className: 'lw-heatgrid', ref: gridRef },
          // 活动索引 = 月份轴 + 星期栏 + 档位图例；<700px 三者全部隐藏，只留网格本身
          narrow
            ? null
            : h(
                'div',
                { className: 'lw-wdcol', style: { paddingTop: GRID_TOP } },
                WD_LABEL.map((w) => h('div', { key: w, className: 'lw-wd', style: { height: rowH } }, w)),
              ),
          h(
            'div',
            { className: 'lw-scroll' },
            h(
              'div',
              { className: 'lw-heat', style: { width: gridW, height: heatH } },
              narrow
                ? null
                : h(
                    'div',
                    { className: 'lw-heat-months', style: { width: gridW } },
                    monthLabels.map((m) => h('span', { key: m.week, className: 'lw-heat-month', style: { left: m.left } }, m.label)),
                  ),
              h(
                'div',
                {
                  className: 'lw-heat-cells',
                  role: 'grid',
                  'aria-label': year + ' 年活动热力图',
                  'aria-rowcount': 7,
                  'aria-colcount': COL,
                  style: { position: 'relative', top: GRID_TOP, width: gridW, height: gridH },
                },
                cells,
              ),
              narrow
                ? null
                : h(
                    'div',
                    { className: 'lw-monthbar', style: { top: barTop, width: gridW, height: barH } },
                    monthBars.segs.map((m) =>
                      h(
                        'button',
                        {
                          key: m.month,
                          type: 'button',
                          className: 'lw-mbar-seg',
                          // data-month 是回归判据：每段的归属月必须与「按日历月分桶」一致
                          'data-month': m.month + 1,
                          'data-days': m.activeDays,
                          style: { left: m.left, width: m.width },
                          title:
                            m.month +
                            1 +
                            ' 月 · ' +
                            fmtNum(m.total) +
                            ' ' +
                            METRIC_LABEL[metric] +
                            ' · ' +
                            m.activeDays +
                            ' 天有活动（点开该月视图）',
                          'aria-label':
                            year + ' 年 ' + (m.month + 1) + ' 月活动 ' + fmtNum(m.total) + ' ' + METRIC_LABEL[metric] + '，' + m.activeDays + ' 天有活动，点开该月视图',
                          onClick: () => props.onMonth(new Date(year, m.month, 1)),
                        },
                        h('i', {
                          style: {
                            height: monthBars.peak > 0 && m.total > 0 ? Math.max(2, Math.round((m.total / monthBars.peak) * barH)) : 0,
                          },
                        }),
                      ),
                    ),
                  ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'lw-heat-foot' },
          h('span', { className: 'lw-meta' }, String(year) + ' 年 · ' + fmtNum(props.total) + ' ' + METRIC_LABEL[metric] + ' · ' + props.activeDays + ' 个活跃日'),
          h('span', { className: 'lw-spacer' }),
          narrow ? null : legend,
        ),
        // <700px：台账栏与活动索引都不在，把「近期活动」放到网格下方，别留一片空白
        narrow && recentList.length > 0
          ? h(
              'div',
              { className: 'lw-heat-recent' },
              h('span', { className: 'lw-meta' }, '近期活动'),
              recentList.map((r) =>
                h(
                  'button',
                  { key: r.date, type: 'button', className: 'lw-recent', onClick: () => props.onPick(r.date), title: r.date + ' · ' + r.hint },
                  h('span', { className: 'lw-recent-d' }, r.date.slice(5)),
                  h('span', { className: 'lw-recent-v' }, r.text),
                ),
              ),
            )
          : null,
        // 空态：能教人 —— 说明现状 + 怎么开始（内联「更新」）
        props.activeDays === 0
          ? h(
              'div',
              { className: 'lw-heat-note', role: 'status' },
              h('span', null, '这一年还没有记录：' + year + ' 年的会话日志里没有任何活动。点「更新」先回填历史 —— 它会增量扫描会话日志并重算摘要。'),
              h(
                'button',
                { type: 'button', className: 'lw-btn lw-tiny lw-primary', onClick: props.onRefresh, disabled: props.refreshing === true },
                props.refreshing === true ? '更新中…' : '更新',
              ),
            )
          : null,
      )
    }

    /**
     * 年度台账栏（§3.5）：低对齐度度量表 —— 没有大数字 hero、没有渐变、没有阴影，
     * 数值 ≤14px 且字重 ≤500。数据全部由已加载的 /state 客户端派生（**不新增端点**）。
     * band=true 时退成主区下方的一行汇总带（900–1080px）。
     */
    function Ledger(props) {
      const rows = Array.isArray(props.rows) ? props.rows : []
      const recent = Array.isArray(props.recent) ? props.recent : []
      const band = props.band === true
      return h(
        'aside',
        {
          className: 'lw-ledger' + (band ? ' lw-ledger-band' : ''),
          'aria-label': '年度台账',
        },
        h('div', { className: 'lw-ledger-title' }, props.title),
        h(
          'div',
          { className: 'lw-ledger-list' },
          rows.map((r) =>
            h(
              'div',
              { className: 'lw-ledger-row', key: r.label, title: typeof r.hint === 'string' ? r.hint : r.label },
              h('span', { className: 'lw-ledger-k' }, r.label),
              h('span', { className: 'lw-ledger-v' }, r.value),
            ),
          ),
        ),
        // 近期活动索引：点一行就打开那天的抽屉
        recent.length === 0
          ? null
          : h(
              'div',
              { className: 'lw-ledger-sec' },
              h('div', { className: 'lw-ledger-sub' }, '近期活动'),
              recent.map((r) =>
                h(
                  'button',
                  {
                    key: r.date,
                    type: 'button',
                    className: 'lw-recent',
                    onClick: () => props.onPick(r.date),
                    title: r.date + ' · ' + r.hint,
                  },
                  h('span', { className: 'lw-recent-d' }, r.date.slice(5)),
                  h('span', { className: 'lw-recent-v' }, r.text),
                ),
              ),
            ),
      )
    }

    // ---------------------------------------------------------------------
    // 月视图：格子吃满面板高度 + 量纲双通道（背景档位 / 底部 3px 强度条）
    // ---------------------------------------------------------------------

    function MonthView(props) {
      const monthDate = props.monthDate
      const year = monthDate.getFullYear()
      const month = monthDate.getMonth()
      const days = props.days
      const thresholds = props.thresholds
      const metric = props.metric
      const today = todayKey()
      const gridRef = useRef(null)

      const cells = useMemo(() => {
        const first = new Date(year, month, 1)
        const gridStart = startOfWeek(first)
        const out = []
        for (let i = 0; i < 42; i += 1) out.push(addDays(gridStart, i))
        return out
      }, [year, month])

      const max = useMemo(() => {
        let m = 0
        for (const d of cells) {
          const rec = days.get(dateKeyOf(d))
          if (rec !== undefined) m = Math.max(m, toNum(rec.value))
        }
        return m
      }, [cells, days])

      /** 方向键（§8.2）：±1 格 / ±7 格，Home/End 行首行尾，PageUp/Down 换月。 */
      const onKey = (ev, idx) => {
        let delta = null
        if (ev.key === 'ArrowLeft') delta = -1
        else if (ev.key === 'ArrowRight') delta = 1
        else if (ev.key === 'ArrowUp') delta = -7
        else if (ev.key === 'ArrowDown') delta = 7
        else if (ev.key === 'Home') delta = -(idx % 7)
        else if (ev.key === 'End') delta = 6 - (idx % 7)
        else if (ev.key === 'PageUp') {
          ev.preventDefault()
          props.onMonth(new Date(year, month - 1, 1))
          return
        } else if (ev.key === 'PageDown') {
          ev.preventDefault()
          props.onMonth(new Date(year, month + 1, 1))
          return
        } else {
          return
        }
        ev.preventDefault()
        const next = idx + delta
        if (next < 0 || next > 41) return
        const host = gridRef.current
        if (host === null || host === undefined) return
        const nodes = host.querySelectorAll('.lw-mcell')
        const node = nodes[next]
        if (node !== undefined && node !== null && typeof node.focus === 'function') node.focus()
      }

      return h(
        'div',
        { className: 'lw-month' },
        // 第一行：周一…周日（12px）
        h(
          'div',
          { className: 'lw-mgrid lw-mhead' },
          WD_LABEL.map((w) => h('div', { key: w, className: 'lw-mwd' }, '周' + w)),
        ),
        // 第二行：42 个格子，行高 minmax(64px,1fr) 吃掉面板剩下的高度
        h(
          'div',
          {
            className: 'lw-mgrid lw-mbody',
            ref: gridRef,
            role: 'grid',
            'aria-label': year + ' 年 ' + (month + 1) + ' 月',
            'aria-rowcount': 6,
            'aria-colcount': 7,
          },
          cells.map((d, i) => {
            const key = dateKeyOf(d)
            const rec = days.get(key)
            const value = rec === undefined ? 0 : toNum(rec.value)
            const entries = rec === undefined ? 0 : toNum(rec.entries)
            const sessions = rec === undefined ? 0 : toNum(rec.sessions)
            const out = d.getMonth() !== month
            const degraded = rec !== undefined && rec.degraded === true
            // 量纲通道①：背景按分位档位着中性色（绿色只留给强度条）
            const pct = MLEVEL_PCT[heatLevel(value, thresholds)]
            // 量纲通道②：底部 3px 条按**本月峰值**
            const strip = max > 0 && value > 0 ? Math.max(4, Math.round((value / max) * 100)) : 0
            const tip =
              key +
              '\n' +
              METRIC_LABEL[metric] +
              '：' +
              fmtNum(value) +
              '\n会话：' +
              sessions +
              '\n条目：' +
              entries +
              (degraded ? '\n（该天摘要降级）' : '')
            return h(
              'button',
              {
                key: key,
                type: 'button',
                role: 'gridcell',
                'aria-rowindex': Math.floor(i / 7) + 1,
                'aria-colindex': (i % 7) + 1,
                className: 'lw-mcell',
                style: { '--lw-pct': pct + '%' },
                'data-out': out ? '1' : '0',
                'data-selected': key === props.selectedDate ? '1' : '0',
                'data-today': key === today ? '1' : '0',
                'data-degraded': degraded ? '1' : '0',
                title: tip,
                'aria-label': tip.replace(/\n/g, '，'),
                onClick: () => props.onPick(key),
                onKeyDown: (ev) => onKey(ev, i),
              },
              h('span', { className: 'lw-mnum' }, String(d.getDate())),
              h('span', { className: 'lw-mval' + (value > 0 ? '' : ' lw-zero') }, value > 0 ? fmtNum(value) + ' ' + METRIC_LABEL[metric] : '—'),
              entries > 0 ? h('span', { className: 'lw-mcnt' }, entries + ' 条') : null,
              h('span', { className: 'lw-mstrip', 'aria-hidden': true }, h('i', { style: { width: strip + '%' } })),
            )
          }),
        ),
      )
    }

    function MonthHeader(props) {
      const d = props.monthDate
      const thisMonth = new Date()
      const atThisMonth = d.getFullYear() === thisMonth.getFullYear() && d.getMonth() === thisMonth.getMonth()
      return h(
        'div',
        { className: 'lw-month-head' },
        h(
          'button',
          { type: 'button', className: 'lw-btn lw-tiny lw-bare', onClick: () => props.onMonth(new Date(d.getFullYear(), d.getMonth() - 1, 1)), title: '上一月' },
          h(Icon, { name: 'chevron-left', size: 12 }),
          '上月',
        ),
        h('span', { className: 'lw-month-title' }, d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月'),
        h(
          'button',
          { type: 'button', className: 'lw-btn lw-tiny lw-bare', onClick: () => props.onMonth(new Date(d.getFullYear(), d.getMonth() + 1, 1)), title: '下一月' },
          '下月',
          h(Icon, { name: 'chevron-right', size: 12 }),
        ),
        atThisMonth
          ? null
          : h('button', { type: 'button', className: 'lw-btn lw-tiny lw-bare', onClick: () => props.onMonth(new Date(thisMonth.getFullYear(), thisMonth.getMonth(), 1)) }, '回到本月'),
        h('span', { className: 'lw-spacer' }),
        props.totals !== null && props.totals !== undefined
          ? h('span', { className: 'lw-meta' }, '本月 ' + fmtNum(props.totals.turns) + ' 轮次 · ' + fmtNum(props.totals.sessions) + ' 会话 · ' + fmtNum(props.totals.entries) + ' 条目')
          : null,
      )
    }

    // ---------------------------------------------------------------------
    // 日详情抽屉 = 行式台账：来源（小节标签）→ 工作区（组头）→ 条目（行）
    //   三层**都不是盒子**：层级靠缩进 + 1px 分隔线表达，没有任何嵌套卡片。
    // ---------------------------------------------------------------------

    /** 行内编辑：原行就地变成 textarea + 保存/取消（不弹窗、不套卡）。 */
    function EntryEditor(props) {
      const entry = props.entry
      const [summary, setSummary] = useState(typeof entry.summary === 'string' ? entry.summary : '')
      const [tag, setTag] = useState(typeof entry.tag === 'string' ? entry.tag : '')
      return h(
        'div',
        { className: 'lw-entry-row' },
        h('span', { className: 'lw-entry-time' }, fmtRange(entry.startTime, entry.endTime)),
        h('div', { className: 'lw-entry-edit' }, [
          h('textarea', {
            key: 'sum',
            className: 'lw-field',
            value: summary,
            maxLength: 2000,
            placeholder: '这段时间做了什么（一句话）',
            onChange: (e) => setSummary(e.target.value),
            'aria-label': '条目摘要',
          }),
          h(
            'div',
            { key: 'row', className: 'lw-form-row' },
            h('input', {
              className: 'lw-field',
              value: tag,
              maxLength: 40,
              placeholder: '标签（如：重构/调研）',
              style: { flex: 1, minWidth: 80 },
              onChange: (e) => setTag(e.target.value),
              'aria-label': '条目标签',
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'lw-btn lw-tiny lw-bare',
                disabled: props.busy === true,
                onClick: () => props.onSave({ summary: summary, tag: tag }),
              },
              props.busy === true ? '保存中…' : '保存',
            ),
            h('button', { type: 'button', className: 'lw-btn lw-tiny lw-bare', onClick: props.onCancel }, '取消'),
          ),
        ]),
      )
    }

    function EntryRow(props) {
      const e = props.entry
      const [editing, setEditing] = useState(false)
      const [busy, setBusy] = useState(false)
      const refs = Array.isArray(e.sessionRefs) ? e.sessionRefs : []
      const onSave = (patch) => {
        setBusy(true)
        props
          .onPatch(e.id, patch)
          .then((ok) => {
            setBusy(false)
            if (ok) setEditing(false)
          })
          .catch(() => setBusy(false))
      }
      const onDelete = () => {
        // 两段式确认交给上层 toast 文案即可；这里不做 window.confirm（沙箱里可能被拦）
        setBusy(true)
        props
          .onDelete(e.id)
          .then(() => setBusy(false))
          .catch(() => setBusy(false))
      }
      if (editing) {
        return h(EntryEditor, { entry: e, busy: busy, onSave: onSave, onCancel: () => setEditing(false) })
      }
      return h(
        'div',
        { className: 'lw-entry-row' },
        h('span', { className: 'lw-entry-time' }, fmtRange(e.startTime, e.endTime)),
        h(
          'span',
          { className: 'lw-entry-sum' },
          typeof e.summary === 'string' && e.summary.length > 0 ? e.summary : h('span', { className: 'lw-meta' }, '（无摘要）'),
        ),
        h(
          'span',
          { className: 'lw-entry-side' },
          typeof e.tag === 'string' && e.tag.length > 0 ? h('span', { className: 'lw-tag', title: e.tag }, e.tag) : null,
          // 已手改 = 小圆点 + 文字（不再是一个描边 pill）
          e.edited === true
            ? h('span', { className: 'lw-mark', title: '用户手改过，不会被重算覆盖' }, h('i', { 'aria-hidden': true }), '已手改')
            : null,
          refs.length > 0 ? h('span', { className: 'lw-meta' }, refs.length + ' 个会话') : null,
          h(
            'span',
            { className: 'lw-entry-acts' },
            h('button', { type: 'button', className: 'lw-linkbtn', onClick: () => setEditing(true), disabled: busy }, '编辑'),
            h('button', { type: 'button', className: 'lw-linkbtn lw-danger', onClick: onDelete, disabled: busy }, busy ? '处理中…' : '删除'),
          ),
        ),
      )
    }

    function AddEntryForm(props) {
      const [open, setOpen] = useState(false)
      const [summary, setSummary] = useState('')
      const [tag, setTag] = useState('')
      const [busy, setBusy] = useState(false)
      const workspaces = Array.isArray(props.workspaces) ? props.workspaces : []
      const [ws, setWs] = useState(workspaces.length > 0 ? workspaces[0].workspacePath : '')
      const [sourceId, setSourceId] = useState(props.sourceId)
      if (!open) {
        return h(
          'button',
          { type: 'button', className: 'lw-btn lw-tiny lw-bare', onClick: () => setOpen(true) },
          h(Icon, { name: 'plus', size: 12 }),
          '新增条目',
        )
      }
      const submit = () => {
        if (summary.trim().length === 0) {
          toast('摘要不能为空', 'error')
          return
        }
        setBusy(true)
        props
          .onAdd({ date: props.date, sourceId: sourceId, workspacePath: ws, summary: summary.trim(), tag: tag.trim() })
          .then((ok) => {
            setBusy(false)
            if (ok) {
              setOpen(false)
              setSummary('')
              setTag('')
            }
          })
          .catch(() => setBusy(false))
      }
      // 行内表单：在原位置展开，不弹窗、不套卡
      return h(
        'div',
        { className: 'lw-add-row' },
        h('div', { className: 'lw-meta' }, '新增条目 · ' + props.date),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 } }, [
          h('textarea', {
            key: 'sum',
            className: 'lw-field',
            value: summary,
            placeholder: '这段时间做了什么',
            onChange: (e) => setSummary(e.target.value),
            'aria-label': '新条目摘要',
          }),
          h(
            'div',
            { key: 'tag', className: 'lw-form-row' },
            h('input', { className: 'lw-field', style: { flex: 1, minWidth: 90 }, value: tag, placeholder: '标签', onChange: (e) => setTag(e.target.value), 'aria-label': '新条目标签' }),
          ),
          h(
            'div',
            { key: 'ws', className: 'lw-form-row' },
            h(
              'select',
              { className: 'lw-field', value: sourceId, onChange: (e) => setSourceId(e.target.value), 'aria-label': '来源' },
              props.sources.map((s) => h('option', { key: s.id, value: s.id }, s.label)),
            ),
            workspaces.length > 0
              ? h(
                  'select',
                  { className: 'lw-field', style: { flex: 1, minWidth: 110 }, value: ws, onChange: (e) => setWs(e.target.value), 'aria-label': '工作区' },
                  workspaces.map((w) => h('option', { key: w.workspacePath, value: w.workspacePath }, w.workspaceLabel)),
                )
              : h('input', { className: 'lw-field', style: { flex: 1, minWidth: 110 }, value: ws, placeholder: '工作区路径', onChange: (e) => setWs(e.target.value), 'aria-label': '工作区路径' }),
          ),
          h(
            'div',
            { key: 'act', className: 'lw-form-row', style: { justifyContent: 'flex-end' } },
            h('button', { type: 'button', className: 'lw-btn lw-tiny lw-bare', onClick: () => setOpen(false) }, '取消'),
            h('button', { type: 'button', className: 'lw-btn lw-tiny lw-primary', onClick: submit, disabled: busy }, busy ? '新增中…' : '新增'),
          ),
        ]),
      )
    }

    function DayDetail(props) {
      const date = props.date
      const sources = props.sources
      const fetcher = props.useDay
      const result = fetcher.result
      const data = result !== null && result !== undefined && result.ok === true ? result.data : null
      const groups = data !== null && Array.isArray(data.groups) ? data.groups : []
      const totals = data !== null && isObj(data.totals) ? data.totals : null

      let body = null
      if (fetcher.loading === true && data === null) {
        body = h(Skeleton, { rows: 5 })
      } else if (result !== null && result !== undefined && result.ok === false && notReadyOf(result)) {
        body = h(DataUnavailable, { result: result, endpoint: '/day', onRetry: props.onReload })
      } else if (result !== null && result !== undefined && result.ok === false && data === null) {
        body = h(DataUnavailable, { result: result, endpoint: '/day', onRetry: props.onReload })
      } else if (groups.length === 0) {
        body = h(EmptyState, {
          title: '这一天没有记录',
          text: '按事件时间归属，没有任何会话在这一天活动。换个日期，或点右上角「更新」先回填历史。',
          extra: h('button', { type: 'button', className: 'lw-btn lw-tiny lw-bare', onClick: props.onReload }, '刷新'),
        })
      } else {
        body = groups.map((g, gi) => {
          const sourceLabel = typeof g.sourceLabel === 'string' && g.sourceLabel.length > 0 ? g.sourceLabel : String(g.sourceId)
          const workspaces = Array.isArray(g.workspaces) ? g.workspaces : []
          return h(
            // 来源 = 小节标签（无边框无底色，只有分隔线）
            'div',
            { className: 'lw-src-row', key: String(g.sourceId) + ':' + gi },
            h(
              'div',
              { className: 'lw-src-head' },
              h('span', { className: 'lw-pill' }, g.sourceId === 'local' ? '本机' : '远程'),
              sourceLabel !== (g.sourceId === 'local' ? '本机' : '') ? h('span', { className: 'lw-meta' }, sourceLabel) : null,
            ),
            workspaces.length === 0 ? h('div', { className: 'lw-meta' }, '该来源当天没有工作区记录') : null,
            workspaces.map((w, wi) => {
              const entries = Array.isArray(w.entries) ? w.entries : []
              const wt = isObj(w.totals) ? w.totals : {}
              return h(
                // 工作区 = 组头（缩进一层，白底无框）
                'div',
                { className: 'lw-ws-row', key: String(w.workspacePath) + ':' + wi },
                h(
                  'div',
                  { className: 'lw-ws-head' },
                  h('span', { className: 'lw-ws-title', title: w.workspacePath }, typeof w.workspaceLabel === 'string' && w.workspaceLabel.length > 0 ? w.workspaceLabel : String(w.workspacePath)),
                  h('span', { className: 'lw-ws-meta' }, fmtNum(wt.turns) + ' 轮 · ' + fmtNum(wt.sessions) + ' 会话 · ' + fmtNum(wt.entries) + ' 条'),
                ),
                h('div', { className: 'lw-ws-path' }, String(w.workspacePath)),
                entries.map((e) =>
                  h(EntryRow, {
                    key: String(e.id),
                    entry: e,
                    onPatch: props.onPatch,
                    onDelete: props.onDelete,
                  }),
                ),
                h(AddEntryForm, {
                  date: date,
                  sourceId: typeof g.sourceId === 'string' ? g.sourceId : 'local',
                  sources: sources,
                  workspaces: workspaces,
                  onAdd: props.onAdd,
                }),
              )
            }),
          )
        })
      }

      const dayDate = fromDateKey(date)
      const parts = String(date).split('-')
      const monthText = dayDate !== null ? dayDate.getFullYear() + ' 年 ' + (dayDate.getMonth() + 1) + ' 月' : parts.slice(0, 2).join('-')
      const wdText = dayDate !== null ? '星期' + WD_LABEL[(dayDate.getDay() + 6) % 7] : ''
      return h(
        'aside',
        { className: 'lw-drawer', 'aria-label': '日详情' },
        // sticky 头部：大号 tabular 日号 + 星期 + 月份 + 刷新/关闭图标
        h(
          'div',
          { className: 'lw-drawer-head' },
          h(
            'div',
            { className: 'lw-drawer-date' },
            h('span', { className: 'lw-drawer-day' }, dayDate !== null ? String(dayDate.getDate()) : '—'),
            h(
              'span',
              { className: 'lw-drawer-when' },
              wdText !== '' ? h('span', { className: 'lw-drawer-wd' }, wdText) : null,
              h('span', { className: 'lw-drawer-wd' }, monthText),
            ),
          ),
          h(
            'div',
            { className: 'lw-drawer-meta' },
            totals !== null
              ? h('span', { className: 'lw-meta' }, fmtNum(totals.turns) + ' 轮 · ' + fmtNum(totals.sessions) + ' 会话 · ' + fmtNum(totals.entries) + ' 条')
              : null,
            props.degraded === true ? h('span', { className: 'lw-mark', title: '该天摘要降级（/state.degradedDays）' }, h('i', { 'aria-hidden': true }), '摘要降级') : null,
          ),
          h('span', { className: 'lw-spacer' }),
          h(IconButton, { name: 'refresh', label: '刷新当天数据', title: '刷新', onClick: props.onReload, disabled: fetcher.loading === true }),
          h(IconButton, { name: 'close', label: '关闭日详情', title: '关闭', onClick: props.onClose }),
        ),
        h('div', { className: 'lw-drawer-body' }, body),
      )
    }

    // ---------------------------------------------------------------------
    // 周/月简报
    // ---------------------------------------------------------------------

    /** 从 `/digests/periods` 的取数结果里挑出该 kind 的周期列表（新 → 旧）。 */
    function periodsOf(fetch, kind) {
      const r = fetch === null || fetch === undefined ? null : fetch.result
      if (r === null || r === undefined || r.ok !== true || !isObj(r.data)) return []
      const arr = kind === 'week' ? r.data.weeks : r.data.months
      return Array.isArray(arr) ? arr : []
    }

    function DigestPanel(props) {
      const kind = props.kind
      const period = props.period
      const digestResult = props.useDigest.result
      const digest = digestResult !== null && digestResult !== undefined && digestResult.ok === true && isObj(digestResult.data) ? digestResult.data.digest : null
      const [localDigest, setLocalDigest] = useState(null)
      const current = isObj(localDigest) ? localDigest : digest
      const [busy, setBusy] = useState(false)
      const [agentBusy, setAgentBusy] = useState(false)
      const [promptText, setPromptText] = useState('')
      const promptRef = useRef(null)

      // 周期导航：只在**有活动**的周期之间跳，避免切进一片空白。
      // 列表按「新 → 旧」排；'YYYY-Www' 与 'YYYY-MM' 的字典序恰好等于时间序，可比大小。
      const periodList = periodsOf(props.periods, kind)
      const newerList = periodList.filter((p) => p.period > period)
      const olderList = periodList.filter((p) => p.period < period)
      const nextNewer = newerList.length > 0 ? newerList[newerList.length - 1] : null // 最近的一个更晚周期
      const nextOlder = olderList.length > 0 ? olderList[0] : null // 最近的一个更早周期
      const here = periodList.find((p) => p.period === period) ?? null
      const isCurrentPeriod = props.todayPeriod === period
      const unit = kind === 'week' ? '周' : '月'

      // 周期一变（导航，或跟随选中日期）就丢掉本地那份"刚生成"的缓存与提示词。
      // 不重置会**串台**：切到上一周，正文却还显示原来的那份（因为 localDigest 优先于取数结果）。
      useEffect(() => {
        setLocalDigest(null)
        setPromptText('')
      }, [kind, period])

      const generate = () => {
        setBusy(true)
        request('/digest/generate', {
          method: 'POST',
          body: { kind: kind, period: period, sources: props.sources },
        }).then((res) => {
          setBusy(false)
          if (res.ok === true && isObj(res.data) && isObj(res.data.digest)) {
            setLocalDigest(res.data.digest)
            toast('简报已生成')
            props.onGenerated()
          } else {
            toast('生成失败：' + String(res.error || '未知错误'), 'error')
          }
        })
      }

      const agentPrompt = () => {
        setAgentBusy(true)
        request('/digest/agent-prompt', { method: 'POST', body: { kind: kind, period: period, sources: props.sources } }).then((res) => {
          setAgentBusy(false)
          if (res.ok !== true || !isObj(res.data) || typeof res.data.prompt !== 'string') {
            toast('取提示词失败：' + String(res.error || '未知错误'), 'error')
            return
          }
          setPromptText(res.data.prompt)
          // 先试输入框通道（overlay 座位会在 session 作用域里 setDraft）
          setPendingComposerText(res.data.prompt)
          toast('已尝试写入输入框；若没出现请从下方文本框手动复制')
          setTimeout(() => {
            const el = promptRef.current
            if (el !== null && el !== undefined && typeof el.focus === 'function') el.focus()
          }, 60)
        })
      }

      const copyPrompt = () => {
        const el = promptRef.current
        if (el !== null && el !== undefined && typeof el.select === 'function') el.select()
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(promptText)
            toast('提示词已复制到剪贴板')
            return
          }
        } catch {
          /* 剪贴板权限被拒 → 退回手动复制 */
        }
        toast('请按 Ctrl+C 复制选中的提示词')
      }

      let state = null
      if (digestResult !== null && digestResult !== undefined && digestResult.ok === false && notReadyOf(digestResult)) {
        state = h(DataUnavailable, { result: digestResult, endpoint: '/digests' })
      } else if (digestResult !== null && digestResult !== undefined && digestResult.loading === true) {
        state = h(Skeleton, { rows: 3 })
      } else if (isObj(current)) {
        const items = Array.isArray(current.items) ? current.items : []
        state = h(
          'div',
          null,
          h(
            'div',
            { className: 'lw-digest-body' },
            typeof current.headline === 'string' && current.headline.length > 0 ? h('div', { className: 'lw-headline' }, current.headline) : null,
            items.length === 0 ? h('div', { className: 'lw-meta' }, '简报里没有条目。') : null,
            // 条目是**行**不是卡：摘要 13px | 右侧中性 chip
            h(
              'div',
              { className: 'lw-dlist' },
              items.map((it, i) =>
                h(
                  'div',
                  { className: 'lw-ditem', key: i },
                  h('div', { className: 'lw-ditem-sum' }, typeof it.summary === 'string' ? it.summary : String(it.summary)),
                  typeof it.tag === 'string' && it.tag.length > 0 ? h('span', { className: 'lw-tag' }, it.tag) : null,
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'lw-digest-foot' },
            h('span', { className: 'lw-meta lw-wrap' }, '生成于 ' + (fmtDateTime(current.generatedAt) || '未知') + ' · 范围 ' + fmtPeriod(period, kind) + ' · 模型 ' + (isObj(current.model) ? String(current.model.provider) + '/' + String(current.model.model) : String(current.origin || '未知')) + ' · 来源 ' + (Array.isArray(current.sourceIds) && current.sourceIds.length > 0 ? current.sourceIds.join('、') : '全部')),
            h('span', { className: 'lw-spacer' }),
            h('button', { type: 'button', className: 'lw-btn lw-tiny', onClick: generate, disabled: busy === true }, busy === true ? '生成中…' : '重新生成'),
          ),
        )
      } else if (digestResult !== null && digestResult !== undefined && digestResult.ok === true) {
        state = h(EmptyState, {
          title: '还没有这份简报',
          text: '缓存里没有 ' + period + ' 的' + (kind === 'week' ? '周' : '月') + '简报。点「生成」让模型读一遍这段时间的条目，或点「交给智能体」把提示词丢进输入框自己问。',
          acts: true,
          extra: [
            // 主操作
            h('button', { key: 'gen', type: 'button', className: 'lw-btn lw-primary', onClick: generate, disabled: busy === true }, busy === true ? '生成中…' : '生成'),
            h('button', { key: 'agent', type: 'button', className: 'lw-btn', onClick: agentPrompt, disabled: agentBusy === true }, agentBusy === true ? '准备中…' : '交给智能体'),
          ],
        })
      } else {
        state = h(Skeleton, { rows: 3 })
      }

      return h(
        'div',
        { className: 'lw-digest' },
        h(
          'div',
          { className: 'lw-digest-head' },
          h(
            'button',
            {
              type: 'button',
              className: 'lw-btn lw-tiny lw-bare',
              disabled: nextOlder === null,
              title: nextOlder === null ? '没有更早的活动周期' : `跳到上一${unit}（${nextOlder.period}）`,
              onClick: () => nextOlder !== null && props.onPeriod(nextOlder.period),
            },
            h(Icon, { name: 'chevron-left', size: 12 }),
          ),
          h('span', { className: 'lw-digest-title' }, (kind === 'week' ? '周总结' : '月总结') + ' · ' + period),
          h(
            'button',
            {
              type: 'button',
              className: 'lw-btn lw-tiny lw-bare',
              disabled: nextNewer === null,
              title: nextNewer === null ? '没有更晚的活动周期' : `跳到下一${unit}（${nextNewer.period}）`,
              onClick: () => nextNewer !== null && props.onPeriod(nextNewer.period),
            },
            h(Icon, { name: 'chevron-right', size: 12 }),
          ),
          h(
            'span',
            { className: 'lw-meta' },
            fmtPeriod(period, kind) +
              (here !== null
                ? ` · ${here.days} 天有活动 · ${here.entries} 条条目`
                : periodList.length > 0
                  ? ' · 该周期没有记录'
                  : ''),
          ),
          isCurrentPeriod === false
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'lw-btn lw-tiny lw-bare',
                  title: props.selectedDate === null || props.selectedDate === undefined
                    ? `回到本${unit}`
                    : `回到今天所在的${unit}`,
                  onClick: () => {
                    props.onPeriod(props.todayPeriod)
                    props.onClearDay()
                  },
                },
                `回到本${unit}`,
              )
            : null,
          h('span', { className: 'lw-spacer' }),
          // 主操作
          h('button', { type: 'button', className: 'lw-btn lw-primary', onClick: generate, disabled: busy === true }, busy === true ? '生成中…' : isObj(current) ? '重新生成' : '生成'),
          h('button', { type: 'button', className: 'lw-btn lw-tiny', onClick: agentPrompt, disabled: agentBusy === true }, agentBusy === true ? '准备中…' : '交给智能体'),
          h('button', { type: 'button', className: 'lw-btn lw-tiny lw-bare', onClick: props.onClose }, '收起'),
        ),
        state,
        promptText.length > 0
          ? h(
              'div',
              { className: 'lw-digest-body' },
              h('div', { className: 'lw-meta lw-wrap' }, '提示词（已尝试写入输入框；没成功就手动复制）'),
              h('textarea', { className: 'lw-promptbox', ref: promptRef, value: promptText, readOnly: true, onFocus: (e) => e.target.select() }),
              h(
                'div',
                { className: 'lw-form-row', style: { justifyContent: 'flex-end' } },
                h('button', { type: 'button', className: 'lw-btn lw-tiny', onClick: copyPrompt }, '复制'),
                h('button', { type: 'button', className: 'lw-btn lw-tiny', onClick: () => setPromptText('') }, '关闭'),
              ),
            )
          : null,
      )
    }

    // ---------------------------------------------------------------------
    // 面板主体
    // ---------------------------------------------------------------------

    function LogWikiPage() {
      const now = useMemo(() => new Date(), [])
      const [view, setView] = useState('year')
      const [year, setYear] = useState(now.getFullYear())
      const [monthDate, setMonthDate] = useState(new Date(now.getFullYear(), now.getMonth(), 1))
      const [metric, setMetric] = useState(null)
      const [ping, setPing] = useState(null)
      const [pingError, setPingError] = useState(null)
      const [selectedDate, setSelectedDate] = useState(null)
      const [selectedSources, setSelectedSources] = useState(null) // null = 全部（未初始化）
      const [refreshNonce, setRefreshNonce] = useState(0)
      const [dayNonce, setDayNonce] = useState(0)
      const [refreshing, setRefreshing] = useState(false)
      const [progress, setProgress] = useState(null)
      const [connState, setConnState] = useState('idle')
      const [digestOpen, setDigestOpen] = useState(null) // {kind, period}
      // 二期：来源管理区块 + 同步中标记
      const [sourceOpen, setSourceOpen] = useState(false)
      const [syncing, setSyncing] = useState(false)
      // 视口宽度：四档断点（<700 隐藏活动索引 / ≥900 分段控件 / ≥1080 台账进右栏）
      const viewportW = useViewportWidth()

      // 1) /ping 自检 + 拿默认指标
      useEffect(() => {
        let alive = true
        request('/ping').then((res) => {
          if (!alive) return
          if (res.ok === true && isObj(res.data)) {
            setPing(res.data)
            setPingError(null)
            const cfgMetric = isObj(res.data.config) && isObj(res.data.config.heatmap) ? res.data.config.heatmap.metric : null
            if (typeof cfgMetric === 'string' && METRICS.indexOf(cfgMetric) >= 0) setMetric((cur) => (cur === null ? cfgMetric : cur))
          } else {
            setPingError(String(res.error || '未知错误'))
          }
        })
        return () => {
          alive = false
        }
      }, [refreshNonce])

      // 2) /sources（缺就只显示本机）
      const sourcesState = useFetchData('/sources', [refreshNonce])
      const sources = useMemo(() => {
        const data = sourcesState.result !== null && sourcesState.result !== undefined && sourcesState.result.ok === true ? sourcesState.result.data : null
        const list = data !== null && Array.isArray(data.sources) ? data.sources.filter((s) => isObj(s) && s.enabled !== false) : []
        if (list.length > 0) return list
        return [{ id: 'local', kind: 'local', label: '本机', enabled: true }]
      }, [sourcesState.result])

      // 3) /health（scan 进度；缺就静默）
      const healthState = useFetchData('/health', [refreshNonce])
      const scan = useMemo(() => {
        const data = healthState.result !== null && healthState.result !== undefined && healthState.result.ok === true ? healthState.result.data : null
        return data !== null && isObj(data.scan) ? data.scan : null
      }, [healthState.result])

      // 4) /state（热力图）
      const effectiveSources = selectedSources === null ? null : selectedSources
      const stateQuery = useMemo(() => {
        if (view === 'year') {
          const from = year + '-01-01'
          const to = year + '-12-31'
          const q = '?from=' + from + '&to=' + to + (effectiveSources === null ? '' : '&sources=' + encodeURIComponent(effectiveSources.join(',')))
          return '/state' + q
        }
        const first = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1)
        const from = dateKeyOf(first)
        const to = dateKeyOf(new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0))
        const q = '?from=' + from + '&to=' + to + (effectiveSources === null ? '' : '&sources=' + encodeURIComponent(effectiveSources.join(',')))
        return '/state' + q
      }, [view, year, monthDate, effectiveSources])
      const stateData = useFetchData(stateQuery, [refreshNonce])

      const stateBody = stateData.result !== null && stateData.result !== undefined && stateData.result.ok === true ? stateData.result.data : null

      /** date → { value, sessions, entries, turns, degraded }，指标已按当前 metric 取值。
       *  ⚠️ 不下发也不缓存 tags：/state.heatmap[] 上没有这个字段（R0.5），早先那行
       *  `tags: Array.isArray(row.tags) ? row.tags : []` 是恒为空的死映射，已删。 */
      const dayMap = useMemo(() => {
        const map = new Map()
        if (stateBody === null || !isObj(stateBody)) return map
        const heat = Array.isArray(stateBody.heatmap) ? stateBody.heatmap : []
        const useMetric = typeof metric === 'string' ? metric : 'turns'
        for (const row of heat) {
          if (!isObj(row) || typeof row.date !== 'string') continue
          const work = isObj(row.work) ? row.work : {}
          const tokens = isObj(work.tokens) ? toNum(work.tokens.input) + toNum(work.tokens.output) + toNum(work.tokens.cacheRead) + toNum(work.tokens.cacheWrite) + toNum(work.tokens.reasoning) : 0
          const value = useMetric === 'tokens' ? tokens : toNum(work[useMetric])
          map.set(row.date, {
            value: value,
            sessions: toNum(work.sessions),
            entries: toNum(work.entries),
            turns: toNum(work.turns),
            degraded: false,
          })
        }
        const degraded = Array.isArray(stateBody.degradedDays) ? stateBody.degradedDays : []
        for (const d of degraded) {
          if (typeof d !== 'string') continue
          const rec = map.get(d)
          if (rec !== undefined) rec.degraded = true
          else map.set(d, { value: 0, sessions: 0, entries: 0, turns: 0, degraded: true })
        }
        return map
      }, [stateBody, metric])

      const thresholds = useMemo(() => {
        const values = []
        for (const rec of dayMap.values()) values.push(rec.value)
        return quantileThresholds(values)
      }, [dayMap])

      const totals = stateBody !== null && isObj(stateBody.totals) ? stateBody.totals : { turns: 0, sessions: 0, entries: 0 }
      // 活跃日：与当前指标无关 —— 只要当天有轮次/会话/条目就算活跃
      const activeDays = useMemo(() => {
        let n = 0
        for (const rec of dayMap.values()) if (rec.turns > 0 || rec.entries > 0 || rec.sessions > 0) n += 1
        return n
      }, [dayMap])
      const metricValue = metric === null ? 'turns' : metric
      const totalTokens = isObj(totals.tokens)
        ? toNum(totals.tokens.input) + toNum(totals.tokens.output) + toNum(totals.tokens.cacheRead) + toNum(totals.tokens.cacheWrite) + toNum(totals.tokens.reasoning)
        : 0
      const yearMetric = metricValue === 'tokens' ? totalTokens : toNum(totals[metricValue])

      // ---------------------------------------------------------------------
      // 年度台账：全部由**已加载**的 /state 客户端派生（不新增任何端点）
      //   活跃日 / 轮次 / 会话 / 条目 / Token / 最长连续 / 最忙的一天 / 平均每活跃日
      // ---------------------------------------------------------------------
      const ledger = useMemo(() => {
        const keys = []
        let busiestKey = null
        let busiestValue = 0
        for (const [key, rec] of dayMap.entries()) {
          if (rec.turns > 0 || rec.entries > 0 || rec.sessions > 0) keys.push(key)
          if (rec.value > busiestValue) {
            busiestValue = rec.value
            busiestKey = key
          }
        }
        keys.sort()
        // 最长连续（按日历日逐个比对）
        let best = 0
        let run = 0
        let prev = null
        for (const key of keys) {
          const d = fromDateKey(key)
          if (d === null) continue
          run = prev !== null && Math.round((d.getTime() - prev.getTime()) / 86400000) === 1 ? run + 1 : 1
          prev = d
          if (run > best) best = run
        }
        const avg = activeDays > 0 ? Math.round(yearMetric / activeDays) : 0
        const busyText =
          busiestKey === null
            ? '—'
            : String(busiestKey).slice(5).replace('-', '/')
        const allRows = [
          { label: '轮次', value: fmtNum(totals.turns), hint: '已记录的轮次总数' },
          { label: '会话', value: fmtNum(totals.sessions), hint: '已记录的会话总数' },
          { label: '条目', value: fmtNum(totals.entries), hint: '任务条目总数' },
          { label: 'Token', value: fmtNum(totalTokens), hint: 'input+output+cacheRead+cacheWrite+reasoning' },
          { label: '活跃日', value: String(activeDays), hint: '有轮次/会话/条目的天数' },
          { label: '最长连续', value: activeDays > 0 ? best + ' 天' : '—', hint: '连续活跃的最长天数' },
          {
            label: '最忙的一天',
            value: busyText,
            hint: busiestKey === null ? '还没有记录' : busiestKey + ' · ' + fmtNum(busiestValue) + ' ' + METRIC_LABEL[metricValue],
          },
          { label: '平均每活跃日', value: activeDays > 0 ? fmtNum(avg) : '—', hint: '当前指标（' + METRIC_LABEL[metricValue] + '）÷ 活跃日' },
        ]
        // 近期活动索引：按当前指标取最近 5 个活跃日，点一行就打开抽屉
        const recent = []
        for (let i = keys.length - 1; i >= 0 && recent.length < 5; i -= 1) {
          const rec = dayMap.get(keys[i])
          const v = rec === undefined ? 0 : rec.value
          recent.push({
            date: keys[i],
            text: fmtNum(v) + ' ' + METRIC_LABEL[metricValue],
            hint: fmtNum(v) + ' ' + METRIC_LABEL[metricValue],
          })
        }
        return { rows: allRows, recent: recent, best: best }
      }, [dayMap, totals, totalTokens, activeDays, yearMetric, metricValue])

      // 5) SSE 进度
      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.EventSource !== 'function') {
          setConnState('unsupported')
          return undefined
        }
        let es = null
        let closed = false
        let retry = null
        const open = () => {
          if (closed) return
          try {
            es = new window.EventSource(API + '/events')
          } catch {
            setConnState('failed')
            return
          }
          setConnState('connecting')
          es.onopen = () => setConnState('open')
          es.addEventListener('progress', (ev) => {
            let payload = null
            try {
              payload = JSON.parse(ev.data)
            } catch {
              payload = null
            }
            if (payload === null) return
            setProgress(payload)
            if (payload.finished === true) {
              setRefreshing(false)
              setProgress(payload)
              setRefreshNonce((n) => n + 1)
              setDayNonce((n) => n + 1)
            } else {
              setRefreshing(true)
            }
          })
          es.onerror = () => {
            setConnState('failed')
            if (es !== null) {
              try {
                es.close()
              } catch {
                /* 已经关了 */
              }
              es = null
            }
            if (closed) return
            // 断线重连（3 秒）；组件卸载时 closed=true 就不再重连
            retry = setTimeout(open, 3000)
          }
        }
        open()
        return () => {
          closed = true
          if (retry !== null) clearTimeout(retry)
          if (es !== null) {
            try {
              es.close()
            } catch {
              /* 已经关了 */
            }
          }
        }
      }, [])

      const onRefresh = useCallback(() => {
        setRefreshing(true)
        request('/refresh', { method: 'POST', body: {} }).then((res) => {
          if (res.ok !== true) {
            setRefreshing(false)
            toast('更新失败：' + String(res.error || '未知错误'), 'error')
            // SSE 没起来的话至少把静态数据刷一遍
            setRefreshNonce((n) => n + 1)
            return
          }
          if (isObj(res.data) && res.data.running === true && res.data.ok === false) toast('已有一个更新任务在跑，等它结束')
          toast('已开始更新')
        })
      }, [])

      const onToggleSource = useCallback(
        (id) => {
          setSelectedSources((cur) => {
            const all = sources.map((s) => s.id)
            const base = cur === null ? all.slice() : cur.slice()
            const idx = base.indexOf(id)
            if (idx >= 0) base.splice(idx, 1)
            else base.push(id)
            if (base.length === 0) return all.slice() // 至少留一个来源
            if (base.length === all.length) return null // 全选 == 不过滤
            return base
          })
        },
        [sources],
      )

      // 6) 日详情
      const dayPath = selectedDate === null ? null : '/day?date=' + selectedDate + (effectiveSources === null ? '' : '&sources=' + encodeURIComponent(effectiveSources.join(',')))
      const dayFetch = useFetchData(dayPath, [dayNonce])

      // 降级标记必须与**格子描边**同源、同真值，但 dayMap 只覆盖当前视图的 /state 区间
      // （切到别的月/年时，选中日可能不在区间里 → 抽屉头的标记会凭空消失，与格子不一致）。
      // 所以对选中日期单独取一次 /state（同样的端点、同样的 from/to 语义，不新增接口），
      // 再由 degradedDays 判定。
      const selectedStatePath =
        selectedDate === null
          ? null
          : '/state?from=' + selectedDate + '&to=' + selectedDate + (effectiveSources === null ? '' : '&sources=' + encodeURIComponent(effectiveSources.join(',')))
      const selectedState = useFetchData(selectedStatePath, [refreshNonce, dayNonce])
      const selectedDegraded = useMemo(() => {
        if (selectedDate === null) return false
        const r = selectedState.result
        const body = r !== null && r !== undefined && r.ok === true && isObj(r.data) ? r.data : null
        const list = body !== null && Array.isArray(body.degradedDays) ? body.degradedDays : []
        return list.indexOf(selectedDate) >= 0
      }, [selectedState.result, selectedDate])

      const afterEntryChange = useCallback(() => {
        setDayNonce((n) => n + 1)
        setRefreshNonce((n) => n + 1)
      }, [])

      const patchEntry = useCallback(
        (entryId, patch) => {
          return request('/entry', { method: 'POST', body: { entryId: entryId, summary: patch.summary, tag: patch.tag } }).then((res) => {
            if (res.ok !== true) {
              toast('保存失败：' + String(res.error || '未知错误'), 'error')
              return false
            }
            toast('已保存')
            afterEntryChange()
            return true
          })
        },
        [afterEntryChange],
      )

      const deleteEntry = useCallback(
        (entryId) => {
          return request('/entry/delete', { method: 'POST', body: { entryId: entryId } }).then((res) => {
            if (res.ok !== true) {
              toast('删除失败：' + String(res.error || '未知错误'), 'error')
              return false
            }
            toast('已删除')
            afterEntryChange()
            return true
          })
        },
        [afterEntryChange],
      )

      const addEntry = useCallback(
        (payload) => {
          return request('/entry/add', { method: 'POST', body: payload }).then((res) => {
            if (res.ok !== true) {
              toast('新增失败：' + String(res.error || '未知错误'), 'error')
              return false
            }
            toast('已新增')
            afterEntryChange()
            return true
          })
        },
        [afterEntryChange],
      )

      // 7) 简报周期 —— **跟随当前选中的日期**
      //    用户看着 9/28 点「周总结」，出的就该是 9/28 那一周（而不是"今天"那一周）。
      //    这与主流日历应用一致：周期跟随焦点。没有选中日期时才回落到今天。
      const periodOfDate = useCallback((kind, ymd) => {
        let d = new Date()
        if (typeof ymd === 'string') {
          const parts = ymd.split('-').map(Number)
          if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
            d = new Date(parts[0], parts[1] - 1, parts[2])
          }
        }
        return kind === 'week' ? gfmWeekKey(d) : monthKeyOf(d)
      }, [])
      const todayPeriodOf = useCallback((kind) => periodOfDate(kind, null), [periodOfDate])
      const openDigest = useCallback(
        (kind) => {
          setDigestOpen({ kind: kind, period: periodOfDate(kind, selectedDate) })
        },
        [periodOfDate, selectedDate],
      )
      // 选中日期一变，已打开的简报就跟着走（这正是用户要的行为）。
      //
      // ⚠️ 这里必须用 ref 记住"上一次跟随过的日期"，只在**日期真的变了**时跟随。
      // 早先的写法是「只要 当前周期 ≠ 选中日的周期 就 setState」，结果**手动导航会被立刻拉回来**：
      //   点 › → 周期变 W40 → effect 发现 ≠ 选中日的 W39 → 改回 W39 → 看起来"箭头点了没反应"。
      // （当时我只断言了按钮的 title/disabled，没真的点过它，所以没测出来。）
      const followedDayRef = useRef(selectedDate)
      useEffect(() => {
        const dayChanged = followedDayRef.current !== selectedDate
        followedDayRef.current = selectedDate
        if (dayChanged === false) return // 只是手动导航/其它状态变化 → 不动周期
        if (digestOpen === null) return
        const period = periodOfDate(digestOpen.kind, selectedDate)
        if (period !== digestOpen.period) setDigestOpen({ kind: digestOpen.kind, period: period })
      }, [selectedDate, digestOpen, periodOfDate])
      const digestPath = digestOpen === null ? null : '/digests?kind=' + digestOpen.kind + '&period=' + digestOpen.period
      const digestFetch = useFetchData(digestPath, [refreshNonce])
      // 「有活动的周期」清单：做前后跳转 + 提示该周期有多少条条目
      const periodsFetch = useFetchData('/digests/periods', [refreshNonce])

      // 二期：来源管理（用**原始** /sources 行，含 sessionCount/entryCount 与 lastError）
      const sourceRows = useMemo(() => {
        const r = sourcesState.result
        if (r === null || r === undefined || r.ok !== true || !isObj(r.data) || !Array.isArray(r.data.sources)) return []
        return r.data.sources
      }, [sourcesState.result])
      const syncSourceNow = useCallback((id) => {
        setSyncing(true)
        request('/source/sync', { method: 'POST', body: { sourceId: id } }).then((res) => {
          setSyncing(false)
          if (res.ok === true) toast('已开始同步，请看进度条')
          else toast('同步失败：' + String(res.error || '未知错误'), 'error')
        })
      }, [])
      const deleteSourceNow = useCallback((id) => {
        request('/source/delete', { method: 'POST', body: { sourceId: id } }).then((res) => {
          if (res.ok === true) {
            const d = isObj(res.data) ? res.data : {}
            toast(`已删除来源（会话 ${d.removedSessions === undefined ? 0 : d.removedSessions}，条目 ${d.removedEntries === undefined ? 0 : d.removedEntries}）`)
            setRefreshNonce((n) => n + 1)
          } else {
            toast('删除失败：' + String(res.error || '未知错误'), 'error')
          }
        })
      }, [])
      // 同步完成后（进度条回到 idle）刷新一次列表，让状态点/计数更新
      useEffect(() => {
        if (progress !== null && progress.finished === true && progress.phase === 'idle') {
          setRefreshNonce((n) => n + 1)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [progress === null ? null : progress.finished])

      const version = ping !== null && ping !== undefined && typeof ping.version === 'string' ? ping.version : null

      // 布局断点（DESIGN §2.9）
      const narrowIndex = viewportW < 700        // 活动索引（月份轴/星期栏/图例）全隐藏
      const compactMetric = viewportW < 900      // 指标分段控件退回 <select>
      const twoRowHead = viewportW < 900         // 工具栏两段换行
      const ledgerInColumn = viewportW >= 1080   // 台账栏进右栏，否则退成主区下方汇总带
      const showLedger = view === 'year' && viewportW >= 700

      // 8) 主体内容
      const stateLoading = stateData.loading === true && stateBody === null
      let content = null
      if (stateLoading) {
        // 骨架屏与所替代内容同形：年视图 = 7×53 小格，月视图 = 7×6 日历格
        content = h('div', { className: 'lw-main' }, view === 'year' ? h(HeatSkeleton, null) : h(MonthSkeleton, null))
      } else if (stateData.result !== null && stateData.result !== undefined && stateData.result.ok === false && stateBody === null) {
        content = h('div', { className: 'lw-main' }, h(DataUnavailable, { result: stateData.result, endpoint: '/state', onRetry: () => setRefreshNonce((n) => n + 1) }))
      } else if (view === 'year') {
        content = h(
          'div',
          { className: 'lw-main' },
          h(Heatmap, {
            year: year,
            days: dayMap,
            thresholds: thresholds,
            metric: metricValue,
            total: yearMetric,
            activeDays: activeDays,
            selectedDate: selectedDate,
            narrow: narrowIndex,
            recent: ledger.recent,
            refreshing: refreshing,
            onPick: setSelectedDate,
            onYear: setYear,
            onMonth: (d) => {
              setMonthDate(d)
              setView('month')
            },
            onRefresh: onRefresh,
          }),
          stateBody !== null && isObj(stateBody) && typeof stateBody.metric === 'string' && stateBody.metric !== metricValue
            ? h('div', { className: 'lw-meta' }, '（宿主侧当前档位：' + METRIC_LABEL[stateBody.metric] + '）')
            : null,
          // 这行提示是**可见文案**：用 label-secondary（浅色 5.80:1），不用 label-tertiary（3.71:1）
          h('div', { className: 'lw-meta' }, '点任意格子看当天条目；方向键在网格里移动，Enter 打开。'),
        )
      } else {
        content = h(
          'div',
          { className: 'lw-main' },
          h(MonthHeader, { monthDate: monthDate, onMonth: setMonthDate, totals: totals }),
          h(MonthView, {
            monthDate: monthDate,
            days: dayMap,
            thresholds: thresholds,
            metric: metricValue,
            selectedDate: selectedDate,
            onPick: setSelectedDate,
            onMonth: setMonthDate,
          }),
        )
      }

      const ledgerNode = showLedger
        ? h(
            Boundary,
            { label: '年度台账' },
            stateLoading
              ? h(LedgerSkeleton, { year: year })
              : h(Ledger, { title: year + ' 年', rows: ledger.rows, recent: ledger.recent, band: ledgerInColumn === false, onPick: setSelectedDate }),
          )
        : null

      return h(
        'div',
        { className: 'lw-root' },
        h(Header, {
          year: year,
          view: view,
          metric: metricValue,
          sources: sources,
          selectedSources: selectedSources === null ? new Set(sources.map((s) => s.id)) : new Set(selectedSources),
          connState: connState,
          refreshing: refreshing,
          digestBusy: false,
          version: version,
          pingFailed: pingError !== null,
          twoRow: twoRowHead,
          compactMetric: compactMetric,
          onYear: setYear,
          onView: setView,
          onMetric: setMetric,
          onToggleSource: onToggleSource,
          onRefresh: onRefresh,
          onDigest: openDigest,
          onAddSource: () => setSourceOpen(true),
        }),
        h(ScanBanner, { scan: scan, progress: progress, refreshing: refreshing }),
        h(ToastHost, null),
        // 简报 / 来源：占据面板的整段视图（整宽，不挤在角落）
        sourceOpen === true
          ? h(
              'div',
              { className: 'lw-section' },
              h(
                Boundary,
                { label: '来源区块' },
                h(SourceDialog, {
                  rows: sourceRows,
                  syncing: syncing,
                  onChanged: () => setRefreshNonce((n) => n + 1),
                  onSync: syncSourceNow,
                  onDelete: deleteSourceNow,
                  onClose: () => setSourceOpen(false),
                }),
              ),
            )
          : null,
        digestOpen !== null
          ? h(
              'div',
              { className: 'lw-section' },
              h(
                Boundary,
                { label: '简报区块' },
                h(DigestPanel, {
                  kind: digestOpen.kind,
                  period: digestOpen.period,
                  sources: effectiveSources === null ? undefined : effectiveSources,
                  useDigest: digestFetch,
                  periods: periodsFetch,
                  todayPeriod: todayPeriodOf(digestOpen.kind),
                  onPeriod: (period) => setDigestOpen({ kind: digestOpen.kind, period: period }),
                  selectedDate: selectedDate,
                  onClearDay: () => setSelectedDate(null),
                  onGenerated: () => setRefreshNonce((n) => n + 1),
                  onClose: () => setDigestOpen(null),
                }),
              ),
            )
          : null,
        h(
          'div',
          { className: 'lw-split' },
          h(
            'div',
            { className: 'lw-stack' },
            h(Boundary, { label: '日历主体' }, content),
            // 900–1080（含 700–900）：台账离开右栏，退成主区下方的一行汇总带
            ledgerInColumn ? null : ledgerNode,
          ),
          ledgerInColumn ? ledgerNode : null,
          selectedDate !== null
            ? h(
                Boundary,
                { label: '日详情' },
                h(DayDetail, {
                  date: selectedDate,
                  sources: sources,
                  useDay: dayFetch,
                  degraded: selectedDegraded,
                  onReload: () => setDayNonce((n) => n + 1),
                  onPatch: patchEntry,
                  onDelete: deleteEntry,
                  onAdd: addEntry,
                  onClose: () => setSelectedDate(null),
                }),
              )
            : null,
        ),
      )
    }

    return {
      name: 'dsh-logwiki-client',
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(applyStyles, 'dsh-logwiki: styles')

        const slots = ctx.get('slots')
        if (slots === undefined) {
          ctx.logger?.warn?.('[dsh-logwiki] slots 服务不可用，面板未注册')
          return
        }

        // 左侧栏图标行：与「插件」「自动化任务」同一条 icon strip。
        ctx.effect(
          () =>
            slots.inject('sidebar.panellist', () =>
              slots.register(
                { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => '任务日历' },
                LogWikiIcon,
              ),
            ),
          'dsh-logwiki: sidebar entry',
        )

        // 整页日历：main 是唯一整页座位，key 即 activePanelId。
        ctx.effect(
          () =>
            slots.inject('main', () =>
              slots.register({ name: 'main', key: PANEL_ID }, function Page() {
                return h(Boundary, { label: 'LogWiki 面板' }, h(LogWikiPage, null))
              }),
            ),
          'dsh-logwiki: main panel',
        )

        // 输入框通道：conversation.input.overlay 是 list 座位、session 作用域，
        // 标准 props 里带 inputActions（已核对 ui-conversation 的 slot 契约）。
        // 无头组件：没有 inputActions 就注册成空壳，什么也不做（静默降级）。
        ctx.effect(() => {
          let dispose = null
          try {
            dispose = slots.inject('conversation.input.overlay', () =>
              slots.register({ name: 'conversation.input.overlay', id: 'logwiki-composer', order: 90 }, ComposerBridge),
            )
          } catch (e) {
            ctx.logger?.warn?.('[dsh-logwiki] input overlay 座位注册失败：' + errText(e))
            return () => {}
          }
          return () => {
            if (typeof dispose === 'function') dispose()
          }
        }, 'dsh-logwiki: composer bridge')
      },
    }
  },
})
