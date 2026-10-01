# dsh-LogWiki

> **DSH 的任务日历 + Wiki**：把你在 DSH 里的工作按天沉淀成"一句话任务卡"，用热力图看工作量，按周/月生成大方向简报。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.0--rc.2-blue)
![零构建](https://img.shields.io/badge/build-none%20(hand--written%20ESM)-green)

![年视图热力图](docs/screenshots/l1-real-01-heatmap.png)

![日详情三层卡片](docs/screenshots/l1-real-02-day.png)

---

## 它解决什么问题

你在 DSH 里干了一天的活，但**日志是按会话存的**——想知道"上周三我到底推进了哪几件事"，得翻几十个会话文件。dsh-LogWiki 把这件事变成：**打开日历 → 点那一天 → 看几张卡片**。

- **不新增任何记录负担**：数据全部来自你已经产生的 DSH 会话日志，你不需要写日报。
- **一句话而不是转录**：每条任务由 LLM 归纳成一句人话 + 一个关键词标签，你可以手改，改过的**永不被自动重算覆盖**。
- **周/月简报按"大方向"而非流水账**：明确要求模型产出 **8–12 条**，实测周 11/10 条、月 9/8 条。

## 功能

| 能力 | 实现 |
|---|---|
| 日历 + 工作量热力图 | GitHub 风格 53×7 网格；指标可切 回合 / Token / 会话数 / 条目数；阈值按可见窗口的分位数（p25/p50/p75/p90）分档 |
| 点进某天看做了什么 | 抽屉式详情，**来源 → 工作区 → 任务条目** 三层卡片 |
| 一句话任务卡 | 时间 + 一句话总结 + 关键词标签 + 来源会话数；按时间升序；卡片风格 |
| 标签可编辑 | 条目可编辑/删除/新增；手改后打 `已手改` 徽章且**永不被重算覆盖**，同时被排除出 LLM 输入 |
| 手动更新 | 「更新」按钮 + SSE 实时进度；增量、分批、从新到旧，可断点续跑 |
| 周/月简报 | 插件内直调 LLM 归纳并**落库留存**；「重新生成」才覆盖；另有「交给智能体」按钮把提示词写进输入框 |
| 周期导航 | 简报**跟随你正在看的那一天**（点 9/25 就出 9/25 那一周），并可用 `‹ ›` 在**有活动的周期之间**前后跳 |

**来源隔离已经就位**：内部键是 `<来源>::<会话>`，条目 id 也含来源，日详情第一层就是来源分区——所以"本机 + 远程服务器（如 `rocs`）分别成卡"是数据结构原生支持的（远程来源的采集通道见文末 Roadmap）。

## 安装

**零构建**：克隆后直接指向 `lib/index.js` 即可，不需要 `npm install`、不需要打包。

```powershell
git clone https://github.com/gychen-NJU/dsh-logwiki.git
```

然后在 `$DSH_HOME/profiles/web/cordis.patch.yml` 末尾追加（把 `<repo>` 换成本机克隆路径）：

```yaml
- insert:
    - id: logwiki
      name: 'file:///<repo>/dsh-logwiki/lib/index.js'
      config:
        scan:
          sinceDays: 365
          maxSessions: 2000
          maxNewPerRun: 300
        summarize:
          provider: deepseek-official
          model: deepseek-flash
          maxTokens: 8192
          timeoutMs: 60000
          maxConcurrency: 2
          onlyTopLevelSessions: true
        heatmap:
          metric: turns
          includeSubagents: true
        ui:
          language: zh
          weekStart: 1
        remote:
          enable: false
          sinceDays: 90
          maxBytesPerSync: 33554432
```

重启该实例后，左栏出现「**任务日历**」。卸载 = 删掉这段再重启。

**要点**
- 插件用**绝对 `file:///` 路径**加载，因此不依赖 profile 的 `node_modules`。
- 客户端半边由**最近的祖先 `package.json`** 里的 `dsh.client` + `exports["./client"]` 发现 —— 所以别只拷 `lib/`，要连 `dsh-logwiki/package.json` 一起。
- **改 host 半边必须重启实例**；客户端半边改动由 client-hmr 热替换。
- `config` 是**整体替换、不深合并**，改任何一项都要把整块写全。

## 使用

1. 左栏点「**任务日历**」。
2. 年视图看热力图，点任意有色格进某天详情。
3. 改某条摘要/标签 → 保存（标记为手改，后续重算不覆盖）。
4. 点「**更新**」增量回填新会话。**首次回填很重**，按 `scan.maxNewPerRun` 分批、从新到旧。
   - ⚠️ 读超大日志（5 MB 级、多帧 zstd 解压 + 重放校验）会占住 Node 事件循环数十秒，**期间页面会发顿**——这是预期行为，不是崩溃。
5. 「**周总结**」/「**月总结**」：跟随选中日期；有缓存直接显示，没有就点「生成」。「交给智能体」会把提示词写进输入框（不支持时给可复制文本框）。

![周总结](docs/screenshots/l2-3080-digest.png)

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `scan.sinceDays` | 365 | 回填窗口（天） |
| `scan.maxSessions` | 2000 | 候选会话上限 |
| `scan.maxNewPerRun` | 300 | 每次「更新」最多处理多少个**新增**会话（已入库的会廉价跳过） |
| `summarize.provider` / `model` | `deepseek-official` / `deepseek-flash` | 摘要与简报所用模型 |
| `summarize.maxTokens` | 8192 | ⚠️ 别调太小：设成 2048 会把简报输出截断，生成直接失败 |
| `summarize.timeoutMs` | 60000 | 单次 LLM 调用超时 |
| `summarize.maxConcurrency` | 2 | 并发上限 |
| `summarize.onlyTopLevelSessions` | true | 只为顶层会话生成条目（子代理并入其父） |
| `heatmap.metric` | `turns` | 默认指标 |
| `heatmap.includeSubagents` | true | 子代理工作量是否计入热力图 |
| `ui.language` / `weekStart` | `zh` / `1` | 语言 / 周一起始 |
| `remote.enable` | false | 远程来源总开关（二期） |

## 数据存放

- 结构化数据经 `ctx.storage` 落到 **`$DSH_HOME/storages/dsh_logwiki.json`**：条目、简报、来源、同步账本、会话指纹。
- **不要手改**这个文件——它是插件唯一的持久化载体。
- ⚠️ 该文件**被同 `$DSH_HOME` 的所有实例共享**。**同一时刻只应有一个实例启用本插件**，否则并发写。

## 验证

```powershell
cd <repo>/dsh-logwiki

# 对**生产实例**：安全、只读、幂等
# （跑前后 storages/dsh_logwiki.json 的 sha256 不变，已实证）
node scripts/accept-l1.mjs http://127.0.0.1:3080

# 完整模式：会写数据（改条目、重生成简报、触发回填）——仅限专用测试实例
node scripts/accept-l1.mjs http://127.0.0.1:3081 --mutate --refresh

# 纯离线自检（不需要运行中的实例）
node scripts/verify-extract.mjs       # 真实日志全量重放 + 159 断言
node scripts/verify-prompts.mjs       # 提示词 / JSON 容错 / 契约行为 103 断言
node scripts/verify-remote.mjs        # 远程来源纯逻辑层 60 断言
node scripts/verify-zstd-frames.mjs   # 多重 zstd frame 解码 8 断言
```

当前结果：**只读 38/38（exit=0）**；离线四套件 159/0 · 103/0 · 60/60 · 8/8。

> `accept-l1.mjs` 只打 HTTP 端点，**测不到"按钮点了有没有反应"**。点击类交互另见 [`docs/MANUAL-CHECKLIST.md`](docs/MANUAL-CHECKLIST.md) 的 C2 节清单。

## 代码结构

```
dsh-logwiki/
├─ package.json          dsh.client{platform:"web"} + exports["./client"]
├─ cordis.patch.yml      包内 patch（用 dsh plugin add 安装时用）
├─ lib/
│  ├─ index.js           集成层：路由 / 刷新编排 / SSE / 条目 CRUD / 工具注册 / 动态 import 降级
│  ├─ extract.js         纯函数：事件 → 会话指纹（按事件时间归日、token、工具直方图、顶层判定）
│  ├─ fold.js            纯函数：子代理归并、天/工作区聚合、分位分档、State/Day payload
│  ├─ store.js           唯一接触 ctx 的数据文件：storage KV 落盘（防抖 + 串行化 + 降级）
│  ├─ summarize.js       LLM 层：条目摘要 + 简报（ctx.llm.stream，无 complete）
│  ├─ prompts.js         中文提示词 + JSON 容错解析
│  ├─ vendor-dsh.js      **唯一** import @deepseek-ai/* 的文件（createRequire 解析 DSH 安装路径）
│  ├─ remote.js          纯函数：远程来源的命令构造 / 清单解析 / 同步规划 / 解码（不接触 ctx）
│  ├─ remote-sources.js  纯函数：来源定义校验 + 「添加来源」提示词 + logwiki_import_source 工具
│  ├─ vendor/            内联 fzstd（MIT，逐字节复制，见其 README）
│  └─ client.js          客户端半边：手写 ESM + React.createElement
└─ scripts/              验收与离线自检
```

配套文档：[`docs/OVERVIEW.md`](docs/OVERVIEW.md)（**冻结接口契约**，改接口先改它）、[`docs/MANUAL-CHECKLIST.md`](docs/MANUAL-CHECKLIST.md)（验收清单、实测结果、已知问题）、[`DEVLOG.md`](DEVLOG.md)（逐里程碑证据与踩坑记录）。

## 关键技术约束（改代码前必读）

1. **客户端半边**必须是 `window.__ModuleLoader__.load({ id, factory })`，`id` 逐字等于包名，否则整页白屏；**只能 `require('react')`**（平台只 seed 9 个模块），其它服务走 `inject` + `ctx.get()`；样式只用 `--dsw-*` token。
2. **Cordis**：`inject` 保持最小（本插件只硬依赖 `webServer`）。`ctx.timeout()` 需要 `timer` 注入、`ctx.logger` 同样需注入（否则**静默**）。让出事件循环用普通 `setTimeout`，日志用 `console`。
3. **会话数据只走 `ctx.sessionQuery`**，绝不手工解析日志（多重 zstd 帧 + 多代格式）。
4. **绝不向会话日志追加事件**（v4 只接受 producer-owned source kind）。插件数据一律进 `storage`。
5. **LLM**：`ctx.llm.stream` 是唯一动词，**省略 `purpose` 与 `sessionId`**；手搓调用只有一次 attempt，失败以 finish chunk 返回，必须自己判。
6. **归并规则**：只归并非顶层记录，**顶层永不参与归并**；归并不得改写 `delegationDepth`。（否则会静默丢数据——曾实测丢 51 回合 / 611 steps。）
7. **多帧 zstd**：DSH 的 `session.v4.jsonl.zstd` 是**多个独立 frame 拼接**，而 **Node 自带的 `zlib.zstdDecompressSync` 只解第一帧**（实测同一份 5.18 MB 日志：内置解出 1 行 / 198 字节，fzstd 解出 4333 行 / 15.5 MB）。DSH 自己的多帧解码器在 `@deepseek-ai/dsh-session-persistence-jsonl`，但该包 `exports` 只暴露 `.`，`./zstd` 不可 import —— 所以内联了 `fzstd`。**本地会话仍一律走 `ctx.sessionQuery`**，手工解码只用于远程来源。

## Roadmap

- [x] **一期**（已发布并已通过验收）：本机会话 → 日历 / 热力图 / 三层卡片 / 条目编辑 / 周月简报 / 周期导航
- [ ] **二期**（进行中）：远程来源
  - **添加来源**：对话框收 SSH 别名 / WSL 发行版 / 远端 `DSH_HOME` → 生成提示词交给智能体走 **f2a-ssh**（WSL OpenSSH + ControlMaster，2FA 只发生一次）→ 调 `logwiki_import_source` 落库；信息不全时由智能体用 `ask_user_question` 向你索取
  - **快速通道同步**：`ctx.subprocess` 调 `wsl.exe → ssh`（复用主连接免 2FA）→ 远端 `find` 清单 → 比对账本 → 只拉新增/变化文件（base64）→ 本地用内联 `fzstd` 解码 → 复用同一个 `extract.js`
  - **来源隔离展示**：日详情第一层就是来源分区（本机 / `rocs` …）

## License

[MIT](./LICENSE) © gychen-NJU

内联的 `fzstd` 亦为 MIT，见 [`dsh-logwiki/lib/vendor/fzstd.LICENSE.txt`](dsh-logwiki/lib/vendor/fzstd.LICENSE.txt)。
