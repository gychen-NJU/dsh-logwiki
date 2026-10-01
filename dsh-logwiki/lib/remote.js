/**
 * dsh-logwiki · 远程来源的**纯逻辑层**（二期 M10）
 *
 * 本文件刻意**不接触 ctx**：命令构造、清单解析、同步规划、日志解码全是纯函数，
 * 由 `lib/index.js` 负责把执行器（`ctx.subprocess` / `ctx.timeout`）注进来。
 * 这样这些逻辑可以在离线脚本里被确定性地测试（见 `scripts/verify-remote.mjs`）。
 *
 * 安全基线（贯穿全文件）：
 *   1. **别名与远端路径都白名单校验**，不允许任何 shell 元字符；
 *   2. 远端命令**一律 base64 包裹**再交给 `ssh`，把 f2a-ssh 文档里那条
 *      "PowerShell → wsl.exe → sh → ssh 四层转义" 的坑彻底绕开；
 *   3. 拼进 shell 的只有「校验过的别名」与「base64 字符串」两类值。
 *
 * 传输链路（实测依据见 `~/.agents/skills/f2a-ssh/SKILL.md`）：
 *   `wsl.exe -e sh -lc "ssh <alias> '<base64 解码后执行的脚本>'"` —— 借道 WSL 里的
 *   OpenSSH ControlMaster，2FA 只在建立主连接时发生一次，之后复用免验证。
 */

import { decompress } from './vendor/fzstd.mjs'

/** 远端会话日志文件名（当前格式代）。 */
export const REMOTE_SESSION_FILE = 'session.v4.jsonl.zstd'

const ALIAS_RE = /^[A-Za-z0-9._-]{1,128}$/

/**
 * 校验 SSH 主机别名。别名会被拼进 shell，**必须**限制在安全字符集内。
 * @throws {Error} 含非法字符时
 */
export function assertSafeAlias(alias) {
  if (typeof alias !== 'string' || !ALIAS_RE.test(alias)) {
    throw new Error(`SSH 别名不合法（只允许 A-Z a-z 0-9 . _ -，长度 1..128）：${JSON.stringify(String(alias)).slice(0, 40)}`)
  }
  return alias
}

/**
 * 校验远端 DSH_HOME 路径：必须是绝对路径，且不含 shell 元字符/引号/换行/`..`。
 * @throws {Error}
 */
export function assertSafeRemotePath(p) {
  if (typeof p !== 'string' || p === '') throw new Error('远端路径不能为空')
  if (!p.startsWith('/')) throw new Error(`远端路径必须是绝对路径（以 / 开头）：${p.slice(0, 60)}`)
  if (/[\s'"`$&|;<>()*?![\]{}\\]/.test(p)) throw new Error(`远端路径含不安全字符：${p.slice(0, 60)}`)
  if (p.split('/').includes('..')) throw new Error(`远端路径不允许包含 ..：${p.slice(0, 60)}`)
  return p.replace(/\/+$/, '')
}

/** base64（UTF-8）。 */
function b64(text) {
  return Buffer.from(String(text), 'utf8').toString('base64')
}

/**
 * 构造一次「在远端执行脚本」的 argv（不经过 shell 字符串拼接，直接给 spawn）。
 *
 * 远端脚本用 base64 包裹：`echo <b64> | base64 -d | sh`。
 * 这样即使脚本里有引号、管道、换行，也不会撞上多层转义。
 *
 * @param {{alias: string, script: string, wslDistro?: string}} spec
 * @returns {string[]} 例如 ['wsl.exe','-e','sh','-lc',"ssh rocs 'echo … | base64 -d | sh'"]
 */
export function buildSshArgv(spec) {
  const alias = assertSafeAlias(spec.alias)
  if (typeof spec.script !== 'string' || spec.script === '') throw new Error('远端脚本不能为空')
  const inner = `echo ${b64(spec.script)} | base64 -d | sh`
  const shCommand = `ssh ${alias} '${inner}'`
  const argv = ['wsl.exe']
  if (typeof spec.wslDistro === 'string' && spec.wslDistro !== '') {
    assertSafeAlias(spec.wslDistro) // 发行版名同样限制字符集
    argv.push('-d', spec.wslDistro)
  }
  argv.push('-e', 'sh', '-lc', shCommand)
  return argv
}

/**
 * 远端清单脚本：列出窗口内的会话日志及 mtime/size。
 * 用 `-printf '%T@ %s %p\n'`（epoch 秒 + 字节数 + 路径），一行一条，解析最省事。
 */
export function buildIndexCommand(spec) {
  const home = assertSafeRemotePath(spec.dshHome)
  const days = Number.isFinite(spec.sinceDays) && spec.sinceDays > 0 ? Math.floor(spec.sinceDays) : 90
  return [
    `find ${home}/sessions -type f -name '${REMOTE_SESSION_FILE}' -mtime -${days} -printf '%T@ %s %p\\n' 2>/dev/null`,
    `echo '__LOGWIKI_INDEX_END__'`,
  ].join('; ')
}

/**
 * 解析 `find -printf '%T@ %s %p\n'` 的输出。
 * @returns {{entries: Array<{path: string, mtimeMs: number, size: number}>, malformed: string[]}}
 */
export function parseIndex(stdout) {
  const entries = []
  const malformed = []
  const text = typeof stdout === 'string' ? stdout : ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line === '__LOGWIKI_INDEX_END__') continue
    // 路径里可能有空格：只切前两个字段
    const first = line.indexOf(' ')
    const second = first < 0 ? -1 : line.indexOf(' ', first + 1)
    if (first < 0 || second < 0) {
      malformed.push(line.slice(0, 120))
      continue
    }
    const mtimeSec = Number(line.slice(0, first))
    const size = Number(line.slice(first + 1, second))
    const path = line.slice(second + 1)
    if (!Number.isFinite(mtimeSec) || !Number.isFinite(size) || path === '') {
      malformed.push(line.slice(0, 120))
      continue
    }
    entries.push({ path, mtimeMs: mtimeSec * 1000, size })
  }
  return { entries, malformed }
}

/**
 * 规划这一轮要拉哪些文件。
 *
 * 规则：① 只考虑窗口内；② 与账本比对，mtime/size 都没变的跳过（增量）；③ **从新到旧**；
 * ④ 受 `maxFiles` / `maxBytes` 双重约束（远端可能很大，不能一次拉爆）。
 *
 * @param {{index: Array, ledger?: Record<string, {mtimeMs: number, size: number}>,
 *          now: number, sinceDays: number, maxFiles: number, maxBytes: number}} spec
 * @returns {{fetch: Array, skippedUnchanged: number, skippedOld: number, skippedOverBudget: number, totalBytes: number}}
 */
export function planSync(spec) {
  const ledger = spec.ledger !== null && typeof spec.ledger === 'object' ? spec.ledger : {}
  const cutoff = spec.now - Math.max(1, spec.sinceDays) * 86400000
  let skippedOld = 0
  let skippedUnchanged = 0

  const candidates = []
  for (const e of Array.isArray(spec.index) ? spec.index : []) {
    if (!Number.isFinite(e?.mtimeMs) || e.mtimeMs < cutoff) {
      skippedOld += 1
      continue
    }
    const known = ledger[e.path]
    if (known !== undefined && known.mtimeMs === e.mtimeMs && known.size === e.size) {
      skippedUnchanged += 1
      continue
    }
    candidates.push(e)
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs) // 从新到旧

  const fetch = []
  let totalBytes = 0
  let skippedOverBudget = 0
  for (const e of candidates) {
    if (fetch.length >= spec.maxFiles || totalBytes + e.size > spec.maxBytes) {
      skippedOverBudget += 1
      continue
    }
    fetch.push(e)
    totalBytes += e.size
  }
  return { fetch, skippedUnchanged, skippedOld, skippedOverBudget, totalBytes }
}

/** 取单个文件（base64）的远端脚本。 */
export function buildFetchCommand(remotePath) {
  const safe = assertSafeRemotePath(remotePath)
  // base64 -w0：不换行，便于整块传回后一次性解码
  return `base64 -w0 ${safe}`
}

/**
 * 把 `base64 -w0` 的 stdout 还原成 Buffer。
 * 容忍空白与换行（不同平台的 base64 行为不一致）。
 */
export function decodeBase64Payload(stdout) {
  const cleaned = String(stdout ?? '').replace(/[^A-Za-z0-9+/=]/g, '')
  if (cleaned === '') throw new Error('base64 载荷为空')
  return Buffer.from(cleaned, 'base64')
}

/**
 * 解开一份远端会话日志（**多重 zstd frame**）。
 * 用内联的 fzstd —— Node 自带的 `zlib.zstdDecompressSync` 只解第一帧（实测只剩 header）。
 * @returns {string} 完整的 JSONL 文本
 */
export function decodeSessionLog(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  return Buffer.from(decompress(new Uint8Array(bytes))).toString('utf8')
}

/**
 * 把一份远端日志文本拆成 `{header, events, title}`，可直接喂给 `extract.extractSession()`。
 * 与本地路径共用同一个 `extract.js` —— 保证远程与本地口径完全一致。
 */
export function parseSessionLog(text) {
  let header = null
  let title
  const events = []
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (obj !== null && typeof obj === 'object' && obj.type === 'session' && header === null) {
      header = obj
      continue
    }
    if (obj?.type === 'session/title' && title === undefined) title = obj.data?.title
    events.push(obj)
  }
  return { header, events, title }
}

/**
 * 端到端：base64 载荷 → 会话日志文本 → 指纹记录。
 * @param {Buffer|string} payload 远端 `base64 -w0` 的 stdout（或已解码的 Buffer）
 * @param {{extract: object, sourceId: string, workspaceLabelOf?: Function}} deps
 */
export function remotePayloadToFingerprint(payload, deps) {
  const buf = typeof payload === 'string' ? decodeBase64Payload(payload) : payload
  const parsed = parseSessionLog(decodeSessionLog(buf))
  if (parsed.header === null) return null
  const fp = deps.extract.extractSession({ header: parsed.header, events: parsed.events, title: parsed.title })
  if (fp === null) return null
  return { ...fp, sourceId: deps.sourceId, fingerprint: deps.extract.sessionFingerprintOf(fp) }
}
