#!/usr/bin/env node
/**
 * dsh-logwiki · 线 A 验证脚本（**仅供测试，不是 lib 依赖**）
 *
 * 跑法：`node scripts/verify-extract.mjs`
 *
 * 做三件事：
 *   1. 边界断言：dayKey / isTopLevel / sessionFingerprintOf / quantileThresholds / heatLevel
 *      （含空数组、全 0、单值）。
 *   2. 全量重放**真实会话日志**：解压 → JSON.parse → {header, events, title} → extractSession()
 *      → rollupSubagents / buildDays / buildState，打印真实分布。
 *   3. 顶层会话 vs 子代理会话的归属行为对比（isTopLevel / rollupSubagents）。
 *
 * ⚠️ 真实日志是**多个 zstd frame 拼接**的，`node:zlib` 的 zstdDecompressSync 只解第一帧，
 *    所以这里用 profile 里已装的 `fzstd`（经实测可全解）。
 *    **这是 dev-only 依赖，绝不能出现在 lib/ 下的任何文件里。**
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  dayKey,
  extractSession,
  isTopLevel,
  sessionFingerprintOf,
  hostTzOffsetMinutes,
} from '../lib/extract.js'
import {
  buildDay,
  buildDays,
  buildState,
  daySessionFingerprint,
  heatLevel,
  quantileThresholds,
  rollupSubagents,
} from '../lib/fold.js'

// ---------------------------------------------------------------- 测试设施

const FZSTD_URL = 'file:///C:/Users/13676/.dsh/profiles/web/node_modules/fzstd/lib/index.js'
const SESSIONS_ROOT = 'C:\\Users\\13676\\.dsh\\sessions'
const TZ = 480

let passed = 0
const failures = []

function ok(label, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${label}${detail === undefined ? '' : ` · ${detail}`}`)
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(label, a === e, `期望 ${e}，实际 ${a}`)
}

/** 分位是线性插值，浮点尾差不可避免 → 数值断言用近似比较。 */
function approxEq(label, actual, expected, tolerance = 1e-9) {
  const a = Array.isArray(actual) ? actual : [actual]
  const e = Array.isArray(expected) ? expected : [expected]
  if (a.length !== e.length) {
    ok(label, false, `长度 ${a.length} != ${e.length}（实际 ${JSON.stringify(actual)}）`)
    return
  }
  const bad = a.findIndex((v, i) => Math.abs(v - e[i]) > tolerance * Math.max(1, Math.abs(e[i])))
  ok(label, bad === -1, `下标 ${bad}: ${a[bad]} != ${e[bad]}`)
}

const line = (char = '─') => console.log(char.repeat(74))
const head = (title) => {
  console.log('')
  line('═')
  console.log(title)
  line('═')
}

// ---------------------------------------------------------------- 1. 边界断言

head('1. 纯函数边界断言')

// --- dayKey ---
eq('dayKey 东八区 00:00 边界', dayKey(Date.UTC(2026, 8, 30, 16, 0, 0), TZ), '2026-10-01')
eq('dayKey 东八区 23:59 边界', dayKey(Date.UTC(2026, 8, 30, 15, 59, 59), TZ), '2026-09-30')
eq('dayKey UTC 偏移 = 0', dayKey(Date.UTC(2026, 9, 1, 12, 0, 0), 0), '2026-10-01')
eq('dayKey 负偏移（西五区）', dayKey(Date.UTC(2026, 9, 1, 3, 0, 0), -300), '2026-09-30')
eq('dayKey 补零', dayKey(Date.UTC(2026, 0, 5, 12, 0, 0), 0), '2026-01-05')
eq('dayKey(0) 东八区', dayKey(0, TZ), '1970-01-01')
eq('dayKey 非数字 → 不抛', typeof dayKey(undefined, TZ), 'string')
ok('宿主 tzOffsetMinutes = +480', hostTzOffsetMinutes(Date.UTC(2026, 9, 1, 0, 0, 0)) === 480,
  `实际 ${hostTzOffsetMinutes(Date.UTC(2026, 9, 1, 0, 0, 0))}`)

// --- isTopLevel ---
ok('isTopLevel: origin 缺失 + depth 0 → true', isTopLevel({ delegationDepth: 0 }) === true)
ok('isTopLevel: origin undefined + depth 0 → true', isTopLevel({ origin: undefined, delegationDepth: 0 }) === true)
ok('isTopLevel: subagent → false', isTopLevel({ origin: 'subagent', delegationDepth: 0 }) === false)
ok('isTopLevel: depth 1 → false', isTopLevel({ delegationDepth: 1 }) === false)
ok('isTopLevel: depth 0 + origin 其它值 → true', isTopLevel({ origin: 'user', delegationDepth: 0 }) === true)
ok('isTopLevel: null → false', isTopLevel(null) === false)
ok('isTopLevel: 缺 delegationDepth → 视作 0 → true', isTopLevel({}) === true)

// --- sessionFingerprintOf ---
const fpBase = { sessionId: 's1', title: 't', turns: 3, steps: 4, tokens: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0, reasoning: 0 }, perDay: { '2026-10-01': { turns: 3, steps: 4, tokens: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0, reasoning: 0 } } }, toolHistogram: { pwsh: 2, read: 1 }, promptPreview: ['hi'] }
const fpA = sessionFingerprintOf(fpBase)
ok('fingerprint: 16 位 hex', /^[0-9a-f]{16}$/.test(fpA), fpA)
ok('fingerprint: 稳定（同输入同输出）', sessionFingerprintOf(structuredClone(fpBase)) === fpA)
ok('fingerprint: 与键序无关（perDay）', sessionFingerprintOf({ ...structuredClone(fpBase), perDay: { '2026-10-01': fpBase.perDay['2026-10-01'] } }) === fpA)
ok('fingerprint: toolHistogram 键序无关', sessionFingerprintOf({ ...structuredClone(fpBase), toolHistogram: { read: 1, pwsh: 2 } }) === fpA)
ok('fingerprint: title 变 → 变', sessionFingerprintOf({ ...structuredClone(fpBase), title: 'x' }) !== fpA)
ok('fingerprint: turns 变 → 变', sessionFingerprintOf({ ...structuredClone(fpBase), turns: 4 }) !== fpA)
ok('fingerprint: 输入垃圾 → 全 0', sessionFingerprintOf(null) === '0000000000000000')

// --- extractSession 边界 ---
ok('extractSession: 空数组 → null', extractSession({ header: { id: 'x' }, events: [] }) === null)
ok('extractSession: events 缺失 → null', extractSession({ header: { id: 'x' } }) === null)
ok('extractSession: 无 header.id → null', extractSession({ header: {}, events: [{ type: 'turn/end', time: 1, data: {} }] }) === null)
ok('extractSession: 全垃圾事件 → 有 id 就出记录', extractSession({ header: { id: 'x' }, events: [null, 1, 'x', {}] })?.sessionId === 'x')

// 2026-09-30 23:30（东八区）= 15:30 UTC；跨到 2026-10-01 00:10（东八区）= 16:10 UTC
const D1 = Date.UTC(2026, 8, 30, 15, 30, 0)
const D1b = Date.UTC(2026, 8, 30, 15, 45, 0)
const D2 = Date.UTC(2026, 8, 30, 16, 10, 0)
const D2b = Date.UTC(2026, 8, 30, 16, 30, 0)
const D2c = Date.UTC(2026, 8, 30, 16, 31, 0)
const mixed = extractSession({
  header: { id: 'sx', createdAt: D1, cwd: 'C:\\w', delegationDepth: 0 },
  events: [
    { type: 'user/message', seq: 1, time: D1, data: { content: [{ type: 'text', text: '真用户\n第二行' }], source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, time: D2b, data: { content: [{ type: 'text', text: '注入内容不该进预览' }], source: { kind: 'runtime-context' } } },
    { type: 'assistant/message', seq: 3, time: D2, data: { usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 1, reasoningTokens: 7 }, message: { content: [{ type: 'text', text: '答复' }, { type: 'reasoning', text: '想' }] } } },
    { type: 'tool/call', seq: 4, time: D2, data: { name: 'pwsh' } },
    { type: 'turn/end', seq: 5, time: D1b, data: { turn: 1 } },
    { type: 'step/end', seq: 6, time: D1b, data: { turn: 1, step: 1 } },
    // 次日 00:30（东八区）→ 必须归到 2026-10-01
    { type: 'turn/end', seq: 7, time: D2b, data: { turn: 2 } },
    { type: 'session/title', seq: 8, time: D2c, data: { title: '标题' } },
  ],
  tzOffsetMinutes: TZ,
})
eq('extractSession: promptPreview 只收 source.kind=user', mixed.promptPreview, ['真用户'])
eq('extractSession: 跨天 perDay 分键', Object.keys(mixed.perDay).sort(), ['2026-09-30', '2026-10-01'])
eq('extractSession: 次日 turns（00:30 那笔）', mixed.perDay['2026-10-01'].turns, 1)
eq('extractSession: 当日 turns（23:45 那笔）', mixed.perDay['2026-09-30'].turns, 1)
eq('extractSession: 当日 steps', mixed.perDay['2026-09-30'].steps, 1)
eq('extractSession: 次日 token 归日', mixed.perDay['2026-10-01'].tokens.input, 100)
eq('extractSession: 总 turns', mixed.turns, 2)
eq('extractSession: steps', mixed.steps, 1)
eq('extractSession: tokens', mixed.tokens, { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, reasoning: 7 })
eq('extractSession: toolHistogram', mixed.toolHistogram, { pwsh: 1 })
eq('extractSession: title 来自 session/title', mixed.title, '标题')
ok('extractSession: assistantTail 含 text+reasoning', mixed.assistantTail.includes('答复') && mixed.assistantTail.includes('想'), mixed.assistantTail)
ok('extractSession: lastEventAt 取最大事件时间', mixed.lastEventAt === D2c, String(mixed.lastEventAt))

// --- quantileThresholds ---
eq('quantileThresholds: 空数组', quantileThresholds([]), [])
eq('quantileThresholds: 非数组', quantileThresholds(undefined), [])
eq('quantileThresholds: 全 0', quantileThresholds([0, 0, 0]), [])
eq('quantileThresholds: 单值', quantileThresholds([5]), [5])
eq('quantileThresholds: 单值 0', quantileThresholds([0]), [])
approxEq('quantileThresholds: 两值（线性插值）', quantileThresholds([1, 3]), [1.5, 2, 2.5, 2.8])
approxEq('quantileThresholds: 值里混 0 → 0 被剔除', quantileThresholds([0, 2, 4, 6, 8]), [3.5, 5, 6.5, 7.4])
approxEq('quantileThresholds: 极差（只有 2 个非零值）', quantileThresholds([1, 100]), [25.75, 50.5, 75.25, 90.1])

const q10 = quantileThresholds(Array.from({ length: 100 }, (_, i) => i + 1))
ok('quantileThresholds: 100 连值 → 4 档阈值', q10.length === 4, JSON.stringify(q10))
ok('quantileThresholds: 严格递增', q10.every((v, i) => i === 0 || v > q10[i - 1]), JSON.stringify(q10))
approxEq('quantileThresholds: 100 连值的分位', q10, [25.75, 50.5, 75.25, 90.1])

// --- heatLevel ---
eq('heatLevel: 0 → 0', heatLevel(0, [1, 2, 3, 4]), 0)
eq('heatLevel: 负数 → 0', heatLevel(-5, [1, 2, 3, 4]), 0)
eq('heatLevel: NaN → 0', heatLevel(Number.NaN, [1, 2, 3, 4]), 0)
eq('heatLevel: 空 thresholds + 正数 → 1', heatLevel(7, []), 1)
eq('heatLevel: thresholds 非数组 + 正数 → 1', heatLevel(7, undefined), 1)
eq('heatLevel: == p25 → 1（不严格大于）', heatLevel(2, [2, 5, 9, 12]), 1)
eq('heatLevel: > p25 → 2', heatLevel(3, [2, 5, 9, 12]), 2)
eq('heatLevel: > p90 → 4', heatLevel(13, [2, 5, 9, 12]), 4)
eq('heatLevel: 远超 → 封顶 4', heatLevel(9999, [2, 5, 9, 12]), 4)
eq('heatLevel: 单阈值 + 正数 → 2', heatLevel(1, [0.5]), 2)
eq('heatLevel: 单值阈值形状 [5]', heatLevel(6, [5]), 2)

// --- rollupSubagents / buildDays 边界 ---
const top = { sessionId: 'TOP', delegationDepth: 0, cwd: 'C:\\a', sourceId: 'local', createdAt: 1, lastEventAt: 10, turns: 5, steps: 4, tokens: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, perDay: { '2026-10-01': { turns: 5, steps: 4, tokens: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 } } }, toolHistogram: { pwsh: 2 }, promptPreview: [] }
const child1 = { sessionId: 'C1', parentSessionId: 'TOP', origin: 'subagent', delegationDepth: 1, cwd: 'C:\\a', sourceId: 'local', createdAt: 2, lastEventAt: 8, turns: 3, steps: 2, tokens: { input: 30, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, perDay: { '2026-10-01': { turns: 3, steps: 2, tokens: { input: 30, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0 } } }, toolHistogram: { read: 1 }, promptPreview: [] }
const grand = { sessionId: 'G1', parentSessionId: 'C1', origin: 'subagent', delegationDepth: 2, cwd: 'C:\\a', sourceId: 'local', createdAt: 3, lastEventAt: 6, turns: 1, steps: 1, tokens: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, perDay: { '2026-10-01': { turns: 1, steps: 1, tokens: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 } } }, toolHistogram: {}, promptPreview: [] }
const orphan = { sessionId: 'ORPH', parentSessionId: 'MISSING', origin: 'subagent', delegationDepth: 1, cwd: 'C:\\b', sourceId: 'local', createdAt: 4, lastEventAt: 5, turns: 2, steps: 2, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, perDay: { '2026-10-02': { turns: 2, steps: 2, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } } }, toolHistogram: {}, promptPreview: [] }
// 孙代的父（C1）自己也指向顶层 → 必须一路并进 TOP，而不是并进 C1 后被一起丢掉
const greatGrand = { sessionId: 'GG1', parentSessionId: 'G1', origin: 'subagent', delegationDepth: 3, cwd: 'C:\\a', sourceId: 'local', createdAt: 4, lastEventAt: 4, turns: 1, steps: 1, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, perDay: { '2026-10-01': { turns: 1, steps: 1, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 } } }, toolHistogram: {}, promptPreview: [] }

const rolled = rollupSubagents([top, child1, grand, orphan, greatGrand])
eq('rollup: 只剩顶层 + 孤儿', [...rolled.parents.keys()].sort(), ['ORPH', 'TOP'])
eq('rollup: 被归并的键（含孙代/曾孙代）', [...rolled.subagentKeys].sort(), ['C1', 'G1', 'GG1'])
eq('rollup: 顶层 turns = 5+3+1+1（曾孙代不回落到中间节点）', rolled.parents.get('TOP').turns, 10)
eq('rollup: 顶层 tokens.input 累加（跨 3 层）', rolled.parents.get('TOP').tokens.input, 91)
// ⚠️ 归并**不得**改写父记录的 delegationDepth（契约 §5.3 硬规则二）：一旦抬高，父记录就不再满足
// isTopLevel()，结果集里会出现"伪顶层"，并连带毁掉 buildDay 的会话数口径（本机实测 20 条 / 会话数虚增 2）。
eq('rollup: 父记录 delegationDepth 未被改写', rolled.parents.get('TOP').delegationDepth, 0)
ok('rollup: 归并后的父记录仍满足 isTopLevel()', isTopLevel(rolled.parents.get('TOP')) === true)
eq('rollup: 顶层 toolHistogram 合并', rolled.parents.get('TOP').toolHistogram, { pwsh: 2, read: 1 })
eq('rollup: 入参未被改写', top.turns, 5)
ok('rollup: 孤立子代理保留为独立记录', rolled.parents.has('ORPH'))
ok('rollup: 孤儿子代理带 orphanSubagent 标记 + 进 orphanKeys（契约 §5.3）',
  rolled.parents.get('ORPH').orphanSubagent === true && rolled.orphanKeys.has('ORPH'))
eq('rollup: orphanKeys 只含真正无法上溯的子代理', [...rolled.orphanKeys].sort(), ['ORPH'])
eq('rollup: 归并后 turns 守恒（TOP 组）', rolled.parents.get('TOP').turns, top.turns + child1.turns + grand.turns + greatGrand.turns)

// ---- 回归（真实事故复刻）：伪顶层不得被归并，否则整条链的工作量蒸发 ----
// 契约 §5.3 硬规则一的真实反例：A(subagent,51 turns/611 steps) → B(origin 缺省+depth 0 = 顶层, 但带 parentSession)
// → C(真顶层)。旧实现归并「任何带 parentSessionId 的记录」：B 被并进 C 并删除，A 被并进 B 的克隆体、
// 克隆体又被删 → 51 turns / 611 steps 凭空消失（本机语料实测缺口正好是 51/611）。
const pseudoRoot = { sessionId: 'ROOT', delegationDepth: 0, cwd: 'C:\\a', sourceId: 'local', createdAt: 1, lastEventAt: 9, turns: 7, steps: 6, tokens: { input: 70, output: 7, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, perDay: { '2026-10-01': { turns: 7, steps: 6, tokens: { input: 70, output: 7, cacheRead: 0, cacheWrite: 0, reasoning: 0 } } }, toolHistogram: {}, promptPreview: [] }
const pseudoTop = { sessionId: 'PT', parentSessionId: 'ROOT', delegationDepth: 0, cwd: 'C:\\a', sourceId: 'local', createdAt: 1, lastEventAt: 9, turns: 4, steps: 3, tokens: { input: 40, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, perDay: { '2026-10-01': { turns: 4, steps: 3, tokens: { input: 40, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 0 } } }, toolHistogram: {}, promptPreview: [] }
const deepChild = { sessionId: 'DEEP', parentSessionId: 'PT', origin: 'subagent', delegationDepth: 1, cwd: 'C:\\a', sourceId: 'local', createdAt: 2, lastEventAt: 8, turns: 51, steps: 611, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, perDay: { '2026-10-01': { turns: 51, steps: 611, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 } } }, toolHistogram: {}, promptPreview: [] }
const pseudoInput = [pseudoRoot, pseudoTop, deepChild]
const pseudoRolled = rollupSubagents(pseudoInput, { includeSubagents: true })
const sumTurnsOf = (list) => list.reduce((sum, r) => sum + r.turns, 0)
const sumStepsOf = (list) => list.reduce((sum, r) => sum + r.steps, 0)
eq('回归(伪顶层): 顶层记录即使带 parentSession 也不被归并', [...pseudoRolled.parents.keys()].sort(), ['PT', 'ROOT'])
eq('回归(伪顶层): 只有真子代理被归并', [...pseudoRolled.subagentKeys], ['DEEP'])
eq('回归(伪顶层): 子代理并进最近的顶层记录（PT，而不是越过它并进 ROOT）', pseudoRolled.parents.get('PT').turns, 4 + 51)
eq('回归(伪顶层): ROOT 只拿到自己的量', pseudoRolled.parents.get('ROOT').turns, 7)
ok('回归(伪顶层): 归并不丢 turns', sumTurnsOf([...pseudoRolled.parents.values()]) === sumTurnsOf(pseudoInput),
  `${sumTurnsOf([...pseudoRolled.parents.values()])} vs ${sumTurnsOf(pseudoInput)}`)
ok('回归(伪顶层): 归并不丢 steps（51 turns / 611 steps 那次事故）',
  sumStepsOf([...pseudoRolled.parents.values()]) === sumStepsOf(pseudoInput),
  `${sumStepsOf([...pseudoRolled.parents.values()])} vs ${sumStepsOf(pseudoInput)}`)
const pseudoDays = buildDays(pseudoInput, { includeSubagents: true, tzOffsetMinutes: TZ })
eq('回归(伪顶层): buildDays 守恒 turns = 7+55', pseudoDays['2026-10-01'].work.turns, 62)
eq('回归(伪顶层): buildDays 会话数 = 2（伪顶层自成一家）', pseudoDays['2026-10-01'].work.sessions, 2)

// ---- 回归：孤儿子代理（父不在扫描范围内）——工作量不丢，但不计入 sessions（契约 §5.3）----
const orphanDays = buildDays({ 'local::ORPH': orphan }, { includeSubagents: true, tzOffsetMinutes: TZ })
eq('孤儿子代理: 自己的日子照常出现', Object.keys(orphanDays), ['2026-10-02'])
eq('孤儿子代理: 工作量不丢（turns 计入）', orphanDays['2026-10-02'].work.turns, 2)
eq('孤儿子代理: 不计入 work.sessions', orphanDays['2026-10-02'].work.sessions, 0)

// ---- 回归：perDay 为空的"幽灵会话"不得虚增会话数（日归属只认 perDay 槽位）----
// 反例：旧实现用 lastEventAt/createdAt 兜底，把 0 turns/0 steps/0 tokens 的会话
// 也算成"该天有一个会话"（本机语料实测把 2026-10-01 由 7 虚增到 9）。
const ghost = { sessionId: 'GHOST', delegationDepth: 0, cwd: 'C:\\a', sourceId: 'local', createdAt: Date.UTC(2026, 8, 30, 16, 0, 0), lastEventAt: Date.UTC(2026, 8, 30, 17, 0, 0), turns: 0, steps: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, perDay: {}, toolHistogram: { read: 3 }, promptPreview: [] }
eq('幽灵会话(perDay 空): 不产生任何一天', buildDays({ 'local::GHOST': ghost }, { includeSubagents: true, tzOffsetMinutes: TZ }), {})
eq('幽灵会话(perDay 空): 不影响同一天已有会话的会话数',
  buildDays({ 'local::GHOST': ghost, 'local::TOP': top }, { includeSubagents: true, tzOffsetMinutes: TZ })['2026-10-01'].work.sessions, 1)

// 成环保护：A → B → A 不应该无限上溯
const cycleA = { sessionId: 'CA', parentSessionId: 'CB', origin: 'subagent', delegationDepth: 1, turns: 1, steps: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, perDay: {}, toolHistogram: {}, promptPreview: [] }
const cycleB = { sessionId: 'CB', parentSessionId: 'CA', origin: 'subagent', delegationDepth: 1, turns: 1, steps: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, perDay: {}, toolHistogram: {}, promptPreview: [] }
const cycled = rollupSubagents([cycleA, cycleB])
eq('rollup: 成环 → 都保留、不归并', [...cycled.parents.keys()].sort(), ['CA', 'CB'])
eq('rollup: 成环 → subagentKeys 为空', cycled.subagentKeys.size, 0)

const rolledNoSub = rollupSubagents([top, child1, grand, orphan, greatGrand], { includeSubagents: false })
eq('rollup(includeSubagents=false): 顶层 turns 不变', rolledNoSub.parents.get('TOP').turns, 5)
eq('rollup(includeSubagents=false): 子代理同样被剔除', [...rolledNoSub.parents.keys()].sort(), ['ORPH', 'TOP'])

const daysIn = buildDays({ 'local::TOP': top, 'local::C1': child1, 'local::G1': grand, 'local::GG1': greatGrand }, { includeSubagents: true, tzOffsetMinutes: TZ })
eq('buildDays(含子代理): 天数', Object.keys(daysIn), ['2026-10-01'])
eq('buildDays(含子代理): turns = 5+3+1+1', daysIn['2026-10-01'].work.turns, 10)
eq('buildDays(含子代理): sessions', daysIn['2026-10-01'].work.sessions, 1)
const daysOut = buildDays({ 'local::TOP': top, 'local::C1': child1, 'local::G1': grand }, { includeSubagents: false, tzOffsetMinutes: TZ })
eq('buildDays(不含子代理): turns', daysOut['2026-10-01'].work.turns, 5)
eq('buildDays: bySource.local.byWorkspace 键 = cwd', Object.keys(daysOut['2026-10-01'].bySource.local.byWorkspace), ['C:\\a'])
eq('buildDays: 空输入 → {}', buildDays({}, { tzOffsetMinutes: TZ }), {})

// --- daySessionFingerprint ---
const f1 = daySessionFingerprint({ a: { sessionId: 'A', fingerprint: '11' }, b: { sessionId: 'B', fingerprint: '22' } })
const f2 = daySessionFingerprint({ z: { sessionId: 'B', fingerprint: '22' }, y: { sessionId: 'A', fingerprint: '11' } })
ok('daySessionFingerprint: 与顺序无关', f1 === f2)
ok('daySessionFingerprint: 16 位 hex', /^[0-9a-f]{16}$/.test(f1))
ok('daySessionFingerprint: 成员变 → 变', daySessionFingerprint({ a: { sessionId: 'A', fingerprint: '99' } }) !== f1)
eq('daySessionFingerprint: 空 → 稳定串', daySessionFingerprint({}), daySessionFingerprint([]))

// ---------------------------------------------------------------- 2. 真实日志重放

head('2. 真实会话日志全量重放')

const fzstd = await import(FZSTD_URL)
const decompress = fzstd.decompress ?? fzstd.default?.decompress
if (typeof decompress !== 'function') {
  console.error('fzstd 不可用，无法解压真实日志')
  process.exit(2)
}

function walkZstd(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walkZstd(path, out)
    else if (entry.name === 'session.v4.jsonl.zstd') out.push(path)
  }
  return out
}

/** 解压 → 逐行 JSON.parse → { header, events, title, lines } */
function readSnapshot(file) {
  const raw = Buffer.from(decompress(new Uint8Array(readFileSync(file))))
  const lines = raw.toString('utf8').split('\n')
  let header
  const events = []
  let title
  for (const text of lines) {
    const trimmed = text.trim()
    if (trimmed === '') continue
    let obj
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (obj === null || typeof obj !== 'object') continue
    if (obj.type === 'session') {
      header = obj
      continue
    }
    events.push(obj)
    if (obj.type === 'session/title' && typeof obj.data?.title === 'string') title = obj.data.title
  }
  return { header, events, title, lines: lines.length }
}

const files = walkZstd(SESSIONS_ROOT)
console.log(`会话日志文件：${files.length} 个（${SESSIONS_ROOT}）`)

const records = []
const skips = []
let multiDay = 0
let totalEvents = 0
const originHist = new Map()
const depthHist = new Map()

for (const file of files) {
  let snapshot
  try {
    snapshot = readSnapshot(file)
  } catch (error) {
    skips.push(`${file}: 解压/解析失败 ${error instanceof Error ? error.message : String(error)}`)
    continue
  }
  totalEvents += snapshot.events.length
  const record = extractSession(snapshot)
  if (record === null) {
    skips.push(`${file}: extractSession → null（header.id=${snapshot.header?.id ?? '缺失'}）`)
    continue
  }
  record.sourceId = 'local'
  record.workspaceLabel = record.cwd === '' ? '(未知工作区)' : record.cwd
  record.fingerprint = sessionFingerprintOf(record)
  record.file = file
  records.push(record)
  originHist.set(record.origin ?? '(缺失)', (originHist.get(record.origin ?? '(缺失)') ?? 0) + 1)
  depthHist.set(record.delegationDepth, (depthHist.get(record.delegationDepth) ?? 0) + 1)
  if (Object.keys(record.perDay).length > 1 || Object.keys(record.perDay).length === 0) multiDay += 1
}

const topLevel = records.filter((r) => isTopLevel(r))
const subagents = records.filter((r) => !isTopLevel(r))
/** 全语料原始合计（归并守恒的基准）。 */
const sessionTurnsAll = records.reduce((sum, r) => sum + r.turns, 0)
const sessionStepsAll = records.reduce((sum, r) => sum + r.steps, 0)
const sessionInputAll = records.reduce((sum, r) => sum + r.tokens.input, 0)

line()
console.log(`成功提取：${records.length} 条（跳过 ${skips.length} 条）；解析事件总数 ${totalEvents}`)
console.log(`origin 分布：${JSON.stringify([...originHist])}`)
console.log(`delegationDepth 分布：${JSON.stringify([...depthHist])}`)
console.log(`isTopLevel=true：${topLevel.length} 条；isTopLevel=false（子代理）：${subagents.length} 条`)
ok('真实语料：有顶层会话', topLevel.length > 0)
ok('真实语料：有子代理会话', subagents.length > 0)
ok('真实语料：所有 origin=subagent 都判为子代理', records.filter((r) => r.origin === 'subagent').every((r) => !isTopLevel(r)))
ok('真实语料：所有 depth>0 都判为子代理', records.filter((r) => r.delegationDepth > 0).every((r) => !isTopLevel(r)))
ok('真实语料：所有顶层会话 depth 都是 0', topLevel.every((r) => r.delegationDepth === 0))
ok('真实语料：extractSession 零跳过', skips.length === 0, skips.slice(0, 3).join(' | '))
if (skips.length > 0) for (const s of skips.slice(0, 5)) console.log(`  ! ${s}`)

// 逐条一致性：perDay 求和 == 顶层计数
let sumMismatch = 0
for (const record of records) {
  let t = 0
  let s = 0
  const tk = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  for (const date of Object.keys(record.perDay)) {
    const slot = record.perDay[date]
    t += slot.turns
    s += slot.steps
    for (const key of Object.keys(tk)) tk[key] += slot.tokens[key]
  }
  if (t !== record.turns || s !== record.steps) sumMismatch += 1
  else for (const key of Object.keys(tk)) if (tk[key] !== record.tokens[key]) { sumMismatch += 1; break }
}
ok('真实语料：perDay 求和 == 会话总计', sumMismatch === 0, `${sumMismatch} 条不一致`)

// ---------------------------------------------------------------- 3. 顶层 vs 子代理

head('3. 顶层会话 vs 子代理会话')

function describe(record, tag) {
  const dates = Object.keys(record.perDay).sort()
  console.log(`  [${tag}] ${record.sessionId}`)
  console.log(`        origin=${record.origin ?? '(缺失)'} depth=${record.delegationDepth} parent=${record.parentSessionId ?? '(无)'} isTopLevel=${isTopLevel(record)}`)
  console.log(`        cwd=${record.cwd === '' ? '(空)' : record.cwd}`)
  console.log(`        title=${record.title === undefined ? '(无)' : JSON.stringify(record.title.slice(0, 28))}`)
  console.log(`        turns=${record.turns} steps=${record.steps} tokens=${JSON.stringify(record.tokens)}`)
  console.log(`        fp=${record.fingerprint}`)
  console.log(`        各天分布：${dates.map((d) => `${d}(turns=${record.perDay[d].turns},steps=${record.perDay[d].steps})`).join('  ')}`)
  console.log(`        promptPreview=${JSON.stringify(record.promptPreview)}`)
}

const busiestTop = topLevel.slice().sort((a, b) => b.turns - a.turns)[0]
const busiestSub = subagents.slice().sort((a, b) => b.turns - a.turns)[0]
if (busiestTop !== undefined) describe(busiestTop, 'TOP-LEVEL')
if (busiestSub !== undefined) describe(busiestSub, 'SUBAGENT')

ok('样例顶层：isTopLevel=true', busiestTop !== undefined && isTopLevel(busiestTop))
ok('样例子代理：isTopLevel=false', busiestSub !== undefined && !isTopLevel(busiestSub))
ok('样例子代理：parentSessionId 非空', busiestSub !== undefined && typeof busiestSub.parentSessionId === 'string' && busiestSub.parentSessionId !== '')

// 真实语料里挑一个子代理，其父在语料内 → 必须被归并
const byId = new Map(records.map((r) => [r.sessionId, r]))
const childIdsOf = new Map() // parentSessionId → [childSessionId]
for (const record of records) {
  if (typeof record.parentSessionId !== 'string' || record.parentSessionId === '') continue
  const list = childIdsOf.get(record.parentSessionId) ?? []
  list.push(record.sessionId)
  childIdsOf.set(record.parentSessionId, list)
}
/** 递归收集某个会话的全部后代会话 id（孙代也算）。 */
function descendantsOf(sessionId) {
  const out = []
  const queue = [...(childIdsOf.get(sessionId) ?? [])]
  const seen = new Set([sessionId])
  while (queue.length > 0) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    queue.push(...(childIdsOf.get(id) ?? []))
  }
  return out
}

/**
 * 某个顶层会话「真正会被归并进来的后代」：沿 parentSessionId 向下收集，
 * **遇到另一个顶层记录就停止下钻**（顶层记录自成一家，契约 §5.3 硬规则一）。
 */
function mergedFamilyOf(topId) {
  const out = []
  const queue = [...(childIdsOf.get(topId) ?? [])]
  const seen = new Set([topId])
  while (queue.length > 0) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    const record = byId.get(id)
    if (record === undefined) continue
    if (isTopLevel(record)) continue // ★ 顶层记录不并入别家，也不再向下收集
    out.push(id)
    queue.push(...(childIdsOf.get(id) ?? []))
  }
  return out
}

/** 某个顶层会话在「归并后」会出现在哪些天：自身 perDay ∪ 全部被归并后代的 perDay。 */
function familyDatesOf(topId) {
  const dates = new Set(Object.keys(byId.get(topId).perDay))
  for (const id of mergedFamilyOf(topId)) for (const d of Object.keys(byId.get(id).perDay)) dates.add(d)
  return dates
}

const resolvedParent = subagents.find((r) => byId.has(r.parentSessionId))
const rolledAll = rollupSubagents(records, { includeSubagents: true })
if (resolvedParent !== undefined) {
  const father = byId.get(resolvedParent.parentSessionId)
  const fatherIsTop = isTopLevel(father)
  const descendants = descendantsOf(father.sessionId)
  // ★ 只有「非顶层」后代才会被归并进来（顶层后代自成一家，契约 §5.3 硬规则一）
  const mergedDesc = mergedFamilyOf(father.sessionId)
  const topDesc = descendants.filter((id) => isTopLevel(byId.get(id)))
  const mergedTurns = mergedDesc.reduce((sum, id) => sum + byId.get(id).turns, 0)
  const mergedInput = mergedDesc.reduce((sum, id) => sum + byId.get(id).tokens.input, 0)
  console.log('')
  console.log(`  真实归并样例：顶层父 ${father.sessionId}(turns=${father.turns}, isTopLevel=${fatherIsTop})`)
  console.log(`                后代 ${descendants.length} 条 → 会被归并 ${mergedDesc.length} 条（turns 合计 ${mergedTurns}）、自成顶层 ${topDesc.length} 条`)
  console.log(`                其中直接子代理 ${resolvedParent.sessionId}(turns=${resolvedParent.turns})`)
  if (fatherIsTop) {
    const merged = rolledAll.parents.get(father.sessionId)
    ok('真实归并：子代理被标记为已归并', rolledAll.subagentKeys.has(resolvedParent.sessionId))
    eq('真实归并：父 turns == 自身 + 全部被归并后代', merged.turns, father.turns + mergedTurns)
    eq('真实归并：父 tokens.input == 自身 + 全部被归并后代', merged.tokens.input, father.tokens.input + mergedInput)
    ok('真实归并：父记录 delegationDepth 未被改写（归并后仍是顶层）',
      merged.delegationDepth === father.delegationDepth && isTopLevel(merged),
      `father.depth=${father.delegationDepth} merged.depth=${merged.delegationDepth}`)
    ok('真实归并：自带 parentSession 的顶层后代不被归并（否则会丢它们整条链）',
      topDesc.every((id) => rolledAll.parents.has(id) && !rolledAll.subagentKeys.has(id)),
      topDesc.filter((id) => !(rolledAll.parents.has(id) && !rolledAll.subagentKeys.has(id))).join(','))
    console.log(`                归并后：turns=${merged.turns} tokens.input=${merged.tokens.input} depth=${merged.delegationDepth}`)
  } else {
    console.log('                父会话本身也是子代理 → 应继续上溯')
  }
  // 另挑一个「被归并后代 ≥ 2」的顶层父，确保覆盖多跳上溯（不依赖记录顺序）
  const richFather = topLevel.slice().sort((a, b) => mergedFamilyOf(b.sessionId).length - mergedFamilyOf(a.sessionId).length)[0]
  if (richFather !== undefined) {
    const richDesc = mergedFamilyOf(richFather.sessionId)
    const richMerged = rolledAll.parents.get(richFather.sessionId)
    const richTurns = richDesc.reduce((sum, id) => sum + byId.get(id).turns, 0)
    ok('真实归并：存在被归并后代 ≥ 2 的顶层父（本用例覆盖多跳上溯）', richDesc.length >= 2, `${richDesc.length} 条`)
    eq(`真实归并(多跳 ${richFather.sessionId.slice(8, 16)}): 父 turns == 自身 + 全部被归并后代`,
      richMerged.turns, richFather.turns + richTurns)
  }
}

// 全量守恒：归并过程中不能丢任何一次 turn/step。
// 注意：被归并的**孙代**（其父本身也被归并）不在 subagentKeys 里，所以基准必须取
// 「结果集里那些记录自己的原始值」，而不是「全语料合计 − 被归并合计」。
const parentsTurns = [...rolledAll.parents.values()].reduce((sum, r) => sum + r.turns, 0)
const keptRecords = records.filter((r) => !rolledAll.subagentKeys.has(r.sessionId))
const keptTurnsRaw = keptRecords.reduce((sum, r) => sum + r.turns, 0)
const keptInputRaw = keptRecords.reduce((sum, r) => sum + r.tokens.input, 0)
const mergedTurns = records.filter((r) => rolledAll.subagentKeys.has(r.sessionId)).reduce((sum, r) => sum + r.turns, 0)
// 结果集 = 原始语料里「没被归并」的那些记录（顶层 + 无法上溯的孤儿），一一对应；
// 合计 = 这些记录自己的原始量 + 被归并子代理的量（归并只搬家，不增不减）。
// ⚠️ 注意：不能写成 `parentsTurns === keptTurnsRaw` —— 那是把「子代理的量」当成不该存在（旧实现
// 的伪顶层丢数据恰好让两侧碰巧相等）。正确关系是下面这条分解式，外加「== 全语料合计」的强不变量。
eq('真实归并：结果集条数 == 未被归并的原始记录数', rolledAll.parents.size, keptRecords.length)
eq('真实归并守恒：结果集合计 == 未被归并记录原始 turns + 被归并子代理 turns', parentsTurns, keptTurnsRaw + mergedTurns)
// ★ 强不变量（回归锁）：归并只是「搬家」，任何一次 turn/step 都不许蒸发。
// 旧实现正是在这里丢过 51 turns / 611 steps（伪顶层链 B 被删、A 随之消失）。基准 = 全语料合计。
const parentsSteps = [...rolledAll.parents.values()].reduce((sum, r) => sum + r.steps, 0)
eq('真实归并守恒(强)：结果集 turns 合计 == 全语料 turns 合计', parentsTurns, sessionTurnsAll)
eq('真实归并守恒(强)：结果集 steps 合计 == 全语料 steps 合计', parentsSteps, sessionStepsAll)
const parentsInput = [...rolledAll.parents.values()].reduce((sum, r) => sum + r.tokens.input, 0)
const mergedInputRaw = records.filter((r) => rolledAll.subagentKeys.has(r.sessionId)).reduce((sum, r) => sum + r.tokens.input, 0)
eq('真实归并守恒：结果集 tokens.input == 未被归并记录原始 input + 被归并子代理 input', parentsInput, keptInputRaw + mergedInputRaw)
eq('真实归并守恒(强)：结果集 tokens.input == 全语料 tokens.input', parentsInput, sessionInputAll)
console.log(`  归并守恒：全部 turns=${sessionTurnsAll} = 保留记录 ${keptTurnsRaw}（其中自身） + 被归并 ${mergedTurns}；结果集 ${rolledAll.parents.size} 条`)

// 被归并的记录一律不该留在结果集里
ok('真实归并：结果集里不含任何被归并的键', [...rolledAll.parents.keys()].every((k) => !rolledAll.subagentKeys.has(k)))
// 结果集里剩下的非顶层记录：只允许是「无法上溯」的孤儿子代理，且**必须带 orphanSubagent 标记**。
// ⚠️ 诊断纪律（契约 §5.3）：不能拿 parents 当语料事实 —— 那是被归并变换过的克隆体。
const strayNonTop = [...rolledAll.parents.values()].filter((r) => !isTopLevel(r))
const strayUnmarked = strayNonTop.filter((r) => r.orphanSubagent !== true)
ok('真实归并：残留的非顶层记录必须带 orphanSubagent 标记（伪顶层已不可能出现）', strayUnmarked.length === 0,
  strayUnmarked.map((r) => `${r.sessionId}(depth=${r.delegationDepth},origin=${r.origin ?? '缺省'},parent=${r.parentSessionId ?? '无'},turns=${r.turns})`).join(' '))
ok('真实语料：parents 全部是真正顶层（本机语料 0 条无法上溯的子代理）', strayNonTop.length === 0,
  `${strayNonTop.length} 条：${strayNonTop.slice(0, 3).map((r) => r.sessionId).join(',')}`)
if (strayNonTop.length > 0) {
  console.log(`  残留孤儿子代理 ${strayNonTop.length} 条（父会话不在本次扫描范围内，保留为独立记录、不计入 sessions）：`)
  for (const r of strayNonTop.slice(0, 3)) console.log(`    ${r.sessionId} depth=${r.delegationDepth} parentSession=${r.parentSessionId ?? '(缺失)'} turns=${r.turns}`)
}
ok('真实归并：子代理条数被真正吃掉一部分', rolledAll.subagentKeys.size > 0, `归并 ${rolledAll.subagentKeys.size} 条`)

// ---------------------------------------------------------------- 4. 聚合快照

head('4. buildDays / buildState / buildDay')

const buildStart = Date.now()
const daysWithSub = buildDays(records, { includeSubagents: true, tzOffsetMinutes: TZ })
const daysNoSub = buildDays(records, { includeSubagents: false, tzOffsetMinutes: TZ })
console.log(`buildDays 耗时：${Date.now() - buildStart}ms；覆盖 ${Object.keys(daysWithSub).length} 天`)

const sessionTotals = { turns: sessionTurnsAll, steps: sessionStepsAll }
const dayTotals = { turns: 0, steps: 0 }
for (const date of Object.keys(daysWithSub)) {
  dayTotals.turns += daysWithSub[date].work.turns
  dayTotals.steps += daysWithSub[date].work.steps
}
// buildDays 内部也走 rollupSubagents：其合计必须等于「归并后结果集」的合计，
// 而不是原始语料合计（子代理已并进父会话，不会重复计）。
let keptTurns = 0
let keptSteps = 0
for (const record of [...rolledAll.parents.values()]) {
  keptTurns += record.turns
  keptSteps += record.steps
}
// ★ 强不变量（契约 §5.3「工作量不能丢」）：includeSubagents=true 时，各天合计必须等于**全语料**合计。
// 归并只做搬家（子代理并进顶层父），总量一份不减 —— 旧实现在这里差 51 turns / 611 steps。
eq('buildDays 守恒(强)：turns 合计 == 全语料 turns 合计', dayTotals.turns, sessionTotals.turns)
eq('buildDays 守恒(强)：steps 合计 == 全语料 steps 合计', dayTotals.steps, sessionTotals.steps)
eq('buildDays 守恒：turns 合计 == 归并后结果集 turns 合计（等价说法）', dayTotals.turns, keptTurns)
eq('buildDays 守恒：steps 合计 == 归并后结果集 steps 合计（等价说法）', dayTotals.steps, keptSteps)
eq('buildDays 守恒：归并后结果集合计 == 全语料合计（归并没丢数据）', keptTurns, sessionTotals.turns)

// 逐日会话数口径（独立复算，覆盖全部天）：会话数 == 顶层会话族在该天有 perDay 槽位的条数。
// perDay 为空的"幽灵会话"（0 turns/0 steps/0 tokens）不得虚增会话数
// —— 旧实现用 lastEventAt/createdAt 兜底，本机实测把 2026-10-01 由 7 虚增到 9、2026-09-13 由 2 虚增到 3。
const daySessionMismatch = []
for (const date of Object.keys(daysWithSub)) {
  const expect = topLevel.filter((r) => familyDatesOf(r.sessionId).has(date)).length
  const got = daysWithSub[date].work.sessions
  if (got !== expect) daySessionMismatch.push(`${date}: got=${got} expect=${expect}`)
}
eq('buildDays 逐日会话数 == 顶层会话族落到该天的条数（全部天）', daySessionMismatch, [])
console.log(`  守恒：原始 turns=${sessionTotals.turns} → buildDays=${dayTotals.turns}（归并后结果集=${keptTurns}，被归并子代理=${sessionTotals.turns - keptTurns}）`)

const topOnlyTurns = topLevel.reduce((sum, r) => sum + r.turns, 0)
let noSubTurns = 0
for (const date of Object.keys(daysNoSub)) noSubTurns += daysNoSub[date].work.turns
ok('buildDays(不含子代理) turns 显著小于含子代理', noSubTurns < dayTotals.turns, `${noSubTurns} vs ${dayTotals.turns}`)
console.log(`  含子代理 turns=${dayTotals.turns} / 不含子代理 turns=${noSubTurns}（顶层会话自身 turns=${topOnlyTurns}）`)

const last14 = Object.keys(daysWithSub).sort().slice(-14)
console.log('')
console.log('  最近 14 天（含子代理）：')
for (const date of last14) {
  const day = daysWithSub[date]
  const src = Object.keys(day.bySource).join('+')
  console.log(`    ${date}  turns=${String(day.work.turns).padStart(4)}  steps=${String(day.work.steps).padStart(4)}  sessions=${String(day.work.sessions).padStart(3)}  sources=${src}  tokens.in=${day.work.tokens.input}`)
}

const heatValues = last14.map((date) => daysWithSub[date].work.turns)
const thresholds = quantileThresholds(heatValues)
console.log('')
console.log(`  近 14 天 turns 序列：${JSON.stringify(heatValues)}`)
console.log(`  quantileThresholds → ${JSON.stringify(thresholds)}`)
console.log(`  heatLevel → ${JSON.stringify(heatValues.map((v) => heatLevel(v, thresholds)))}`)
ok('阈值严格递增', thresholds.every((v, i) => i === 0 || v > thresholds[i - 1]))
ok('分档落在 0..4', heatValues.every((v) => heatLevel(v, thresholds) >= 0 && heatLevel(v, thresholds) <= 4))

// buildState
const from = Object.keys(daysWithSub).sort().slice(-30)[0] ?? ''
const to = Object.keys(daysWithSub).sort().slice(-1)[0] ?? ''
const state = buildState({
  sessions: records,
  days: daysWithSub,
  entries: {},
  sources: { local: { id: 'local', kind: 'local', label: '本机', enabled: true } },
  from,
  to,
  metric: 'turns',
  scan: { started: true, done: true, scanned: records.length, total: records.length, failed: 0 },
  degradedDays: [],
  tzOffsetMinutes: TZ,
})
eq('buildState: ok', state.ok, true)
eq('buildState: metric 默认 turns', state.metric, 'turns')
eq('buildState: range', state.range, { from, to })
ok('buildState: heatmap 按日期升序', state.heatmap.every((row, i) => i === 0 || row.date > state.heatmap[i - 1].date))
ok('buildState: heatmap 落在 range 内', state.heatmap.every((row) => row.date >= from && row.date <= to))
eq('buildState: heatmap 行数 == range 内天数', state.heatmap.length, Object.keys(daysWithSub).filter((d) => d >= from && d <= to).length)
eq('buildState: totals.turns == heatmap 求和', state.totals.turns, state.heatmap.reduce((sum, row) => sum + row.work.turns, 0))
eq('buildState: sources 投影', state.sources, [{ id: 'local', kind: 'local', label: '本机', enabled: true }])
eq('buildState: scan 透传', state.scan.scanned, records.length)
console.log('')
console.log(`  buildState: range=${from}..${to}（30 天窗口）  heatmap 行=${state.heatmap.length}`)
console.log(`              totals=${JSON.stringify(state.totals.turns)} turns / ${state.totals.sessions} sessions / ${state.totals.entries} entries`)
console.log(`              tokens=${JSON.stringify(state.totals.tokens)}`)

const emptyState = buildState({ sessions: {}, entries: {}, sources: {}, from: '2026-01-01', to: '2026-01-02', tzOffsetMinutes: TZ })
eq('buildState: 空输入 heatmap=[]', emptyState.heatmap, [])
eq('buildState: 空输入 totals.turns=0', emptyState.totals.turns, 0)
eq('buildState: 空输入 metric 回退 turns', emptyState.metric, 'turns')
eq('buildState: 非法 metric 回退 turns', buildState({ metric: 'nope' }).metric, 'turns')

// buildDay
const busiestDay = Object.keys(daysWithSub).sort().sort((a, b) => daysWithSub[b].work.turns - daysWithSub[a].work.turns)[0]
const syntheticEntries = {
  e1: { id: 'e1', sourceId: 'local', date: busiestDay, workspacePath: 'C:\\a', workspaceLabel: '工作区A', startTime: Date.UTC(2026, 8, 30, 16, 40, 0), endTime: Date.UTC(2026, 8, 30, 17, 0, 0), summary: '甲', tag: '实现', origin: 'llm', edited: false, sessionRefs: ['s1'] },
  e2: { id: 'e2', sourceId: 'local', date: busiestDay, workspacePath: 'C:\\b', workspaceLabel: '工作区B', startTime: Date.UTC(2026, 8, 30, 15, 0, 0), endTime: Date.UTC(2026, 8, 30, 15, 30, 0), summary: '乙', tag: '调研', origin: 'seed', edited: true, sessionRefs: [] },
  e3: { id: 'e3', sourceId: 'local', date: busiestDay, workspacePath: 'C:\\a', workspaceLabel: '工作区A', startTime: Date.UTC(2026, 8, 30, 16, 10, 0), endTime: Date.UTC(2026, 8, 30, 16, 20, 0), summary: '丙', tag: '实现', origin: 'user', edited: false, sessionRefs: ['s2'] },
  eOther: { id: 'eOther', sourceId: 'remote1', date: busiestDay, workspacePath: '/root/x', workspaceLabel: '远端A', startTime: Date.UTC(2026, 8, 30, 18, 0, 0), endTime: Date.UTC(2026, 8, 30, 18, 30, 0), summary: '丁', tag: '远端', origin: 'llm', edited: false, sessionRefs: [] },
  eOut: { id: 'eOut', sourceId: 'local', date: '1999-01-01', workspacePath: 'C:\\a', workspaceLabel: '工作区A', startTime: 0, endTime: 0, summary: '不该出现', tag: '', origin: 'seed', edited: false, sessionRefs: [] },
}
const day = buildDay({
  date: busiestDay,
  sessions: records,
  entries: syntheticEntries,
  sources: [
    { id: 'remote1', kind: 'remote', label: '远端机', enabled: true },
    { id: 'local', kind: 'local', label: '本机', enabled: true },
  ],
  tzOffsetMinutes: TZ,
})
eq('buildDay: ok/date', [day.ok, day.date], [true, busiestDay])
eq('buildDay: groups 本地在前', day.groups.map((g) => g.sourceId), ['local', 'remote1'])
eq('buildDay: 本日 entries 计数', day.totals.entries, 4)
eq('buildDay: workspaces 按 entries 降序', day.groups[0].workspaces.map((w) => w.workspaceLabel), ['工作区A', '工作区B'])
eq('buildDay: workspace A 有 2 条', day.groups[0].workspaces[0].totals.entries, 2)
eq('buildDay: entries 按 startTime 升序', day.groups[0].workspaces[0].entries.map((e) => e.id), ['e3', 'e1'])
// 会话数口径：顶层会话族（顶层记录 + 其被归并的后代）在该天有 perDay 槽位的条数。
// 独立复算（不拿 buildDays 自己的中间产物当基准），与 buildDays 的逐日口径互为交叉验证。
ok('buildDay: 本日会话数 == 顶层会话族落到该天的条数',
  day.totals.sessions === topLevel.filter((r) => familyDatesOf(r.sessionId).has(busiestDay)).length,
  `got=${day.totals.sessions} expect=${topLevel.filter((r) => familyDatesOf(r.sessionId).has(busiestDay)).length}`)
ok('buildDay: totals.turns > 0', day.totals.turns > 0, String(day.totals.turns))
console.log('')
console.log(`  buildDay(${busiestDay}): totals=${JSON.stringify(day.totals)}`)
for (const group of day.groups) {
  console.log(`    ${group.sourceId}（${group.sourceLabel}）：${group.workspaces.map((w) => `${w.workspaceLabel}×${w.totals.entries}`).join(' ')}`)
  for (const w of group.workspaces) for (const e of w.entries) console.log(`        ${e.id} ${new Date(e.startTime).toISOString()} ${e.origin}${e.edited ? '/edited' : ''} ${e.summary}`)
}
const emptyDay = buildDay({ date: '1999-01-01', sessions: {}, entries: {}, sources: [], tzOffsetMinutes: TZ })
eq('buildDay: 空输入 groups=[]', emptyDay.groups, [])
eq('buildDay: 空输入 totals', emptyDay.totals, { turns: 0, sessions: 0, entries: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } })

// ---------------------------------------------------------------- 汇总

head('汇总')
console.log(`断言通过：${passed}`)
if (failures.length === 0) {
  console.log('断言失败：0')
  console.log('')
  console.log('✅ 全部通过')
  process.exit(0)
} else {
  console.log(`断言失败：${failures.length}`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
