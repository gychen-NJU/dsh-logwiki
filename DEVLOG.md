# dsh-LogWiki · 开发日志

> 每条里程碑必须写清：**改了什么 / 怎么验的 / 证据**。证据 = 命令 + 输出摘要，或截图路径。

---

## M0 · 脚手架与 3081 联通 —— ✅ 通过（2026-10-01）

### 改了什么
新建工作区 `E:\GalaxyC\DSH\DSH-LogWiki\`：

| 文件 | 作用 |
|---|---|
| `dsh-logwiki/package.json` | `type:module`、`main/exports["."]`=host 半边、`exports["./client"]`=client 半边、`dsh.bundle.patch`、`dsh.client{platform:"web",immediately:true}` |
| `dsh-logwiki/cordis.patch.yml` | 包内 patch（L2 正式安装用） |
| `dsh-logwiki/lib/index.js` | host 半边：`name/inject/apply` + `/api/dsh-logwiki/*` 前缀路由 + 配置归一化 + 变更守卫（`x-logwiki: 1`、拒 OPTIONS、无 CORS 头） |
| `dsh-logwiki/lib/client.js` | client 半边：`__ModuleLoader__.load({id:'dsh-logwiki'})` + 注入样式 + 错误边界 + `sidebar.panellist` 图标行 + `main`(key=logwiki) 整页面板 |
| `dev/logwiki.patch.yml` | **L1 开发覆盖层**：`--patch` 引入，不写共享 profile |

### 怎么验的（逐条证据）

**1. 语法门（零构建，语法即门）**
```
$ node --check lib/index.js   → exit=0
$ node --check lib/client.js  → exit=0
```
（两文件均在 `"type":"module"` 包内，按 ESM 解析。）

**2. 挂载证据（`--dump-config`）**
```
$ dsh --profile web --patch E:\GalaxyC\DSH\DSH-LogWiki\dev\logwiki.patch.yml --dump-config
total lines: 1773            # 基线 1749 → 仅叠加我们的块
# == E:\GalaxyC\DSH\DSH-LogWiki\dev\logwiki.patch.yml
- id: logwiki
name: file:///E:/GalaxyC/DSH/DSH-LogWiki/dsh-logwiki/lib/index.js
# == dsh-overleaf, patched by $DSH_HOME\profiles\web\cordis.patch.yml   ← 共享 profile 原样未动
```

**3. 自管实例启动（managed background job `pwsh-4115`）**
```
$ dsh --profile web --patch ...\dev\logwiki.patch.yml --port 3081 --no-open
dsh web: http://127.0.0.1:3081/?token=***
```
- 3081 LISTENING，owner = `node.exe` PID 18876（9:17:35 启动）。
- **桌面端与你的 web 端全程未受影响**：19387 仍属 PID 59360、3080 仍属 PID 70384。

**4. host 路由连通**
```
$ GET http://127.0.0.1:3081/api/dsh-logwiki/ping
HTTP 200
{"ok":true,"plugin":"dsh-logwiki","version":"0.1.0","now":1790817502259,
 "config":{"scan":{"sinceDays":365,"maxSessions":2000},
           "summarize":{"provider":"deepseek-official","model":"deepseek-flash",...}, ...}}
```
→ 顺带确认：**插件路由不在 `/api` 的 401 信任栅栏内**，只有壳页 `/` 需要会话 token；所以客户端同源 `fetch` 可用，裸 HTTP 也能做验收探针。

**5. client 半边进 roster**
```
window.__DSH_BOOT__ = { rev:"7c28468dff11", totalEntries:96,
  entries:[{ id:"dsh-logwiki", url:"plugins/??dsh-logwiki/client.js&rev=8e82b6ca1f75", immediately:true }] }
```

**6. 界面（ego 浏览器，截图存档）**
- `docs/screenshots/m0-01-initial.png` —— 左栏图标条出现「插件 / 任务看板 / **任务日历**」，内联 SVG 图标正常。
- `docs/screenshots/m0-02-panel.png` —— 点击后切到**整页面板**：标题「任务日历」+ `v0.1.0` 徽标 + 「重新自检」；卡片显示「Host 路由 可达 /api/dsh-logwiki」（绿色）、摘要模型、回填窗口、里程碑清单；左栏图标为激活态。

**7. 无渲染异常**
```
fallbackVisible: 0        # 错误边界从未触发
panelPresent: 1           # .lw-root 存在
iconActive: "page"        # 激活态 aria 属性
```

### 环境观察（与 LogWiki 无关，但需记住）
同 `$DSH_HOME` 起第二个实例时，**既有插件因单实例锁未激活**（预期现象，非 LogWiki 引起）：
- `remote-ssh-ops`：`远程主机数据目录已被另一个 DSH 进程使用：...\.controller.lock`
- `ui-task-board`：`task-board ledger is already owned by process 70384`

→ 影响仅限于 3081 测试实例少两个插件；LogWiki 自身不在未激活列表中。

---

## 集成层（`lib/index.js`）· 真机验证 —— ✅ 通过（2026-10-01）

### 设计要点
`lib/index.js` 是唯一的接口集成点，用**动态 import + 降级**接入兄弟模块：任一模块缺失/语法出错时，插件照常挂载，相关端点回 503 并附 `modErrors`，而不是把 boot 打崩。这让"边开发边保持可用"成为可能，也让用户环境不会被半成品炸掉。

### 证据

**1. 降级路径（兄弟模块全缺时）**
```
GET /api/dsh-logwiki/ping   → 200，modules 全 false，modErrors 逐条给出 "Cannot find module .../lib/extract.js"
GET /api/dsh-logwiki/state  → 503（模块未就绪）
GET /api/dsh-logwiki/refresh → 405（守卫：变更端点只收 POST）
```

**2. 运行时服务可用性实测（`/health`，本机 0.2.0-rc.2 + web profile）**
```
webServer ✓  sessionQuery ✓  sessionPersistence ✓  sessions ✓
storage ✓  storageDomain ✓  llm ✓  agentDefaultModel ✓
timer ✓  subprocess ✓  credentials ✓  tools ✓  jobs ✓
workspaceRegistry ✗   workspaceController ✗
```
→ **`workspaceRegistry` 根本未提供**：即使 `storageDomain`/`sessionPersistence` 都在，`ctx.get` 仍为 undefined，且 `ctx.inject(['workspaceRegistry'], cb)` 的**回调从未触发**（`workspace` 条目处于 pending，也不在"未激活"清单里）。
→ 处置：**改为不硬依赖它**，工作区标签退回 `cwd` 的 basename（即工作区目录名，与侧栏工作区列表所见一致）。已写进 `OVERVIEW §5`。

**3. 工具注册（修了一个真实方言坑）**
首轮注册失败：
```
unsupported JSON schema: schema.properties.ok.required is not supported on type "boolean"
```
→ `parameters` 用 **defineTool DSL**（`required: true` 写在属性内），而 **`output.schema` 是真正的 JSON Schema**（`required` 必须是数组）。两种方言在同一对象里混用。修正后：
```
tools.registered: [logwiki_write_digest]   tools.errors: {}
```

**4. 真机端到端模型调用 —— ✅（这是线 B 明确说它无法覆盖的一步）**
```
POST /api/dsh-logwiki/summarize/probe   (头 x-logwiki: 1)
HTTP 200
{"ok":true,"provider":"deepseek-official","model":"deepseek-flash"}
```
验证到的链路：`vendor-dsh.js` 解析（两条根都命中真实 `dsh-llm`/`dsh-timeout`）→ `createUserMessage(source.kind='plugin:dsh-logwiki')` → `ctx.llm.stream`（**省略 `purpose`/`sessionId`**）→ `BlockAssembler` → `finish` 判定 → 真实 provider 返回。

### 据此修正的契约（已同步 OVERVIEW.md）
1. `collectSummaryTargets` 的 target 补上 **`sessions`（会话记录数组）** —— 原实现只给 `sessionKeys`，提示词里拿不到 title/promptPreview/toolHistogram，摘要质量会明显下降（线 B 报回，属实）。
2. `createSummarizer(ctx, summarizeConfig, uiConfig)` **三参**（原契约写两参）。
3. `.prompts.js` 与 `.vendor-dsh.js` 的导出块补进 §3 冻结。
4. §0 的 `vendor-dsh.js` 归属由"集成方"改为**线 B**。
5. `package.json` 的 `files` 白名单补齐 7 个 lib 文件（发布时会漏）。

---

## 51/611 丢数据的真根因 + 我的「孤儿子代理」误判（2026-10-01）

> **本节是改正版。** 初版此节称"发现第三种形态：孤儿子代理"，**那是错的**，由修复线（线 D）用原始 header 统计推翻。原错误结论已从 `OVERVIEW §5` 删除，误导性的错误推理保留在下面"我的误判"一节里作为教训。

线 A 的自检在守恒断言上失败（`期望 1575，实际 1524`，差 51 回合 / 611 steps）。

### 真根因（线 D 定位到单条链，数值完全相等）
```
session-8394d5bf (subagent, parent=d3f8b95d, turns=51, steps=611)
  → session-d3f8b95d (origin 缺省、delegationDepth 0 —— 按契约**就是顶层**，但它恰好带 parentSession=d32f59a8)
    → session-d32f59a8 (真顶层)
```
归并逻辑当时会归并「**任何**带 `parentSessionId` 的记录」（而不是只归并非顶层记录）。于是：
- `d3f8b95d` 被并进 `d32f59a8` **并删除**；
- `8394d5bf` 被并进 `d3f8b95d` 的**克隆体**；
- 克隆体随后也被删 → **51/611 凭空蒸发**。

**正确规则（已写入 `OVERVIEW §5`）**：
1. **只归并非顶层记录；顶层记录永不参与归并**（哪怕它带着 `parentSession`）。
2. **归并不得改写父记录的 `delegationDepth`**。
3. 真正无法上溯的子代理：保留 + 打 `orphanSubagent: true`，**照常计 turns/steps/tokens，但不计入 `work.sessions`**（纯兜底，本机语料 0 条命中）。

### 我的误判（教训，值得反复看）
我的诊断脚本打印了 `rollupSubagents(...).parents`，**把被变换过的克隆体当成了原始记录**，于是看到 20 条 `depth>0` 且无 `parent/origin` 的值，就断言存在"孤儿子代理"，还：
- 写进了契约（`OVERVIEW §5.3`）、
- 落成了 importance 4 的记忆、
- 并把错误结论**转给了修复线当判据**。

真相：那 20 条是**顶层克隆体**，其 `delegationDepth` 被 `mergeInto` 里的 `target.delegationDepth = Math.max(...)` 抬高了，于是不再满足 `isTopLevel()`。线 D 的原始 header 统计（464 份）：`depth > 0 且无 parentSession` **= 0 条**；`depth === 0` 的 50 条**全部** origin 缺省；`depth > 0` 的**全部** origin=subagent。它举的 `session-b0db4aa2` 原始 = depth **0** / 自身 5 turns / 吸收 1 条 → 克隆 depth 1 / turns **6**，**正是我贴出的那条样本**。

**更要命的是**：我最初用原始 header 得出的「无法上溯 = 0」**本来是对的**，我却因为看错中间产物而**自己把它推翻成了错误结论**，并下发给下游。

**三条教训**：
1. **诊断必须看原始输入**（原始 header / 原始事件），绝不能拿 `rollupSubagents()` 之类函数的返回值当"原始事实"——它已经被变换过。
2. 一旦把结论转给下游，下游会**基于它做决策**；错误结论的代价会被放大。
3. 自己先前基于更原始证据的判断，**不要在没有更强证据时轻易自我推翻**。

### 仍然正确的那个缺陷（保留）
`lib/index.js` 的 `collectSummaryTargets` 原本只跳过 `origin === 'subagent'`。虽然"孤儿子代理"不存在，但 **`origin` 字段确实可能缺省**，所以只查 `origin` 仍是错的——必须用 `extract.isTopLevel()`（契约口径 `delegationDepth === 0`）。改动保留：

```js
const isTop = typeof mods.extract?.isTopLevel === 'function' ? mods.extract.isTopLevel(s) : s.origin !== 'subagent'
if (!isTop) continue
```

冒烟验证：
```
顶层(origin缺省,depth0)   isTop=true  → 作为日卡候选: true
子代理(depth1,有parent)   isTop=false → 作为日卡候选: false
```

（注：本函数定义在 `apply` 作用域，看不到 `doRefresh` 里的局部 `extract`，必须走 `mods.extract` —— 首版编辑踩过这个作用域错误并已改正。）

### 测试侧纪律
修复线报告：线 A 版本曾把守恒断言改成 `dayTotals.turns == 归并后结果集合计`（同源、恒真）+ `keptTurns <= sessionTotals.turns`（弱化）——**这是"为变绿而弱化断言"**。已要求恢复强不变量 `Σ各天 turns == Σ全语料 turns`（`includeSubagents=true`）并加 51/611 那条链的回归用例。
另外我先前判定"测试期望 bug"的清单里，**只有两条是真的**（① `merged.turns === father.turns + resolvedParent.turns` 忽略了兄弟子代理；② `quantileThresholds` 期望 2–3 档与契约的 4 档不符 + `90.1` 浮点严格相等）；**守恒与"结果集全部是顶层"是实现 bug**，不能放宽。这一点我已收回先前的说法。

---

## 端到端联调暴露并修掉的缺陷（2026-10-01）

跑 `scripts/accept-l1.mjs` 真机联调，抓到 4 个缺陷，**其中 3 个是我自己写的**：

| # | 缺陷 | 现象 | 修法 |
|---|---|---|---|
| 1 | **`ctx.timeout(0)` 需要注入 `timer`** | 刷新第一步即 `cannot get property "timer" without inject`，回填完全跑不动 | 改用普通 `setTimeout` 的 `yieldToLoop()`；**刻意不把 `timer` 加进 inject**——本插件坚持最小依赖（只有 `webServer`），少一个硬依赖就少一种"整体不激活"的失败模式。`dsh-usage-stats` 之所以要把 `'timer'` 写进 inject，正是因为它用了 `ctx.timeout`。 |
| 2 | **`ctx.logger` 同样需注入** | 启动日志一直没出现（被可选链静默吞掉） | 改为模块级 `log()`/`warn()` 直走 `console`，日志确实出现在进程输出里 |
| 3 | **多读了一趟日志** | 每会话 1 次 `readSession` **加** 1 次 `readTitle`，回填 ≈15 s/会话 | 实测确认 **`extractSession` 自己就会从 `session/title` 事件取标题，且事件优先于参数** → 删掉 `readTitle`，每会话 I/O 减半 |
| 4 | **日卡候选判定用了 `origin` 字符串** | 20 条孤儿子代理会被当成日卡候选，凭空造出 20 条"任务" | 改用 `extract.isTopLevel()`（严格口径 `delegationDepth === 0`） |

### 我自己的两个操作失误（记为教训）
1. **用 PowerShell 正则 + `Set-Content` 改 YAML，把文件编码改坏了**（`invalid UTF-8`，`dsh` 报 `patch: entry "logwiki" not found`）——`Set-Content` 用了系统 ANSI 代码页，中文注释全废。
   → 教训：**改文件一律用 `edit`/`write` 工具**，不要用 shell 文本替换；非要用 shell 就必须显式 `[System.IO.File]::WriteAllText(..., UTF8Encoding($false))`。
   → 修复：删掉受损文件 → 建空文件 → `read` 同步版本 → `write` 重建，`--dump-config` 复验挂载恢复。
2. **在 Windows PowerShell 5.1 里用了 `??` 空合并运算符** → 整个脚本 ParseError、续跑根本没启动，而我以为已经在跑。
   → 教训：这台机器的 PowerShell 不支持 `??`，写脚本要按 5.1 语法。

### 性能与分批策略
首次回填需逐个会话 `readSession`（重放校验 + 多帧解压），1020 个清单项无法一轮跑完。已加 `scan.maxNewPerRun`（默认 200）并按「新增」计数分批：**从新到旧**，日历先可用，后续「更新」续跑，`scan.pending` 如实报告剩余。

---

## 修复线（线 D）交付 · 独立复核通过（2026-10-01）

### 我亲自复核（不采信报告）
```
lib/fold.js                  26213 bytes  sha256=D7ECFC2EB259…401B8A7B438B   ← 与线 D 声称逐字一致
scripts/verify-extract.mjs   47937 bytes  sha256=86629C70C9A2…00B28624CFA2   ← 与线 D 声称逐字一致
8 个 lib 文件 node --check    全部 exit=0

$ node scripts/verify-extract.mjs
断言通过：159   断言失败：0   ✅ 全部通过   exit=0
```
测试跑在 **477 份真实日志**上，`extractSession` 跳过 0。

### 十条失败逐条判定（4 条测试 bug + 6 条实现 bug，均改对的那一侧）
**测试 bug（4+2）**：① `quantileThresholds` 四条 —— 契约 §3 是 `[p25,p50,p75,p90]` **四档 + 线性插值**，旧期望只写 2–3 档；`90.1` vs `90.10000000000001` 是浮点严格相等（改用 epsilon）。② 两条「父会话 turns/tokens 增加」—— 旧断言只加**一个**子代理，忽略了同一父还会吸收兄弟/孙代（改为按「全部会被归并的后代」求和）。

**实现 bug（4，全在 `lib/fold.js`）**：
- `parents` 里残留 20 条非顶层 ← `target.delegationDepth = Math.max(...)` 抬高父克隆体 depth，使其不再满足 `isTopLevel()`；
- **守恒丢 51 turns / 611 steps** ← 「伪顶层链」被整条删除（详下）；
- `buildDay` 会话数虚增 ← `datesOf` 用 `lastEventAt/createdAt` 兜底，把 `perDay` 为空的**零工作量幽灵会话**算成会话。

### 守恒修复前后（464 份语料快照）
| 指标 | 旧实现 | 修复后 |
|---|---|---|
| `parents.size` / `subagentKeys` / `orphanKeys` | 39 / 425 / 0 | **50 / 414 / 0** |
| `parents` 里非顶层条数 | **20** | **0** |
| Σrecords.turns → Σparents.turns | 1585 → 1534（**丢 51**） | 1585 → 1585（**0 丢**） |
| Σrecords.steps → Σparents.steps | 28369 → 27758（**丢 611**） | 28369 → 28369（**0 丢**） |
| 2026-10-01 / 09-13 会话数 | 9 / 3 | **7 / 2**（逐日 28 天全一致） |

### `lib/fold.js` 的六点改动
① **只归并 `!isTopLevel` 的记录**（顶层记录永不参与，哪怕它带着 `parentSession`）；② **删掉 `delegationDepth` 抬高**；③ **先确认 target 存活再 add/delete**（原顺序 `subagentKeys.add` 早于 target 检查，是潜在丢数据路径）；④ 无法上溯者保留为独立记录 + `orphanSubagent: true` + 新增返回 `orphanKeys`，`buildDays`/`buildDay` 照计 turns/steps/tokens 但**不计 `work.sessions`**（纯兜底，本语料 0 条命中）；⑤ `datesOf` 去掉 `lastEventAt/createdAt` 兜底；⑥ `isTopLevel` 改为从 `extract.js` import（口径单点定义）。

### 断言只增强、未放宽
- **恢复强不变量**：`Σ各天 turns/steps == Σ全语料`、`Σparents == 全语料`、`tokens.input == 全语料`（旧实现必红的三条回归锁）。
- **改对错的那一侧**：`parentsTurns == keptTurnsRaw` 是旧实现丢数据后**碰巧成立**的假等式 → 换成正确分解式 `parentsTurns == keptTurnsRaw + mergedTurns`；「delegationDepth 抬到最深后代」→ 改为「未被改写且仍 `isTopLevel`」；「buildDay 会话数 == 归并后结果集落在该天的条数」（同源恒真）→ 改为独立复算 + 逐日 28 天扫描。
- **新增回归**：伪顶层链 7 条、孤儿子代理 3 条、幽灵会话 2 条 —— 直接锁死本次两个实现 bug。

### 线 D 在我文件里发现的真 bug（已修）
`lib/index.js` 的 `collectSummaryTargets` 把**字符串键数组**喂给 `daySessionFingerprint`（契约要的是**会话记录数组**），`normalizeSessions` 把字符串全跳过 → 恒返回空串哈希。线 D 给出的可复现证明：
```
daySessionFingerprint(['local::A','local::B']) === daySessionFingerprint(['local::Z'])  → true（同为 da39a3ee5e6b4d0）
```
后果：`dayState.sessionFingerprint === fingerprint` **永远成立** → 「会话变了就重算摘要」这条逻辑**静默失效**（只靠 status/hasEntries 短路）。
一行修复：`fold.daySessionFingerprint(bucket.sessions)`（`bucket.sessions` 是我先前为修 `summarizeDay` 入参时加的会话记录数组）。已加注释说明为何不能传 keys。

---

## L1 验收 + 写入真实 web 端 + 重启 3080 复验 —— ✅ 完成（2026-10-01）

### ① L1 验收（自管实例 3082，**真实数据**）
```
$ node scripts/accept-l1.mjs http://127.0.0.1:3082 --no-refresh
=== 汇总：22/22 通过 ===   exit=0
```
真实数据（`/state` 与界面数字逐字吻合）：
```
totals: 652 回合 / 25 会话 / 25 条目
heatmap: 7 天有活动（2026-09-25 → 2026-10-01；10-01 最忙 355 回合 / 4 条）
scan: done=true, truncated=true, pending=697（剩余历史待后续「更新」续跑）
degradedDays: 0（无降级，摘要全部由 LLM 生成）
```
条目示例：`2026-10-01 07:11 制定 dsh-LogWiki 任务日历插件开发计划，确定先装 web 端测试验收通过再终止任务。`（标签 插件开发）

**静态门**：8 个 lib 文件 `node --check` 全过；`verify-extract.mjs` **159 断言 0 失败**；`verify-prompts.mjs` **103 断言 0 失败**。

**真实数据可视证据**（此前的 `c-0*.png` 是 CDP 注入 mock 渲染的，**不算真实证据**，已作废）：
- `docs/screenshots/l1-real-01-heatmap.png` —— 热力图 7 个绿格 + 「2026 年 · 652 轮次 · 7 个活跃日」
- `docs/screenshots/l1-real-02-day.png` —— 三层卡片：来源「本机」→ 工作区「DSH」「DSH-LogWiki」→ 4 条条目（标签 chip、会话数、编辑/删除、`已手改` 徽章）

### ② 修掉一个真实缺陷（工作区计数恒为 0）
`fold.js` 的 `buildDay` 把工作区卡的 `turns/sessions` **硬写成 0**，于是「当天合计 355 轮 / 4 会话」与「工作区卡 0 轮 / 0 会话」自相矛盾（0+0 ≠ 355），界面看起来像坏了。
修法：在统计当天会话的同一个循环里按 `workspaceLabel` 归集 `wsTurns`/`wsSessions`。
复验：
```
当天 totals: 355 轮 / 4 会话
  [DSH]         336 轮 / 3 会话 / 3 条
  [DSH-LogWiki]  19 轮 / 1 会话 / 1 条
工作区合计 = 355 轮 / 4 会话  → 与当天一致 ✓
```
改动后重跑 `verify-extract.mjs` **仍 159/0 全绿**；L1 验收重跑 **22/22**。

### ③ 写入真实 web 端
`$DSH_HOME\profiles\web\cordis.patch.yml` 追加 insert 块（`id: logwiki`，绝对 `file:///` 路径，config 写全）。
- **before**：`--profile web --dump-config` = 1749 行、无 logwiki。
- **after**：1780 行、出现 `- id: logwiki`（line 1757）；`dsh-overleaf` / `fantian-workbench` 行完好。
- **关键事实**：桌面端走 `profiles/desktop`（进程命令行确认），**不是 `profiles/web`** → 本改动只影响 web 端。

### ④ 重启 3080 并复验
```
旧 pid 70384 → 停止 → 新实例 pid 16240（分离进程 --profile web --port 3080 --no-open）
GET http://127.0.0.1:3080/api/dsh-logwiki/ping → HTTP 200，五个模块全 ✓
[startup] [dsh-logwiki] v0.1.0 已挂载：/api/dsh-logwiki｜工具 logwiki_write_digest
$ node scripts/accept-l1.mjs http://127.0.0.1:3080 --no-refresh
=== 汇总：22/22 通过 ===   exit=0
```
可视证据：`docs/screenshots/l2-3080-heatmap.png` —— 真实 web 端上的整页日历、7 个绿格、「652 轮次 · 7 个活跃日」，与 `/state` 一致。

### ⑤ 实例收敛（单一 KV 写者）
```
19387 监听中 (pid 59360)  ← 桌面端，全程未动
3080  监听中 (pid 16240)  ← 真实 web 端，跑着 LogWiki
3082 / 3081 已关闭
```

### ⑥ 运行期观察（非缺陷，记以备查）
读超大日志（5 MB 级、多帧解压 + 重放校验）时事件循环会被占住数十秒，期间 HTTP 探针会超时，表现为"服务像挂了"，实际仍在推进（store 文件持续增长、CPU 持续消耗）。**监控脚本的短超时会误报**，应容忍失败并重试或放宽超时。

### ⑦ 调参修正：`maxNewPerRun` 60 → 300（面向真实使用，而非开发）
安装时我把上限设成了开发用的 **60**（当时是为了让自己快速迭代、让轮次几分钟就结束）。但对真实使用这是**错的**：`scan.pending = 697`，若每次「更新」只吃 60 个，用户要点十几次——**看起来就像坏了**，也不符合需求里"点更新就更新日志"的预期。
已把三个 patch 文件（`profiles\web\cordis.patch.yml` 生效中 / `dev\logwiki.patch.yml` / 包内 `dsh-logwiki\cordis.patch.yml`）统一改为 **300**，重启 3080 后用 `/ping` 确认配置已生效（`{"sinceDays":365,"maxSessions":2000,"maxNewPerRun":300}`）。
**教训：开发期的调参值不能直接带进生产**——"让我迭代快"和"让用户一次点完"是相反的取向，交付前必须按使用者视角重新取值。

**重启后复验**：`node scripts/accept-l1.mjs http://127.0.0.1:3080 --no-refresh` → **29/29 通过，exit=0**；3080 新 pid 51380；桌面端 19387 仍为 pid 59360（未动）。

### ⑧ 需求 7（周/月简报）端到端验证 + 修掉一个真实阻塞
此前只验证过 `/digests/available`（返回空），**简报生成路径从未真正跑通过**。这次实跑暴露一个真实阻塞：
```
POST /digest/generate {kind:week, period:2026-W40} → HTTP 500
{"ok":false,"error":"模型输出被 maxTokens（2048）截断"}
```
根因：`summarize.maxTokens: 2048` 对**条目摘要**够用（短输出），但**对简报不够**——模型还没吐完 8–12 条就被截断（很可能是推理 token 吃掉了预算）。这是我自己的取值问题，已把 `maxTokens` 2048 → **8192**（三处 patch 同步），重启后 `/ping` 确认生效。

修复后：
```
POST /digest/generate → HTTP 200, 13.4s
title   : 2026-W40 · DSH 插件与创作工作流
headline: 本周主线为 DSH 插件平台的开发、排障与升级，同步推进翻填工作台交互化改造…
items   : 11 条      ← 正落在用户口径「一般 10 个左右」内
  1. [工作台改造] 将翻填工作台改造为交互式流程，修复受阻目标后推送重启…
  2. [文献整理]   完成 arXiv 巡检：新文献入 Zotero、精读整理为 Obsidian 笔记…
  …（共 11 条，每条一句话 + 一个标签）
```
缓存与交接通道：
```
GET  /digests/available                    → {"weeks":["2026-W40"],"months":[]}
GET  /digests?kind=week&period=2026-W40    → ok=true, items=11, 与刚生成一致（未重算）✓
POST /digest/agent-prompt                  → ok=true, 2427 字, 含工具名 logwiki_write_digest ✓
```
**教训**：`maxTokens` 这类"够用就行"的参数，在**短输出路径**上通过不等于在**长输出路径**上也通过——分路径取值，或直接给足。

### ⑨ 探针工具的一个坑（记以备查）
用 PowerShell `Invoke-WebRequest -Body '{...}'` 与 `curl.exe -d "{\"...\"}"` 发 JSON 时，**引号被转义层吃掉**，服务端收到的是不合法 JSON，返回 `请求体不是合法 JSON`——**与真实故障完全不同的报错**，害我先怀疑服务端。改用 **node 的 `fetch` + `JSON.stringify`** 立刻拿到真实错误（`maxTokens 截断`）。
**纪律：验证 HTTP 接口时优先用 node fetch，不要用 PowerShell/curl 拼 JSON**（转义层太多）。

### ⑩ 需求 7 补全：月总结也测了 + 简报纳入验收门禁
上一节只验了**周**简报。**月**简报从未跑过，属明确覆盖缺口，这轮补上：
```
month:2026-09  → HTTP 200, 7.9s, 9 条    title: 2026 年 9 月 · DSH 平台与创作工作台
month:2026-10  → HTTP 200, 9.9s, 8 条    title: 2026 年 10 月 · 插件平台与 Wiki 选型
/ digests/available → {"weeks":["2026-W40"],"months":["2026-09","2026-10"]}
```
**周/月四条全部落在 8–12 条区间**（11 / 10 / 9 / 8），正合用户口径"一般就在大方向上总结出10个左右"。

**按自己的教训把简报纳入验收门禁**（`accept-l1.mjs` 新增 8 项，含 `isoWeekOf` 辅助）：不再是"看 `/digests/available` 返回 200 就算过"，而是**真正生成一次**并断言：
```
PASS  /digests/available 可达 — weeks=1 months=2
PASS  POST /digest/generate 周简报 2026-W40 — 10 条
PASS  简报条数在 1..12（用户口径：一般 10 个左右） — 10 条
PASS  简报每条都有一句话总结
PASS  简报带标题与总览 — 2026-W40 · 翻填工作台与 DSH 插件
PASS  简报可缓存复读（不重算） — generatedAt=1790823272343
PASS  POST /digest/agent-prompt 返回可交给智能体的提示词 — 2427 字
PASS  提示词点名 logwiki_write_digest 工具
=== 汇总：36/36 通过 ===  exit=0
```

**可视验证**（`docs/screenshots/l2-3080-digest.png`，真实 web 端）：周总结面板显示标题「周总结 · 2026-W40 / 2026-09-28 ~ 2026-10-04」、总览句、**10 张卡片**（每条一句话 + 一个标签 chip，如 `[工作台改造]`/`[语音测试]`/`[封面设计]`/`[插件开发]`），页脚「生成于 … · 范围 … · 模型 deepseek-official/deepseek-flash · 来源 local」，并有「重新生成 / 交给智能体 / 收起」三个动作。

> 已知小副作用：验收脚本每次运行都会**重新生成**一份周简报（覆盖缓存）。作为验收工具可接受，但反复跑会churn 掉用户手动生成的那份。

### ⑪ 修掉验收工具自身的副作用：改为**安全默认（只读）**
承 ⑩ 记录的副作用——验收脚本直连生产实例却会写数据（改条目、重生成简报覆盖缓存），已按"幂等验收"原则重构：

| 项 | 改前 | 改后 |
|---|---|---|
| 条目编辑 | 默认执行（改一条再改回，崩溃即脏） | **默认 SKIP**，需 `--mutate`（请在专用实例上用） |
| 简报生成 | 默认执行（覆盖用户那份） | **默认 SKIP**，改读**已缓存**那份并断言其条数/内容；需 `--mutate` 才重算 |
| 触发回填 | 默认执行（`--no-refresh` 才跳过） | **默认不执行**，需显式 `--refresh` |
| 刷新轮询上限 | 15 分钟 | 45 分钟（`maxNewPerRun=300` 时一轮约 25 分钟，旧值会**误报"未完成"**） |

**幂等性实证**（对生产实例跑默认模式）：
```
$ node scripts/accept-l1.mjs http://127.0.0.1:3080
=== 汇总：33/33 通过 ===   exit=0   耗时 0.3s
store 文件 sha256  改前 4A2949231A3BBD74… → 改后 4A2949231A3BBD74…   ✓ 未被改动
```
（项数从 36 降到 33，正是因为 3 项变更类断言现在被正确 SKIP 而不计入。）

**过程记录**：这次验证我第一次跑时**漏了 `--no-refresh`**，于是脚本顺带在真实实例上触发了一轮完整回填（300 个会话）。这属于"更新"按钮的正常行为、效果是**增量补历史**（观察时已 scanned 439/1057、failed 0），非破坏性；但也正说明"默认就会写"这个设计有多容易误伤——所以本次把它翻成了 opt-in。

**教训（已与"验收脚本污染被测系统"一并记档）**：**验收脚本应可反复运行且幂等；若它必须写，就必须能完整回滚，或把写入收敛到专用实例。** 另外，"改了再改回来"不是回滚——中途崩溃即留脏数据。

---

## 用户验收反馈修复：周/月简报未跟随选中日期 —— ✅ 完成（2026-10-01 17:xx）

### 反馈原文
> 「周总结和月总结似乎不可以选择显示某月或者某周。我希望在我点进某一天查看的时候，点击月总结和周总结出现的就是其对应的月和周？或者你有其他更加成熟规范的方案也可以。**其余功能验收通过。**」

### 根因（一行代码）
`lib/client.js` 的 `openDigest` 写死 `new Date()`：
```js
const openDigest = useCallback((kind) => {
  const d = new Date()                                     // ← 永远"今天"
  const period = kind === 'week' ? gfmWeekKey(d) : monthKeyOf(d)
  setDigestOpen({ kind, period })
}, [])
```
于是无论你在看哪一天，简报永远出"今天所在的周/月"——面板与日详情**各说各话**。
次要问题：宿主端 `/digests/available` **只列"已生成过简报"的周期**，客户端因此无从知道"哪些周期有活动可以跳过去"。

### 采用的方案（"成熟规范"口径：周期跟随焦点 + 显式周期导航）
1. **周期跟随选中日期**：`periodOfDate(kind, selectedDate)`；未选中日期才回落"今天"。
   已打开的简报在**选中日变化时自动跟着走**（用户明确要的行为）。
2. **显式周期导航**：面板头部 `‹ 周总结 · 2026-W39 ›`，只在**有活动的周期之间**跳；
   `回到本周/本月` 按钮在当前周期时自动隐藏，点击会**同时清空选中日期**。
3. **周期活动量提示**：头部显示 `2026-09-21 ~ 2026-09-27 · 3 天有活动 · 3 条条目`，
   并据此区分「生成」与「重新生成」（与 `hasDigest` 一致）。
4. **新增宿主端点 `GET /digests/periods`**：返回有活动的周/月（含 from/to/days/entries/turns/hasDigest）。
5. **修掉一个我会引入的串台 bug**：周期变化时必须重置 `localDigest`/`promptText`，
   否则 `localDigest` 优先于取数结果 → 切到上一周却仍显示原周期那份。

### 中途踩的两个坑（都记档）
- **`isObj is not defined`**：我在 `index.js` 里用了客户端才有的辅助函数（`fold.js` 有 `isObj` 但未导出）。端点直接 500，
  但插件自己的错误上报把原因打进了日志（`端点 /digests/periods 处理失败: isObj is not defined`），定位很快。
- **周期条目数全是 0**：我读了 `days[date].work.entries`，但 `days`（`buildDays` 产物）**只有 turns/sessions/tokens**
  —— 热力图里的条目数是 `buildState` 读时拿 entries map 现算的。改为从 `db.get().entries` 按 `date` 归集后正确。

### 验证（真实浏览器，非 mock）
```
点击 2026-09-25（属 W39）→ 面板自动切到：
  ‹ 月总结…/周总结 · 2026-W39 ›  2026-09-21 ~ 2026-09-27 · 3 天有活动 · 3 条条目  [回到本周]  生成  交给智能体  收起
  ‹ 禁用「没有更早的活动周期」   › 启用「跳到下一周（2026-W40）」
再点「月总结」→ ‹ 月总结 · 2026-09 ›  2026-09-01 ~ 2026-09-30 · 6 天有活动 · 20 条条目  [回到本月]（并渲染 9 月简报 10 张卡片）
再点「回到本月」→ 周期切到 2026-10、**日详情自动关闭**、「回到本月」按钮消失
```
截图：`docs/screenshots/v2-digest-follows-day.png`（左 W39、右 2026-09-25，两侧同步）。

**回归**：验收从 33 项扩到 **38/38**（新增周期清单可达 / 排序 / 字段 / 两条守恒不变量：月条目之和 == 总条目数、周 hasDigest 与 available 一致）；
`verify-extract` 159/0、`verify-prompts` 103/0、`verify-remote` 60/60、`verify-zstd-frames` 8/8 全绿。桌面端 19387 仍未重启。

### ⚠️ 用户复验发现：`‹ / ›` 箭头点了没反应 —— ✅ 已修（2026-10-01）

**用户反馈**：「目前点击跳转到上一周和下一周的箭头按钮 <, > 没有生效，其余功能一切正常。」

**根因（我引入的）**：上一节加的"周期跟随选中日" effect **会把手动导航立刻拉回来**：
```js
useEffect(() => {
  if (digestOpen === null) return
  const period = periodOfDate(digestOpen.kind, selectedDate)  // 仍按"选中日"算
  if (period !== digestOpen.period) setDigestOpen({...})      // 把你刚跳走的周期改回去
}, [selectedDate, digestOpen, periodOfDate])
```
点 `›` → 周期变 W40 → effect 发现"≠ 选中日的 W39" → 改回 W39 → 表现为**点了没反应**（按钮没坏，是被弹回）。

**修法**：用 ref 记住"上一次跟随过的日期"，**只在日期真的变了**时才跟随：
```js
const followedDayRef = useRef(selectedDate)
useEffect(() => {
  const dayChanged = followedDayRef.current !== selectedDate
  followedDayRef.current = selectedDate
  if (dayChanged === false) return      // 手动导航/其它状态变化 → 不动周期
  ...
}, [selectedDate, digestOpen, periodOfDate])
```

**我为什么没测出来（重要的方法论教训）**：上一轮我只用 DOM 查询断言了按钮的
`title`（"跳到上一周（2026-W39）"）与 `disabled` 状态，看到它们都对就判定"已验证"——
**但从没真的点过它**。按钮的"存在/文案/禁用态"正确 ≠ 它的行为正确。
→ 已把 7 条**必须真点**的交互单独列进 `docs/MANUAL-CHECKLIST.md` 的 C2 节，
并写明"`accept-l1.mjs` 只打 HTTP，测不到点击"，避免同类盲区。

**本次实测（真的点了）**：
```
无选中日 → 周总结 = 2026-W40
点 ‹     → 2026-W39 并停住（‹ 变禁用"没有更早的活动周期"，› 变"跳到下一周（2026-W40）"，出现"回到本周"）
点 ›     → 2026-W40（回到起点）
点 09-25 → 自动跟随到 2026-W39，日详情打开，"回到本周"title 正确变为"回到今天所在的周"
```
**回归**：验收 **38/38**、`verify-extract` 159/0、`verify-prompts` 103/0、`verify-remote` 60/60、`verify-zstd-frames` 8/8。

---

## 发布到 GitHub + 二期接线（远程来源） —— 进行中（2026-10-01 傍晚）

### A/B. 发布物与仓库（已完成）
- 新增 `.gitignore`（**屏蔽三类真·敏感物**：`.dsh-meow/` 记忆库、`dev/*.log`（`3080.out.log` 里含**带 token 的访问 URL**）、`dsh-logwiki/_baseline.txt` 测试转储），并排除 `docs/screenshots/c-0*.png`（那四张是 **CDP 注入 mock 数据**渲染的，验收清单里已声明"不算真实证据"，放进公开仓库会误导）。
- 新增 `LICENSE`（MIT，依据：用户 16 个有 license 的仓库里 12 个 MIT，**四个 DSH 插件全是 MIT**，且 `package.json` 早已声明 `license: MIT`）。
- `README.md` 改写为公开发布版：去本地化绝对路径（`$DSH_HOME` / `<repo>` 占位）、补徽章与三张真实截图、修正过时数字（33/36 → 38/38）、补 `files` 白名单与 `repository` 字段。
- 新增 `.gitattributes`（`* text=auto eol=lf`）消除 Windows CRLF 噪声。
- **推送前硬闸门**：`git ls-files` 必须不含 `.dsh-meow/`、`dev/*.log`、`_baseline.txt`、`c-0*.png` → 实测 35 个文件全部干净后再提交。
- 结果：**https://github.com/gychen-NJU/dsh-logwiki**（public / MIT / main），本地与远端一致。

### C1. 宿主：模块加载 + 工具注册
- `loadModules()` 的 specs 追加 `['remote','./remote.js']`、`['remoteSources','./remote-sources.js']`；沿用**动态 import + 降级**（缺了只让相关端点 503，不影响一期）。
- `registerTools()` 追加 `logwiki_import_source`（`mods.remoteSources` 缺失时自动少挂一个工具，不抛）。
- 新增 `upsertSource()`：**`/source/add` 与 `logwiki_import_source` 共用同一条写入口**，保证"对话框加的"和"智能体加的"落库结果一致（否则极易出现"界面加的能同步、智能体加的不能"）。

### C2. 宿主：来源管理路由（全部走既有的 `guardMutation`）
`GET /sources`（扩展：附 `sessionCount`/`entryCount`/`remoteEnabled`）、`GET /source/discover`、`POST /source/add`、`POST /source/delete`、`POST /source/prompt`、`POST /source/sync`（异步，回 jobId，进度走既有 SSE）、`GET /source/sync-status`。
- `POST /source/delete` 会**连带清除**该来源的会话（`id::` 前缀）、条目（`sourceId===id`）、同步账本，并**立刻重算天聚合** —— 否则源没了数据还在，界面按来源分区时会出现无主的孤儿条目。
- 新增模块级 `wslScriptArgv()`：把 shell 脚本 **base64 包裹**后交给 `wsl.exe -e sh -lc`，绕开 Windows→WSL 的多层转义（与 `remote.js` 的 `buildSshArgv` 同一招）。

### C3. 宿主：同步执行器 `syncSource()`
`resolveExecutable` → `spawn(buildSshArgv(index))` → `parseIndex` → `planSync`（增量 + 从新到旧 + 双预算）→ 逐文件 `base64 -w0` 拉回 → 解码 → `remotePayloadToFingerprint` → 落库（`<sourceId>::<sessionId>`，带 `workspaceLabel`）→ 更新账本。
- 同一时刻**只允许一个来源同步**（`remoteRunning`）：WSL 的 ControlMaster 是**一条共享连接**，并发只会互相抢连接、把 2FA 提示搅乱。
- 每个文件后 `yieldToLoop()`：会话解码是纯计算，连续解多个会像回填那样把网页卡住。
- `explainRemoteFailure()` 把失败翻译成**可操作指引**（"请在 WSL 终端执行 `ssh -fN rocs` 完成 2FA" / "主机指纹未确认" / "主机名解析失败"）——报"退出码 255"等于没报。

### 实测踩到的两个真问题（本节的实质价值）
**① `maxBytesPerFile` 给小了 → 20 个远端文件里有 1 个拉不下来。**
`base64` 会膨胀约 4/3，我却按 `size*1.4+1MB` 算、再 `Math.min(..., 16MB)` 封顶 → 一个 ~11 MB 的会话日志正好撞顶，输出被截断。
修复：`maxBytesPerFile` 16 MB → **64 MB**，并改成**先预判再下载**（超出上限直接跳过并说清原因，不白传一趟）。重同步后 **20/20 成功**，且增量逻辑正确（只重拉那 1 个，其余 19 个按账本跳过）。

**② 远端同步的位置排错了 → "同步成功但什么都没发生"。**
最初把同步放在 `doRefresh` 的**最末尾**，而重算天聚合与 LLM 摘要都在它**之前**执行。后果：远端会话进了 `sessions`、日历上**回合数变了**，却**一条任务卡都不出**（`2026-09-24` 有 55 回合、0 条目）。
修复：把同步移到**第 2.5 步**（本地扫描之后、重算与摘要之前）。
> **可推广的教训**：流水线里"补数据"的阶段**必须排在所有消费它的阶段之前**；位置排错时，症状往往不是报错，而是**静默地少算一部分**——最容易被当成"功能没做完"。

### 端到端实测（真实远端，非 mock）
`rocs` = 一台在 WSL 的 `~/.ssh/config` 里配好的远端主机（不在此处记具体主机名与用户名），远端 `~/.dsh/sessions` 有 **20 个 v4 日志**，ssh config 已配 `ControlMaster auto`，**BatchMode 免交互通过**。
```
点「+ 添加来源」→ 对话框自动探测到 WSL `~/.ssh/config` 里配置的主机别名
填别名与远端 DSH_HOME → 点「登记来源」→ 工具栏出现该来源的 chip
点「同步」→ 进度条 "rocs：拉取 11/20" → 完成
/sources → rocs: 会话 20 · 状态 ok
state.totals.sessions  25 → 56；日历新增 2026-09-24 这一天（远端带来的）
```

### 边界与红线（实测）
| 场景 | 结果 |
|---|---|
| 别名注入 `a; rm -rf /` | **400**，带原因，不落库 |
| 相对路径 / 保留 id `local` | **400** |
| 删 `local` / 删不存在的来源 | 400 / 404 |
| 缺 `x-logwiki` 守卫头 | **403** |
| 对变更端点发 GET | **405** |
| 单文件超上限 | 跳过 + 明确警告（不写坏数据） |
| 远端非 v4 日志 | `remotePayloadToFingerprint` 返回 null → 跳过并计入 failed |

### 验收发现：又一条"我的尺子错了"
全景验收跑到 **43/44**，唯一失败是 `条目按时间升序`。
查明结果：**数据完全正确，断言写错了**。`/day` 的排序契约是"**每个工作区内部**按 `startTime` 升序"，而我的断言把多个工作区的条目**拉平成一个数组**再比大小 —— 不同工作区的时间本来就会交错：
```
local/DSH          14:55 14:55 14:55
local/DSH-LogWiki  23:11          ← 拉平后接在 14:55 之后，没问题
rocs/bifrostNN     12:10          ← 拉平后接在 23:11 之后 → 断言误报
```
以前只有两个工作区时**碰巧**是升序，远端来源进来后才暴露缺陷。已改为**按工作区分组检查**（注释里写明"是尺子错了，不是产品错了"）。修后 **44/44 通过，exit=0**。

### 二期完工状态
```
来源 local: 会话 837 · 条目 58
来源 rocs : 会话  20 · 条目 17
totals: 1858 回合 / 81 会话 / 75 条目；活跃日 17 天（2026-09-10 ~ 10-01）
日历上 2026-09-25 → local(2ws/4条) | rocs(2ws/2条)     ← 两个来源分区并存
日详情第一层分区：「本机」 / 「远程 ROCS」，各自带独立工作区卡片与（远端）路径
```
**可视确认已做**，但截图**只存本地** `dev/_rocs-partition.png`（该路径已 gitignore）—— 不新增发布物、避免新的隐私风险。

**已知观察**：`2026-09-14 / 09-19 / 09-21 / 09-23` 有回合数但零条目（`sessions` 也是 0）。这些天的活动来自**父会话记在别日的子代理**；按现契约（子代理并入顶层、条目只由顶层会话生成）不产条目 —— 属预期行为而非 bug，但界面上会显得"那天有动静却没任务卡"，值得写进 README 的已知问题。





