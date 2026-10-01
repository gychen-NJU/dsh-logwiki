/**
 * dsh-logwiki · 聚合层（**纯函数**）
 *
 * 职责：会话指纹集合 → 天/工作区聚合、热力图分档、StatePayload / DayPayload 快照。
 *
 * 纪律（契约 §0）：
 *   - 不接触 ctx、不发网络请求、不写盘；只 import node: 内置模块。
 *   - 必须能被 `node scripts/verify-extract.mjs` 直接调用。
 *
 * 关键规则（契约 §5）：
 *   - 日归属按事件时间（extract 已把 perDay 按日期键算好，本层只做求和）。
 *   - 子代理沿 parentSession 上溯并入最近顶层会话；是否计入热力图由 includeSubagents 决定。
 *   - heatmap.metric 默认 'turns'（turn/end 计数）。
 */

import { createHash } from 'node:crypto'
// isTopLevel 从 extract.js 取，保证「顶层判定」全仓只有一处定义（契约 §3）。
import { dayKey, hostTzOffsetMinutes, isTopLevel } from './extract.js'

const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']
/** 天/工作区指标里会出现的非 token 数值键。 */
const COUNT_KEYS = ['turns', 'steps', 'entries', 'sessions']
const METRICS = ['turns', 'tokens', 'sessions', 'entries']
/** buildState 默认的 scan 状态。 */
const EMPTY_SCAN = { started: false, done: false, scanned: 0, total: 0, failed: 0 }

function isObj(v) {
  return v !== null && typeof v === 'object'
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function str(v) {
  return typeof v === 'string' ? v : ''
}

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

function emptyCounts() {
  const out = {}
  for (const key of COUNT_KEYS) out[key] = 0
  out.tokens = emptyTokens()
  return out
}

function addTokens(target, source) {
  if (!isObj(source)) return target
  for (const key of TOKEN_KEYS) target[key] += num(source[key])
  return target
}

/** token 总量（热力图 metric='tokens' 用）。 */
function tokenTotal(tokens) {
  let sum = 0
  for (const key of TOKEN_KEYS) sum += num(isObj(tokens) ? tokens[key] : 0)
  return sum
}

function compareStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function hash16(payload) {
  return createHash('sha1').update(payload).digest('hex').slice(0, 16)
}

/** 工作区标签：注册表未命中时直接用路径；无 cwd → `(未知工作区)`（契约 §5.4 的降级半边，注册表匹配在集成层）。 */
function workspaceLabelOf(session) {
  const label = str(session.workspaceLabel)
  if (label !== '') return label
  const cwd = str(session.cwd)
  return cwd !== '' ? cwd : '(未知工作区)'
}

/**
 * 会话的日期键列表 = `perDay` 的键（契约 §5.1：日归属按**事件时间**，不按会话 `createdAt`）。
 *
 * ⚠️ 不再对 `perDay` 为空的会话做 `lastEventAt/createdAt` 兜底（2026-10-01 实测修正）：
 * `perDay` 为空 ⟺ 该会话没有任何 `turn/end`、`step/end`、带时间的 `assistant/message`
 * （token 只在 `assistant/message` 的日桶里累加），因此它的 turns/steps/tokens **必然全为 0**。
 * 这种兜底只会把「零工作量幽灵会话」计进某天的 `work.sessions`（实测 2026-10-01 虚增到 9、
 * 2026-09-13 虚增到 3），让同一对象里严格按 perDay 求和的 turns/steps/tokens 与会话数口径不一致；
 * 兜底的 `createdAt` 分支还直接违反契约 §5.1。故：没有 perDay 槽位 ⇒ 该会话不进入任何一天。
 */
function datesOf(session) {
  const perDay = isObj(session.perDay) ? session.perDay : {}
  return Object.keys(perDay).sort(compareStr)
}

/** 会话在某天的 {turns, steps, tokens}。 */
function dayOf(session, date) {
  const perDay = isObj(session.perDay) ? session.perDay : {}
  const slot = perDay[date]
  if (isObj(slot)) {
    return { turns: num(slot.turns), steps: num(slot.steps), tokens: isObj(slot.tokens) ? slot.tokens : emptyTokens() }
  }
  return { turns: 0, steps: 0, tokens: emptyTokens() }
}

/**
 * 子代理上溯归并：沿 parentSession 找到最近顶层祖先，并把子代理的指标并进去。
 *
 * `sessions` 可以是数组（指纹记录）或对象（store 的 `sessions` 字典，`sid::key` → 记录）。
 * 归并只改副本，**不修改入参**。
 *
 * 语义要点（契约 §5.3 + 本机真实日志实测）：
 *   1. **只有非顶层记录才上溯**。顶层记录（`isTopLevel`）即使自带 `parentSessionId`
 *      （实测 12 条：origin 缺省 + depth 0 + 有 parentSession）也**不参与归并**——
 *      它本身就是别的子代理的上溯终点；把它并走，会让「并进它克隆体里的子代理」
 *      随克隆体一起被删除，工作量凭空蒸发（实测丢 51 turns / 611 steps）。
 *   2. 归并**不得改写父记录的 `delegationDepth`**：一旦抬高，父记录就不再满足
 *      `isTopLevel()`，结果集里会出现伪顶层（实测 20 条），并连带毁掉
 *      `work.sessions` 的口径（`buildDay` 的会话数会与真实顶层数对不上）。
 *   3. 无法上溯的记录（父会话不在扫描范围内 / 无 `parentSessionId` / 成环）保留为独立记录，
 *      并打 `orphanSubagent: true`：**工作量不能丢**，但不计入 `work.sessions`（契约 §5.3）。
 *
 * @param {Array|Record<string, object>} sessions
 * @param {Array|Record<string, object>} sessions
 * @param {{includeSubagents?: boolean, tzOffsetMinutes?: number}} [options]
 *   includeSubagents=false 时只做「标记并移除」，不把子代理的 turns/steps/tokens 并进父会话。
 * @returns {{parents: Map<string, object>, subagentKeys: Set<string>, orphanKeys: Set<string>}}
 *   parents 的键与入参一致（数组 → `sessionId`，字典 → 原 key）；subagentKeys 是被归并掉的记录键；
 *   orphanKeys 是无法上溯、被保留为独立记录的键（其记录带 `orphanSubagent: true`）。
 */
export function rollupSubagents(sessions, options = {}) {
  const includeSubagents = options.includeSubagents !== false
  const entries = normalizeSessions(sessions)
  /** @type {Map<string, object>} */
  const byKey = new Map()
  /** @type {Map<string, string>} sessionId → 记录键 */
  const bySessionId = new Map()
  for (const [key, session] of entries) {
    byKey.set(key, session)
    const sid = str(session.sessionId)
    if (sid !== '' && !bySessionId.has(sid)) bySessionId.set(sid, key)
  }

  /** @type {Map<string, object>} */
  const parents = new Map()
  for (const [key, session] of entries) parents.set(key, cloneRecord(session))

  /**
   * 从任意键上溯到「最近顶层会话」的键。
   * 关键：**先解析再归并**——父会话自己也可能被归并（孙代链），
   * 一边遍历一边删会漏掉「父被删后其子无处可去」的那批记录。
   * 返回 `{ key }`（不携带 depth：归并**不允许**改写父记录的 delegationDepth，见上方语义要点 2）。
   */
  const canonicalOf = (startKey) => {
    const visited = new Set([startKey])
    let cursorKey = startKey
    for (;;) {
      const record = byKey.get(cursorKey)
      if (record === undefined) return undefined
      const parentId = str(record.parentSessionId)
      if (parentId === '') return undefined
      const parentKey = bySessionId.get(parentId)
      if (parentKey === undefined || visited.has(parentKey)) return undefined // 父不在扫描范围内 / 成环
      visited.add(parentKey)
      const parentRecord = byKey.get(parentKey)
      if (isTopLevel(parentRecord)) return { key: parentKey }
      cursorKey = parentKey
    }
  }

  /** @type {Set<string>} */
  const subagentKeys = new Set()
  /** @type {Set<string>} */
  const orphanKeys = new Set()

  for (const [key, session] of entries) {
    // ★ 语义要点 1：顶层记录永不归并（哪怕它自带 parentSessionId）
    if (isTopLevel(session)) continue
    const resolved = str(session.parentSessionId) === '' ? undefined : canonicalOf(key)
    if (resolved === undefined) {
      // 语义要点 3：无处上溯 → 保留为独立记录（工作量不能丢），打标记供下游区分
      orphanKeys.add(key)
      const orphan = parents.get(key)
      if (orphan !== undefined) orphan.orphanSubagent = true
      continue
    }
    const target = parents.get(resolved.key)
    if (target === undefined) continue // 目标缺失：既不归并也不删除（防丢数据）
    subagentKeys.add(key)
    if (!includeSubagents) continue
    mergeInto(target, session)
  }

  // 被归并的记录不留在结果里
  for (const key of subagentKeys) parents.delete(key)
  return { parents, subagentKeys, orphanKeys }
}

/** 把 child 的指标并进 target（原地改 target，调用方负责传入副本）。 */
function mergeInto(target, child) {
  target.turns = num(target.turns) + num(child.turns)
  target.steps = num(target.steps) + num(child.steps)
  if (!isObj(target.tokens)) target.tokens = emptyTokens()
  addTokens(target.tokens, child.tokens)

  const childPerDay = isObj(child.perDay) ? child.perDay : {}
  if (!isObj(target.perDay)) target.perDay = {}
  for (const date of Object.keys(childPerDay)) {
    const src = childPerDay[date]
    if (!isObj(src)) continue
    const dst = isObj(target.perDay[date]) ? target.perDay[date] : undefined
    if (dst === undefined) {
      target.perDay[date] = {
        turns: num(src.turns),
        steps: num(src.steps),
        tokens: { ...emptyTokens(), ...(isObj(src.tokens) ? pickTokens(src.tokens) : {}) },
      }
    } else {
      dst.turns = num(dst.turns) + num(src.turns)
      dst.steps = num(dst.steps) + num(src.steps)
      if (!isObj(dst.tokens)) dst.tokens = emptyTokens()
      addTokens(dst.tokens, src.tokens)
    }
  }

  if (!isObj(target.toolHistogram)) target.toolHistogram = {}
  const childTools = isObj(child.toolHistogram) ? child.toolHistogram : {}
  for (const name of Object.keys(childTools)) {
    target.toolHistogram[name] = num(target.toolHistogram[name]) + num(childTools[name])
  }

  if (num(child.createdAt) > 0 && (num(target.createdAt) === 0 || num(child.createdAt) < num(target.createdAt))) {
    target.createdAt = num(child.createdAt)
  }
  if (num(child.lastEventAt) > num(target.lastEventAt)) target.lastEventAt = num(child.lastEventAt)
}

function pickTokens(tokens) {
  const out = emptyTokens()
  addTokens(out, tokens)
  return out
}

function cloneRecord(session) {
  const perDay = {}
  const src = isObj(session.perDay) ? session.perDay : {}
  for (const date of Object.keys(src)) {
    const slot = src[date]
    perDay[date] = {
      turns: num(slot.turns),
      steps: num(slot.steps),
      tokens: { ...emptyTokens(), ...(isObj(slot.tokens) ? pickTokens(slot.tokens) : {}) },
    }
  }
  return {
    ...session,
    tokens: { ...emptyTokens(), ...(isObj(session.tokens) ? pickTokens(session.tokens) : {}) },
    toolHistogram: { ...(isObj(session.toolHistogram) ? session.toolHistogram : {}) },
    promptPreview: Array.isArray(session.promptPreview) ? [...session.promptPreview] : [],
    perDay,
  }
}

/** 数组或字典 → [[key, session], ...]。字典键优先，数组键用 sessionId。 */
function normalizeSessions(sessions) {
  const out = []
  if (Array.isArray(sessions)) {
    for (const session of sessions) {
      if (!isObj(session)) continue
      const key = str(session.sessionId)
      if (key === '') continue
      out.push([key, session])
    }
    return out
  }
  if (isObj(sessions)) {
    for (const key of Object.keys(sessions)) {
      const session = sessions[key]
      if (!isObj(session)) continue
      out.push([key, session])
    }
  }
  return out
}

/**
 * 由 sessions 重算 days 与各天 work 指标。
 *
 * 内部先做 `rollupSubagents`：子代理并进顶层父会话后，其 turns/steps/tokens 只在
 * `includeSubagents !== false` 时计入（契约 §5.3）。**一个会话可以出现在多天**。
 * 无法上溯的孤儿子代理（`orphanSubagent`）照常计入 turns/steps/tokens，但**不计入 `sessions`**。
 *
 * @param {Array|Record<string, object>} sessions
 * @param {{includeSubagents?: boolean, tzOffsetMinutes?: number, sources?: Record<string, object>}} [options]
 * @returns {Record<string, {work:object, bySource:Record<string, object>}>}
 */
export function buildDays(sessions, options = {}) {
  const includeSubagents = options.includeSubagents !== false
  const tzOffsetMinutes = typeof options.tzOffsetMinutes === 'number' && Number.isFinite(options.tzOffsetMinutes)
    ? options.tzOffsetMinutes
    : hostTzOffsetMinutes()
  const { parents } = rollupSubagents(sessions, { includeSubagents })

  /** @type {Map<string, {work:object, bySource:Map<string, object>}>} */
  const days = new Map()

  const ensureDay = (date) => {
    let day = days.get(date)
    if (day === undefined) {
      day = { work: emptyCounts(), bySource: new Map() }
      days.set(date, day)
    }
    return day
  }
  const ensureSource = (day, sourceId) => {
    let slot = day.bySource.get(sourceId)
    if (slot === undefined) {
      slot = { turns: 0, steps: 0, sessions: 0, tokens: emptyTokens(), byWorkspace: new Map() }
      day.bySource.set(sourceId, slot)
    }
    return slot
  }
  const ensureWorkspace = (slot, label) => {
    let ws = slot.byWorkspace.get(label)
    if (ws === undefined) {
      ws = { turns: 0, steps: 0, entries: 0 }
      slot.byWorkspace.set(label, ws)
    }
    return ws
  }

  for (const session of parents.values()) {
    const sourceId = str(session.sourceId) || 'local'
    const label = workspaceLabelOf(session)
    // 孤儿子代理：工作量照计，但不计入会话数（契约 §5.3）
    const countAsSession = session.orphanSubagent !== true
    for (const date of datesOf(session)) {
      const slot = dayOf(session, date)
      const day = ensureDay(date)
      day.work.turns += slot.turns
      day.work.steps += slot.steps
      if (countAsSession) day.work.sessions += 1
      addTokens(day.work.tokens, slot.tokens)

      const src = ensureSource(day, sourceId)
      src.turns += slot.turns
      src.steps += slot.steps
      if (countAsSession) src.sessions += 1
      addTokens(src.tokens, slot.tokens)

      const ws = ensureWorkspace(src, label)
      ws.turns += slot.turns
      ws.steps += slot.steps
    }
  }

  const out = {}
  for (const [date, day] of [...days].sort((a, b) => compareStr(a[0], b[0]))) {
    const bySource = {}
    for (const [sourceId, slot] of day.bySource) {
      const byWorkspace = {}
      // 工作区按 turns 降序、标签升序，保证输出稳定
      const wsEntries = [...slot.byWorkspace].sort((a, b) => (b[1].turns - a[1].turns) || compareStr(a[0], b[0]))
      for (const [label, ws] of wsEntries) {
        byWorkspace[label] = { turns: ws.turns, steps: ws.steps, entries: ws.entries }
      }
      bySource[sourceId] = {
        turns: slot.turns,
        steps: slot.steps,
        sessions: slot.sessions,
        tokens: slot.tokens,
        byWorkspace,
      }
    }
    out[date] = { work: day.work, bySource }
  }
  return out
}

/**
 * 分位分档：返回 [p25, p50, p75, p90] 阈值。
 *
 * 规则（契约 §3）：**严格递增、去重、0 值不算入**；不足 4 档时返回较少的阈值。
 * @param {number[]} values
 * @returns {number[]}
 */
export function quantileThresholds(values) {
  const arr = (Array.isArray(values) ? values : [])
    .map((v) => num(v))
    .filter((v) => v > 0)
    .sort((a, b) => a - b)
  if (arr.length === 0) return []

  const quantile = (q) => {
    const pos = (arr.length - 1) * q
    const lo = Math.floor(pos)
    const hi = Math.ceil(pos)
    if (lo === hi) return arr[lo]
    return arr[lo] + (arr[hi] - arr[lo]) * (pos - lo)
  }

  const out = []
  for (const q of [0.25, 0.5, 0.75, 0.9]) {
    const value = quantile(q)
    const last = out.length > 0 ? out[out.length - 1] : undefined
    if (last === undefined || value > last) out.push(value)
  }
  return out
}

/**
 * 0 → 0；否则按 thresholds 落 1..4 档（契约 §3）。
 *
 * 语义：value 超过第 k 个阈值即达到第 k+1 档（5 个阈值以下最多 4 档）。
 * 空 thresholds → 任何正数都算 1 档。
 * @param {number} value
 * @param {number[]} thresholds
 * @returns {number} 0..4
 */
export function heatLevel(value, thresholds) {
  const v = num(value)
  if (v <= 0) return 0
  const list = Array.isArray(thresholds) ? thresholds : []
  let level = 1
  for (const threshold of list) {
    if (v > num(threshold)) level += 1
    else break
  }
  return level > 4 ? 4 : level
}

/**
 * 会话集合的稳定指纹（用于 dayState.sessionFingerprint）。
 * 与顺序无关：按 `sessionId + '|' + fingerprint` 排序后哈希。
 * @param {Array|Record<string, object>} sessionsOfDay
 * @returns {string} 16 位 hex
 */
export function daySessionFingerprint(sessionsOfDay) {
  const parts = []
  for (const [, session] of normalizeSessions(sessionsOfDay)) {
    const sid = str(session.sessionId)
    const fp = str(session.fingerprint)
    parts.push(`${sid}|${fp}`)
  }
  parts.sort(compareStr)
  return hash16(parts.join('\n'))
}

/**
 * 组装 StatePayload（契约 §2）。
 *
 * @param {object} input
 * @param {Array|Record<string, object>} [input.sessions]
 * @param {Record<string, object>} [input.days] buildDays 的产物；缺省时用 sessions 现算
 * @param {Record<string, object>} [input.entries] 可为 {}
 * @param {Array|Record<string, object>} [input.sources]
 * @param {string} [input.from] 'YYYY-MM-DD'
 * @param {string} [input.to]
 * @param {string} [input.metric] 'turns'|'tokens'|'sessions'|'entries'
 * @param {object} [input.scan]
 * @param {string[]} [input.degradedDays]
 * @param {boolean} [input.includeSubagents]
 * @param {number} [input.tzOffsetMinutes]
 * @param {number} [input.generatedAt]
 */
export function buildState(input = {}) {
  const tzOffsetMinutes = typeof input.tzOffsetMinutes === 'number' && Number.isFinite(input.tzOffsetMinutes)
    ? input.tzOffsetMinutes
    : hostTzOffsetMinutes()
  const includeSubagents = input.includeSubagents !== false

  // 天聚合：优先用调用方已算好的 days（可能来自 store），否则现算
  let days = isObj(input.days) ? input.days : undefined
  if (days === undefined) {
    days = buildDays(input.sessions ?? [], { includeSubagents, tzOffsetMinutes })
  }

  const from = str(input.from)
  const to = str(input.to)
  const inRange = (date) => (from === '' || date >= from) && (to === '' || date <= to)

  const entryList = listOf(isObj(input.entries) ? input.entries : {})
  const entriesByDay = new Map()
  for (const [, entry] of entryList) {
    const date = entryDate(entry, tzOffsetMinutes)
    if (date === '') continue
    entriesByDay.set(date, (entriesByDay.get(date) ?? 0) + 1)
  }

  // 天聚合里的 entries 计数取自 entries 表（buildDays 不知道条目）
  const heatmap = []
  const totals = Object.assign(emptyCounts(), { sessions: 0 })
  totals.tokens = emptyTokens()

  for (const date of Object.keys(days).sort(compareStr)) {
    if (!inRange(date)) continue
    const day = isObj(days[date]) ? days[date] : {}
    const work = isObj(day.work) ? day.work : {}
    const entries = entriesByDay.get(date) ?? 0
    const row = {
      date,
      work: {
        turns: num(work.turns),
        steps: num(work.steps),
        sessions: num(work.sessions),
        entries,
        tokens: { ...emptyTokens(), ...(isObj(work.tokens) ? pickTokens(work.tokens) : {}) },
      },
      bySource: isObj(day.bySource) ? day.bySource : {},
    }
    heatmap.push(row)
    totals.turns += row.work.turns
    totals.steps += row.work.steps
    totals.sessions += row.work.sessions
    totals.entries += entries
    addTokens(totals.tokens, row.work.tokens)
  }

  const sources = listOf(isObj(input.sources) ? input.sources : Array.isArray(input.sources) ? toRecord(input.sources) : {})
    .map(([, source]) => ({
      id: str(source.id),
      kind: str(source.kind),
      label: str(source.label),
      enabled: source.enabled !== false,
      lastSyncStatus: source.lastSyncStatus,
      lastError: source.lastError,
    }))

  return {
    ok: true,
    generatedAt: num(input.generatedAt) || Date.now(),
    sources,
    range: { from, to },
    heatmap,
    totals: {
      turns: totals.turns,
      steps: totals.steps,
      sessions: totals.sessions,
      entries: totals.entries,
      tokens: totals.tokens,
    },
    metric: METRICS.includes(input.metric) ? input.metric : 'turns',
    scan: Object.assign({ ...EMPTY_SCAN }, isObj(input.scan) ? input.scan : {}),
    degradedDays: Array.isArray(input.degradedDays) ? [...input.degradedDays] : [],
  }
}

/**
 * 组装 DayPayload（契约 §2）。
 *
 * 排序：`groups` 本地在前；`workspaces` 按 `entries` 数量降序；`entries` 按 `startTime` 升序。
 * 只有真的挂在本日条目上的 (来源, 工作区) 才会出现在 groups 里。
 *
 * @param {object} input
 * @param {string} input.date 'YYYY-MM-DD'
 * @param {Array|Record<string, object>} [input.sessions]
 * @param {Record<string, object>} [input.entries] 可为 {}
 * @param {Array|Record<string, object>} [input.sources]
 * @param {number} [input.tzOffsetMinutes]
 */
export function buildDay(input = {}) {
  const date = str(input.date)
  const tzOffsetMinutes = typeof input.tzOffsetMinutes === 'number' && Number.isFinite(input.tzOffsetMinutes)
    ? input.tzOffsetMinutes
    : hostTzOffsetMinutes()

  const sourceMap = new Map()
  const sourcesInput = input.sources
  const sourceList = Array.isArray(sourcesInput)
    ? sourcesInput.map((s, i) => [str(isObj(s) ? s.id : '') || `#${i}`, s])
    : listOf(isObj(sourcesInput) ? sourcesInput : {})
  for (const [key, source] of sourceList) {
    if (!isObj(source)) continue
    sourceMap.set(str(source.id) || key, source)
  }

  // 本日条目按 (sourceId, workspaceLabel) 分组
  /** @type {Map<string, Map<string, {path:string, entries:object[]}>>} */
  const grouped = new Map()
  const entryList = listOf(isObj(input.entries) ? input.entries : {})
  let entryCount = 0
  for (const [key, entry] of entryList) {
    if (entryDate(entry, tzOffsetMinutes) !== date) continue
    entryCount += 1
    const sourceId = str(entry.sourceId) || 'local'
    const label = str(entry.workspaceLabel) || str(entry.workspacePath) || '(未知工作区)'
    let workspaces = grouped.get(sourceId)
    if (workspaces === undefined) {
      workspaces = new Map()
      grouped.set(sourceId, workspaces)
    }
    let bucket = workspaces.get(label)
    if (bucket === undefined) {
      bucket = { path: str(entry.workspacePath), entries: [] }
      workspaces.set(label, bucket)
    }
    if (bucket.path === '' && str(entry.workspacePath) !== '') bucket.path = str(entry.workspacePath)
    bucket.entries.push({
      id: str(entry.id) || key,
      startTime: num(entry.startTime),
      endTime: num(entry.endTime),
      summary: str(entry.summary),
      tag: str(entry.tag),
      origin: str(entry.origin) || 'seed',
      edited: entry.edited === true,
      sessionRefs: Array.isArray(entry.sessionRefs) ? entry.sessionRefs.filter((s) => typeof s === 'string') : [],
    })
  }

  // 本日会话（顶层；用于 totals.turns / totals.sessions）
  // 归并后结果集里的每个键要么是真顶层、要么是无法上溯的孤儿子代理（后者不计会话数）。
  const { parents } = rollupSubagents(input.sessions ?? {}, { includeSubagents: input.includeSubagents !== false })
  let sessionsOfDay = 0
  let turnsOfDay = 0
  // 工作区级汇总（按 workspaceLabel 归集），供下面的工作区卡使用。
  // 之前这里没算，工作区卡的 turns/sessions 被硬写成 0 —— 于是「当天合计 355 轮 / 4 会话」
  // 与「工作区卡 0 轮 / 0 会话」自相矛盾（0+0 ≠ 355），界面看起来像坏了。
  const wsTurns = new Map()
  const wsSessions = new Map()
  for (const session of parents.values()) {
    if (!datesOf(session).includes(date)) continue
    const slot = dayOf(session, date)
    const label = workspaceLabelOf(session)
    if (session.orphanSubagent !== true) {
      sessionsOfDay += 1
      wsSessions.set(label, (wsSessions.get(label) ?? 0) + 1)
    }
    turnsOfDay += slot.turns
    wsTurns.set(label, (wsTurns.get(label) ?? 0) + slot.turns)
  }

  const groups = []
  for (const sourceId of [...grouped.keys()].sort((a, b) => compareStr(a, b))) {
    const source = sourceMap.get(sourceId)
    const kind = isObj(source) ? str(source.kind) : sourceId === 'local' ? 'local' : 'remote'
    const workspaces = [...grouped.get(sourceId)].map(([label, bucket]) => ({
      workspacePath: bucket.path,
      workspaceLabel: label,
      totals: {
        turns: wsTurns.get(label) ?? 0,
        sessions: wsSessions.get(label) ?? 0,
        entries: bucket.entries.length,
      },
      entries: bucket.entries.slice().sort((a, b) => (a.startTime - b.startTime) || compareStr(a.id, b.id)),
    }))
    // workspaces 按 entries 数量降序，其次标签升序
    workspaces.sort((a, b) => (b.totals.entries - a.totals.entries) || compareStr(a.workspaceLabel, b.workspaceLabel))
    groups.push({
      sourceId,
      sourceLabel: isObj(source) && str(source.label) !== '' ? str(source.label) : kind === 'local' ? '本机' : sourceId,
      kind,
      workspaces,
    })
  }
  // 本地在前
  groups.sort((a, b) => {
    const la = a.kind === 'local' ? 0 : 1
    const lb = b.kind === 'local' ? 0 : 1
    return (la - lb) || compareStr(a.sourceId, b.sourceId)
  })
  for (const group of groups) delete group.kind

  return {
    ok: true,
    date,
    totals: {
      turns: turnsOfDay,
      sessions: sessionsOfDay,
      entries: entryCount,
      tokens: (() => {
        const tokens = emptyTokens()
        for (const session of parents.values()) {
          if (!datesOf(session).includes(date)) continue
          addTokens(tokens, dayOf(session, date).tokens)
        }
        return tokens
      })(),
    },
    groups,
  }
}

/** 条目的归属日期：优先 entry.date，否则按 startTime 现算。 */
function entryDate(entry, tzOffsetMinutes) {
  const date = str(entry.date)
  if (date !== '') return date
  const startTime = num(entry.startTime)
  return startTime > 0 ? dayKey(startTime, tzOffsetMinutes) : ''
}

/** 对象 → [[key, value], ...]（跳过 null）。 */
function listOf(obj) {
  const out = []
  for (const key of Object.keys(obj)) {
    const value = obj[key]
    if (value === null || value === undefined) continue
    out.push([key, value])
  }
  return out
}

/** 数组 → 以 id/序号为键的对象。 */
function toRecord(list) {
  const out = {}
  list.forEach((item, index) => {
    if (!isObj(item)) return
    out[str(item.id) || `#${index}`] = item
  })
  return out
}
