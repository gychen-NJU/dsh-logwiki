/**
 * summarize.js —— `ctx.llm.stream` 封装：条目摘要 + 周/月简报。
 *
 * 契约（OVERVIEW §3「lib/summarize.js 内部必须遵守」，逐条对齐）：
 *   1. `ctx.llm.stream` 是**唯一**模型调用动词，没有 `complete()`；
 *   2. **省略** `purpose` 与 `sessionId`（purpose 是封闭联合 'compaction'|'session-title'；
 *      省略 sessionId 才不会写会话日志）；
 *   3. `createUserMessage({ content:[{type:'text',text}], source:{ kind:'plugin:dsh-logwiki' } })`；
 *   4. `for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)`，
 *      然后**自己判** `assembler.finish`：error / aborted / max-tokens / tool-calls → 抛；
 *   5. `deadline(signal, config.timeoutMs, 'LOGWIKI_TIMEOUT')` 限时；
 *   6. 模型取 `config.provider` / `config.model`，未配置回退 `ctx.get('agentDefaultModel')?.currentSelection()`。
 *
 * 依赖纪律：本文件**不** import `@deepseek-ai/*`，只从 ./vendor-dsh.js 取。
 * vendor 不可用时抛 `LOGWIKI_VENDOR_UNAVAILABLE`，由集成方按 OVERVIEW §6 降级 seed。
 */

import { loadVendor, vendorStatus } from './vendor-dsh.js'
import {
  LIMITS,
  agentPrompt,
  digestPrompt,
  entryPrompt,
  parseDigestJson,
  parseEntryJson,
} from './prompts.js'

/** deadline 的 code（契约固定值）。 */
const TIMEOUT_CODE = 'LOGWIKI_TIMEOUT'
/** 消息来源标识（契约固定值；**不得**使用 source.kind='plugin'）。 */
const SOURCE_KIND = 'plugin:dsh-logwiki'

const DEFAULTS = Object.freeze({
  maxTokens: 2048,
  timeoutMs: 60000,
})

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function wikiError(code, message, cause) {
  const error = new Error(message)
  error.code = code
  if (cause !== undefined) error.cause = cause
  return error
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(value) {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined) return []
  return [value]
}

function positiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * `createSummarizer(ctx, config, ui)` 的 config 可能是：
 *   · `config.summarize`（OVERVIEW §3 + index.js 实际调用）；
 *   · 整个 config（含 `.summarize`）—— 防御性兼容。
 */
function pickSummarizeConfig(config) {
  if (isPlainObject(config) && isPlainObject(config.summarize)) return config.summarize
  return isPlainObject(config) ? config : {}
}

/* ------------------------------------------------------------------ *
 * 工厂
 * ------------------------------------------------------------------ */

/**
 * @param {object} ctx      cordis 上下文（需要 ctx.llm；可选 ctx.get）
 * @param {object} config   `config.summarize`
 * @param {object} [ui]     `config.ui`（签名兼容用；提示词按契约固定中文）
 */
export function createSummarizer(ctx, config, ui) {
  const cfg = pickSummarizeConfig(config)
  const _ui = isPlainObject(ui) ? ui : {}

  const maxTokens = positiveInt(cfg.maxTokens, DEFAULTS.maxTokens)
  const timeoutMs = positiveInt(cfg.timeoutMs, DEFAULTS.timeoutMs)
  const onlyTopLevel = cfg.onlyTopLevelSessions !== false

  /* ---------------- 模型解析 ---------------- */

  function service(name) {
    if (ctx === null || ctx === undefined) return undefined
    try {
      if (typeof ctx.get === 'function') {
        const got = ctx.get(name)
        if (got !== undefined && got !== null) return got
      }
    } catch {
      /* 单个服务取不到不算错误 */
    }
    return ctx[name]
  }

  /** config 优先；未配置时回退 agentDefaultModel.currentSelection()。 */
  function resolveModel() {
    let provider = typeof cfg.provider === 'string' && cfg.provider !== '' ? cfg.provider : ''
    let model = typeof cfg.model === 'string' && cfg.model !== '' ? cfg.model : ''

    if (provider === '' || model === '') {
      const selection = (() => {
        try {
          const svc = service('agentDefaultModel')
          return typeof svc?.currentSelection === 'function' ? svc.currentSelection() : undefined
        } catch {
          return undefined
        }
      })()
      if (provider === '' && typeof selection?.provider === 'string') provider = selection.provider
      if (model === '' && typeof selection?.model === 'string') model = selection.model
    }

    return { provider, model }
  }

  function llmService() {
    const llm = service('llm')
    if (llm === null || llm === undefined || typeof llm.stream !== 'function') {
      throw wikiError('LOGWIKI_NO_LLM', 'ctx.llm 不可用（宿主未挂载 llm 服务）')
    }
    return llm
  }

  /* ---------------- 单次模型调用 ---------------- */

  /**
   * 一次完整的流式调用 → 文本。
   * 严格遵循契约：唯一动词 stream；省略 purpose/sessionId；自判 finish。
   */
  async function callModel({ prompt, maxTokensOverride, signal }) {
    const vendor = await loadVendor()
    if (vendor === null) {
      const status = vendorStatus()
      throw wikiError(
        'LOGWIKI_VENDOR_UNAVAILABLE',
        `无法解析 @deepseek-ai/*（${status.error ?? 'unknown'}）；已尝试：${status.attempts
          .map((a) => `${a.root} → ${a.error}`)
          .join(' | ')}`,
      )
    }

    const { provider, model } = resolveModel()
    if (provider === '' || model === '') {
      throw wikiError('LOGWIKI_NO_MODEL', '未配置 summarize.provider/model，且 agentDefaultModel 不可用')
    }

    const llm = llmService()
    const dl = vendor.deadline(signal ?? undefined, timeoutMs, TIMEOUT_CODE)
    const assembler = new vendor.BlockAssembler()

    try {
      const userMessage = vendor.createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: SOURCE_KIND },
      })

      // 注意：**刻意不传** purpose 与 sessionId（见文件头契约 2）。
      const options = {
        provider,
        model,
        maxTokens: positiveInt(maxTokensOverride, maxTokens),
        messages: [userMessage],
        signal: dl.signal,
      }

      for await (const chunk of llm.stream(options)) {
        assembler.push(chunk)
      }
    } catch (error) {
      // 超时/取消会以异常形式冒出来（消费方自身失败），归一成带码的错误。
      if (dl.signal.aborted && timeoutOf(dl.signal.reason) !== undefined) {
        throw wikiError(TIMEOUT_CODE, `模型调用超时（${timeoutMs}ms）`, error)
      }
      throw wikiError('LOGWIKI_LLM_THROWN', `模型调用抛错：${messageOf(error)}`, error)
    } finally {
      try {
        dl[Symbol.dispose]()
      } catch {
        /* dispose 失败无害 */
      }
    }

    // —— 自己判 finish（契约 4）——
    const finish = assembler.finish
    const kind = isPlainObject(finish) ? finish.kind : undefined

    if (kind === 'error') {
      throw wikiError('LOGWIKI_LLM_ERROR', `模型返回错误：${failureText(finish)}`, finish)
    }
    if (kind === 'aborted') {
      if (dl.signal.aborted && timeoutOf(dl.signal.reason) !== undefined) {
        throw wikiError(TIMEOUT_CODE, `模型调用超时（${timeoutMs}ms）`, finish)
      }
      throw wikiError('LOGWIKI_LLM_ABORTED', `模型调用被中止：${failureText(finish)}`, finish)
    }
    if (kind === 'max-tokens') {
      throw wikiError('LOGWIKI_MAX_TOKENS', `模型输出被 maxTokens（${positiveInt(maxTokensOverride, maxTokens)}）截断`)
    }
    if (kind === 'tool-calls') {
      throw wikiError('LOGWIKI_TOOL_CALLS', '模型返回了工具调用；本插件不发工具，属于协议异常')
    }
    // 'stop' 与未来新增的未知 kind：放行，由解析层与空文本检查兜底。

    const text = textOf(assembler.blocks())
    if (text.trim() === '') {
      throw wikiError('LOGWIKI_EMPTY_RESPONSE', '模型返回空文本')
    }

    return { text, provider, model, usage: assembler.usage ?? null }
  }

  /** 只拼 text 块（reasoning 块不算可见输出）。 */
  function textOf(blocks) {
    if (!Array.isArray(blocks)) return ''
    let out = ''
    for (const block of blocks) {
      if (isPlainObject(block) && block.type === 'text' && typeof block.text === 'string') out += block.text
    }
    return out
  }

  function failureText(finish) {
    const failure = isPlainObject(finish) ? finish.failure : undefined
    if (isPlainObject(failure)) {
      const code = typeof failure.code === 'string' && failure.code !== '' ? `${failure.code}: ` : ''
      const message = typeof failure.message === 'string' ? failure.message : ''
      return `${code}${message}`.trim() || 'unknown-failure'
    }
    return 'unknown-failure'
  }

  /** deadline 的 TimeoutReason：{ code, timeoutMs, name:'TimeoutReason' }。 */
  function timeoutOf(reason) {
    if (!isPlainObject(reason)) return undefined
    if (reason.code === TIMEOUT_CODE) return reason
    return undefined
  }

  /* ---------------- 会话归一 ---------------- */

  /**
   * 兼容三种入参：
   *   · `sessions` = 会话记录数组；
   *   · `sessions` = key → 记录 的 Map/普通对象；
   *   · `sessionKeys`（index.js 实际传的）= `${sourceId}::${sessionId}` 字符串数组。
   */
  function normalizeSessions(input) {
    const raw = input?.sessions ?? input?.sessionKeys ?? []
    let list = []
    if (Array.isArray(raw)) list = raw
    else if (raw instanceof Map) list = Array.from(raw.values())
    else if (isPlainObject(raw)) list = Object.values(raw)

    const out = []
    for (const item of list) {
      if (typeof item === 'string') {
        if (item === '') continue
        const parts = item.split('::')
        out.push({ sessionId: parts.length > 1 ? parts[parts.length - 1] : item })
        continue
      }
      if (isPlainObject(item)) out.push(item)
    }

    if (!onlyTopLevel) return out
    return out.filter((s) => s.origin !== 'subagent' && !(Number.isFinite(s.delegationDepth) && s.delegationDepth > 0))
  }

  /* ---------------- 对外接口（OVERVIEW §3） ---------------- */

  /**
   * 一个 (日, 来源, 工作区) → 任务条目数组。失败抛错（由调用方降级 seed）。
   * @returns {Promise<Array<{summary:string, tag:string, sessionRefs:string[]}>>}
   */
  async function summarizeDay(target) {
    const input = isPlainObject(target) ? target : {}
    const sessions = normalizeSessions(input)

    if (sessions.length === 0) return []

    const prompt = entryPrompt({
      date: input.date,
      workspaceLabel: input.workspaceLabel,
      workspacePath: input.workspacePath,
      sessions,
      alreadyRecorded: input.alreadyRecorded,
    })

    const result = await callModel({ prompt, signal: input.signal })
    const parsed = parseEntryJson(result.text)
    if (parsed === null) {
      throw wikiError('LOGWIKI_PARSE_FAILED', `条目 JSON 解析失败：${preview(result.text)}`)
    }

    return sanitizeEntries(parsed, sessions)
  }

  /** 只保留真实存在的 sessionId，避免模型编造引用。 */
  function sanitizeEntries(entries, sessions) {
    const known = new Set(
      sessions.map((s) => (typeof s.sessionId === 'string' ? s.sessionId : '')).filter((s) => s !== ''),
    )
    if (known.size === 0) return entries
    return entries.map((entry) => ({
      summary: entry.summary,
      tag: entry.tag,
      sessionRefs: entry.sessionRefs.filter((ref) => known.has(ref)),
    }))
  }

  /**
   * 周/月简报。
   * @returns {Promise<{title:string, headline:string, items:Array, model:{provider:string, model:string}}>}
   */
  async function generateDigest(input) {
    const src = isPlainObject(input) ? input : {}
    const prompt = digestPrompt(src)
    const result = await callModel({
      prompt,
      signal: src.signal,
      maxTokensOverride: positiveInt(cfg.digestMaxTokens, maxTokens),
    })

    const parsed = parseDigestJson(result.text)
    if (parsed === null) {
      throw wikiError('LOGWIKI_PARSE_FAILED', `简报 JSON 解析失败：${preview(result.text)}`)
    }

    return {
      title: parsed.title,
      headline: parsed.headline,
      items: parsed.items,
      model: { provider: result.provider, model: result.model },
    }
  }

  /** 构造「交给智能体」的提示词（不调模型）。 */
  async function buildAgentPrompt(input) {
    return agentPrompt(isPlainObject(input) ? input : {})
  }

  /** 模型自检：真发一次极小请求，确认 vendor / 模型路由 / 流式链路都通。 */
  async function probe() {
    const { provider, model } = resolveModel()
    try {
      const result = await callModel({
        prompt: '这是一次连通性自检。请只回复两个字：正常。',
        maxTokensOverride: 32,
      })
      return { ok: true, provider: result.provider, model: result.model }
    } catch (error) {
      return { ok: false, provider, model, error: `${error?.code ? `${error.code}: ` : ''}${messageOf(error)}` }
    }
  }

  /** 诊断信息（附加导出，方便 /ping 或日志排障；不属于冻结契约）。 */
  function status() {
    const { provider, model } = resolveModel()
    return {
      provider,
      model,
      maxTokens,
      timeoutMs,
      onlyTopLevelSessions: onlyTopLevel,
      configured: { provider: cfg.provider ?? null, model: cfg.model ?? null },
      vendor: vendorStatus(),
      limits: LIMITS,
    }
  }

  return { summarizeDay, generateDigest, buildAgentPrompt, probe, status }
}

/** 日志里的响应片段（防刷屏）。 */
function preview(text) {
  const s = typeof text === 'string' ? text : ''
  return s.length > 200 ? `${s.slice(0, 200)}…` : s
}
