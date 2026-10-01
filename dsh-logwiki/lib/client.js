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
 *      颜色/圆角/字号只用 --dsw-* token 并给 fallback。唯一写死颜色的地方是热力图色阶
 *      （绿系 #39d353），且必须经 color-mix 与 --dsw-alias-bg-layer-2 融合，明暗都可读。
 *   4. 每个区块独立容错：任何一处异常都不能让面板白屏；顶层再套一层错误边界。
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

    /** 所有取值都进 `--dsw-*` token；热力图色阶用 color-mix 与主题背景融合。 */
    const CSS = `
.lw-root {
  display: flex; flex-direction: column;
  height: 100%; min-height: 0;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
  font-size: var(--dsw-font-s-14-font-size, 13px);
}
.lw-root *, .lw-root *::before, .lw-root *::after { box-sizing: border-box; }

/* ---------- header ---------- */
.lw-head {
  display: flex; align-items: center; gap: 8px; flex: none;
  flex-wrap: wrap;
  padding: 9px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.lw-title { font-weight: 600; font-size: 14px; letter-spacing: .2px; }
.lw-ver {
  color: var(--dsw-alias-label-tertiary); font-size: 11px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px; padding: 0 7px; line-height: 17px;
}
.lw-spacer { flex: 1; min-width: 8px; }
.lw-group {
  display: inline-flex; align-items: center; gap: 2px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm, 6px);
  padding: 1px;
  background: var(--dsw-alias-bg-layer-2);
}
.lw-btn {
  appearance: none; font: inherit; cursor: pointer;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-button-tool-bar-fill, var(--dsw-alias-bg-layer-2));
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm, 6px);
  padding: 4px 10px;
  white-space: nowrap;
}
.lw-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-3)); }
.lw-btn:disabled { opacity: .5; cursor: default; }
.lw-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.lw-btn.lw-on {
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary-foreground, #fff);
  border-color: transparent;
}
.lw-btn.lw-tiny { padding: 2px 7px; font-size: 12px; border-radius: var(--dsw-radius-xs, 4px); }
.lw-group .lw-btn { border: 0; background: none; border-radius: var(--dsw-radius-xs, 4px); padding: 3px 9px; font-size: 12px; }
.lw-group .lw-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-3)); }
.lw-group .lw-btn.lw-on { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-foreground, #fff); }
.lw-field {
  appearance: none; font: inherit; font-size: 12px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm, 6px);
  padding: 3px 6px;
  max-width: 100%;
}
.lw-field:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
textarea.lw-field { resize: vertical; min-height: 52px; width: 100%; line-height: 1.5; }
select.lw-field { cursor: pointer; }
.lw-chip {
  appearance: none; font: inherit; font-size: 11px; cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px; padding: 1px 9px; line-height: 18px;
  white-space: nowrap;
}
.lw-chip.lw-on {
  color: var(--dsw-alias-label-primary-foreground, #fff);
  background: var(--dsw-alias-brand-primary);
  border-color: transparent;
}
.lw-meta { color: var(--dsw-alias-label-tertiary); font-size: 11px; white-space: nowrap; }

/* ---------- 页身 ---------- */
.lw-split { display: flex; flex: 1; min-height: 0; }
.lw-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: auto; padding: 12px; }
.lw-body { flex: 1; min-height: 0; }

/* ---------- 热力图 ---------- */
.lw-heatwrap { display: flex; flex-direction: column; gap: 8px; min-width: 0; --lw-empty: var(--dsw-alias-bg-layer-2); }
.lw-heatgrid { display: flex; gap: 6px; align-items: flex-start; min-width: 0; }
.lw-wdcol { display: flex; flex-direction: column; flex: none; }
.lw-wd { height: 12px; line-height: 12px; font-size: 10px; color: var(--dsw-alias-label-tertiary); text-align: right; padding-right: 2px; }
.lw-wd.lw-wd-top { height: 14px; }
.lw-scroll {
  overflow: auto; min-width: 0; flex: 1;
  padding-bottom: 4px;
  scrollbar-width: thin;
}
.lw-heat { position: relative; }
.lw-heat-months { position: absolute; top: 0; left: 0; height: 14px; }
.lw-heat-month { position: absolute; top: 0; height: 14px; line-height: 14px; font-size: 10px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
/* 定位上下文：格子是 absolute，必须由这一层建立包含块 */
.lw-heat-cells { position: absolute; left: 0; }
.lw-cell {
  position: absolute; width: 12px; height: 12px;
  padding: 0; margin: 0; border: 1px solid transparent; cursor: pointer;
  border-radius: 2.5px;
  background: color-mix(in srgb, var(--dsw-lw-heat, #39d353) var(--lw-pct, 0%), var(--lw-empty));
}
.lw-cell:hover { border-color: var(--dsw-alias-label-primary); }
.lw-cell:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.lw-cell[data-selected="1"] { border-color: var(--dsw-alias-brand-primary); }
.lw-cell[data-today="1"] { border-color: var(--dsw-alias-label-secondary); }
.lw-cell-legend { display: flex; align-items: center; gap: 4px; justify-content: flex-end; }
.lw-legend-cell { width: 12px; height: 12px; border-radius: 2.5px; border: 1px solid transparent; }

/* ---------- 月视图 ---------- */
.lw-month { display: flex; flex-direction: column; gap: 8px; }
.lw-month-head { display: flex; align-items: center; gap: 8px; }
.lw-month-title { font-weight: 600; font-size: 13px; }
.lw-mgrid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; }
.lw-mwd { text-align: center; font-size: 10px; color: var(--dsw-alias-label-tertiary); padding: 2px 0; }
.lw-mcell {
  appearance: none; font: inherit; cursor: pointer; text-align: left;
  display: flex; flex-direction: column; gap: 3px;
  min-height: 76px; padding: 5px 6px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm, 6px);
}
.lw-mcell:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-3)); }
.lw-mcell:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.lw-mcell[data-out="1"] { opacity: .45; }
.lw-mcell[data-selected="1"] { border-color: var(--dsw-alias-brand-primary); }
.lw-mcell[data-today="1"] { border-color: var(--dsw-alias-label-secondary); }
.lw-mnum { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); }
.lw-mcell[data-today="1"] .lw-mnum { color: var(--dsw-alias-brand-primary); font-weight: 600; }
.lw-mbar { height: 4px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.lw-mbar > i { display: block; height: 100%; border-radius: 999px; background: var(--dsw-lw-heat, #39d353); }
.lw-mcount { font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.lw-mtags { display: flex; gap: 3px; flex-wrap: wrap; }
.lw-tag {
  font-size: 10px; line-height: 15px; padding: 0 5px;
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary);
  background: color-mix(in srgb, var(--dsw-lw-heat, #39d353) 18%, var(--dsw-alias-bg-layer-2));
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;
}

/* ---------- 日详情抽屉 ---------- */
.lw-drawer {
  flex: none; width: 340px; max-width: 46vw;
  min-height: 0; display: flex; flex-direction: column;
  border-left: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.lw-drawer-head {
  flex: none; display: flex; align-items: center; gap: 8px;
  padding: 9px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.lw-drawer-title { font-weight: 600; font-size: 13px; }
.lw-drawer-body { flex: 1; min-height: 0; overflow: auto; padding: 10px 12px 20px; }
.lw-src { margin-bottom: 14px; }
.lw-src-head {
  display: flex; align-items: center; gap: 6px; margin-bottom: 6px;
  font-size: 11px; letter-spacing: .04em; text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary);
}
.lw-pill {
  font-size: 10px; text-transform: none; letter-spacing: 0;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px;
  padding: 0 6px; line-height: 15px; color: var(--dsw-alias-label-secondary);
}
.lw-ws {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-base);
  margin-bottom: 8px; overflow: hidden;
}
.lw-ws-head {
  display: flex; align-items: baseline; gap: 6px;
  padding: 7px 9px; border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
}
.lw-ws-title { font-weight: 600; font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lw-ws-path { color: var(--dsw-alias-label-tertiary); font-size: 10px; word-break: break-all; }
.lw-entries { padding: 7px; display: flex; flex-direction: column; gap: 6px; }
.lw-entry {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-layer-1);
  padding: 6px 7px;
}
.lw-entry-head { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
.lw-entry-time { font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.lw-entry-sum { font-size: 12px; line-height: 1.5; word-break: break-word; white-space: pre-wrap; }
.lw-entry-foot { display: flex; align-items: center; gap: 6px; margin-top: 5px; flex-wrap: wrap; }
.lw-entry-acts { margin-left: auto; display: inline-flex; gap: 4px; }
.lw-linkbtn {
  appearance: none; background: none; border: 0; padding: 0 2px; cursor: pointer;
  font: inherit; font-size: 11px; color: var(--dsw-alias-brand-primary);
}
.lw-linkbtn:hover { text-decoration: underline; }
.lw-linkbtn.lw-danger { color: var(--dsw-alias-state-error-primary); }
.lw-badge {
  font-size: 10px; line-height: 15px; padding: 0 5px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-primary);
}

/* ---------- 简报 ---------- */
.lw-digest {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-1);
  margin-bottom: 12px;
}
.lw-digest-head {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.lw-digest-title { font-weight: 600; font-size: 13px; }
.lw-digest-body { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.lw-headline {
  color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.6;
  white-space: pre-wrap; word-break: break-word;
}
.lw-ditem {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-base);
  padding: 7px 8px; display: flex; flex-direction: column; gap: 4px;
}
.lw-ditem-sum { font-size: 12px; line-height: 1.55; word-break: break-word; }

/* ---------- 卡片 / 通用 ---------- */
.lw-card {
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: var(--dsw-radius-md, 8px);
  padding: 14px 16px;
  max-width: 720px;
}
.lw-card + .lw-card { margin-top: 12px; }
.lw-line { display: flex; gap: 8px; align-items: baseline; margin-top: 6px; }
.lw-k { color: var(--dsw-alias-label-secondary); min-width: 96px; }
.lw-v { color: var(--dsw-alias-label-primary); word-break: break-all; }
.lw-ok { color: var(--dsw-alias-state-success-primary); }
.lw-bad { color: var(--dsw-alias-state-error-primary); }
.lw-warn { color: var(--dsw-alias-state-warn-primary); }
.lw-dim { color: var(--dsw-alias-label-tertiary); }
.lw-empty {
  border: 1px dashed var(--dsw-alias-border-l2, var(--dsw-alias-border-l1));
  border-radius: var(--dsw-radius-md, 8px);
  padding: 22px 18px; text-align: center;
  color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.7;
}
.lw-empty-title { color: var(--dsw-alias-label-secondary); font-weight: 600; font-size: 13px; margin-bottom: 4px; }
.lw-skel { display: flex; flex-direction: column; gap: 8px; }
.lw-skel-row {
  height: 14px; border-radius: var(--dsw-radius-xs, 4px);
  background: var(--dsw-alias-bg-layer-2);
  animation: lw-pulse 1.4s ease-in-out infinite;
}
.lw-skel-row.lw-skel-w1 { width: 40%; }
.lw-skel-row.lw-skel-w2 { width: 72%; }
.lw-skel-row.lw-skel-w3 { width: 55%; }
@keyframes lw-pulse { 0%, 100% { opacity: 1 } 50% { opacity: .45 } }
.lw-fallback {
  margin: 16px; padding: 14px 16px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: var(--dsw-radius-md, 8px);
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  white-space: pre-wrap; word-break: break-word;
}
.lw-iconbtn { appearance: none; background: none; border: 0; padding: 0; cursor: pointer; color: inherit; display: block; }
.lw-banner {
  display: flex; align-items: center; gap: 6px; flex: none;
  padding: 5px 12px; font-size: 11px;
  color: var(--dsw-alias-state-warn-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, var(--dsw-alias-bg-layer-1));
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.lw-progress {
  flex: none; height: 3px; background: var(--dsw-alias-bg-layer-2); overflow: hidden;
}
.lw-progress > i {
  display: block; height: 100%; width: 30%;
  background: var(--dsw-alias-brand-primary);
  animation: lw-slide 1.1s ease-in-out infinite;
}
@keyframes lw-slide { 0% { margin-left: -30% } 100% { margin-left: 100% } }
.lw-promptbox {
  width: 100%; min-height: 140px; font-family: var(--dsw-font-family);
  font-size: 12px; line-height: 1.6;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm, 6px);
  padding: 8px; resize: vertical;
}
.lw-toast {
  position: fixed; z-index: 1100; top: 16px; left: 50%; transform: translateX(-50%);
  max-width: min(520px, calc(100vw - 40px));
  padding: 7px 14px; border-radius: var(--dsw-radius-lg, 12px);
  background: var(--dsw-alias-tooltip-bg, var(--dsw-alias-bg-layer-3));
  color: var(--dsw-alias-toast-label, var(--dsw-alias-label-primary-foreground, #fff));
  box-shadow: var(--dsw-shadow-lv3, var(--dsw-elevation-prominent));
  font-size: 12px; line-height: 18px;
  pointer-events: none;
  animation: lw-toast-in .16s ease-out;
}
@keyframes lw-toast-in { from { opacity: 0; transform: translate(-50%, -6px) } to { opacity: 1; transform: translate(-50%) } }
.lw-events { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

@media (prefers-reduced-motion: reduce) {
  .lw-root * { animation: none !important; transition: none !important; }
  .lw-toast { transform: translateX(-50%); }
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

    function EmptyState(props) {
      return h(
        'div',
        { className: 'lw-empty', role: 'status' },
        props.title !== undefined ? h('div', { className: 'lw-empty-title' }, props.title) : null,
        h('div', null, props.text),
        props.extra !== undefined && props.extra !== null ? h('div', { style: { marginTop: 10 } }, props.extra) : null,
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

    function Loading(props) {
      return h('div', { className: 'lw-body' }, h(Skeleton, { rows: props.rows !== undefined ? props.rows : 4 }))
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
            (bad ? '⚠ ' : '') + label,
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
        { className: 'lw-head' },
        h('span', { className: 'lw-title' }, '任务日历'),
        s.version !== null ? h('span', { className: 'lw-ver' }, 'v' + s.version) : null,
        s.pingFailed
          ? h('span', { className: 'lw-ver lw-bad' }, '宿主不可达')
          : s.version !== null
            ? h('span', { className: 'lw-ver lw-ok' }, '已连接')
            : null,
        h(
          'div',
          { className: 'lw-group', 'aria-label': '年份' },
          h('button', { type: 'button', className: 'lw-btn', onClick: () => s.onYear(s.year - 1), title: '上一年' }, '‹'),
          h('span', { className: 'lw-meta', style: { padding: '0 4px' } }, String(s.year)),
          h('button', { type: 'button', className: 'lw-btn', onClick: () => s.onYear(s.year + 1), title: '下一年' }, '›'),
        ),
        h(Segmented, {
          label: '视图',
          value: s.view,
          onChange: s.onView,
          options: [
            { value: 'year', label: '年' },
            { value: 'month', label: '月' },
          ],
        }),
        h(
          'select',
          {
            className: 'lw-field',
            value: s.metric,
            onChange: (e) => s.onMetric(e.target.value),
            'aria-label': '指标',
            title: '热力图指标',
          },
          METRICS.map((m) => h('option', { key: m, value: m }, METRIC_LABEL[m])),
        ),
        h(SourceChips, { sources: s.sources, selected: s.selectedSources, onToggle: s.onToggleSource }),
        h('span', { className: 'lw-spacer' }),
        s.connState === 'open' ? h('span', { className: 'lw-meta', title: '进度通道已连接' }, '● 实时') : null,
        h(
          'button',
          {
            type: 'button',
            className: 'lw-btn',
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
      )
    }

    /** SSE 进度条：连不上就整块不渲染。 */
    function ScanBanner(props) {
      const scan = props.scan
      const progress = props.progress
      if (isObj(progress)) {
        const done = toNum(progress.done)
        const total = toNum(progress.total)
        const phaseText = { scan: '扫描会话', summarize: '生成摘要', digest: '生成简报', remote: '同步远程来源' }[progress.phase] || '处理'
        return h(
          'div',
          { className: 'lw-banner' },
          h('span', null, phaseText + ' ' + done + (total > 0 ? '/' + total : '') + (typeof progress.current === 'string' && progress.current.length > 0 ? ' · ' + progress.current : '')),
          toNum(progress.errors) > 0 ? h('span', null, '· ' + toNum(progress.errors) + ' 处失败') : null,
        )
      }
      if (progress === false && props.refreshing === true) {
        return h('div', { className: 'lw-progress', 'aria-label': '正在更新' }, h('i', null))
      }
      if (isObj(scan) && scan.done === false) {
        return h(
          'div',
          { className: 'lw-banner' },
          '正在回填历史… ' + toNum(scan.scanned) + (toNum(scan.total) > 0 ? '/' + toNum(scan.total) : '') + ' 个会话',
          toNum(scan.failed) > 0 ? h('span', null, '· 失败 ' + toNum(scan.failed)) : null,
        )
      }
      return null
    }

    // ---------------------------------------------------------------------
    // 年视图：53 列 × 7 行热力图
    // ---------------------------------------------------------------------

    const CELL = 12
    const GAP = 3

    function Heatmap(props) {
      const year = props.year
      const days = props.days
      const thresholds = props.thresholds
      const metric = props.metric
      const selected = props.selectedDate
      const today = todayKey()
      const scrollRef = useRef(null)

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

      // 默认滚动位置：让"今天"那一列尽量可见，但最多只滚到一半，
      // 免得年初打开时整屏都在看年末、而前面几个月全在视野外。
      useEffect(() => {
        const el = scrollRef.current
        if (el === null || el === undefined) return
        const start = startOfWeek(new Date(year, 0, 1))
        const todayDate = fromDateKey(today)
        let target = 0
        if (todayDate !== null && todayDate.getFullYear() === year) {
          const week = Math.floor((startOfWeek(todayDate).getTime() - start.getTime()) / 604800000)
          target = week * (CELL + GAP) - el.clientWidth / 2 + CELL
        }
        const max = Math.max(0, el.scrollWidth - el.clientWidth)
        el.scrollLeft = Math.max(0, Math.min(target, max / 2))
      }, [year, today])

      const monthLabels = useMemo(() => {
        const out = []
        let last = -1
        for (let w = 0; w < weeks.length; w += 1) {
          const first = weeks[w][0]
          const m = first.getMonth()
          if (m !== last) {
            last = m
            // 跳过上一月留下的尾巴：只在该月 1 号之后的第一列打标签
            if (first.getDate() <= 7 || w === 0) out.push({ week: w, label: MONTH_LABEL[m] })
          }
        }
        return out
      }, [weeks])

      const width = weeks.length * (CELL + GAP) - GAP
      const height = 7 * (CELL + GAP) - GAP
      const gridTop = 16

      const cells = []
      for (let w = 0; w < weeks.length; w += 1) {
        for (let d = 0; d < 7; d += 1) {
          const date = weeks[w][d]
          const key = dateKeyOf(date)
          const rec = days.get(key)
          const value = rec === undefined ? 0 : toNum(rec.value)
          const level = heatLevel(value, thresholds)
          const pct = level === 0 ? 0 : [0, 25, 45, 68, 100][level]
          const tip =
            key +
            '\n' +
            METRIC_LABEL[metric] +
            '：' +
            fmtNum(value) +
            '\n会话：' +
            (rec === undefined ? 0 : toNum(rec.sessions)) +
            '\n条目：' +
            (rec === undefined ? 0 : toNum(rec.entries)) +
            (rec !== undefined && rec.degraded === true ? '\n（该天摘要降级）' : '')
          cells.push(
            h('button', {
              key: key,
              type: 'button',
              className: 'lw-cell',
              style: {
                left: w * (CELL + GAP),
                top: d * (CELL + GAP),
                '--lw-pct': pct + '%',
              },
              'data-selected': key === selected ? '1' : '0',
              'data-today': key === today ? '1' : '0',
              title: tip,
              'aria-label': tip.replace(/\n/g, '，'),
              onClick: () => props.onPick(key),
            }),
          )
        }
      }

      const legend = h(
        'div',
        { className: 'lw-cell-legend' },
        h('span', { className: 'lw-meta' }, '少'),
        [0, 1, 2, 3, 4].map((lv) =>
          h('span', {
            key: lv,
            className: 'lw-legend-cell',
            style: { '--lw-pct': (lv === 0 ? 0 : [0, 25, 45, 68, 100][lv]) + '%' },
          }),
        ),
        h('span', { className: 'lw-meta' }, '多'),
      )

      return h(
        'div',
        { className: 'lw-heatwrap' },
        h(
          'div',
          { className: 'lw-heatgrid' },
          h(
            'div',
            { className: 'lw-wdcol', style: { paddingTop: gridTop } },
            WD_LABEL.map((w) => h('div', { key: w, className: 'lw-wd', style: { height: CELL + GAP } }, w)),
          ),
          h(
            'div',
            { className: 'lw-scroll', ref: scrollRef },
            h(
              'div',
              { className: 'lw-heat', style: { width: width, height: gridTop + height } },
              h(
                'div',
                { className: 'lw-heat-months', style: { width: width } },
                monthLabels.map((m) => h('span', { key: m.week, className: 'lw-heat-month', style: { left: m.week * (CELL + GAP) } }, m.label)),
              ),
              h('div', { className: 'lw-heat-cells', style: { position: 'relative', top: gridTop, width: width, height: height } }, cells),
            ),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
          h('span', { className: 'lw-meta' }, String(props.year) + ' 年 · ' + fmtNum(props.total) + ' ' + METRIC_LABEL[metric] + ' · ' + props.activeDays + ' 个活跃日'),
          h('span', { className: 'lw-spacer' }),
          legend,
        ),
      )
    }

    // ---------------------------------------------------------------------
    // 月视图
    // ---------------------------------------------------------------------

    function MonthView(props) {
      const monthDate = props.monthDate
      const year = monthDate.getFullYear()
      const month = monthDate.getMonth()
      const days = props.days
      const thresholds = props.thresholds
      const metric = props.metric
      const today = todayKey()

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

      return h(
        'div',
        { className: 'lw-month' },
        h(
          'div',
          { className: 'lw-mgrid' },
          WD_LABEL.map((w) => h('div', { key: w, className: 'lw-mwd' }, '周' + w)),
        ),
        h(
          'div',
          { className: 'lw-mgrid' },
          cells.map((d) => {
            const key = dateKeyOf(d)
            const rec = days.get(key)
            const value = rec === undefined ? 0 : toNum(rec.value)
            const out = d.getMonth() !== month
            const tags = rec !== undefined && Array.isArray(rec.tags) ? rec.tags.slice(0, 2) : []
            const pct = max > 0 ? Math.max(3, Math.round((value / max) * 100)) : 0
            const tip =
              key +
              '\n' +
              METRIC_LABEL[metric] +
              '：' +
              fmtNum(value) +
              '\n会话：' +
              (rec === undefined ? 0 : toNum(rec.sessions)) +
              '\n条目：' +
              (rec === undefined ? 0 : toNum(rec.entries))
            return h(
              'button',
              {
                key: key,
                type: 'button',
                className: 'lw-mcell',
                'data-out': out ? '1' : '0',
                'data-selected': key === props.selectedDate ? '1' : '0',
                'data-today': key === today ? '1' : '0',
                title: tip,
                onClick: () => props.onPick(key),
              },
              h('span', { className: 'lw-mnum' }, String(d.getDate())),
              h('span', { className: 'lw-mbar', 'aria-hidden': true }, h('i', { style: { width: pct + '%' } })),
              h('span', { className: 'lw-mcount' }, value > 0 ? fmtNum(value) + ' ' + METRIC_LABEL[metric] : '—'),
              tags.length > 0 ? h('span', { className: 'lw-mtags' }, tags.map((t, i) => h('span', { key: i, className: 'lw-tag' }, String(t)))) : null,
            )
          }),
        ),
      )
    }

    function MonthHeader(props) {
      const d = props.monthDate
      return h(
        'div',
        { className: 'lw-month-head' },
        h('button', { type: 'button', className: 'lw-btn lw-tiny', onClick: () => props.onMonth(new Date(d.getFullYear(), d.getMonth() - 1, 1)) }, '‹ 上月'),
        h('span', { className: 'lw-month-title' }, d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月'),
        h('button', { type: 'button', className: 'lw-btn lw-tiny', onClick: () => props.onMonth(new Date(d.getFullYear(), d.getMonth() + 1, 1)) }, '下月 ›'),
        h('span', { className: 'lw-spacer' }),
        props.totals !== null && props.totals !== undefined
          ? h('span', { className: 'lw-meta' }, '本月 ' + fmtNum(props.totals.turns) + ' 轮次 · ' + fmtNum(props.totals.sessions) + ' 会话 · ' + fmtNum(props.totals.entries) + ' 条目')
          : null,
      )
    }

    // ---------------------------------------------------------------------
    // 日详情抽屉：来源 → 工作区 → 条目 三层
    // ---------------------------------------------------------------------

    function EntryEditor(props) {
      const entry = props.entry
      const [summary, setSummary] = useState(typeof entry.summary === 'string' ? entry.summary : '')
      const [tag, setTag] = useState(typeof entry.tag === 'string' ? entry.tag : '')
      return h(
        'div',
        { className: 'lw-entry' },
        h('textarea', {
          className: 'lw-field',
          value: summary,
          maxLength: 2000,
          placeholder: '这段时间做了什么（一句话）',
          onChange: (e) => setSummary(e.target.value),
          'aria-label': '条目摘要',
        }),
        h('div', { style: { display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' } }, [
          h('input', {
            key: 'tag',
            className: 'lw-field',
            value: tag,
            maxLength: 40,
            placeholder: '标签（如：重构/调研）',
            style: { flex: 1 },
            onChange: (e) => setTag(e.target.value),
            'aria-label': '条目标签',
          }),
          h(
            'button',
            {
              key: 'save',
              type: 'button',
              className: 'lw-btn lw-tiny',
              disabled: props.busy === true,
              onClick: () => props.onSave({ summary: summary, tag: tag }),
            },
            props.busy === true ? '保存中…' : '保存',
          ),
          h('button', { key: 'cancel', type: 'button', className: 'lw-btn lw-tiny', onClick: props.onCancel }, '取消'),
        ]),
      )
    }

    function EntryCard(props) {
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
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm('删除这条任务条目？')) return
        setBusy(true)
        props.onDelete(e.id).then(() => setBusy(false)).catch(() => setBusy(false))
      }
      if (editing) {
        return h(EntryEditor, { entry: e, busy: busy, onSave: onSave, onCancel: () => setEditing(false) })
      }
      return h(
        'div',
        { className: 'lw-entry' },
        h(
          'div',
          { className: 'lw-entry-head' },
          h('span', { className: 'lw-entry-time' }, fmtRange(e.startTime, e.endTime)),
          e.edited === true ? h('span', { className: 'lw-badge', title: '用户手改过，不会被重算覆盖' }, '已手改') : null,
          e.origin === 'seed' ? h('span', { className: 'lw-meta' }, '降级') : null,
          refs.length > 0 ? h('span', { className: 'lw-meta', style: { marginLeft: 'auto' } }, refs.length + ' 个会话') : null,
        ),
        h('div', { className: 'lw-entry-sum' }, typeof e.summary === 'string' && e.summary.length > 0 ? e.summary : h('span', { className: 'lw-dim' }, '（无摘要）')),
        h(
          'div',
          { className: 'lw-entry-foot' },
          typeof e.tag === 'string' && e.tag.length > 0 ? h('span', { className: 'lw-tag' }, e.tag) : null,
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
          { type: 'button', className: 'lw-btn lw-tiny', onClick: () => setOpen(true) },
          '+ 新增条目',
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
      return h(
        'div',
        { className: 'lw-entry', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('div', { className: 'lw-meta' }, '新增条目 · ' + props.date),
        h('textarea', {
          className: 'lw-field',
          value: summary,
          placeholder: '这段时间做了什么',
          onChange: (e) => setSummary(e.target.value),
          'aria-label': '新条目摘要',
        }),
        h(
          'div',
          { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          h('input', { className: 'lw-field', style: { flex: 1, minWidth: 90 }, value: tag, placeholder: '标签', onChange: (e) => setTag(e.target.value), 'aria-label': '新条目标签' }),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
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
          { style: { display: 'flex', gap: 6, justifyContent: 'flex-end' } },
          h('button', { type: 'button', className: 'lw-btn lw-tiny', onClick: () => setOpen(false) }, '取消'),
          h('button', { type: 'button', className: 'lw-btn lw-tiny', onClick: submit, disabled: busy }, busy ? '新增中…' : '新增'),
        ),
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
        })
      } else {
        body = groups.map((g, gi) => {
          const sourceLabel = typeof g.sourceLabel === 'string' && g.sourceLabel.length > 0 ? g.sourceLabel : String(g.sourceId)
          const workspaces = Array.isArray(g.workspaces) ? g.workspaces : []
          return h(
            'div',
            { className: 'lw-src', key: String(g.sourceId) + ':' + gi },
            h(
              'div',
              { className: 'lw-src-head' },
              g.sourceId === 'local' ? h('span', { className: 'lw-pill' }, '本机') : h('span', { className: 'lw-pill' }, '远程'),
              sourceLabel !== (g.sourceId === 'local' ? '本机' : '') ? h('span', null, sourceLabel) : null,
            ),
            workspaces.length === 0 ? h('div', { className: 'lw-meta' }, '该来源当天没有工作区记录') : null,
            workspaces.map((w, wi) => {
              const entries = Array.isArray(w.entries) ? w.entries : []
              const wt = isObj(w.totals) ? w.totals : {}
              return h(
                'div',
                { className: 'lw-ws', key: String(w.workspacePath) + ':' + wi },
                h(
                  'div',
                  { className: 'lw-ws-head' },
                  h('span', { className: 'lw-ws-title', title: w.workspacePath }, typeof w.workspaceLabel === 'string' && w.workspaceLabel.length > 0 ? w.workspaceLabel : String(w.workspacePath)),
                  h('span', { className: 'lw-meta', style: { marginLeft: 'auto' } }, fmtNum(wt.turns) + ' 轮 · ' + fmtNum(wt.sessions) + ' 会话 · ' + fmtNum(wt.entries) + ' 条'),
                ),
                h('div', { className: 'lw-ws-path', style: { padding: '4px 9px 0' } }, String(w.workspacePath)),
                h(
                  'div',
                  { className: 'lw-entries' },
                  entries.map((e) =>
                    h(EntryCard, {
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
                ),
              )
            }),
          )
        })
      }

      return h(
        'aside',
        { className: 'lw-drawer', 'aria-label': '日详情' },
        h(
          'div',
          { className: 'lw-drawer-head' },
          h('span', { className: 'lw-drawer-title' }, fmtDay(date)),
          totals !== null
            ? h('span', { className: 'lw-meta' }, fmtNum(totals.turns) + ' 轮 · ' + fmtNum(totals.sessions) + ' 会话 · ' + fmtNum(totals.entries) + ' 条')
            : null,
          h('span', { className: 'lw-spacer' }),
          h('button', { type: 'button', className: 'lw-btn lw-tiny', onClick: props.onReload, disabled: fetcher.loading === true }, '刷新'),
          h('button', { type: 'button', className: 'lw-btn lw-tiny', onClick: props.onClose, 'aria-label': '关闭日详情' }, '✕'),
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
            items.map((it, i) =>
              h(
                'div',
                { className: 'lw-ditem', key: i },
                h('div', { className: 'lw-ditem-sum' }, typeof it.summary === 'string' ? it.summary : String(it.summary)),
                typeof it.tag === 'string' && it.tag.length > 0 ? h('span', { className: 'lw-tag', style: { alignSelf: 'flex-start' } }, it.tag) : null,
              ),
            ),
          ),
          h(
            'div',
            { className: 'lw-digest-head', style: { borderTop: '1px solid var(--dsw-alias-border-l1)', borderBottom: 0 } },
            h('span', { className: 'lw-meta' }, '生成于 ' + (fmtDateTime(current.generatedAt) || '未知') + ' · 范围 ' + fmtPeriod(period, kind) + ' · 模型 ' + (isObj(current.model) ? String(current.model.provider) + '/' + String(current.model.model) : String(current.origin || '未知')) + ' · 来源 ' + (Array.isArray(current.sourceIds) && current.sourceIds.length > 0 ? current.sourceIds.join('、') : '全部')),
            h('span', { className: 'lw-spacer' }),
            h('button', { type: 'button', className: 'lw-btn lw-tiny', onClick: generate, disabled: busy === true }, busy === true ? '生成中…' : '重新生成'),
          ),
        )
      } else if (digestResult !== null && digestResult !== undefined && digestResult.ok === true) {
        state = h(EmptyState, {
          title: '还没有这份简报',
          text: '缓存里没有 ' + period + ' 的' + (kind === 'week' ? '周' : '月') + '简报。点「生成」让模型读一遍这段时间的条目，或点「交给智能体」把提示词丢进输入框自己问。',
          extra: h(
            'div',
            { style: { display: 'flex', gap: 8, justifyContent: 'center' } },
            h('button', { type: 'button', className: 'lw-btn', onClick: generate, disabled: busy === true }, busy === true ? '生成中…' : '生成'),
            h('button', { type: 'button', className: 'lw-btn', onClick: agentPrompt, disabled: agentBusy === true }, agentBusy === true ? '准备中…' : '交给智能体'),
          ),
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
              className: 'lw-btn lw-tiny',
              disabled: nextOlder === null,
              title: nextOlder === null ? '没有更早的活动周期' : `跳到上一${unit}（${nextOlder.period}）`,
              onClick: () => nextOlder !== null && props.onPeriod(nextOlder.period),
            },
            '‹',
          ),
          h('span', { className: 'lw-digest-title' }, (kind === 'week' ? '周总结' : '月总结') + ' · ' + period),
          h(
            'button',
            {
              type: 'button',
              className: 'lw-btn lw-tiny',
              disabled: nextNewer === null,
              title: nextNewer === null ? '没有更晚的活动周期' : `跳到下一${unit}（${nextNewer.period}）`,
              onClick: () => nextNewer !== null && props.onPeriod(nextNewer.period),
            },
            '›',
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
                  className: 'lw-btn lw-tiny',
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
          h('button', { type: 'button', className: 'lw-btn lw-tiny', onClick: generate, disabled: busy === true }, busy === true ? '生成中…' : isObj(current) ? '重新生成' : '生成'),
          h('button', { type: 'button', className: 'lw-btn lw-tiny', onClick: agentPrompt, disabled: agentBusy === true }, agentBusy === true ? '准备中…' : '交给智能体'),
          h('button', { type: 'button', className: 'lw-btn lw-tiny', onClick: props.onClose }, '收起'),
        ),
        state,
        promptText.length > 0
          ? h(
              'div',
              { className: 'lw-digest-body' },
              h('div', { className: 'lw-meta' }, '提示词（已尝试写入输入框；没成功就手动复制）'),
              h('textarea', { className: 'lw-promptbox', ref: promptRef, value: promptText, readOnly: true, onFocus: (e) => e.target.select() }),
              h(
                'div',
                { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
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

      /** date → { value, sessions, entries, tags, degraded }，指标已按当前 metric 取值。 */
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
            tags: Array.isArray(row.tags) ? row.tags : [],
            degraded: false,
          })
        }
        const degraded = Array.isArray(stateBody.degradedDays) ? stateBody.degradedDays : []
        for (const d of degraded) {
          if (typeof d !== 'string') continue
          const rec = map.get(d)
          if (rec !== undefined) rec.degraded = true
          else map.set(d, { value: 0, sessions: 0, entries: 0, turns: 0, tags: [], degraded: true })
        }
        return map
      }, [stateBody, metric])

      const thresholds = useMemo(() => {
        const values = []
        for (const rec of dayMap.values()) values.push(rec.value)
        return quantileThresholds(values)
      }, [dayMap])

      const totals = stateBody !== null && isObj(stateBody.totals) ? stateBody.totals : { turns: 0, sessions: 0, entries: 0 }
      const activeDays = useMemo(() => {
        let n = 0
        for (const rec of dayMap.values()) if (rec.value > 0) n += 1
        return n
      }, [dayMap])
      const metricValue = metric === null ? 'turns' : metric
      const totalTokens = isObj(totals.tokens)
        ? toNum(totals.tokens.input) + toNum(totals.tokens.output) + toNum(totals.tokens.cacheRead) + toNum(totals.tokens.cacheWrite) + toNum(totals.tokens.reasoning)
        : 0
      const yearMetric = metricValue === 'tokens' ? totalTokens : toNum(totals[metricValue])

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

      const version = ping !== null && ping !== undefined && typeof ping.version === 'string' ? ping.version : null

      // 8) 主体内容
      let content = null
      if (stateData.loading === true && stateBody === null) {
        content = h(Loading, { rows: 5 })
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
            onPick: setSelectedDate,
          }),
          stateBody !== null && isObj(stateBody) && typeof stateBody.metric === 'string' && stateBody.metric !== metricValue
            ? h('div', { className: 'lw-meta', style: { marginTop: 8 } }, '（宿主侧当前档位：' + METRIC_LABEL[stateBody.metric] + '）')
            : null,
          h('div', { className: 'lw-meta', style: { marginTop: 8 } }, '点任意格子看当天条目'),
        )
      } else {
        content = h(
          'div',
          { className: 'lw-main' },
          h(MonthHeader, { monthDate: monthDate, onMonth: setMonthDate, totals: totals }),
          h('div', { style: { height: 8 } }),
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
          onYear: setYear,
          onView: setView,
          onMetric: setMetric,
          onToggleSource: onToggleSource,
          onRefresh: onRefresh,
          onDigest: openDigest,
        }),
        h(ScanBanner, { scan: scan, progress: progress, refreshing: refreshing }),
        h(ToastHost, null),
        digestOpen !== null
          ? h(
              'div',
              { style: { padding: '12px 12px 0' } },
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
          h(Boundary, { label: '日历主体' }, content),
          selectedDate !== null
            ? h(
                Boundary,
                { label: '日详情' },
                h(DayDetail, {
                  date: selectedDate,
                  sources: sources,
                  useDay: dayFetch,
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
