# dsh-LogWiki · 契约总览（**冻结接口，改动需同步此文件**）

> 本文件是 host 半边、client 半边、以及各并行开发线的**唯一共同依据**。
> 任何一方要改这里定义的名字/形状，必须先改本文件再改代码。

---

## 0. 模块划分与写盘范围（并行开发纪律）

| 模块 | 文件 | 写盘范围（别人不许碰） | 职责 |
|---|---|---|---|
| 集成 | `lib/index.js` | 集成方独占 | 路由、刷新编排、SSE、工具注册、把各模块接起来 |
| 存储 | `lib/store.js` | 线 A 独占 | KV 落盘、防抖、写串行化、迁移 |
| 提取 | `lib/extract.js` | 线 A 独占 | **纯函数**：事件 → 会话指纹；日期键 |
| 聚合 | `lib/fold.js` | 线 A 独占 | **纯函数**：指纹 → 天/工作区聚合、热力图分档、状态快照 |
| 摘要 | `lib/summarize.js` | 线 B 独占 | `ctx.llm.stream` 封装：条目摘要 + 简报 |
| 提示词 | `lib/prompts.js` | 线 B 独占 | 中文提示词构造 + JSON 容错解析 |
| 依赖解析 | `lib/vendor-dsh.js` | 线 B 独占 | **唯一**允许 import `@deepseek-ai/*` 的文件 |
| 路径派生 | `lib/paths.js` | 集成方独占 | **唯一**允许触碰家目录/DSH 主目录/npm 前缀的文件；全部派生，不许写死用户名 |
| 界面 | `lib/client.js` | 线 C 独占 | 手写 ESM + React.createElement 全部 UI |

**纯函数约束**：`extract.js` / `fold.js` / `prompts.js` 不得接触 `ctx`、网络、时钟以外的副作用；必须能在 `node scripts/verify-extract.mjs` 里直接调用。

**依赖纪律**：M0–M8 一律**只 import `node:` 内置模块**。需要 `@deepseek-ai/*`（`dsh-llm` 的 `BlockAssembler`/`createUserMessage`、`dsh-timeout` 的 `deadline`）时，只允许 `lib/vendor-dsh.js` 解析并转出，其它模块从它 import。**已实测**（Node v24.16.0）：两个根都能解析成功 ——
`$DSH_HOME/profiles/node_modules` 与 `（npm 全局安装里的 dsh 真身）`（前者是 junction，实指后者）。失败时 `loadVendor()` 返 `null`，`summarize.js` 抛 `LOGWIKI_VENDOR_UNAVAILABLE`，**boot 不崩**。

---

## 1. 数据模型（`ctx.storage` KV unit `dsh_logwiki` 的 global 对象）

```js
{
  schemaVersion: 1,
  updatedAt: 0,                       // epoch ms

  sources: {
    local: { id:'local', kind:'local', label:'本机', enabled:true, addedAt:0 },
    [sid]: { id, kind:'remote', label, sshAlias, wslDistro?, dshHome,
             enabled, addedAt, lastSyncAt, lastSyncStatus, lastError }
  },

  // key = `${sourceId}::${sessionId}`
  sessions: {
    [key]: {
      sourceId, sessionId, parentSessionId?, origin?, delegationDepth,
      cwd, workspaceLabel,
      createdAt, lastEventAt,
      title?, promptPreview: string[], toolHistogram: {[tool]:count},
      assistantTail?,
      turns, steps,
      tokens: { input, output, cacheRead, cacheWrite, reasoning },
      perDay: { [date]: { turns, steps, tokens:{...} } },
      fingerprint                              // 变化检测用，见 extract.sessionFingerprintOf
    }
  },

  days: {
    [date]: {
      work: { turns, steps, sessions, entries, tokens:{...} },
      bySource: { [sid]: { turns, steps, sessions, tokens:{...}, byWorkspace: { [wsLabel]: {turns,steps,entries} } } }
    }
  },

  entries: {
    [entryId]: {
      id, sourceId, date, workspacePath, workspaceLabel,
      startTime, endTime,                       // epoch ms
      summary, tag,
      sessionRefs: [sessionId],
      origin: 'llm' | 'seed' | 'user',
      edited: false,
      model?: { provider, model },
      createdAt, updatedAt
    }
  },

  entryOrder: { [date]: [entryId, ...] },       // 按 startTime 升序
  dayState:   { [date]: { generatedAt, sessionFingerprint, status: 'ok'|'seed'|'failed', error? } },

  digests: {
    'week:2026-W40' | 'month:2026-09': {
      kind:'week'|'month', period, rangeStart, rangeEnd,
      title, headline,
      items: [{ summary, tag, sessionRefs: [] }],
      origin: 'llm' | 'agent', model?, sourceIds: [],
      generatedAt, edited: false
    }
  },

  syncLedger: { [sid]: { [remotePath]: { mtimeMs, size } } }
}
```

**entryId 生成**：`e_${date}_${sourceId}_${sha1(sessionRefs.sorted.join('|')).slice(0,10)}`（稳定、可重算、重跑同一天同集合即命中同一条）。

---

## 2. Wire 契约（客户端半边唯一依赖的 HTTP 面）

前缀 `PREFIX = '/api/dsh-logwiki'`。变更类端点必须 `POST` + 头 `x-logwiki: 1`（缺 → 403；`OPTIONS` → 405；非 POST → 405）。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/ping` | — | `{ok:true, plugin, version, now, config}` |
| GET | `/state?from=&to=&sources=` | 日期范围 + 来源过滤 | `StatePayload` |
| GET | `/day?date=YYYY-MM-DD&sources=` | 某天 | `DayPayload` |
| POST | `/refresh` | `{}` | `{ok:true, jobId, running:true}` 或 `{ok:false, running:true, jobId}` |
| GET | `/events` | — | **SSE** 流，事件 `progress` |
| POST | `/entry` | `{entryId, summary?, tag?}` | `{ok:true, entry}` |
| POST | `/entry/add` | `{date, sourceId, workspacePath, summary, tag}` | `{ok:true, entry}` |
| POST | `/entry/delete` | `{entryId}` | `{ok:true}` |
| GET | `/digests?kind=week&period=2026-W40` | 或 `kind=month` | `{ok:true, digest \| null}` |
| GET | `/digests/available` | — | `{ok:true, weeks:[period...], months:[period...]}` |
| POST | `/digest/generate` | `{kind, period, sources?}` | `{ok:true, digest}` |
| POST | `/digest/agent-prompt` | `{kind, period, sources?}` | `{ok:true, prompt}` |
| GET | `/sources` | — | `{ok:true, sources:[Source], local:{...}}` |
| POST | `/source` | `Source` 片段 | `{ok:true, source}` |
| POST | `/source/sync` | `{sourceId}` | `{ok:true, status}` |
| POST | `/source/delete` | `{sourceId}` | `{ok:true}` |
| GET | `/health` | — | `{ok:true, scan:{started,done,scanned,total,failed}, store:{writable}}` |

### `StatePayload`
```js
{
  ok: true,
  generatedAt,
  sources: [{ id, kind, label, enabled, lastSyncStatus?, lastError? }],
  range: { from, to },
  heatmap: [{ date, work:{turns,steps,sessions,entries,tokens}, bySource:{...} }],
  totals: { turns, steps, sessions, entries, tokens:{...} },
  metric: 'turns'|'tokens'|'sessions'|'entries',
  scan: { started, done, scanned, total, failed },
  degradedDays: [date, ...]          // dayState.status !== 'ok'
}
```

### `DayPayload`
```js
{
  ok: true, date, totals: { turns, sessions, entries, tokens },
  groups: [{
    sourceId, sourceLabel,
    workspaces: [{ workspacePath, workspaceLabel, totals:{turns,sessions,entries},
                   entries: [{ id, startTime, endTime, summary, tag, origin, edited, sessionRefs }] }]
  }]
}
```
排序：`groups` 本地在前；`workspaces` 按 `entries` 数量降序；`entries` 按 `startTime` 升序。

### SSE（`/events`）
```
event: progress
data: {"phase":"scan"|"summarize"|"digest"|"remote","done":0,"total":0,"current":"...","errors":0,"finished":false}
```
连接建立时先推一帧当前状态；`finished:true` 后不关闭连接（等下一次刷新）。

---

## 3. 模块导出接口

### `lib/extract.js`（纯函数）
```js
/** 事件时间(epoch ms) → 本地日期键 'YYYY-MM-DD'。
 *  tzOffsetMinutes 可省略，省略时回落宿主本地时区（hostTzOffsetMinutes()）。
 *  ⚠️ 返回值是**日期键**，所以调用方要么显式传时区、要么接受宿主时区——
 *  集成层最易在此踩坑（不传会静默整体偏移一天，不报错）。 */
export function dayKey(ms, tzOffsetMinutes?)

/** 宿主本地相对 UTC 的分钟偏移（东八区 = +480）。测试用它做确定性断言。 */
export function hostTzOffsetMinutes(at?)

/** 会话日志 → 指纹记录的会话部分（不含 sourceId）。events 为 sessionQuery.readSession().events。
 *  ⚠️ `tzOffsetMinutes` 是**可选**参数（缺省回落宿主本地）——因为返回值含日期键 `perDay`，
 *  不传时区它就不可能是纯函数、也无法做确定性测试。（此参数是线 A 补的契约漏洞。） */
export function extractSession({ header, events, title?, tzOffsetMinutes? })
//   header: { id, version, createdAt, cwd?, parentSession?, origin?, delegationDepth, agentPreset? }
//   events: [{ type, seq, time, data }, ...]   —— seq/time 已被服务端归一化
//   返回: { sessionId, parentSessionId?, origin?, delegationDepth, cwd, createdAt, lastEventAt,
//           title?, promptPreview[], toolHistogram, assistantTail?,
//           turns, steps, tokens:{input,output,cacheRead,cacheWrite,reasoning},
//           perDay:{...} }  |  null（无可用事件时）
//   title 优先取 `session/title` 事件（事件优先于传入的 title 参数）。

/** 变化检测指纹：对影响摘要的字段做稳定哈希（sha1 → 16 hex）。 */
export function sessionFingerprintOf(sessionRecord)

/** 顶层会话判定：origin !== 'subagent' 且 delegationDepth === 0。 */
export function isTopLevel(sessionRecord)
```

> **token 字段口径**：`data.usage` 的五个字段**必须逐个判空后累计**——实测
> `cacheWriteTokens` / `totalTokens` 经常缺失（29044 条里只有 25449 / 27671 条带），
> `reasoningTokens` 也有近九成不带。不要假设它们存在。
>
> **`promptPreview` 的已知质量缺陷**：顶层会话首条 `source.kind === 'user'` 消息实测常常不是
> 用户的真实需求，而是 meow-memory 注入的长期记忆块（`"===== 长期记忆 ====="`）。按现行契约
> 它**确实该被采信**，但会拉低一句话摘要的质量。待办：增加"跳过已知注入前缀"的口径
> （倾向做成**可配置 skip-patterns**，不要硬编码）。

**事件读取规则（已实测）**：
- 时间取**顶层** `time`（epoch ms）；`seq`/`time` 由 `sessionQuery` 归一化，`extract` 不处理 `seq0/time0`。
- `user/message`：文本在 `data.content[].text`；**只采信 `data.source.kind === 'user'` 的**（排除注入内容）。
- `assistant/message`：用 `data.usage.{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,reasoningTokens}`；文本在 `data.message.content[]` 里 `type==='text'`。
- `tool/call`：工具名在 `data.name`。
- `turn/end` / `step/end`：`data.turn` / `data.step`。
- `session/title`：`data.title`。

### `lib/fold.js`（纯函数）
```js
/** 子代理上溯归并。
 *  @returns {{ parents: Map<key, mergedRecord>, subagentKeys: Set<key>, orphanKeys: Set<key> }}
 *  ⚠️ 返回值是契约 `{parents, subagentKeys}` 的**超集**（多 `orphanKeys`）——已裁定**接受该增量**：
 *  orphanKeys 是「无法上溯、保留为独立记录」的子代理（记录带 `orphanSubagent: true` 标记），
 *  buildDays/buildDay 照计 turns/steps/tokens 但**不计 work.sessions**（本机语料 0 条命中，纯兜底）。
 *  options: { includeSubagents?, tzOffsetMinutes? }
 *  硬规则：**只归并非顶层记录，顶层记录永不参与归并**（哪怕它带 parentSession）；
 *          归并**不得改写**父记录的 delegationDepth。 */
export function rollupSubagents(sessions, options?)

/** 由 sessions 重算 days 与各天 work 指标。heatmap.includeSubagents 决定子代理是否计入。 */
export function buildDays(sessions, { includeSubagents, tzOffsetMinutes })

/** 分位分档：返回 [p25,p50,p75,p90] 阈值（严格递增、去重、0 值不算入）。 */
export function quantileThresholds(values)

/** 0 → 0；否则按 thresholds 落 1..4 档。 */
export function heatLevel(value, thresholds)

/** 组装 StatePayload。entries 可为 {}。 */
export function buildState({ sessions, days, entries, sources, from, to, metric, scan, degradedDays })

/** 组装 DayPayload。 */
export function buildDay({ date, sessions, entries, sources })

/** 会话集合的稳定指纹（用于 dayState.sessionFingerprint）。 */
export function daySessionFingerprint(sessionsOfDay)
```

### `lib/store.js`
```js
/**
 * @param options.unit 本实例专用的 KV unit 名（**多实例部署必须各不相同**）。
 *   缺省/非法 → `dsh_logwiki`。名字受 DSH 约束 `^[a-z][a-z0-9_]*$`（**不许点号/连字符**）。
 */
export function createStore(ctx, options = {})   // 返回 ↓；storage 不可用时降级为纯内存并置 writable=false
{
  ready: Promise<void>,            // 首次 loadAll 完成
  get(): StoreObject,              // 内存快照（勿直接改写深层对象）
  update(mutator: (draft) => void): void,   // 同步改 + 排队落盘（200ms 防抖 + 串行）
  flush(): Promise<void>,          // 立即落盘（测试/退出用）
  writable: boolean,
  close(): Promise<void>,
  unitName: string,                // 实际生效的 unit 名（供 /ping、/health 对外核对）
}

/** 空 store 快照（测试/无 storage 时用）。线 A 补的导出。 */
export function createEmptyStore()

/** unit 名派生：`unitNameFor('web') === 'dsh_logwiki_web'`；脏输入一律退回默认名。线 A 补的导出。 */
export function unitNameFor(instanceId)
export function sanitizeUnitSuffix(raw)
export const DEFAULT_UNIT_NAME = 'dsh_logwiki'
export const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/
```

> **为什么按实例分 unit**：同一 `$DSH_HOME` 下两个实例（桌面端 + web）共用一个 unit 时，
> 落盘是"整份文档重写"，两进程各持内存快照 → 后写者抹掉先写者（lost update）。
> unit 名由 `index.js` 按 `profileContext.name` 派生，`config.store.unit` 可显式覆盖。

### `lib/paths.js`
```js
export function dshHome()        // $DSH_HOME（纯空白视为未设）→ ~/.dsh
export function sessionsRoot()   // $DSH_HOME/sessions
export function profilesRoot()   // $DSH_HOME/profiles
export function profileDirs()    // profiles 下全部 profile 目录（排序）
export function vendorRoots()    // 可能装着 @deepseek-ai/* 的 node_modules 根（存在性已过滤，按优先级）
export function npmGlobalPrefixes()
export function findInNodeModules(pkg, ...rest)   // 命中返回绝对路径，否则 null
```

> **公开仓库红线**：这是**唯一**允许触碰家目录 / DSH 主目录 / npm 全局前缀的文件，
> 而且一律**派生**（`$DSH_HOME` → 各平台惯例目录），**不得写死任何用户名或盘符**。
> `verify-remote.mjs` 的「隐私门」断言会扫 `lib/` 与 `scripts/`，发现真实用户名路径即 FAIL。
> 非标准布局用环境变量 `DSH_LOGWIKI_VENDOR_ROOTS`（`path.delimiter` 分隔）覆盖。

### `lib/summarize.js`
```js
export function createSummarizer(ctx, summarizeConfig, uiConfig)   // 三参；uiConfig 供提示词按语言取用
{
  /** 一个 (日, 来源, 工作区) → 任务条目数组；失败抛错（由调用方降级）。
   *  sessions 是**会话记录数组**（不是 id 列表）——提示词要用 title/promptPreview/toolHistogram。 */
  summarizeDay({ date, sourceId, workspaceLabel, workspacePath, sessions, sessionKeys, alreadyRecorded }): Promise<[{summary, tag, sessionRefs}]>,
  /** 周/月简报。 */
  generateDigest({ kind, period, rangeStart, rangeEnd, entries, sources }): Promise<{title, headline, items:[{summary,tag,sessionRefs}], model?:{provider,model}}>,
  /** 构造「交给智能体」的提示词（不调模型）。 */
  buildAgentPrompt({ kind, period, rangeStart, rangeEnd, entries, sources }): Promise<string>,
  /** 真机模型自检（会真实发一次极小调用）。 */
  probe(): Promise<{ ok: boolean, provider, model, error? }>,
  /** 非契约，诊断用。 */
  status?(): unknown,
}
```

### `lib/prompts.js`（导出以线 B 实现为准，此处冻结）
```js
export function entryPrompt({ date, workspaceLabel, sessions, alreadyRecorded })
export function digestPrompt({ kind, period, rangeStart, rangeEnd, entries, sources })
export function agentPrompt({ kind, period, rangeStart, rangeEnd, entries, sources })
export function parseEntryJson(text)    // 失败 → null（绝不抛）
export function parseDigestJson(text)   // 失败 → null；items 超 12 条硬截
export const LIMITS
```

### `lib/vendor-dsh.js`
```js
export function loadVendor(): Promise<{ BlockAssembler, createUserMessage, deadline } | null>
export function vendorStatus(): unknown   // 每个解析根的失败原因，诊断用
```

### `lib/summarize.js` 内部必须遵守
- 省略 `purpose` 与 `sessionId`（`purpose` 是封闭联合；省略 `sessionId` 即不写会话日志）。
- `createUserMessage({ content:[{type:'text',text}], source:{ kind:'plugin:dsh-logwiki' } })`。
- `for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)`，然后**必须自己判** `assembler.finish`：`error`/`aborted` → 抛；`max-tokens` → 抛。
- 用 `deadline(signal, config.timeoutMs, 'LOGWIKI_TIMEOUT')` 限时。

### `lib/client.js`
- 只依赖 `require('react')` + `ctx.get('slots')`；样式只用 `--dsw-*` token。
- 注册 `sidebar.panellist`(id=`logwiki`, order=40) 与 `main`(key=`logwiki`)。
- 只 `fetch('/api/dsh-logwiki/*')` 取数；变更类带 `x-logwiki: 1`。
- 每个区块独立容错 + 顶层错误边界；`prefers-reduced-motion` 下关动画。

**视觉尺度与浏览器表面 token 清单**（完整契约见 [`docs/DESIGN.md`](DESIGN.md)；这里是给改代码的人用的速查表）

| 用途 | token | 取值 |
|---|---|---|
| 正文 / 次要文字 / 装饰 | `--dsw-alias-label-primary` / `-secondary` / `-tertiary` | 12–14px；**最小字号 12px**，禁用 `--dsw-font-xxxs-11-*` |
| 字号 12 / 13 / 14 | `--dsw-font-xxs-12-font-size` / `-xs-13-` / `-s-14-` | 12 / 13 / 14px（行高 18 / 20 / 22px） |
| 数字 | `font-variant-numeric: tabular-nums` | 在 `.lw-root` 上统一声明 |
| 主操作 / 选中态 | `--dsw-alias-brand-primary` + `--dsw-alias-label-primary-foreground` | 本应用是**单色品牌色**（浅 `#0f1115` / 深 `#f9fafb`），配对前景是它的反色 |
| 活动绿阶（**只表达"量"**） | `--dsw-lw-heat`（插件自有，**全文件只声明一次**，`#39d353`）→ 组件消费别名 `--lw-heat` | 只允许热力图色阶 / 图例 / 月视图强度条三处消费 |
| 圆角 | `--dsw-radius-xs` / `-sm` / `-md` | 4 / 8 / 12px |
| 分隔线 / 控件边框 / chip 边框 | `--dsw-alias-border-l1` / `-l2` / `-l3` | — |
| hover / 按下底 | `--dsw-alias-interactive-bg-hover` / `-bg-active` | — |
| 文档选区 | `--dsw-alias-bg-document-selection` | `::selection` 用它 |
| 光标 | `caret-color: var(--dsw-alias-brand-primary)` | — |
| 滚动条（细/粗、两级 hover） | `--dsw-alias-scrollbar-bg-l1` / `-bg-l2` / `-hover-l1` / `-hover-l2` | 横向滚动用 l1、纵向容器用 l2 |
| 焦点环 | `outline-width: var(--dsw-focus-ring-width, 2px)` + `outline-color: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))` + `outline-offset: 2px` | **禁止 `outline` 简写**：平台 `focus.css` 已全局接管，简写会覆盖它的鼠标模态抑制规则 |
| 动效 | 120ms（选中）/ 150ms（其余状态）/ 180ms（抽屉） | `prefers-reduced-motion` 下全关；不做加载编排动效 |

> **平台没有间距 token**：`--dsw-*` 里不存在 `space` / `gap` / `size` 类名，padding / gap 直接用 4 的倍数像素。
>
> **第三方皮肤会覆盖 token**：装了换肤插件（本机是 `dsh-dream-skin`）时，`--dsw-alias-brand-primary`、`--dsw-alias-bg-base` 等会被皮肤改写（例如 `bg-base` 变成 10% 半透明、品牌色从单色换成 `#7c8cff` / `#2196f3`）。**上面那张表的取值是原生 token 下的值**；对比度结论也以原生 token 为准。

---

## 4. 配置（`config` 块，patch 整体替换不深合并）

```yaml
scan:      { sinceDays: 365, maxSessions: 2000, maxNewPerRun: 300 }
summarize: { provider: deepseek-official, model: deepseek-flash, maxTokens: 8192,
             timeoutMs: 60000, maxConcurrency: 2, onlyTopLevelSessions: true }
heatmap:   { metric: turns, includeSubagents: true }
ui:        { language: zh, weekStart: 1 }
store:     { unit: '' }        # 空 = 按 profile 派生 dsh_logwiki_<profile>
remote:    { enable: false, sinceDays: 90, maxBytesPerSync: 33554432,
             maxFilesPerSync: 400, maxBytesPerFile: 67108864,
             commandTimeoutMs: 120000, maxSourcesPerRun: 3 }
```

> ⚠️ **`summarize.maxTokens` 是 8192，不是 2048。** 本文件曾长期写 2048，与实际发货值不符。
> 实测口径：调到 2048 会把简报输出**截断**，生成直接失败（`README` 的配置表里有同样的警告）。

| 键 | 默认 | 说明 |
|---|---|---|
| `scan.sinceDays` | 365 | 回填窗口（天） |
| `scan.maxSessions` | 2000 | 候选会话上限 |
| `scan.maxNewPerRun` | 300 | 单次「更新」最多处理多少个**新增**会话（已入库的廉价跳过） |
| `summarize.maxTokens` | 8192 | 条目/简报单次输出上限；**不得调小** |
| `heatmap.metric` | `turns` | 默认指标；客户端可覆盖 |
| `store.unit` | `''`（派生） | 空则派生 `dsh_logwiki_<profile>`；显式填则钉住（见 §3 `lib/store.js`） |
| `remote.enable` | false | 总开关：开了之后「更新」顺带同步所有已启用来源 |
| `remote.sinceDays` | 90 | 远程来源只同步最近多少天的会话 |
| `remote.maxBytesPerSync` | 33554432 | 单次同步总字节预算 |
| `remote.maxFilesPerSync` | 400 | 单次同步最多拉多少个文件 |
| `remote.maxBytesPerFile` | 67108864 | 单文件上限（按 base64 **编码后**体积算） |
| `remote.commandTimeoutMs` | 120000 | 单条远端命令超时 |
| `remote.maxSourcesPerRun` | 3 | 一次「更新」最多同步几个来源 |

`summarize.provider/model` 未配置时回退 `ctx.get('agentDefaultModel')?.currentSelection()`。

---

## 5. 归属与时间规则（**必须一致**）

1. **日归属按事件时间，不按会话 `createdAt`**。同一会话可出现在多天。
2. 时区：一律**宿主本地日**；`tzOffsetMinutes = -new Date(t).getTimezoneOffset()`（本机 = +480）。
3. 子代理（`origin === 'subagent'`，或 `delegationDepth > 0`）：沿 `parentSession` 上溯并入最近顶层会话；**不进日卡条目**；是否计入热力图由 `heatmap.includeSubagents` 决定（默认 true）。
   **归并的两条硬规则**（实测丢数据后定的，务必遵守）：
   - **只归并非顶层记录**。**顶层记录永不参与归并**，哪怕它恰好带着 `parentSession`。
     反例（真实事故）：三层链 `A(subagent, parent=B, 51 turns/611 steps) → B(origin 缺省、depth 0，按契约**就是顶层**，但带 parentSession=C) → C(真顶层)`。若归并「**任何**带 `parentSessionId` 的记录」，B 会被并进 C 并删除，而 A 被并进 B 的克隆体、克隆体又被删 → **51/611 凭空蒸发**。
   - **归并不得改写父记录的 `delegationDepth`**。曾因 `target.delegationDepth = Math.max(...)` 把顶层克隆体的 depth 抬高，使它不再满足 `isTopLevel()` —— 并由此产生了一整类**看起来像"孤儿子代理"的假象**（见下）。
   - 真正无法上溯的子代理：保留为独立记录并打 `orphanSubagent: true`，**照常计入 turns/steps/tokens，但不计入 `work.sessions`**（纯兜底；本机语料实测 0 条命中）。
   
   **⚠️ 一条诊断纪律（我踩过的坑）**：判定语料形态时**必须看原始 header**，绝不能拿 `rollupSubagents()` 返回的 `parents` 当原始事实 —— 那是**被变换过的克隆体**。我曾据此断言存在"20 条孤儿子代理（depth>0 且无 origin/parentSession）"并写进契约，实为误读：原始 464 份 header 里，`depth > 0 且无 parentSession` 的记录 **= 0 条**，`depth === 0` 的 50 条**全部** origin 缺省，`depth > 0` 的**全部** origin=subagent。
4. 工作区标签：`ctx.workspaceRegistry.list()` 按 `path === header.cwd` 精确匹配取 `title`；未注册的 cwd 直接用路径；无 cwd → `(未知工作区)`。
   **⚠️ 已实测（本机 0.2.0-rc.2 + web profile）：`workspaceRegistry` 根本未提供。** 即使 `storageDomain` 与 `sessionPersistence` 都在，`ctx.get('workspaceRegistry')` 仍为 `undefined`，且 `ctx.inject(['workspaceRegistry'], cb)` 的回调**从未触发**（说明 `@deepseek-ai/dsh-workspace` 处于 pending）。
   → 因此**标签的最终口径是**：`title`（若恰好可用）→ **`cwd` 的 basename**（即工作区目录名）→ `(未知工作区)`。实现见 `lib/index.js` 的 `workspaceLabelOf()`。**不要**把 `workspaceRegistry` 写成硬依赖。
5. `heatmap.metric` 默认 `turns`（`turn/end` 计数）。

---

## 6. 错误与降级

| 情况 | 处理 |
|---|---|
| `readSession` 抛 `SESSION_QUERY_CORRUPT_SESSION` 等 | 跳过该会话，`scan.failed++`，下次刷新重试 |
| LLM 失败/超时/JSON 解析失败 | **降级 seed**：每会话一条，summary 取 `title` 或首条用户提示首句；`dayState.status='seed'` |
| `storage` 不可用 | 只读运行，`store.writable=false`，`/state` 带 `store` 告警 |
| 刷新并发点击 | 单飞：第二个请求返回同一 `jobId` + `running:true` |
| 用户编辑过的条目 | `edited:true`，**永不**被重算覆盖，且不再喂给 LLM |
| 绝不 | 向会话日志追加任何事件；使用 `source.kind='plugin'`；`purpose`/`sessionId` 传值 |
