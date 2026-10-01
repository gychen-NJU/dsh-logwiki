/**
 * dsh-logwiki · 提取层（**纯函数**）
 *
 * 职责：把一份会话快照（{ header, events, title }）压成一条可持久化的会话指纹记录。
 *
 * 纪律（契约 §0）：
 *   - 不接触 ctx、不发网络请求、不写盘；只 import node: 内置模块。
 *   - 必须能被 `node scripts/verify-extract.mjs` 直接调用。
 *
 * 字段路径全部经真实日志实测确认（docs/OVERVIEW.md §3「事件读取规则（已实测）」）：
 *   { type, seq, time, data }；time 是 epoch ms，seq/time 已由 sessionQuery 归一化，
 *   本模块**不处理** seq0/time0。
 */

import { createHash } from 'node:crypto'

/** 单条 promptPreview 的字符上限。 */
const PREVIEW_MAX = 200
/** promptPreview 保留的用户消息条数。 */
const PREVIEW_LIMIT = 3
/** assistantTail 的字符上限。 */
const TAIL_MAX = 800
/** toolHistogram 保留的工具种类上限（按次数降序，避免超长会话把 KV 撑爆）。 */
const TOOL_KINDS_MAX = 40

const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']
/** token 键 → assistant/message 的 data.usage 字段名。 */
const USAGE_KEYS = {
  input: 'inputTokens',
  output: 'outputTokens',
  cacheRead: 'cacheReadTokens',
  cacheWrite: 'cacheWriteTokens',
  reasoning: 'reasoningTokens',
}

function isObj(v) {
  return v !== null && typeof v === 'object'
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * 宿主本地时区偏移（分钟，东八区 = +480）。
 * 契约 §5.2：`tzOffsetMinutes = -new Date(t).getTimezoneOffset()`。
 * @param {number} [at] epoch ms，缺省取当前时刻
 */
export function hostTzOffsetMinutes(at) {
  const ms = typeof at === 'number' && Number.isFinite(at) ? at : Date.now()
  return -new Date(ms).getTimezoneOffset()
}

/**
 * 事件时间(epoch ms) → 本地日期键 'YYYY-MM-DD'。
 *
 * 契约 §3 的签名是 `dayKey(ms, tzOffsetMinutes)`；`tzOffsetMinutes` 省略时回落宿主本地时区。
 *
 * @param {number} ms epoch ms
 * @param {number} [tzOffsetMinutes] 本地相对 UTC 的分钟偏移（东八区 = +480）
 * @returns {string}
 */
export function dayKey(ms, tzOffsetMinutes) {
  const off = typeof tzOffsetMinutes === 'number' && Number.isFinite(tzOffsetMinutes)
    ? tzOffsetMinutes
    : hostTzOffsetMinutes(ms)
  // 平移到「本地墙上时间」后用 UTC 取值，宿主时区不参与运算
  const d = new Date(num(ms) + off * 60000)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/**
 * 把一组 content 块拼成纯文本，只保留 allow 里列出的块类型。
 * @param {unknown} content
 * @param {string[]} allow
 */
function textOf(content, allow) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!isObj(block)) continue
    if (!allow.includes(block.type)) continue
    if (typeof block.text !== 'string' || block.text === '') continue
    parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function clip(str, max) {
  return str.length <= max ? str : `${str.slice(0, max)}…`
}

/** 取首行（提示词预览只保留第一行，避免把整段任务书塞进 KV）。 */
function firstLine(str, max) {
  const nl = str.indexOf('\n')
  const line = nl === -1 ? str.trim() : str.slice(0, nl).trim()
  return clip(line === '' ? str.trim() : line, max)
}

/** 按次数降序截断工具直方图，返回普通对象。 */
function pruneTools(histogram) {
  const entries = Object.entries(histogram)
  entries.sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const out = {}
  for (const [name, count] of entries.slice(0, TOOL_KINDS_MAX)) out[name] = count
  return out
}

/** 会话级 16 位 hex 稳定哈希。 */
function hash16(payload) {
  return createHash('sha1').update(payload).digest('hex').slice(0, 16)
}

/**
 * 会话日志 → 指纹记录的会话部分（不含 sourceId）。
 *
 * @param {object} input
 * @param {{id?:string, version?:number, createdAt?:number, cwd?:string, parentSession?:string,
 *          origin?:string, delegationDepth?:number, agentPreset?:string}} [input.header]
 * @param {Array<{type?:string, seq?:number, time?:number, data?:object}>} [input.events]
 * @param {string} [input.title]
 * @param {number} [input.tzOffsetMinutes] 覆盖宿主时区（测试用；缺省取宿主本地）
 * @returns {null | {
 *   sessionId: string, parentSessionId?: string, origin?: string, delegationDepth: number,
 *   cwd: string, createdAt: number, lastEventAt: number, title?: string,
 *   promptPreview: string[], toolHistogram: Record<string, number>, assistantTail?: string,
 *   turns: number, steps: number,
 *   tokens: {input:number,output:number,cacheRead:number,cacheWrite:number,reasoning:number},
 *   perDay: Record<string, {turns:number,steps:number,tokens:object}>
 * }} 无可用事件 / 无会话 id 时返回 null。
 */
export function extractSession({ header, events, title, tzOffsetMinutes } = {}) {
  if (!Array.isArray(events) || events.length === 0) return null
  const h = isObj(header) ? header : {}
  const sessionId = typeof h.id === 'string' ? h.id.trim() : ''
  if (sessionId === '') return null

  const tz = typeof tzOffsetMinutes === 'number' && Number.isFinite(tzOffsetMinutes)
    ? tzOffsetMinutes
    : hostTzOffsetMinutes(h.createdAt)

  /** @type {Map<string, {turns:number, steps:number, tokens:object}>} */
  const days = new Map()
  const dayBucket = (time) => {
    const date = dayKey(time, tz)
    let bucket = days.get(date)
    if (bucket === undefined) {
      bucket = { turns: 0, steps: 0, tokens: emptyTokens() }
      days.set(date, bucket)
    }
    return bucket
  }

  const prompts = []
  const toolHistogram = Object.create(null)
  let assistantTail = ''
  let titleText = typeof title === 'string' && title !== '' ? title : undefined
  let minTime = 0
  let maxTime = 0

  for (const ev of events) {
    if (!isObj(ev)) continue
    const hasTime = typeof ev.time === 'number' && Number.isFinite(ev.time)
    const time = hasTime ? ev.time : 0
    if (hasTime) {
      if (minTime === 0 || time < minTime) minTime = time
      if (time > maxTime) maxTime = time
    }

    switch (ev.type) {
      case 'user/message': {
        // 只采信真实用户输入；排除 agent-instructions / runtime-context / skill-catalog /
        // plugin:* / tool-jobs / compact-checkpoint 等注入内容（契约 §3）。
        const d = ev.data
        if (!isObj(d) || !isObj(d.source) || d.source.kind !== 'user') break
        const text = textOf(d.content, ['text'])
        if (text === '' || prompts.length >= PREVIEW_LIMIT) break
        prompts.push(firstLine(text, PREVIEW_MAX))
        break
      }

      case 'assistant/message': {
        const d = ev.data
        if (!isObj(d)) break
        // 只有带时间的 assistant/message 才归日，保证「只有 token、没有 turn/end」的会话也计日
        if (hasTime) {
          const bucket = dayBucket(time)
          if (isObj(d.usage)) {
            for (const key of TOKEN_KEYS) bucket.tokens[key] += num(d.usage[USAGE_KEYS[key]])
          }
        }
        const msg = isObj(d.message) ? d.message : undefined
        const content = msg !== undefined ? msg.content : undefined
        // reasoning 也算「助手末尾输出」：它往往是这条会话最后的实质内容
        const allParts = textOf(content, ['text', 'reasoning'])
        if (allParts !== '') assistantTail = clip(allParts, TAIL_MAX)
        break
      }

      case 'tool/call': {
        const d = ev.data
        if (!isObj(d) || typeof d.name !== 'string' || d.name === '') break
        toolHistogram[d.name] = (toolHistogram[d.name] ?? 0) + 1
        break
      }

      case 'turn/end': {
        dayBucket(time).turns += 1
        break
      }

      case 'step/end': {
        dayBucket(time).steps += 1
        break
      }

      case 'session/title': {
        const d = ev.data
        if (isObj(d) && typeof d.title === 'string' && d.title !== '') titleText = d.title
        break
      }

      default:
        break
    }
  }

  /** @type {Record<string, {turns:number,steps:number,tokens:object}>} */
  const perDay = {}
  const totalTokens = emptyTokens()
  let turns = 0
  let steps = 0
  for (const [date, bucket] of days) {
    perDay[date] = { turns: bucket.turns, steps: bucket.steps, tokens: { ...bucket.tokens } }
    turns += bucket.turns
    steps += bucket.steps
    for (const key of TOKEN_KEYS) totalTokens[key] += bucket.tokens[key]
  }

  const createdAt = num(h.createdAt) || minTime
  const record = {
    sessionId,
    delegationDepth: num(h.delegationDepth),
    cwd: typeof h.cwd === 'string' ? h.cwd : '',
    createdAt,
    lastEventAt: maxTime || createdAt,
    promptPreview: prompts,
    toolHistogram: pruneTools(toolHistogram),
    turns,
    steps,
    tokens: totalTokens,
    perDay,
  }
  const parentSessionId = typeof h.parentSession === 'string' ? h.parentSession.trim() : ''
  if (parentSessionId !== '') record.parentSessionId = parentSessionId
  if (typeof h.origin === 'string' && h.origin !== '') record.origin = h.origin
  if (titleText !== undefined) record.title = titleText
  if (assistantTail !== '') record.assistantTail = assistantTail
  return record
}

/**
 * 变化检测指纹：对影响摘要的字段做稳定哈希（sha1 → 16 hex）。
 * 只要会影响「喂给 LLM 的内容」或展示的字段变了，指纹就变。
 *
 * @param {object} sessionRecord extractSession 的产物（或 store 里的会话记录）
 * @returns {string} 16 位 hex；输入不可用时返回 '0'.repeat(16)
 */
export function sessionFingerprintOf(sessionRecord) {
  if (!isObj(sessionRecord)) return '0000000000000000'
  const tokens = isObj(sessionRecord.tokens) ? sessionRecord.tokens : {}
  const tools = isObj(sessionRecord.toolHistogram) ? sessionRecord.toolHistogram : {}
  // 工具直方图按名字排序，保证与插入顺序无关
  const toolPairs = Object.keys(tools)
    .sort()
    .map((k) => `${k}:${num(tools[k])}`)
  // perDay 按日期排序，保证与遍历顺序无关
  const perDay = isObj(sessionRecord.perDay) ? sessionRecord.perDay : {}
  const dayPairs = Object.keys(perDay)
    .sort()
    .map((date) => {
      const d = isObj(perDay[date]) ? perDay[date] : {}
      const t = isObj(d.tokens) ? d.tokens : {}
      return `${date}|${num(d.turns)}|${num(d.steps)}|${TOKEN_KEYS.map((k) => num(t[k])).join(',')}`
    })
  const payload = [
    'v1',
    String(sessionRecord.sessionId ?? ''),
    String(sessionRecord.title ?? ''),
    String(sessionRecord.assistantTail ?? ''),
    Array.isArray(sessionRecord.promptPreview) ? sessionRecord.promptPreview.join('\u0001') : '',
    TOKEN_KEYS.map((k) => num(tokens[k])).join(','),
    `${num(sessionRecord.turns)},${num(sessionRecord.steps)}`,
    toolPairs.join(','),
    dayPairs.join(';'),
  ].join('\u0000')
  return hash16(payload)
}

/**
 * 顶层会话判定：`origin !== 'subagent'` 且 `delegationDepth === 0`（契约 §3）。
 * @param {object} sessionRecord
 * @returns {boolean}
 */
export function isTopLevel(sessionRecord) {
  if (!isObj(sessionRecord)) return false
  return sessionRecord.origin !== 'subagent' && num(sessionRecord.delegationDepth) === 0
}
