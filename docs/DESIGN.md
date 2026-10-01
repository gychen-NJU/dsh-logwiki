# dsh-LogWiki · 视觉与交互契约（Operate 模式「年度台账」）

> **这份文件是唯一的设计依据。**
> `ui-crafter` 照它写 `dsh-logwiki/lib/client.js`；`ui-reviewer` 照它逐条核对。
> 凡是本文没写到的样式与交互，实现者**不要自作主张**——要么按最近条款类推，要么在评审里提出。
>
> 本轮范围：**只改 `dsh-logwiki/lib/client.js`**。零接口变更、零 Host 改动。

---

## 0. 范围与红线

| # | 红线 | 判据 |
|---|---|---|
| R0.1 | **不改任何接口** | Host 路由表仍是 **22 个端点**，一个不多一个不少：`/ping` `/health` `/state` `/day` `/refresh` `/events` `/entry` `/entry/add` `/entry/delete` `/digests` `/digests/available` `/digests/periods` `/digest/generate` `/digest/agent-prompt` `/summarize/probe` `/sources` `/source/discover` `/source/add` `/source/delete` `/source/prompt` `/source/sync` `/source/sync-status` |
| R0.2 | 不改守卫契约 | 变更类端点仍须 `POST` + 头 `x-logwiki: 1`；`OPTIONS` → 405；非 POST → 405 |
| R0.3 | 不改 SSE 契约 | 事件名仍是 `progress`，字段仍是 `{phase,done,total,current,errors,finished}` |
| R0.4 | 不改槽位契约 | `sidebar.panellist` id=`logwiki` order=`40`；`main` key=`logwiki`；`conversation.input.overlay` id=`logwiki-composer` order=`90` |
| R0.5 | 不改数据形状 | 前端不得假设 `/state.heatmap[]` 上有 `tags`（Host 不下发，见 `lib/fold.js` 的 `buildState`），也不得要求 Host 新增字段 |
| R0.6 | 文案全中文 | 新增/修改的可见文案一律中文；版本号、`Token`、`SSH`、`WSL`、`DSH`、`DSH_HOME` 等专有名词除外 |
| R0.7 | 颜色只走 token | 颜色、圆角、字号、行高、阴影、焦点环**必须**用 `--dsw-*` token（见 §2.1）。**唯一**允许写死的颜色是 §1.3 的 `--dsw-lw-heat` 声明处 |
| R0.8 | 间距与尺寸不设 token | 平台 405 个 `--dsw-*` 里**没有**任何 `space` / `gap` / `size` 类 token；因此 padding / gap / width / height 直接用**4 的倍数像素**（4/8/12/16/24/28） |
| R0.9 | 公开仓库红线 | 文档与代码中不出现本机用户名、盘符路径 |

**主题基线（实测，来自 DSH 应用包 `app.asar`）**：`body` 是浅色主题（113 个别名 token），`body[data-ds-dark-theme]` 是深色主题（113 个）。下表所有「浅/深」实测值都来自这两处。

---

## 1. 设计意图

### 1.1 一句话

把年视图从「一块热力图 + 一堆浮在旁边的数字」改成**一本可以翻的年度台账**：左边是量的分布（热力图），右边是低对齐度的度量表（216px 台账栏），日详情从「三层嵌套卡片」改成**行式台账**。

### 1.2 四个改造点

1. **热力图数据自适应**——列宽不再写死 12px，而是按容器宽度算出来并 clamp 到 `[8, 22]px`，宽窗用满、窄窗触底（§3.2）。
2. **颜色职责分离**——绿色只再说一件事：「量有多大」（§1.3）。
3. **日详情去嵌套卡片 → 行式台账**——来源 / 工作区 / 条目三层从「盒子套盒子」压成「有缩进层级的行」（§5）。
4. **释放空间给年度台账与月份轴**——主区右侧固定 216px 台账栏；月份轴从 10px 提到 12px 并解决碰撞（§3.4、§3.5）。

### 1.3 颜色职责分离（本轮最重要的一条）

**病：什么都发绿。** 现在绿色同时承担了五种彼此无关的含义，用户没法从颜色判断"这是数据还是按钮"：

| 绿色今天被用在哪 | 现状问题 | 改用什么 |
|---|---|---|
| 热力图色阶（量） | ✅ 正确用途 | **保留**：`--dsw-lw-heat`（fallback `#39d353`） |
| 月视图强度条 `i` | ✅ 正确用途 | **保留**：`--dsw-lw-heat` |
| 工具栏「已连接」徽章文字 `.lw-ok` | 绿**文字**在浅色主题实测只有 **2.28:1**，根本读不清 | 文字改 `--dsw-alias-label-secondary`；「已连接」的**语义**改用一枚 6px 绿点 + `--dsw-alias-state-success-primary` 承担（非文字）。该点必须 `aria-hidden="true"`——它只是**装饰性强化**，语义由「已连接」三个字承载，不是唯一信息通道 |
| 标签 chip（`.lw-tag`、`.lw-mchip`） | 标签是**分类**，不是量；绿色让它看起来像"这个标签很多" | **中性化**：透明底 + 0.5px `--dsw-alias-border-l3` 边框 + `--dsw-alias-label-secondary` 文字 |
| 主操作按钮 / 选中态 / 今天 | 主操作 = 可点，与"数据多"完全无关；且 `brand-primary` 才是平台的品牌色 | **`--dsw-alias-brand-primary`** |

三条硬规则：

- **R1｜活动绿阶只表达「量」。** `--lw-heat`（= `--dsw-lw-heat`，fallback `#39d353`）只有两处允许消费：热力图色阶（§3.3）与月视图强度条（§4.2）。其他地方出现绿色即评审不通过。
- **R2｜主操作与选中态用 `--dsw-alias-brand-primary`。** 实测该 token 在本应用是**单色品牌色**：浅色 `#0f1115`、深色 `#f9fafb`；其配套前景色是 `--dsw-alias-label-primary-foreground`（浅色 `#fff`、深色 `#0f1115`），配对实测对比度 18.90:1 / 18.08:1。用于：主按钮底、分段控件选中底、来源 chip 选中底、热力图格子选中环、月视图今天边框、月视图今日日号。
- **R3｜标签 chip 中性。** 见上表。

> **为什么不用 `--dsw-alias-state-success-primary` 做主色**：它实测就是 `green-500 (#22c55e)`，是平台的**成功/语义色**，职责已被"成功"占满；再拿它当主操作色，就又回到"什么都发绿"。

---

## 2. 全局样式基座

### 2.1 token 清单（实现时会用到的全部）

「浅 / 深」是实测解析值；`fallback` 是必须写进 `var()` 的兜底（宿主换版时仍可读）。

| 用途 | token | 浅色实测 | 深色实测 | 兜底 |
|---|---|---|---|---|
| 页面底 | `--dsw-alias-bg-base` | `#ffffff` | `#151517` | `#ffffff` |
| 层级 1（头部/抽屉底） | `--dsw-alias-bg-layer-1` | `#ffffff` | `#232324` | 无 |
| 层级 2（次级面板底） | `--dsw-alias-bg-layer-2` | `#ffffff` | `#2c2c2e` | 无 |
| 层级 3（悬浮底） | `--dsw-alias-bg-layer-3` | `#ffffff` | `#353638` | 无 |
| 空档格子底 | `--dsw-alias-bg-skeleton` | `#0000000a` | `#ffffff14` | `--dsw-alias-bg-layer-2` |
| 正文 | `--dsw-alias-label-primary` | `#0f1115` | `#f9fafb` | 无 |
| 次要文字 / **占位** | `--dsw-alias-label-secondary` | `#61666b` | `#cfd3d6` | 无 |
| 装饰性文字（**受限**，见 §2.7） | `--dsw-alias-label-tertiary` | `#81858c` | `#adb2b8` | 无 |
| 主按钮/选中态上的前景 | `--dsw-alias-label-primary-foreground` | `#ffffff` | `#0f1115` | `#fff` |
| 分隔线 | `--dsw-alias-border-l1` | `#0000000a` | `#ffffff0f` | 无 |
| 控件边框 | `--dsw-alias-border-l2` | `#0000001a` | `#ffffff1f` | `--dsw-alias-border-l1` |
| chip 边框 | `--dsw-alias-border-l3` | `#0000001f` | `#ffffff29` | `--dsw-alias-border-l2` |
| hover 底 | `--dsw-alias-interactive-bg-hover` | `#2631480f` | `#ffffff14` | `--dsw-alias-bg-layer-3` |
| 按下底 | `--dsw-alias-interactive-bg-active` | `#2631481a` | `#ffffff24` | `--dsw-alias-interactive-bg-hover` |
| 工具栏按钮底 | `--dsw-alias-button-tool-bar-fill` | `#54555780` | `#54555780` | `--dsw-alias-bg-layer-2` |
| 品牌 / 主操作 / 选中 | `--dsw-alias-brand-primary` | `#0f1115` | `#f9fafb` | `#4d6bfe` |
| 焦点环颜色 | `--dsw-focus-ring-color` | 由平台 `focus.css` 提供 | 同左 | `--dsw-alias-state-business-primary` |
| 焦点环宽度 | `--dsw-focus-ring-width` | `2px` | `2px` | `2px` |
| 错误 | `--dsw-alias-state-error-primary` | `#ec1313` | `#f25a5a` | `#d54941` |
| 成功（**只做色块/点**） | `--dsw-alias-state-success-primary` | `#22c55e` | `#22c55e` | 无 |
| 警告 | `--dsw-alias-state-warn-primary` | `#f59e0b` | `#f59e0b` | 无 |
| 提示气泡底 | `--dsw-alias-tooltip-bg` | `#2c2c2e` | `#43454a` | `--dsw-alias-bg-layer-3` |
| 轻提示底 / 文字 | `--dsw-alias-toast-bg` / `--dsw-alias-toast-label` | `#353638` / `#fff` | `#43454a` / `#fff` | `--dsw-alias-bg-layer-3` / `#fff` |
| 滚动条轨道（细/粗） | `--dsw-alias-scrollbar-bg-l1` / `-bg-l2` | `#e5e5e5` / `#e5e5e5` | `#3c3c3d` / `#545557` | 无 |
| 滚动条 hover | `--dsw-alias-scrollbar-hover-l1` / `-hover-l2` | `#d4d4d4` / `#d4d4d4` | `#545557` / `#65676b` | 无 |
| 文档选区 | `--dsw-alias-bg-document-selection` | `color-mix(blue-500 40%, transparent)` | 同左 | 无 |
| 圆角 小/中/大 | `--dsw-radius-xs` / `-sm` / `-md` | `4px` / `8px` / `12px` | 同左 | `4px` / `8px` / `12px` |
| 阴影 | `--dsw-shadow-lv3` / `--dsw-elevation-prominent` | 平台值 | 平台值 | `--dsw-elevation-prominent` |
| 字体族 | `--dsw-font-family` | 平台值 | 平台值 | 无 |
| 字号 12 / 13 / 14 | `--dsw-font-xxs-12-font-size` / `--dsw-font-xs-13-font-size` / `--dsw-font-s-14-font-size` | `12px` / `13px` / `14px` | 同左 | `12px` / `13px` / `14px` |
| 行高 12 / 13 / 14 | `--dsw-font-xxs-12-line-height` / `--dsw-font-xs-13-line-height` / `--dsw-font-s-14-line-height` | `18px` / `20px` / `22px` | 同左 | `18px` / `20px` / `22px` |
| **插件自有**活动绿阶根 | `--dsw-lw-heat` | `#39d353` | `#39d353` | `#39d353` |
| **插件自有**消费别名 | `--lw-heat` | `var(--dsw-lw-heat)` | 同左 | 无 |

> ⚠️ `--dsw-lw-heat` **不是平台 token**（`app.asar` 内 0 处声明），是插件自有的色阶根。
> 它**只允许在 `.lw-root` 里声明一次**；`#39d353` 这个字面量在整个 `client.js` 里**只出现 1 次**。
> 组件内部一律消费短别名 `--lw-heat`（与既有的 `--lw-pct` / `--lw-empty` 命名同族）：
>
> ```css
> .lw-root {
>   --dsw-lw-heat: #39d353;          /* ← 全文件唯一的写死颜色，就在这一行 */
>   --lw-heat: var(--dsw-lw-heat);   /* ← 组件只认这个短别名 */
>   --lw-empty: var(--dsw-alias-bg-skeleton, var(--dsw-alias-bg-layer-2));
> }
> ```
>
> 这样写有两个好处：① `#39d353` 不需要在每个使用点重复当 fallback；② 想把绿阶整体换成别的色系时，只改一行。
> **`--lw-heat` 的消费点只有两处**（§1.3 R1）：热力图色阶、月视图强度条。

### 2.2 字号与行高

| 层级 | 字号 token | 值 | 行高 | 用在哪 |
|---|---|---|---|---|
| L1 面板标题 | `--dsw-font-s-14-font-size` | 14px | 22px | 「任务日历」标题、台账栏年份 |
| L2 区块标题 | `--dsw-font-xs-13-font-size` | 13px | 20px | 抽屉标题、月视图月份标题、简报标题、条目摘要、度量表数值 |
| L3 正文/元信息 | `--dsw-font-xxs-12-font-size` | 12px | 18px | 工具栏控件、chip、度量表标签、图例、月份轴、星期栏、时间、路径、空态 |
| — | — | **12px 是硬下限** | — | **任何可见文字不得小于 12px**（`--dsw-font-xxxs-11-font-size` = 11px 存在但**禁止使用**） |

> 现状里 `10px` / `11px` 的用法（月份标签、星期栏、图例、`.lw-tag`、`.lw-meta`、`.lw-ver`、`.lw-wd`、`.lw-mnum`…）**全部要提到 12px**。

### 2.3 数字一律等宽

**所有数字**（日期、日号、计数、Token、时长、百分比、年份）必须带：

```css
font-variant-numeric: tabular-nums;
```

实现方式：在 `.lw-root` 上统一声明 `font-variant-numeric: tabular-nums;`，需要时用 `.lw-num` 再强调一次。**不要**逐个元素零散地加。

### 2.4 间距尺度

4 / 8 / 12 / 16 / 24（px），只用这五个值。约定：

| 位置 | 值 |
|---|---|
| 头部内边距 | `9px 12px` |
| 主区内边距 | `12px` |
| 区块之间 | `12px` |
| 区块内边距 | `10px 12px` |
| 行内元素间隙 | `6px` |
| 紧凑控件组内间隙 | `2px` |

### 2.5 圆角

| 元素 | token | 值 |
|---|---|---|
| 行内小控件、标签 chip、格子 | `--dsw-radius-xs` | 4px（格子见 §3.3 例外） |
| 输入框、按钮、分段组、行容器 | `--dsw-radius-sm` | 8px |
| 卡片、抽屉区块 | `--dsw-radius-md` | 12px |
| 胶囊（来源 pill、徽章） | `999px` | — |

> 现状把 `--dsw-radius-sm` 的兜底写成 `6px`、`--dsw-radius-md` 写成 `8px`，**与实测不符**（8px / 12px），必须改正兜底值。

### 2.6 浏览器表面（四个必需项）

```css
.lw-root { caret-color: var(--dsw-alias-brand-primary, #4d6bfe); }

.lw-root ::selection {
  background: var(--dsw-alias-bg-document-selection, color-mix(in srgb, #3b82f6 40%, transparent));
  color: inherit;
}

/* 主题化滚动条：细轨 + 粗轨 + 两级 hover，全部走 token */
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
/* 横向滚动（<700px 的热力图）用 l1 一档，视觉上更轻 */
.lw-scroll::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l1); }
.lw-scroll::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l1); }
```

**焦点环（唯一正确写法）**：平台的 `focus.css` 已经全局给 `:focus-visible` 上了 `outline-width: var(--dsw-focus-ring-width)`（=2px）与 `outline-color: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))`。所以插件：

- ✅ **推荐**：只补 `outline-offset: 2px`。
- ✅ 允许：显式写 `outline-width` / `outline-color` / `outline-offset` 三个**长手写属性**。
- ❌ **禁止**：`outline: 2px solid …` 这类**简写**——它会覆盖平台的 `html[data-input-modality=pointer]` 抑制规则（鼠标点击时平台会把环设为透明），导致鼠标用户看到一圈永远消不掉的框。

统一写法：

```css
.lw-btn:focus-visible,
.lw-chip:focus-visible,
.lw-cell:focus-visible,
.lw-mcell:focus-visible,
.lw-field:focus-visible,
.lw-linkbtn:focus-visible {
  outline-width: var(--dsw-focus-ring-width, 2px);
  outline-color: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-style: solid;
  outline-offset: 2px;   /* 硬性要求 */
}
```

### 2.7 对比度与「文字安全色」

WCAG 2.1 AA：正文与占位 **≥4.5:1**；≥18.66px 加粗或 ≥24px 的大字 **≥3:1**。本界面**没有**任何大字号文字（最大 14px），所以**全部按 4.5:1 执行**。

实测（浅色底 `#fff` / 深色底 `#151517`）：

| 前景 | 浅色 | 深色 | 能不能做文字 |
|---|---|---|---|
| `--dsw-alias-label-primary` | **18.90:1** | **17.45:1** | ✅ 两主题都安全 |
| `--dsw-alias-label-secondary` | **5.80:1** | **12.11:1** | ✅ 两主题都安全（**占位文字用它**） |
| `--dsw-alias-label-tertiary` | **3.71:1** ❌ | 8.54:1 ✅ | ⚠️ 只允许深色主题下当次要文字；**浅色下不得承载任何需要读清的信息** |
| `--dsw-alias-label-caption` | 2.13:1 ❌ | 4.92:1 ✅ | ❌ 禁止做文字 |
| `--dsw-alias-state-success-primary` | 2.28:1 ❌ | 8.00:1 ✅ | ❌ 禁止做文字（只能做色块/圆点） |
| `--dsw-alias-state-warn-primary` | 2.15:1 ❌ | 8.49:1 ✅ | ❌ 同上 |
| `--dsw-alias-state-error-primary` | 4.50:1 ✅ | 5.55:1 ✅ | ✅ 可做文字（浅色恰好达标，**不得再叠任何降低对比的底**） |
| `--dsw-alias-link` / `--dsw-alias-state-business-primary` | 4.23:1 ❌ | 7.83:1 ✅ | ⚠️ 浅色下不足 4.5，链接类文字必须**同时**带下划线（WCAG 1.4.1），或改用 `label-secondary` |

**由此推出三条实现纪律：**

1. 占位符 `::placeholder` 用 `--dsw-alias-label-secondary`（浅色 5.80:1），**不许**用 `label-tertiary`。
2. 一切「状态」先由**非文字**承载（6px 圆点、1px 边框、色块），文字本身用 `label-primary` / `label-secondary`。
3. `--dsw-alias-label-tertiary` 只留给**不承载信息**的装饰（分隔点、非关键的编号）。

### 2.8 动效契约

**只有一个"作者时刻"：选中。** 其余全是功能性的状态过渡。

| 场景 | 时长 | 缓动 | 属性 |
|---|---|---|---|
| **选中**（格子、日历格、chip、分段） | **120ms** | `ease-out` | `background-color, border-color, box-shadow, color` |
| **抽屉开合**（日详情进出） | **180ms** | `ease-out` | `width, opacity`（**不做** transform 位移，避免和滚动容器打架） |
| 其余一切 hover / 按下 / 聚焦 | **150ms** | `ease-out` | `background-color, border-color, color` |

硬规则：

- 时长只能是 **120 / 150 / 180** 三个值，不允许出现第四个数。
- **不做加载编排动效**：不许 stagger（逐条延迟入场）、不许骨架屏以外的入场动画、不许列表项 `animation-delay`。
- 骨架屏的 `lw-pulse` 呼吸保留（它是等待反馈，不是装饰），但周期用 `1.4s`，且在 reduced-motion 下关闭。
- `prefers-reduced-motion: reduce` 下**全部关闭**：

```css
@media (prefers-reduced-motion: reduce) {
  .lw-root *, .lw-root *::before, .lw-root *::after {
    animation: none !important;
    transition: none !important;
  }
}
```

### 2.9 响应式断点

| 断点 | 行为 |
|---|---|
| **≥1080px** | 主区（`flex:1`）+ **216px 台账栏**（右，`flex:none`，`border-left: 1px var(--dsw-alias-border-l1)`）；指标用**分段控件**（4 段） |
| **900–1080px** | 台账栏离开右栏，退成主区**下方**的一行汇总带（高 44px，度量横排，数值右对齐）；指标仍是分段控件 |
| **<900px** | 工具栏**两段换行**：第一段 = 标题 + 版本/连接徽章 + 年份导航；第二段 = 视图切换 + 指标 + 来源 chips + 更新 + 周/月总结。**指标分段控件退回 `<select>`**（用同一份 `METRICS`/`METRIC_LABEL`） |
| **<700px** | 格子触底 **8px**；热力图**开主题化横向滚动**（`overflow-x: auto`）；**隐藏台账栏与活动索引** |

**「活动索引」的定义**（避免歧义）：**月份轴标签行 + 左侧星期栏 + 右下档位图例**，这三者合称活动索引。<700px 时三者全部隐藏，只留网格本身。

---

## 3. 年视图

### 3.1 结构

```
.lw-split
├── .lw-main                     主区（flex:1, min-width:0, overflow:auto, padding:12px）
│   └── .lw-heatwrap
│       ├── .lw-heatgrid         左：星期栏 24px │ 右：.lw-scroll
│       │                                        └── .lw-heat
│       │                                            ├── .lw-heat-months  月份轴（绝对定位）
│       │                                            └── .lw-heat-cells   53×7 格子
│       └── .lw-heat-foot        左：年度摘要文字   右：图例
└── .lw-ledger                   216px 台账栏（≥1080px）
```

### 3.2 自适应公式（必须照做）

设：

- `W` = `.lw-heatgrid` 内容盒宽度（**实测**，见下）
- `WDCOL` = 星期栏宽度 = `24px`（<700px 时为 `0`，因为星期栏隐藏）
- `COL` = `53`（固定 53 列）
- `GAP` = `3px`
- `CELL_MIN` = `8px`，`CELL_MAX` = `22px`

```
列宽 = clamp( (容器宽 − 星期栏 − GAP × (COL − 1)) / COL , 8 , 22 )      ← CELL
行高 = CELL + GAP
网格宽 = COL × CELL + (COL − 1) × GAP
网格高 = 7 × (CELL + GAP) − GAP
```

> 需求给的书写形式是 `列宽 =(容器宽 - 星期栏 - 11*gap)/53`。其中 `gap` 项的系数按**53 列之间共 52 条缝**定为 `52`；`11` 在任何列数下都对不上一个自洽的网格，按笔误处理。C16 验收的是**结果**（`网格宽 ≤ 容器宽`），不是这个常数。

**实现要求**：`W` 必须**实测**，不能拿 `window.innerWidth` 减常数。用 `ResizeObserver` 观察 `.lw-heatgrid`，把 `contentRect.width` 存进 state，再由它推导 `CELL`；`CELL` 变化时重算所有格子的 `left/top` 与容器宽高。

**关键数字（写进注释，便于核对）**：

- 格子触底时网格最小宽 = `53×8 + 52×3` = **580px**；加星期栏 24px → **604px**。
- 即：容器 < 604px 时**必然**出现横向滚动；容器 ≥ 604px 且计算值 ≤ 22px 时**必然**没有横向滚动。

**判据（C16 用）**：

- 视口 1440 / 1280 / 1080px：`.lw-scroll` 满足 `scrollWidth <= clientWidth + 1`（**宽窗不出现横向滚动条**）。
- 视口 640px：`.lw-cell` 的 `getBoundingClientRect().width === 8`（触底），且 `.lw-scroll` 出现横向滚动。

### 3.3 格子

| 属性 | 值 |
|---|---|
| 尺寸 | `CELL × CELL`（§3.2），`position:absolute`，`left = 列×(CELL+GAP)`，`top = 行×(CELL+GAP)` |
| 圆角 | `CELL < 16` → `2px`；`CELL ≥ 16` → `--dsw-radius-xs`(4px) |
| 0 档（无活动） | 底 `var(--lw-empty)`，并且**必须**带 1px 内描边（见下「基础」行）——浅色主题下 `bg-base`/`bg-layer-*` 实测都是 `#fff`，没有这圈线空格子会整个隐形 |
| 1–4 档底 | `color-mix(in srgb, var(--lw-heat) P%, var(--lw-empty))`，`P = 25 / 45 / 68 / 100` |
| 档位可区分性 | 相邻档位 `P` 差 ≥ 20 个百分点（25→45→68→100 依次差 20/23/32）✅ |
| **基础**（所有格子） | `box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l1)` —— 保证 53×7 网格线可见 |
| hover | 内描边换成 `--dsw-alias-label-primary`；`transition 150ms` |
| 今天 | 内描边换成 `--dsw-alias-label-secondary` |
| **选中** | 基础内描边 **+ 品牌色外环**：`box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l1), 0 0 0 2px var(--dsw-alias-brand-primary)` |
| 降级（degraded） | 内描边换成 `--dsw-alias-state-warn-primary` |
| focus-visible | §2.6 统一写法（走 **`outline`**，与 `box-shadow` 不同属性，互不冲突），`outline-offset: 2px` |
| **覆盖优先级** | `选中 > 今天 > 降级 > hover > 基础`；同一格同时命中多条时按此取**一条** `box-shadow` 声明，不要叠加成多条规则互相覆盖 |

> 实现建议：只写 4 条规则——`.lw-cell`（基础）、`.lw-cell:hover`、`.lw-cell[data-today="1"]`、`.lw-cell[data-selected="1"]`（最后一条声明完整的两层 `box-shadow`），并让选择器优先级自然满足上表顺序。

| 无障碍 | `role="gridcell"`；`aria-label` = 日期 + 指标名 + 数值 + 会话数 + 条目数；`title` 同文本（换行分隔） |

**格子只允许出现绿色与中性色**——选中环是品牌单色（浅黑/深白），今天环是 `label-secondary`，都不发绿。

### 3.4 月份轴

- 位置：绝对定位，`left = 该月第一周列号 × (CELL + GAP)`，行高 18px，`top: 0`。
- 字体：`--dsw-font-xxs-12-font-size`（**12px**，不再是 10px），颜色 `--dsw-alias-label-secondary`。
- **碰撞规则（必须实现）**：从左往右渲染，只有当与前一个已渲染标签的左边缘距离 **≥ 30px** 时才渲染该标签；否则跳过。避免 `CELL=8px` 时「1月」「2月」叠在一起。
- 标签文本：`1月`…`12月`（沿用 `MONTH_LABEL`）。
- 网格顶部留白 `gridTop = 20px`（月份轴 18px + 2px 间隙）。

### 3.5 年度台账栏（`.lw-ledger`）

**它是低对齐度的度量表，不是大数字 hero 模板。**

| 属性 | 值 |
|---|---|
| 宽度 | `216px`，`flex: none`，`border-left: 1px solid var(--dsw-alias-border-l1)` |
| 内边距 | `12px` |
| 标题 | 年份（`--dsw-font-xs-13-font-size`，`--dsw-alias-label-secondary`，字重 500） |
| 每一行 | `display:flex; justify-content:space-between; align-items:baseline; height:28px; border-bottom:1px solid var(--dsw-alias-border-l1)` |
| 行标签 | `--dsw-font-xxs-12-font-size`，`--dsw-alias-label-secondary` |
| 行数值 | `--dsw-font-xs-13-font-size`，`--dsw-alias-label-primary`，字重 **500**，`tabular-nums`，右对齐 |
| 行内容 | 轮次 / 会话 / 条目 / Token / 活跃日 / 最忙一天 / 平均每活跃日（7 行，取不到就显示 `—`） |

**禁止清单（评审逐条核对）**：

- ❌ 数值字号 > 14px
- ❌ 数值字重 ≥ 700
- ❌ 渐变（`linear-gradient`）、阴影（`box-shadow` 除分隔线外）、发光
- ❌ hero 式居中大数字 + 小标签的排版
- ❌ 与主区争抢宽度（必须 `flex:none`）

> 台账栏的数字来自现有 `/state` 的 `totals` 与 `heatmap`，**不引入任何新字段**。Token 合计沿用现有口径：`input+output+cacheRead+cacheWrite+reasoning`。

### 3.6 年视图状态清单

| 状态 | 触发 | 视觉 | token |
|---|---|---|---|
| **default** | 有数据 | 53×7 网格，0 档灰、1–4 档绿阶 | §3.3 |
| **hover** | 指针进入格子 | 1px 内描边变 `label-primary`；`transition 150ms` | `--dsw-alias-label-primary` |
| **focus-visible** | Tab / 方向键落到格子 | 2px 环 + `outline-offset: 2px` | §2.6 |
| **active** | 按住格子 | 内描边 2px（比 hover 粗一档），不位移 | `--dsw-alias-label-primary` |
| **selected** | 已选中的那一天 | 2px 品牌色外环；再点一次不取消（保持"当前焦点"语义） | `--dsw-alias-brand-primary` |
| **disabled** | 日期落在年份之外（第 1 列/第 53 列里属于邻年的格子） | `opacity: .35`；`tabIndex=-1`；不可点 | — |
| **loading** | `/state` 首次加载 | 主区显示骨架屏（6 行，宽度 40/72/55% 循环），台账栏显示 7 行骨架 | `--dsw-alias-bg-layer-2` + `lw-pulse` |
| **error** | `/state` 非 200 且无缓存 | 主区显示 `DataUnavailable` 卡：`--dsw-alias-state-error-primary` 边框 + 文案「数据源未就绪」+「重试」按钮 | `--dsw-alias-state-error-primary` |
| **empty** | 有数据但整年 0 活动 | 网格照常渲染（全 0 档），台账栏数值为 0，底部提示「这一年还没有记录。点右上角「更新」先回填历史。」 | `--dsw-alias-label-secondary` |
| **degraded** | 某天摘要降级（`degradedDays`） | 该格 `box-shadow` 内描边换成 `--dsw-alias-state-warn-primary`；tooltip 追加「（该天摘要降级）」 | `--dsw-alias-state-warn-primary` |

---

## 4. 月视图

### 4.1 结构

```
.lw-month
├── .lw-month-head      ‹ 上月 │ 2026 年 9 月 │ 下月 › │ 本月合计
└── .lw-mgrid ×2        第一行：周一周二…周日（12px）
                        第二行：42 个 .lw-mcell
```

### 4.2 单元格

| 属性 | 值 |
|---|---|
| 尺寸 | 7 列等分（`grid-template-columns: repeat(7, minmax(0,1fr))`），`gap: 4px`，`min-height: 84px`，`padding: 6px 8px` |
| 边框 | `1px solid var(--dsw-alias-border-l1)`，圆角 `--dsw-radius-sm`(8px) |
| 日期号 | `--dsw-font-xxs-12-font-size`，`--dsw-alias-label-secondary`，`tabular-nums` |
| 强度条 | 高 4px，轨道 `--dsw-alias-bg-layer-2`，填充 **`var(--lw-heat)`**（量的表达，R1 允许的第二处） |
| 数值 | `--dsw-font-xxs-12-font-size`，`--dsw-alias-label-primary`，`tabular-nums`；0 值显示 `—` 且用 `--dsw-alias-label-secondary` |
| **标签 chip** | **删掉**。`/state.heatmap[]` 不下发 `tags`（R0.5），现有 `row.tags` 恒为空数组，是死代码。空间让给日号 + 强度 + 数值 |
| 非本月格 | `opacity: .45` |
| 今天 | 边框 `1px solid`，日期号用 `--dsw-alias-brand-primary` + 字重 600 |
| 选中 | 边框 2px 实心 `--dsw-alias-brand-primary`（用 `box-shadow: 0 0 0 1px` 内缩，避免布局跳动） |
| hover | 底 `--dsw-alias-interactive-bg-hover`，`150ms` |
| focus-visible | §2.6 统一写法 |

### 4.3 状态清单

| 状态 | 触发 | 视觉 |
|---|---|---|
| default | 有数据 | 42 格，非本月淡出 |
| hover | 指针进入 | 底变 `interactive-bg-hover` |
| focus-visible | 键盘 | 2px 环 + offset 2px |
| active | 按住 | 底 `interactive-bg-active` |
| selected | 已选 | 品牌色 2px 边框 |
| disabled | 无（本月视图所有格都可点） | — |
| loading | `/state` 加载中 | 42 格骨架（`bg-skeleton` 底 + `lw-pulse`） |
| error | `/state` 失败 | 同 §3.6 error，换成月视图容器 |
| empty | 当月 0 活动 | 42 格全 0 档，数值全 `—`，头部显示「本月 0 轮次 · 0 会话 · 0 条目」 |

---

## 5. 日详情抽屉（**行式台账**）

### 5.1 目标：消灭嵌套卡片

**现状问题**：来源（`.lw-src`）→ 工作区（`.lw-ws`，有边框+圆角+底色）→ 条目（`.lw-entry`，又有边框+圆角+底色）= 三层盒子，视觉噪音大、有效宽度被吃掉两轮。

**改造后**：**没有任何一层是卡片**，层级靠**缩进 + 分隔线**表达。

```
.lw-drawer                360px（max-width: 46vw），左边框 1px
├── .lw-drawer-head        日期 │ 合计 │ 刷新 │ ✕
└── .lw-drawer-body
    ├── .lw-src-row        「本机」pill + 来源名（小号大写间距，12px）
    │   ├── .lw-ws-row     工作区名 · N 轮 · N 会话        ← 12px，label-secondary
    │   │   └── .lw-entry-row × N                          ← 行式台账
    │   │       ├── 行首：时间(12px tabular) │ chip │ 徽章 │ … │ 编辑 删除
    │   │       └── 行身：摘要 13px/1.55 label-primary
    │   └── .lw-add-row    新增条目（行内表单）
    └── .lw-src-row × N
```

### 5.2 尺寸与 token

| 元素 | 规范 |
|---|---|
| 抽屉宽 | `360px`，`max-width: 46vw`，`border-left: 1px solid var(--dsw-alias-border-l1)`，底 `--dsw-alias-bg-layer-1` |
| 抽屉头 | `9px 12px`，底部 1px `--dsw-alias-border-l1` |
| 抽屉体 | `padding: 0 0 20px`（**去掉左右内边距**，让行能贴满宽度） |
| 来源行 | `padding: 10px 12px 6px`，**无边框无底色**；`border-top: 1px solid var(--dsw-alias-border-l1)`（第一条除外） |
| 来源 pill | `999px` 胶囊，`0.5px solid var(--dsw-alias-border-l3)`，文字 12px `--dsw-alias-label-secondary` |
| 工作区行 | `padding: 4px 12px 6px`，名称 12px `--dsw-alias-label-secondary`（`font-weight: 500`），右侧计数 12px `tabular-nums` |
| 工作区路径 | 12px `--dsw-alias-label-secondary`，`word-break: break-all`，缩进 `12px`，仅在 hover 工作区行或始终显示二选一 → **始终显示，但用 `--dsw-alias-label-tertiary` 之外的 secondary**（浅色下 tertiary 只有 3.71:1） |
| **条目行** | `padding: 6px 12px`，**无边框、无圆角、无底色、无阴影**；行间 `border-top: 1px solid var(--dsw-alias-border-l1)`；左侧 `border-left: 2px solid transparent` 占位 |
| 条目行 hover | `border-left-color: var(--dsw-alias-brand-primary)` + 底 `--dsw-alias-interactive-bg-hover`，`150ms` |
| 条目时间 | 12px，`--dsw-alias-label-secondary`，`tabular-nums`，宽 `88px` 定宽（保证纵向对齐） |
| 条目摘要 | 13px / 1.55，`--dsw-alias-label-primary`，`word-break: break-word`，与时间左对齐（不额外缩进） |
| 标签 chip | 透明底 + `0.5px solid var(--dsw-alias-border-l3)` + `--dsw-alias-label-secondary`，`--dsw-radius-xs`(4px)，高 18px，内边距 `0 5px`，12px |
| 徽章「已手改」 | 胶囊，边框+文字 `--dsw-alias-state-warn-primary`，12px |
| 行内操作 | `编辑` / `删除` 文字按钮，12px；`删除` 用 `--dsw-alias-state-error-primary`；hover 加下划线；`150ms` |

### 5.3 状态清单

| 状态 | 触发 | 视觉 |
|---|---|---|
| default | 打开某天 | 行式台账，见 §5.2 |
| hover | 指针进入条目行 | 左描边品牌色 + 底 `interactive-bg-hover` |
| focus-visible | Tab 到行内按钮 | §2.6：2px 环 + `outline-offset: 2px` |
| active | 按住 | 底 `interactive-bg-active` |
| disabled | 保存中 | 按钮 `opacity: .5` + `cursor: default`（**不得**用 `--dsw-alias-label-tertiary` 做禁用文字，会掉到 3.71:1） |
| loading | `/day` 加载中 | 抽屉体 5 行骨架 |
| error | `/day` 非 200 | `DataUnavailable`（`/day`）+「重试」 |
| empty | 当天无记录 | 空态：标题「这一天没有记录」+ 说明「按事件时间归属，没有任何会话在这一天活动。换个日期，或点右上角「更新」先回填历史。」 |
| editing | 点「编辑」 | 原行就地变成 textarea（13px，`--dsw-radius-sm`），下方「保存」「取消」；`maxLength: 2000` |
| 新增 | 点「新增条目」 | 在原位置展开行内表单（摘要 + 标签 + 来源 + 工作区），不弹窗 |

---

## 6. 简报面板

### 6.1 结构

```
.lw-digest                一张卡（保留，它是独立区块）
├── .lw-digest-head       ‹ │ 周总结 · 2026-W40 │ › │ 范围 · N 天有活动 · N 条 │ 回到本周 │ 生成 交给智能体 收起
├── .lw-digest-body
│   ├── .lw-headline      一句话总览（13px / 1.6，label-secondary）
│   └── .lw-ditem × N     行式：摘要 13px label-primary │ 右侧中性 chip
└── .lw-digest-foot       生成于 … · 范围 … · 模型 … · 来源 …（12px label-secondary）+ 重新生成
```

### 6.2 规范

| 元素 | 规范 |
|---|---|
| 卡片 | `1px solid var(--dsw-alias-border-l1)`，`--dsw-radius-md`(12px)，底 `--dsw-alias-bg-layer-1` |
| 头部 | `8px 10px`，底部 1px 分隔线；标题 13px 字重 600 |
| **条目行** | **不再是卡片**：`display:flex; justify-content:space-between; gap:8px; padding:6px 0; border-bottom:1px solid var(--dsw-alias-border-l1)`，最后一行无分隔线 |
| 条目摘要 | 13px / 1.55，`--dsw-alias-label-primary` |
| 条目 chip | 中性（同 §5.2 标签 chip）；`flex:none`，`align-self:flex-start` |
| 「生成」按钮 | **主操作** → 底 `--dsw-alias-brand-primary` + 文字 `--dsw-alias-label-primary-foreground` |
| 「重新生成」「交给智能体」 | 次级按钮 → 透明底 + 0.5px `--dsw-alias-border-l3` |
| 提示词框 | `13px`（原 12px 统一到 13px 正文档位），`--dsw-radius-sm`，底 `--dsw-alias-bg-layer-2` |
| 条目数 | ≤ 12 条（Host 侧硬截，前端不补） |

### 6.3 状态清单

| 状态 | 触发 | 视觉 |
|---|---|---|
| default | 有缓存简报 | 标题 + 总览 + N 行 |
| hover | 指针进入行 | 底 `interactive-bg-hover` |
| focus-visible | 键盘 | §2.6 |
| active | 按住按钮 | `interactive-bg-active` |
| disabled | `生成中…` / `准备中…` | `opacity: .5`，文案改为进行时 |
| loading | `/digests` 加载中 | 3 行骨架 |
| error | 生成失败 | 轻提示 toast（`--dsw-alias-toast-bg` / `--dsw-alias-toast-label`）+ 保留原内容 |
| empty | 该周期无缓存 | 空态卡：标题「还没有这份简报」+ 说明 + 居中「生成」「交给智能体」两个按钮 |
| 无更早/更晚周期 | 导航到边界 | `‹` / `›` `disabled`，`title` 说明「没有更早的活动周期」 |

---

## 7. 来源面板

### 7.1 结构

```
.lw-source（沿用 .lw-digest 卡壳）
├── 头部：添加来源 │ WSL 探测状态 │ 收起
├── 表单：名称 / SSH 别名 / WSL 发行版 / 远端 DSH_HOME / 回填天数（5 行，标签 160px 定宽）
├── 缺项提示（还缺：…）
├── 操作：登记来源（主）│ 交给智能体（次）
├── 提示词区（可折叠）
└── 已有远程来源：每来源**一行**
    label pill │ 会话 N · 条目 N · 状态 │ 同步 │ 删除
```

### 7.2 规范与状态

| 状态 | 规定 |
|---|---|
| **default** | 区块为一张卡（`--dsw-radius-md` + 1px `--dsw-alias-border-l1`）；头部一行；表单 5 行；底部两个操作按钮；无远程来源时**不渲染**「已有远程来源」分组头 |
| 表单行 | `label` 的 `span` 定宽 `160px`、12px `--dsw-alias-label-secondary`；控件 `flex:1`，12px，`--dsw-radius-sm` |
| 输入框 | 底 `--dsw-alias-bg-layer-2`，`1px solid var(--dsw-alias-border-l1)`；`::placeholder` 用 **`--dsw-alias-label-secondary`**（浅色 5.80:1 ✅） |
| hover | 来源行 / 按钮 hover：底 `--dsw-alias-interactive-bg-hover`，`150ms` |
| **active** | 按下按钮 / 来源行：底 `--dsw-alias-interactive-bg-active`；不位移、不缩放 |
| focus-visible | §2.6 统一写法；**焦点环不得被容器 `overflow:hidden` 裁掉** |
| disabled | 缺必填项时「登记来源」禁用：`opacity: .5` + `cursor: default`；**同时**显示「还缺：SSH 别名、远端 DSH_HOME」文字提示（不许只靠置灰表意） |
| busy | 按钮文案变「处理中…」，`disabled`；同一时刻只允许一个进行中的操作 |
| loading | 探测 WSL 中：「正在探测 WSL…」12px `label-secondary` |
| error | 登记/同步失败：toast（`--dsw-alias-toast-bg` / `--dsw-alias-toast-label`）；来源行状态文字用 `--dsw-alias-state-error-primary`（浅色 4.50:1 ✅） |
| empty | 无远程来源：不渲染「已有远程来源」分组头（**不留空标题**） |
| 删除两段式 | 第一次点击 → 文案变「确认删除？」并换成错误色描边；第二次才执行。**不用 `window.confirm`** |

---

## 8. 键盘与可访问性契约

### 8.1 热力图语义（年视图）

```html
<div class="lw-heat-cells" role="grid" aria-label="2026 年活动热力图">
  <div role="row">                    <!-- 每一周一行？不：本实现按列渲染，
                                           所以用 aria-rowindex/aria-colindex 表达位置 -->
    <button role="gridcell" tabindex="0"  data-selected="1" aria-label="2026-01-01，轮次 12，会话 3，条目 2"></button>
    <button role="gridcell" tabindex="-1" aria-label="…"></button>
```

**要点（逐条核对）**：

1. 容器 `.lw-heat-cells` 必须有 `role="grid"`；每个格子必须是 `role="gridcell"`。
2. 容器上给 `aria-rowcount="7"`、`aria-colcount="53"`；每个格子给 `aria-rowindex`（1–7）与 `aria-colindex`（1–53）。
3. 格子是**可聚焦元素**（`<button>`），不是 `div`。
4. **roving tabindex**：整个网格里**任何时刻只有 1 个格子 `tabindex="0"`**，其余全部 `tabindex="-1"`。初始落在今天（不在本年则落 1 月 1 日）；选中变化后焦点格跟随选中格。
5. **方向键**（在格子上按下）：
   - `←` / `→`：上一周 / 下一周（同一天，±1 列）
   - `↑` / `↓`：上一日 / 下一日（±1 行）
   - `Home`：该行第 1 列；`End`：该行第 53 列
   - `PageUp` / `PageDown`：上一年 / 下一年（沿用 `onYear`）
   - `Tab`：**整体离开网格**（不要用 Tab 走 371 个格子）
6. `Enter` / `Space`：选中当前焦点格对应的日期（等价于鼠标点击）。
7. 越界处理：走到第 1 列/第 53 列之外时**夹住不循环**。

### 8.2 月视图键盘

- 42 个格子都是 `<button>`，`Tab` 顺序 = DOM 顺序（当前 42 个都进 Tab 序列，**可接受**）。
- `role`：月视图用 `role="grid"` + `role="gridcell"` 同样成立（7 列 × 6 行），`aria-rowcount="6"`、`aria-colcount="7"`。
- 方向键行为与 §8.1 第 5 条一致（±1 格 / ±7 格）。

### 8.3 抽屉内 Tab 顺序

打开日详情后，`Tab` 序列**从上到下、从左到右**：

```
抽屉头「刷新」→「✕」
  → 第 1 个来源的第 1 个工作区的第 1 条目的「编辑」→「删除」
  → 第 2 条目的「编辑」→「删除」 → …
  → 「新增条目」→（展开后）摘要 → 标签 → 来源 → 工作区 →「取消」→「新增」
  → 第 2 个工作区 …
```

- **不许**用 `tabindex` 打乱 DOM 顺序去凑视觉顺序（当前实现已经是 DOM 顺序，保持即可）。
- 抽屉打开时**不抢焦点**（不 `autofocus`），避免打断正在用键盘操作日历的用户。

### 8.4 对比度

见 §2.7。**两套主题都要满足**：正文与占位 ≥4.5:1。C22 用脚本枚举校验。

### 8.5 其它

- 所有图标按钮必须有 `aria-label`（例：`✕` → `aria-label="关闭日详情"`）。
- 纯装饰元素加 `aria-hidden="true"`（强度条、色块）。
- 轻提示 `.lw-toast` 用 `role="status"`；错误用 `role="alert"`。
- 骨架屏容器加 `aria-busy="true"`。

---

## 9. 与验收清单 C15–C24 的对应

| # | 契约条款 | 验收动作要点 |
|---|---|---|
| C15 | §1.3、§3.3、§5.2、§6.2 | 颜色职责分离：绿色只在两处；主操作/选中 = `brand-primary`；chip 中性 |
| C16 | §3.2、§3.3 | 自适应公式 + 宽窗无横向滚动 + 窄窗触底 8px |
| C17 | §3.5 | 台账栏 216px、低对齐度、反 hero |
| C18 | §5 | 抽屉零卡框、行式台账、Tab 顺序 |
| C19 | §2.6 | selection / caret / scrollbar / 焦点环 2px + offset 2px |
| C20 | §2.8 | 动效 120/150/180 + reduced-motion 全关 + 无编排动画 |
| C21 | §8.1–8.3 | role=grid/gridcell、roving tabindex、方向键、Enter/Space |
| C22 | §2.7 | 双主题对比度 ≥4.5:1 |
| C23 | §2.9 | 四档断点行为 |
| C24 | §0 | 零接口变更、中文文案、无隐私泄露 |

（C15–C24 的完整「验收动作 + 证据形式」写在 `docs/MANUAL-CHECKLIST.md`。）

---

## 10. 明确不做

- ❌ 不新增/修改任何端点、字段、SSE 事件、槽位。
- ❌ 不改 `lib/index.js` / `fold.js` / `store.js` / `extract.js` / `summarize.js` / `prompts.js`。
- ❌ 不引入任何第三方依赖（`client.js` 仍然只 `require('react')`）。
- ❌ 不做「加载编排动效」（stagger / 逐条延迟入场 / 数字滚动）。
- ❌ 不做大数字 hero 台账栏。
- ❌ 不给月视图加标签 chip（数据拿不到，见 R0.5）。
- ❌ 不使用 `--dsw-font-xxxs-11-font-size`（11px 低于最小字号）。
- ❌ 不使用 `outline` 简写。
- ❌ 不写死除 `--dsw-lw-heat` 声明处以外的任何颜色。
