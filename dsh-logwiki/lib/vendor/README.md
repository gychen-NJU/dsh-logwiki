# lib/vendor —— 第三方代码

## fzstd

- **来源**：`fzstd@0.1.1`，取自本机 `$DSH_HOME\profiles\web\node_modules\fzstd\esm\index.mjs`
- **许可**：MIT（Copyright (c) 2020 Arjun Barrett），全文见同目录 `fzstd.LICENSE.txt`
- **复制方式**：`Copy-Item` **逐字节复制**，未做任何文本变换
- **校验**：`24407` bytes，`sha256 = 1A901FC5A58C349B…`（与源文件一致）

### 为什么需要它

DSH 的会话日志 `session.v4.jsonl.zstd` 是**多个独立 zstd frame 拼接**而成（一个 header 帧 + 每个写入批次一帧）。**Node 自带的 `zlib.zstdDecompressSync` 与 `createZstdDecompress` 都只解第一帧**，实测：

| 解码器 | 同一文件的产出 |
|---|---|
| `zlib.zstdDecompressSync`（整个 buffer） | 263 字节 / **1 行**（只剩 header） |
| `fzstd.decompress` | 689 591 字节 / **187 行**（完整） |

本机 DSH 自带的多帧解码器在 `@deepseek-ai/dsh-session-persistence-jsonl` 里，但该包 **`exports` 只暴露 `.`**（`./zstd` 子路径不可 import），无法复用。所以把 `fzstd` 内联进来。

### 用在哪

**只用于二期（M10）的远程来源**：远端机器上的日志没法通过 `ctx.sessionQuery` 读（那是本机服务），只能把文件拉回来自己解。
**本地会话一律走 `ctx.sessionQuery`**，绝不手工解码 —— 它负责多代格式迁移与 replay 校验。

### 纪律

- 这个文件**不应被 `lib/index.js` 或任何一期文件 import**（一期的验收状态保持冻结）。
- 升级 fzstd 时同步更新上面的 sha256 与版本号。
