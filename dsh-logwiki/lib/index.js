/**
 * dsh-logwiki · Host 半边（零构建 ESM）
 *
 * 职责：路由 + 刷新编排 + SSE 进度 + 条目/简报读写 + 工具注册。
 * 数据层（提取/聚合/存储）与 LLM 层在兄弟模块里，通过**动态 import + 降级**接入：
 * 任一模块缺失或语法出错时，插件仍然挂载并如实报告 503，而不是把 boot 打崩。
 *
 * 依赖策略：只 import node: 内置模块。需要 @deepseek-ai/* 时由 lib/vendor-dsh.js 统一解析。
 *
 * 红线：
 *   · 绝不向会话日志追加事件（v4 只接受 producer-owned source kind）
 *   · ctx.llm 调用省略 purpose / sessionId（见 summarize.js）
 *   · 变更类端点自保：POST + x-logwiki: 1，拒 OPTIONS，不返回 CORS 头
 */

const name = 'dsh-logwiki'
/**
 * 只硬依赖 webServer（没它插件无用）。sessionQuery / workspaceRegistry / storage / llm
 * 一律用 ctx.get() 可选获取 —— 拿不到时路由会如实报错，而不是让插件整体不激活。
 */
const inject = ['webServer']

const VERSION = '0.1.0'
const PREFIX = '/api/dsh-logwiki'
const MUTATION_HEADER = 'x-logwiki'

const DEFAULT_CONFIG = Object.freeze({
  scan: { sinceDays: 365, maxSessions: 2000, maxNewPerRun: 200 },
  summarize: {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    maxTokens: 2048,
    timeoutMs: 60000,
    maxConcurrency: 2,
    onlyTopLevelSessions: true,
  },
  heatmap: { metric: 'turns', includeSubagents: true },
  ui: { language: 'zh', weekStart: 1 },
  remote: {
    enable: false,
    sinceDays: 90,
    maxBytesPerSync: 33554432,
    // 以下为二期接线时补的边界（原设计只写了上面三项）
    maxFilesPerSync: 400,
    // 单个文件 base64 后仍要完整收下的上限。
    // ⚠️ 曾设 16 MB —— 但 base64 会膨胀 4/3，一个 ~11 MB 的会话日志就会撞顶、
    // 输出被截断，实测导致 20 个远端文件里有 1 个拉不下来。给足到 64 MB。
    maxBytesPerFile: 67108864,
    commandTimeoutMs: 120000,
    maxSourcesPerRun: 3,
  },
})

function mergeConfig(raw) {  const out = {}
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const base = DEFAULT_CONFIG[key]
    const given = raw !== null && typeof raw === 'object' ? raw[key] : undefined
    out[key] = given !== null && typeof given === 'object' ? { ...base, ...given } : { ...base }
  }
  if (raw !== null && typeof raw === 'object') {
    for (const key of Object.keys(raw)) if (!(key in out)) out[key] = raw[key]
  }
  return out
}

/**
 * 日志：直接走 console。
 * 不用 `ctx.logger` —— 它需要显式注入才可用，而本插件刻意把 `inject` 压到最小
 * （只有 webServer），少一个服务依赖就少一种"插件整体不激活"的失败模式。
 */
function log(message) {
  console.log(String(message))
}
function warn(message) {
  console.warn(String(message))
}

/**
 * 让出事件循环。
 * 不用 `ctx.timeout()` —— 那是 Cordis 的 **timer 服务**能力，未注入时会抛
 * `cannot get property "timer" without inject`（实测踩过，刷新第一步就挂）。
 * 普通 setTimeout 等效且零依赖。
 */
function yieldToLoop() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

function sendJson(res, code, value) {
  const payload = JSON.stringify(value)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= maxBytes) chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

async function readJsonBody(req, maxBytes) {
  const text = await readBody(req, maxBytes)
  if (text === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return null
  }
}

/**
 * 变更类端点守卫：只接受 POST、必须带 MUTATION_HEADER、明确拒绝 OPTIONS。
 * ctx.webServer 无任何鉴权/Origin 策略，跨站简单请求设不了自定义头 → 足够挡住跨站写入。
 */
function guardMutation(req) {
  const method = (req.method || 'GET').toUpperCase()
  if (method === 'OPTIONS') return { code: 405, error: '不支持 OPTIONS（本路由不实现 CORS 预检）' }
  if (method !== 'POST') return { code: 405, error: `变更类端点只接受 POST（收到 ${method}）` }
  if (req.headers[MUTATION_HEADER] !== '1') {
    return { code: 403, error: `缺少 ${MUTATION_HEADER}: 1 头，拒绝跨站/表单写入` }
  }
  return null
}

/** 本地相对 UTC 的分钟偏移（本机东八区 = +480）。 */
function tzOffsetMinutes() {
  return -new Date().getTimezoneOffset()
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 周期 → 起止日期（含）。
 * `YYYY-Www` 用 ISO 周（周一为起，1 月 4 日所在周为第 1 周）；`YYYY-MM` 用自然月。
 * 本函数刻意留在集成层：契约里没有把它算作 fold.js 的导出，避免给并行线加需求。
 * @returns {{from: string, to: string} | null}
 */
function periodRange(kind, period) {
  if (kind === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(period)
    if (m === null) return null
    const year = Number(m[1])
    const month = Number(m[2])
    if (month < 1 || month > 12) return null
    return { from: fmtDate(new Date(year, month - 1, 1)), to: fmtDate(new Date(year, month, 0)) }
  }
  const m = /^(\d{4})-W(\d{2})$/.exec(period)
  if (m === null) return null
  const year = Number(m[1])
  const week = Number(m[2])
  if (week < 1 || week > 53) return null
  const jan4 = new Date(year, 0, 4)
  const jan4Dow = (jan4.getDay() + 6) % 7 // 周一=0
  const week1Mon = new Date(year, 0, 4 - jan4Dow)
  const from = new Date(week1Mon.getTime() + (week - 1) * 7 * 86400000)
  const to = new Date(from.getTime() + 6 * 86400000)
  return { from: fmtDate(from), to: fmtDate(to) }
}

/**
 * `'YYYY-MM-DD'` → ISO 周标识 `'YYYY-Www'`（周一起始，1 月 4 日所在周为第 1 周）。
 *
 * ⚠️ 必须与客户端 `gfmWeekKey()` **同算法**：客户端用「选中日 → 周期」来跟随用户视角，
 * 两边算出的周不同就会跳到错误的周。两者都按"取该日所在周的周四、再数它是第几周"实现。
 * @returns {string | null}
 */
function isoWeekKeyOf(dateKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey))
  if (m === null) return null
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(t.getTime())) return null
  // 周三之前的日往前挪到本周周四，之后的往后挪到本周周四
  const thu = new Date(t.getTime() + (3 - ((t.getDay() + 6) % 7)) * 86400000)
  const jan1 = new Date(thu.getFullYear(), 0, 1)
  const ordinal = Math.round((thu.getTime() - jan1.getTime()) / 86400000) + 1
  const week = Math.floor((ordinal - 1) / 7) + 1
  return `${thu.getFullYear()}-W${String(week).padStart(2, '0')}`
}

/**
 * 把一段 shell 脚本交给 `wsl.exe` 执行：**脚本一律 base64 包裹**。
 *
 * 为什么非要 base64：从 Windows 到 WSL 要穿过 `wsl.exe → sh -lc → (目标 shell)` 两层，
 * 任何引号/`$`/换行都会被吃掉一层。base64 之后待插值的只剩 base64 字符集，注入面归零。
 * （`lib/remote.js` 的 `buildSshArgv` 用的是同一招，只是再往外套了一层 ssh。）
 */
function wslScriptArgv(script, wslDistro) {
  const inner = `echo ${Buffer.from(String(script), 'utf8').toString('base64')} | base64 -d | sh`
  const argv = ['wsl.exe']
  if (typeof wslDistro === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(wslDistro)) argv.push('-d', wslDistro)
  argv.push('-e', 'sh', '-lc', inner)
  return argv
}

/**
 * 运行时服务可用性探测（长期诊断用）。
 * 实测发现 workspaceRegistry 可能因依赖未满足而始终 pending —— 本插件**不硬依赖**它，
 * 拿不到就退回 cwd 的 basename 作工作区标签。
 */
const PROBED_SERVICES = [
  'webServer',
  'sessionQuery',
  'sessionPersistence',
  'sessions',
  'workspaceRegistry',
  'workspaceController',
  'storage',
  'storageDomain',
  'llm',
  'agentDefaultModel',
  'timer',
  'subprocess',
  'credentials',
  'tools',
  'jobs',
  'sessions',
]

function probeServices(ctx) {
  const out = {}
  for (const key of PROBED_SERVICES) {
    if (key in out) continue
    let present = false
    try {
      present = ctx.get(key) !== undefined
    } catch {
      present = false
    }
    out[key] = present
  }
  return out
}

/** 路径末段（同时吃 \ 与 /）。 */
function basenameOf(p) {
  const s = String(p).replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  const b = i >= 0 ? s.slice(i + 1) : s
  return b !== '' ? b : s
}

/**
 * 工作区显示名：workspaceRegistry 的 title 优先，否则退回 cwd 的 basename
 * （与侧栏工作区列表看到的名称一致），最后才是「(未知工作区)」。
 */
function workspaceLabelOf(cwd, titles) {
  if (typeof cwd !== 'string' || cwd === '') return '(未知工作区)'
  const titled = titles.get(cwd)
  if (typeof titled === 'string' && titled !== '') return titled
  return basenameOf(cwd)
}

/**
 * 挂载插件。
 * @param ctx - Cordis 上下文（services: webServer；可选 sessionQuery/workspaceRegistry/storage/llm）
 * @param config - cordis.patch.yml（或 --patch 覆盖层）里那一行的 config
 */
export function apply(ctx, config = {}) {
  const resolved = mergeConfig(config)
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    warn('[dsh-logwiki] webServer 服务不可用，插件不挂载路由')
    return
  }

  // ---------------------------------------------------------------- 兄弟模块（动态加载 + 降级）
  const mods = {
    extract: null,
    fold: null,
    store: null,
    summarize: null,
    prompts: null,
    // 二期（远程来源）。同样是动态 import + 降级：缺了只让相关端点回 503，
    // 不影响一期功能——这样"半成品不会炸掉用户环境"。
    remote: null,
    remoteSources: null,
  }
  const modErrors = {}

  async function loadModules() {
    const specs = [
      ['extract', './extract.js'],
      ['fold', './fold.js'],
      ['store', './store.js'],
      ['summarize', './summarize.js'],
      ['prompts', './prompts.js'],
      ['remote', './remote.js'],
      ['remoteSources', './remote-sources.js'],
    ]
    for (const [key, spec] of specs) {
      try {
        mods[key] = await import(spec)
        delete modErrors[key]
      } catch (error) {
        mods[key] = null
        modErrors[key] = error instanceof Error ? error.message : String(error)
        warn(`[dsh-logwiki] 模块 ${spec} 不可用：${modErrors[key]}`)
      }
    }
  }

  /** 需要哪些模块才能干活；缺了就 503（而不是崩）。 */
  function requireMods(res, keys) {
    const missing = keys.filter((k) => mods[k] === null)
    if (missing.length === 0) return true
    sendJson(res, 503, {
      ok: false,
      error: `模块未就绪：${missing.join(', ')}`,
      detail: missing.map((k) => ({ module: k, error: modErrors[k] ?? 'unknown' })),
    })
    return false
  }

  // ---------------------------------------------------------------- 可选服务：workspaceRegistry
  // 实测：即使 storageDomain / sessionPersistence 都在，ctx.get('workspaceRegistry') 仍为
  // undefined —— 该服务需要显式注入才可见。用 ctx.inject 做条件注入：它出现时才取用，
  // 不出现也不影响插件激活（我们在没有它的 profile 下退回 cwd 的 basename 作标签）。
  let workspaceRegistry = null
  ctx.effect(
    () =>
      ctx.inject(['workspaceRegistry'], (scoped) => {
        try {
          workspaceRegistry = scoped.get('workspaceRegistry') ?? null
        } catch {
          workspaceRegistry = null
        }
        if (workspaceRegistry !== null) {
          log('[dsh-logwiki] workspaceRegistry 已接入（工作区标题可用）')
        }
        return () => {
          workspaceRegistry = null
        }
      }),
    'dsh-logwiki: workspace registry (optional)',
  )

  // ---------------------------------------------------------------- 存储
  /** @type {null | ReturnType<typeof import('./store.js').createStore>} */
  let store = null

  async function ensureStore() {
    if (store !== null) return store
    if (mods.store === null) return null
    try {
      store = mods.store.createStore(ctx)
      await store.ready
    } catch (error) {
      warn(`[dsh-logwiki] store 初始化失败：${error instanceof Error ? error.message : String(error)}`)
      store = null
    }
    return store
  }

  // ---------------------------------------------------------------- 进度 / SSE
  const sseClients = new Set()
  const progress = {
    phase: 'idle',
    done: 0,
    total: 0,
    current: '',
    errors: 0,
    finished: true,
    startedAt: 0,
    jobId: null,
  }
  const scan = { started: false, done: false, scanned: 0, total: 0, failed: 0, pending: 0, truncated: false }

  function pushProgress(patch) {
    Object.assign(progress, patch)
    const line = `event: progress\ndata: ${JSON.stringify(progress)}\n\n`
    for (const res of sseClients) {
      try {
        res.write(line)
      } catch {
        sseClients.delete(res)
      }
    }
  }

  // ---------------------------------------------------------------- 刷新（单飞）
  let running = null

  async function doRefresh(jobId) {
    const sessionQuery = ctx.get('sessionQuery')
    if (sessionQuery === undefined) throw new Error('sessionQuery 服务不可用，无法读取会话')
    if (!requireModsNoRes(['extract', 'fold', 'store'])) throw new Error('数据层模块未就绪')

    const db = await ensureStore()
    if (db === null) throw new Error('store 不可用（storage 缺失或初始化失败）')
    const { extract, fold } = mods

    const tz = tzOffsetMinutes()
    const now = Date.now()
    const cutoff = now - Math.max(1, resolved.scan.sinceDays) * 86400000

    // 1) 工作区表（path → title）；registry 不可用时留空，标签退回 basename
    const workspaceTitles = new Map()
    if (workspaceRegistry !== null) {
      try {
        for (const w of workspaceRegistry.list() ?? []) {
          if (w !== null && w !== undefined && typeof w.path === 'string' && w.path !== '') {
            workspaceTitles.set(w.path, typeof w.title === 'string' ? w.title : '')
          }
        }
      } catch (error) {
        warn(`[dsh-logwiki] workspaceRegistry.list 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // 2) 会话清单（newest-first），先按 createdAt 粗筛 + 上限
    let records = []
    try {
      records = (await sessionQuery.listSessions()) ?? []
    } catch (error) {
      throw new Error(`sessionQuery.listSessions 失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const candidates = records
      .filter((r) => r !== null && r !== undefined && r.header !== undefined && typeof r.header.id === 'string')
      .filter((r) => (typeof r.header.createdAt === 'number' ? r.header.createdAt : 0) >= cutoff)
      .slice(0, Math.max(1, resolved.scan.maxSessions))

    scan.started = true
    scan.total = candidates.length
    pushProgress({ phase: 'scan', done: 0, total: candidates.length, current: '', errors: 0, finished: false })

    const before = db.get()
    const known = before.sessions ?? {}
    let changed = 0
    let processed = 0
    let newProcessed = 0
    let truncated = false
    // 首次回填可能上千个会话、每个都要完整读一遍日志（重放校验 + 多帧解压），
    // 所以按「新增」计数设上限：先让最近的历史可用，再靠后续「更新」续跑。
    const maxNew = Math.max(1, Number(resolved.scan.maxNewPerRun) || 200)

    for (const record of candidates) {
      const sourceId = 'local'
      const key = `${sourceId}::${record.header.id}`
      try {
        const previous = known[key]
        const needsRead = previous === undefined
        if (!needsRead) {
          processed += 1
          scan.scanned = processed
          if (processed % 25 === 0) pushProgress({ done: processed, current: record.header.id })
          continue
        }
        if (newProcessed >= maxNew) {
          truncated = true
          break
        }
        newProcessed += 1

        const events = []
        let snapshot = null
        try {
          snapshot = await sessionQuery.readSession(record.header.id)
        } catch (error) {
          throw error
        }
        if (snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.events)) {
          for (const ev of snapshot.events) events.push(ev)
        }

        // 标题**不**单独调 readTitle：extractSession 会自己从 session/title 事件里取
        //（实测事件优先级还高于 title 参数）。省掉这一趟 = 每会话的日志读取量减半。
        const extracted = extract.extractSession({ header: record.header, events })
        if (extracted !== null && extracted !== undefined) {
          const fingerprint = extract.sessionFingerprintOf(extracted)
          const cwd = typeof extracted.cwd === 'string' ? extracted.cwd : ''
          const label = workspaceLabelOf(cwd, workspaceTitles)
          db.update((draft) => {
            if (draft.sessions === undefined) draft.sessions = {}
            draft.sessions[key] = { ...extracted, sourceId, workspaceLabel: label, fingerprint }
          })
          changed += 1
        }
      } catch (error) {
        scan.failed += 1
        pushProgress({ errors: scan.failed })
        warn(
          `[dsh-logwiki] 会话 ${record.header.id} 处理失败（跳过）：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      processed += 1
      scan.scanned = processed
      if (processed % 10 === 0 || processed === candidates.length) {
        pushProgress({ done: processed, current: record.header.id })
      }
      await yieldToLoop()
    }

    scan.done = true
    scan.truncated = truncated
    scan.pending = truncated ? Math.max(0, candidates.length - processed) : 0

    // 2.5) 远端来源（二期）—— **必须排在重算天聚合与摘要之前**。
    //
    // 踩过的坑：最初把它放在整个 doRefresh 的最末尾，结果远端会话虽然进了 sessions，
    // 却赶不上本轮的重算与摘要 —— 日历上只多了"回合数"，一条任务卡都不出。
    // 顺序反了，用户看到的就是"同步成功但什么都没发生"。
    const remoteSummary = []
    if (resolved.remote.enable === true && mods.remote !== null) {
      const list = Object.values(db.get().sources ?? {}).filter(
        (s) => s !== null && typeof s === 'object' && s.kind === 'remote' && s.enabled !== false,
      )
      for (const source of list.slice(0, resolved.remote.maxSourcesPerRun)) {
        // 手动同步正在进行 → 这轮跳过，别去抢那条共享的 ControlMaster 连接
        if (remoteRunning !== null) break
        remoteRunning = source.id
        try {
          remoteSummary.push({ label: source.label, ...(await syncSource(source.id)) })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          warn(`[dsh-logwiki] 同步 ${source.label} 异常：${message}`)
          remoteSummary.push({ label: source.label, ok: false, error: message })
        } finally {
          remoteRunning = null
        }
      }
    }

    // 3) 重算天聚合
    const after = db.get()
    const sessions = after.sessions ?? {}
    const includeSubagents = resolved.heatmap.includeSubagents !== false
    const days = fold.buildDays(sessions, { includeSubagents, tzOffsetMinutes: tz })
    db.update((draft) => {
      draft.days = days
      draft.updatedAt = Date.now()
    })

    // 4) 生成缺失的条目摘要（按 天 × 来源 × 工作区）
    let summarized = 0
    if (mods.summarize !== null && mods.fold !== null) {
      const summarizer = createSummarizer()
      if (summarizer !== null) {
        const targets = collectSummaryTargets(db.get(), sessions, fold)
        pushProgress({ phase: 'summarize', done: 0, total: targets.length, current: '', finished: false })
        let done = 0
        const concurrency = Math.max(1, Math.min(4, resolved.summarize.maxConcurrency || 2))
        const queue = targets.slice()
        const workers = Array.from({ length: concurrency }, async () => {
          for (;;) {
            const target = queue.shift()
            if (target === undefined) return
            try {
              const entries = await summarizer.summarizeDay(target)
              if (Array.isArray(entries) && entries.length > 0) {
                writeEntries(db, target, entries)
                summarized += entries.length
              } else {
                db.update((draft) => {
                  if (draft.dayState === undefined) draft.dayState = {}
                  draft.dayState[target.date] = { generatedAt: Date.now(), status: 'seed', error: 'empty-result' }
                })
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              warn(`[dsh-logwiki] ${target.date}/${target.workspaceLabel} 摘要失败：${message}`)
              const seeded = seedEntries(target)
              writeEntries(db, target, seeded)
              db.update((draft) => {
                if (draft.dayState === undefined) draft.dayState = {}
                draft.dayState[target.date] = { generatedAt: Date.now(), status: 'seed', error: message }
              })
            }
            done += 1
            pushProgress({ done, current: `${target.date} · ${target.workspaceLabel}` })
            await yieldToLoop()
          }
        })
        await Promise.all(workers)
      }
    }

    pushProgress({ phase: 'idle', finished: true, done: progress.total, current: '' })
    return { changed, summarized, scanned: scan.scanned, failed: scan.failed, remote: remoteSummary }
  }

  function requireModsNoRes(keys) {
    return keys.every((k) => mods[k] !== null)
  }

  /** 需要生成摘要的 (日期, 来源, 工作区) 目标集。 */
  function collectSummaryTargets(db, sessions, fold) {
    const targets = []
    const dayState = db.dayState ?? {}
    const entryOrder = db.entryOrder ?? {}
    const byDayWorkspace = new Map()
    for (const key of Object.keys(sessions)) {
      const s = sessions[key]
      if (s === null || s === undefined) continue
      // 用 extract.isTopLevel 而不是 origin 字符串判定：`origin` 字段**可能缺省**，
      // 此时只能靠 delegationDepth 区分（契约口径：顶层 = delegationDepth === 0）。
      // 注意这里必须走 mods.extract —— 本函数定义在 apply 作用域，看不到 doRefresh 里的局部 extract。
      const isTop = typeof mods.extract?.isTopLevel === 'function' ? mods.extract.isTopLevel(s) : s.origin !== 'subagent'
      if (!isTop) continue
      const perDay = s.perDay ?? {}
      for (const date of Object.keys(perDay)) {
        const ws = typeof s.cwd === 'string' && s.cwd !== '' ? s.cwd : '(未知工作区)'
        const k = `${date}\u0000${s.sourceId}\u0000${ws}`
        let bucket = byDayWorkspace.get(k)
        if (bucket === undefined) {
          bucket = {
            date,
            sourceId: s.sourceId,
            workspacePath: ws,
            workspaceLabel: s.workspaceLabel ?? ws,
            sessionKeys: [],
            // 契约要求把会话记录本身喂给 summarizeDay —— 只有 sessionId 的话提示词里
            // 拿不到 title / promptPreview / toolHistogram，摘要质量会明显下降。
            sessions: [],
          }
          byDayWorkspace.set(k, bucket)
        }
        bucket.sessionKeys.push(key)
        bucket.sessions.push(s)
      }
    }
    for (const bucket of byDayWorkspace.values()) {
      const state = dayState[bucket.date]
      const hasEntries = Array.isArray(entryOrder[bucket.date]) && entryOrder[bucket.date].length > 0
      // 必须传**会话记录数组**（bucket.sessions），不是字符串键数组：
      // daySessionFingerprint 内部的 normalizeSessions 会把字符串全部跳过，
      // 传 sessionKeys 会恒返回空串哈希 → 「会话变了就重算摘要」这条逻辑静默失效。
      const fingerprint =
        typeof fold.daySessionFingerprint === 'function' ? fold.daySessionFingerprint(bucket.sessions) : null
      if (state !== undefined && state.sessionFingerprint === fingerprint && (state.status === 'ok' || hasEntries)) continue
      targets.push({ ...bucket, sessionFingerprint: fingerprint })
    }
    return targets
  }

  /** 用会话标题/首条提示兜底，保证任何情况下都不丢数据。 */
  function seedEntries(target) {
    return target.sessionKeys.map((key) => {
      const s = (store?.get()?.sessions ?? {})[key] ?? {}
      const first = Array.isArray(s.promptPreview) && s.promptPreview.length > 0 ? s.promptPreview[0] : ''
      const fallback = typeof s.title === 'string' && s.title !== '' ? s.title : first
      return {
        summary: String(fallback || '(未命名会话)').slice(0, 60),
        tag: '',
        sessionRefs: [s.sessionId].filter(Boolean),
      }
    })
  }

  /** 把一行条目写进 entries + entryOrder（保持 startTime 升序）。 */
  function writeEntries(db, target, rows) {
    const now = Date.now()
    const sessions = db.get().sessions ?? {}
    const refSession = sessions[target.sessionKeys[0]] ?? {}
    const startTime = typeof refSession.createdAt === 'number' ? refSession.createdAt : now
    db.update((draft) => {
      if (draft.entries === undefined) draft.entries = {}
      if (draft.entryOrder === undefined) draft.entryOrder = {}
      const ids = []
      rows.forEach((row, i) => {
        const refs = Array.isArray(row.sessionRefs) && row.sessionRefs.length > 0 ? row.sessionRefs : [refSession.sessionId].filter(Boolean)
        const id = entryIdOf(target.date, target.sourceId, refs, i)
        const existing = draft.entries[id]
        // edited 条目永不被覆盖
        if (existing !== undefined && existing.edited === true) {
          ids.push(id)
          return
        }
        draft.entries[id] = {
          id,
          sourceId: target.sourceId,
          date: target.date,
          workspacePath: target.workspacePath,
          workspaceLabel: target.workspaceLabel,
          startTime: startTime + i,
          endTime: startTime + i,
          summary: String(row.summary ?? '').slice(0, 200),
          tag: String(row.tag ?? '').slice(0, 24),
          sessionRefs: refs,
          origin: row.origin ?? 'llm',
          edited: false,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        }
        ids.push(id)
      })
      const merged = new Set([...(draft.entryOrder[target.date] ?? []), ...ids])
      draft.entryOrder[target.date] = Array.from(merged).sort((a, b) => {
        const ea = draft.entries[a]
        const eb = draft.entries[b]
        return (ea?.startTime ?? 0) - (eb?.startTime ?? 0)
      })
      if (draft.dayState === undefined) draft.dayState = {}
      draft.dayState[target.date] = {
        generatedAt: now,
        sessionFingerprint: target.sessionFingerprint ?? null,
        status: 'ok',
      }
    })
  }

  /** 稳定 entryId：同日同来源同会话集合 → 同一条。 */
  function entryIdOf(date, sourceId, sessionRefs, index) {
    const key = `${date}|${sourceId}|${sessionRefs.slice().sort().join('|')}|${index}`
    let hash = 0
    for (let i = 0; i < key.length; i += 1) {
      hash = (hash * 31 + key.charCodeAt(i)) | 0
    }
    return `e_${date}_${sourceId}_${(hash >>> 0).toString(16)}`
  }

  function createSummarizer() {
    if (mods.summarize === null) return null
    try {
      // 三参：ctx, summarize 子配置, ui 子配置（第 3 参供提示词按语言取用）。
      return mods.summarize.createSummarizer(ctx, resolved.summarize, resolved.ui)
    } catch (error) {
      warn(`[dsh-logwiki] 摘要器创建失败：${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  // ---------------------------------------------------------------- 工具（「交给智能体」闭环）
  const registeredTools = []
  const toolErrors = {}

  /**
   * `logwiki_write_digest` —— 让「交给智能体」那条路能把总结结果直接落库。
   * 工具本身**不做任何 LLM 工作**，只校验 + 写入（形状同 meow-memory 的 memory_dream）。
   */
  function digestTool() {
    return {
      name: 'logwiki_write_digest',
      description:
        '把一份周/月工作简报写入 LogWiki 任务日历。用于「交给智能体总结」这条路径：' +
        '先把 LogWiki 给出的工作条目归纳成 8–12 个**大方向**任务（不要逐条罗列细节），再用本工具落库，' +
        '用户即可在「任务日历」面板里看到并复看。',
      parameters: {
        kind: { type: 'string', required: true, description: "周期类型：'week' 或 'month'", enum: ['week', 'month'] },
        period: { type: 'string', required: true, description: '周期标识：week 形如 2026-W40；month 形如 2026-09' },
        title: { type: 'string', description: '简报标题' },
        headline: { type: 'string', description: '一句话总览' },
        items: {
          type: 'array',
          required: true,
          description: '8–12 条大方向任务，每条一句话 + 一个标签；避免上百条细碎条目',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              summary: { type: 'string', required: true, description: '一句话总结（建议 ≤60 字）' },
              tag: { type: 'string', description: '关键词标签（建议 ≤8 字）' },
            },
          },
        },
      },
      output: {
        // 注意：output.schema 是**真正的 JSON Schema**（required 是数组），
        // 与上面 parameters 的 defineTool DSL（required 在属性内）方言不同 —— 实测踩过。
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            period: { type: 'string' },
            items: { type: 'integer' },
          },
          required: ['ok', 'period', 'items'],
        },
        render: (_args, value) => [
          { type: 'text', text: `已写入 LogWiki 简报 ${value.period}（${value.items} 条），可在「任务日历」面板查看。` },
        ],
      },
      async execute(args) {
        const kind = args?.kind === 'month' ? 'month' : 'week'
        const period = typeof args?.period === 'string' ? args.period : ''
        const range = period === '' ? null : periodRange(kind, period)
        if (range === null) throw new Error(`无法解析周期：${kind}:${period}`)
        const items = Array.isArray(args?.items) ? args.items.slice(0, 12) : []
        if (items.length === 0) throw new Error('items 不能为空')
        const db = await ensureStore()
        if (db === null) throw new Error('store 不可用，无法写入简报')
        const clean = items
          .map((it) => ({
            summary: String(it?.summary ?? '').slice(0, 200),
            tag: String(it?.tag ?? '').slice(0, 24),
            sessionRefs: [],
          }))
          .filter((it) => it.summary !== '')
        if (clean.length === 0) throw new Error('items 里没有有效的 summary')
        const record = {
          kind,
          period,
          rangeStart: range.from,
          rangeEnd: range.to,
          title: typeof args?.title === 'string' && args.title !== '' ? args.title.slice(0, 80) : `${period} 简报`,
          headline: typeof args?.headline === 'string' ? args.headline.slice(0, 200) : '',
          items: clean,
          origin: 'agent',
          sourceIds: Object.keys(db.get().sources ?? {}),
          generatedAt: Date.now(),
          edited: false,
        }
        db.update((draft) => {
          if (draft.digests === undefined) draft.digests = {}
          draft.digests[`${kind}:${period}`] = record
        })
        return { ok: true, period: `${kind}:${period}`, items: clean.length }
      },
    }
  }

  /**
   * 登记/更新一个远程来源。
   *
   * `/source/add`（对话框直连）与 `logwiki_import_source`（智能体回写）**共用这一条写入口**，
   * 保证两条路径落库结果完全一致 —— 否则很容易出现"界面加的能同步、智能体加的不能"。
   */
  async function upsertSource(source) {
    const db = await ensureStore()
    if (db === null) throw new Error('store 不可用')
    db.update((draft) => {
      if (draft.sources === undefined) draft.sources = {}
      const prev = draft.sources[source.id]
      draft.sources[source.id] = prev === undefined ? source : { ...prev, ...source }
    })
    return source
  }

  function registerTools() {
    const tools = ctx.get('tools')
    if (tools === undefined) {
      toolErrors['<tools service>'] = 'tools 服务不可用'
      return
    }
    if (typeof tools.register !== 'function') {
      toolErrors['<tools service>'] = 'tools.register 不是函数'
      return
    }
    const defs = [digestTool()]
    // 二期工具按可用性挂载：remote-sources 模块缺失时只是少一个工具，不影响一期。
    if (mods.remoteSources !== null && typeof mods.remoteSources.makeImportSourceTool === 'function') {
      defs.push(mods.remoteSources.makeImportSourceTool({ upsertSource }))
    }
    for (const def of defs) {
      try {
        const dispose = tools.register(def)
        registeredTools.push(def.name)
        if (typeof dispose === 'function') ctx.effect(() => dispose)
      } catch (error) {
        toolErrors[def.name] = error instanceof Error ? error.message : String(error)
        warn(`[dsh-logwiki] 工具 ${def.name} 注册失败：${toolErrors[def.name]}`)
      }
    }
  }

  async function startRefresh() {
    if (running !== null) return { jobId: running.jobId, running: true }
    const jobId = `lw_${Date.now().toString(36)}`
    scan.started = true
    scan.done = false
    scan.scanned = 0
    scan.failed = 0
    scan.pending = 0
    scan.truncated = false
    pushProgress({ phase: 'scan', done: 0, total: 0, current: '', errors: 0, finished: false, startedAt: Date.now(), jobId })
    const task = (async () => {
      try {
        return await doRefresh(jobId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        warn(`[dsh-logwiki] 刷新失败：${message}`)
        pushProgress({ phase: 'idle', finished: true, current: `失败：${message}` })
        return { error: message }
      } finally {
        running = null
      }
    })()
    running = { jobId, task }
    return { jobId, running: true }
  }

  // ---------------------------------------------------------------- 远程来源同步（二期）
  /**
   * 同一时刻只允许一个来源在同步。
   * 理由：WSL 里的 ControlMaster 是**一条共享连接**，并发发起多路 ssh 只会互相抢连接、
   * 还会把 2FA 提示搅乱；串行反而更快也更可解释。
   */
  let remoteRunning = null

  /**
   * 跑一条远端命令并回收全部输出。
   *
   * `ctx.subprocess.spawn` 的 spec **不套任何默认值** —— argv / cwd / stdio / graceMs 必须给全。
   * stdout 用 collect 模式（进程结束后仍可读），`handle.done` 给退出事实。
   */
  async function runRemote(argv, options) {
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined || typeof subprocess.spawn !== 'function') {
      return { ok: false, error: 'subprocess 服务不可用（本实例无法执行外部命令）' }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs)
    try {
      const handle = subprocess.spawn({
        argv,
        cwd: options.cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { mode: 'collect', maxBytes: options.maxBytes },
          stderr: { mode: 'collect', maxBytes: 64 * 1024 },
        },
        graceMs: 10000,
        signal: controller.signal,
      })
      const outcome = await handle.done
      const collected = handle.collected === undefined ? {} : handle.collected
      const out = collected.stdout === undefined ? null : collected.stdout.readFrom(0)
      const err = collected.stderr === undefined ? null : collected.stderr.readFrom(0)
      return {
        ok: outcome.exitCode === 0,
        exitCode: outcome.exitCode,
        stdout: out !== null && typeof out.text === 'string' ? out.text : '',
        stderr: err !== null && typeof err.text === 'string' ? err.text : '',
        // lossy = 内存尾部被截断（maxBytes 给小了）。必须显式判它，否则会拿半截 base64 去解码。
        lossy: out !== null && out.lossy === true,
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 把远端失败翻译成**可操作的指引**。
   * 这里是本功能最容易把用户卡住的地方 —— 2FA 需要真人参与，报"退出码 255"等于没报。
   */
  function explainRemoteFailure(result, alias, label) {
    if (typeof result.error === 'string' && result.error !== '') return `连接 ${label} 失败：${result.error}`
    const text = String(result.stderr ?? '')
    if (/Permission denied|publickey/i.test(text)) {
      return `连不上 ${label}：需要先完成 2FA。请在 WSL 终端执行 ssh -fN ${alias} 并通过验证，之后本机可免验证复用该连接。`
    }
    if (/Host key verification failed/i.test(text)) {
      return `连不上 ${label}：主机指纹未确认。请在 WSL 终端先手动 ssh ${alias} 一次并接受指纹。`
    }
    if (/Could not resolve hostname/i.test(text)) {
      return `连不上 ${label}：主机名解析失败。请核对 WSL 的 ~/.ssh/config 里该别名的 HostName。`
    }
    if (/No such file or directory|not found/i.test(text)) {
      return `${label}：远端找不到目标路径，请核对远端 DSH_HOME 是否正确。`
    }
    const tail = text.trim().split('\n').filter(Boolean).slice(-2).join(' ')
    return `${label} 远端命令退出码 ${String(result.exitCode)}${tail === '' ? '' : '：' + tail.slice(0, 240)}`
  }

  /**
   * 同步一个远程来源：远端清单 → 比对账本 → 只拉新增/变化 → base64 解码 → 指纹 → 落库。
   *
   * 传输链路（f2a-ssh 那套）：`wsl.exe -e sh -lc "ssh <别名> '<base64 后的脚本>'"`。
   * 远端脚本一律 base64 包裹，绕开 PowerShell→wsl→sh→ssh 的多层转义；别名与远端路径都过白名单校验。
   */
  async function syncSource(sourceId) {
    if (mods.remote === null || mods.extract === null || mods.fold === null) {
      return { ok: false, error: 'remote / extract / fold 模块未就绪' }
    }
    const R = mods.remote
    const cfg = resolved.remote
    const db = await ensureStore()
    if (db === null) return { ok: false, error: 'store 不可用' }
    const source = db.get().sources?.[sourceId]
    if (source === undefined || source.kind !== 'remote') return { ok: false, error: `不是远程来源：${sourceId}` }

    const startedAt = Date.now()
    const mark = (patch) => {
      db.update((draft) => {
        if (draft.sources === undefined) draft.sources = {}
        const prev = draft.sources[sourceId]
        if (prev === undefined) return
        draft.sources[sourceId] = { ...prev, ...patch }
      })
    }
    const fail = (message) => {
      mark({ lastSyncAt: startedAt, lastSyncStatus: 'error', lastError: message })
      pushProgress({ phase: 'idle', finished: true, current: '' })
      warn(`[dsh-logwiki] 同步 ${source.label} 失败：${message}`)
      return { ok: false, error: message }
    }

    // 1) 远端清单
    pushProgress({ phase: 'remote', done: 0, total: 0, current: `${source.label}：读取远端清单`, finished: false })
    let indexResult
    try {
      indexResult = await runRemote(
        R.buildSshArgv({
          alias: source.sshAlias,
          wslDistro: source.wslDistro,
          script: R.buildIndexCommand({ dshHome: source.dshHome, sinceDays: source.sinceDays }),
        }),
        { cwd: process.cwd(), timeoutMs: cfg.commandTimeoutMs, maxBytes: 4 * 1024 * 1024 },
      )
    } catch (error) {
      return fail(`连接 ${source.label} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (indexResult.ok !== true) return fail(explainRemoteFailure(indexResult, source.sshAlias, source.label))

    const parsed = R.parseIndex(indexResult.stdout)
    if (parsed.malformed.length > 0) {
      warn(`[dsh-logwiki] ${source.label} 的远端清单有 ${parsed.malformed.length} 行无法解析（已跳过）`)
    }
    const plan = R.planSync({
      index: parsed.entries,
      ledger: db.get().syncLedger?.[sourceId] ?? {},
      now: Date.now(),
      sinceDays: typeof source.sinceDays === 'number' && source.sinceDays > 0 ? source.sinceDays : cfg.sinceDays,
      maxFiles: cfg.maxFilesPerSync,
      maxBytes: cfg.maxBytesPerSync,
    })

    if (plan.fetch.length === 0) {
      mark({ lastSyncAt: Date.now(), lastSyncStatus: 'ok', lastError: null })
      pushProgress({ phase: 'idle', finished: true, current: '' })
      return {
        ok: true,
        label: source.label,
        indexCount: parsed.entries.length,
        fetched: 0,
        skippedUnchanged: plan.skippedUnchanged,
        skippedOld: plan.skippedOld,
      }
    }

    // 2) 逐个拉取（串行；从新到旧由 planSync 保证）
    const okRows = []
    let fetched = 0
    let failed = 0
    const total = plan.fetch.length
    for (const item of plan.fetch) {
      pushProgress({ phase: 'remote', done: fetched + failed, total, current: `${source.label}：拉取 ${fetched + failed + 1}/${total}`, finished: false })
      // base64 使体积膨胀约 4/3，再留 2 MB 余量。
      // **先预判再下载**：超出上限的文件直接跳过并说清原因，不白传一趟。
      const needed = Math.ceil(item.size * 1.4) + 2097152
      if (needed > cfg.maxBytesPerFile) {
        failed += 1
        warn(`[dsh-logwiki] ${source.label} 跳过超大文件 ${item.path}（${Math.round(item.size / 1048576)} MB，超过 maxBytesPerFile=${Math.round(cfg.maxBytesPerFile / 1048576)} MB）`)
        await yieldToLoop()
        continue
      }
      let got
      try {
        got = await runRemote(
          R.buildSshArgv({ alias: source.sshAlias, wslDistro: source.wslDistro, script: R.buildFetchCommand(item.path) }),
          { cwd: process.cwd(), timeoutMs: cfg.commandTimeoutMs, maxBytes: needed },
        )
      } catch (error) {
        got = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      if (got.ok !== true || got.lossy === true) {
        failed += 1
        warn(`[dsh-logwiki] ${source.label} 拉取失败（跳过）${item.path}：${got.lossy === true ? '输出被截断（maxBytes 太小）' : explainRemoteFailure(got, source.sshAlias, source.label)}`)
        await yieldToLoop()
        continue
      }
      try {
        const fp = R.remotePayloadToFingerprint(got.stdout, { extract: mods.extract, sourceId })
        if (fp === null) {
          failed += 1
          warn(`[dsh-logwiki] ${source.label} 的 ${item.path} 不是可识别的 v4 会话日志（跳过）`)
        } else {
          okRows.push({ item, fp })
          fetched += 1
        }
      } catch (error) {
        failed += 1
        warn(`[dsh-logwiki] ${source.label} 解码失败（跳过）${item.path}：${error instanceof Error ? error.message : String(error)}`)
      }
      // 逐文件让出事件循环：会话日志解码是纯计算，连续解多个会像回填那样把网页卡住。
      await yieldToLoop()
    }

    // 3) 落库（一次 update，避免 n 次全量落盘）
    if (okRows.length > 0) {
      db.update((draft) => {
        if (draft.sessions === undefined) draft.sessions = {}
        if (draft.syncLedger === undefined) draft.syncLedger = {}
        const ledger = draft.syncLedger[sourceId] ?? {}
        // 远端没有本地的工作区标题注册表，用远端 cwd 的末段做标签（与本地兜底口径一致）。
        const noTitles = new Map()
        for (const row of okRows) {
          const sessionId = row.fp.sessionId
          const fingerprint = mods.extract.sessionFingerprintOf(row.fp)
          const cwd = typeof row.fp.cwd === 'string' ? row.fp.cwd : ''
          draft.sessions[`${sourceId}::${sessionId}`] = {
            ...row.fp,
            sourceId,
            workspaceLabel: workspaceLabelOf(cwd, noTitles),
            fingerprint,
          }
          ledger[row.item.path] = { mtimeMs: row.item.mtimeMs, size: row.item.size }
        }
        draft.syncLedger[sourceId] = ledger
      })
    }

    mark({ lastSyncAt: Date.now(), lastSyncStatus: failed > 0 ? 'partial' : 'ok', lastError: null })
    pushProgress({ phase: 'idle', finished: true, current: '' })
    log(`[dsh-logwiki] 同步 ${source.label} 完成：拉取 ${fetched}，失败 ${failed}，未变化 ${plan.skippedUnchanged}`)
    return {
      ok: true,
      label: source.label,
      indexCount: parsed.entries.length,
      fetched,
      failed,
      skippedUnchanged: plan.skippedUnchanged,
      skippedOld: plan.skippedOld,
      skippedOverBudget: plan.skippedOverBudget,
    }
  }

  // ---------------------------------------------------------------- 路由
  const routes = new Map()

  routes.set('/ping', (req, res) => {
    sendJson(res, 200, {
      ok: true,
      plugin: name,
      version: VERSION,
      now: Date.now(),
      config: resolved,
      modules: Object.keys(mods).reduce((acc, k) => ({ ...acc, [k]: mods[k] !== null }), {}),
      modErrors,
    })
  })

  routes.set('/health', async (req, res) => {
    const db = store
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      scan,
      progress,
      services: { ...probeServices(ctx), workspaceRegistryInjected: workspaceRegistry !== null },
      modules: Object.keys(mods).reduce((acc, k) => ({ ...acc, [k]: mods[k] !== null }), {}),
      modErrors,
      tools: { registered: registeredTools, errors: toolErrors },
      store: db === null ? { ready: false } : { ready: true, writable: db.writable === true },
    })
  })

  routes.set('/state', async (req, res) => {
    if (!requireMods(res, ['fold', 'store'])) return
    const db = await ensureStore()
    if (db === null) {
      sendJson(res, 503, { ok: false, error: 'store 不可用' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const tz = tzOffsetMinutes()
    const today = mods.extract.dayKey(Date.now(), tz)
    const from = url.searchParams.get('from') ?? mods.extract.dayKey(Date.now() - 370 * 86400000, tz)
    const to = url.searchParams.get('to') ?? today
    const data = db.get()
    sendJson(
      res,
      200,
      mods.fold.buildState({
        sessions: data.sessions ?? {},
        days: data.days ?? {},
        entries: data.entries ?? {},
        sources: data.sources ?? {},
        from,
        to,
        metric: resolved.heatmap.metric,
        scan,
        degradedDays: Object.keys(data.dayState ?? {}).filter((d) => (data.dayState[d]?.status ?? 'ok') !== 'ok'),
      }),
    )
  })

  routes.set('/day', async (req, res) => {
    if (!requireMods(res, ['fold', 'store'])) return
    const db = await ensureStore()
    if (db === null) {
      sendJson(res, 503, { ok: false, error: 'store 不可用' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const date = url.searchParams.get('date') ?? mods.extract.dayKey(Date.now(), tzOffsetMinutes())
    const data = db.get()
    sendJson(
      res,
      200,
      mods.fold.buildDay({
        date,
        sessions: data.sessions ?? {},
        entries: data.entries ?? {},
        entryOrder: data.entryOrder ?? {},
        sources: data.sources ?? {},
      }),
    )
  })

  routes.set('/refresh', async (req, res) => {
    const blocked = guardMutation(req)
    if (blocked !== null) {
      sendJson(res, blocked.code, { ok: false, error: blocked.error })
      return
    }
    const result = await startRefresh()
    sendJson(res, 200, { ok: true, ...result })
  })

  routes.set('/events', (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    res.write(`event: progress\ndata: ${JSON.stringify(progress)}\n\n`)
    sseClients.add(res)
    const cleanup = () => sseClients.delete(res)
    req.on('close', cleanup)
    req.on('error', cleanup)
  })

  routes.set('/entry', async (req, res) => {
    const blocked = guardMutation(req)
    if (blocked !== null) {
      sendJson(res, blocked.code, { ok: false, error: blocked.error })
      return
    }
    if (!requireMods(res, ['store'])) return
    const db = await ensureStore()
    if (db === null) {
      sendJson(res, 503, { ok: false, error: 'store 不可用' })
      return
    }
    const body = await readJsonBody(req, 64 * 1024)
    if (body === null) {
      sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
      return
    }
    const id = typeof body.entryId === 'string' ? body.entryId : ''
    const current = db.get().entries?.[id]
    if (current === undefined) {
      sendJson(res, 404, { ok: false, error: `条目不存在：${id}` })
      return
    }
    let updated = null
    db.update((draft) => {
      const entry = draft.entries[id]
      if (typeof body.summary === 'string') entry.summary = body.summary.slice(0, 200)
      if (typeof body.tag === 'string') entry.tag = body.tag.slice(0, 24)
      entry.edited = true
      entry.origin = 'user'
      entry.updatedAt = Date.now()
      updated = { ...entry }
    })
    sendJson(res, 200, { ok: true, entry: updated })
  })

  routes.set('/entry/add', async (req, res) => {
    const blocked = guardMutation(req)
    if (blocked !== null) {
      sendJson(res, blocked.code, { ok: false, error: blocked.error })
      return
    }
    if (!requireMods(res, ['store', 'fold'])) return
    const db = await ensureStore()
    if (db === null) {
      sendJson(res, 503, { ok: false, error: 'store 不可用' })
      return
    }
    const body = await readJsonBody(req, 64 * 1024)
    if (body === null) {
      sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
      return
    }
    const tz = tzOffsetMinutes()
    const date = typeof body.date === 'string' && body.date !== '' ? body.date : mods.extract.dayKey(Date.now(), tz)
    const summary = typeof body.summary === 'string' ? body.summary.slice(0, 200) : ''
    if (summary === '') {
      sendJson(res, 400, { ok: false, error: 'summary 不能为空' })
      return
    }
    const sourceId = typeof body.sourceId === 'string' && body.sourceId !== '' ? body.sourceId : 'local'
    const workspacePath = typeof body.workspacePath === 'string' ? body.workspacePath : ''
    const id = `e_${date}_${sourceId}_manual_${Date.now().toString(36)}`
    const now = Date.now()
    db.update((draft) => {
      if (draft.entries === undefined) draft.entries = {}
      if (draft.entryOrder === undefined) draft.entryOrder = {}
      draft.entries[id] = {
        id,
        sourceId,
        date,
        workspacePath,
        workspaceLabel: workspacePath !== '' ? workspacePath : '(手动)',
        startTime: now,
        endTime: now,
        summary,
        tag: typeof body.tag === 'string' ? body.tag.slice(0, 24) : '',
        sessionRefs: [],
        origin: 'user',
        edited: true,
        createdAt: now,
        updatedAt: now,
      }
      draft.entryOrder[date] = [...(draft.entryOrder[date] ?? []), id].sort((a, b) => {
        const ea = draft.entries[a]
        const eb = draft.entries[b]
        return (ea?.startTime ?? 0) - (eb?.startTime ?? 0)
      })
    })
    sendJson(res, 200, { ok: true, entry: db.get().entries[id] })
  })

  routes.set('/entry/delete', async (req, res) => {
    const blocked = guardMutation(req)
    if (blocked !== null) {
      sendJson(res, blocked.code, { ok: false, error: blocked.error })
      return
    }
    if (!requireMods(res, ['store'])) return
    const db = await ensureStore()
    if (db === null) {
      sendJson(res, 503, { ok: false, error: 'store 不可用' })
      return
    }
    const body = await readJsonBody(req, 64 * 1024)
    if (body === null || typeof body.entryId !== 'string') {
      sendJson(res, 400, { ok: false, error: '缺少 entryId' })
      return
    }
    const id = body.entryId
    db.update((draft) => {
      const entry = draft.entries?.[id]
      if (entry !== undefined) {
        delete draft.entries[id]
        const order = draft.entryOrder?.[entry.date]
        if (Array.isArray(order)) draft.entryOrder[entry.date] = order.filter((x) => x !== id)
      }
    })
    sendJson(res, 200, { ok: true })
  })

  routes.set('/digests', async (req, res) => {
    if (!requireMods(res, ['store'])) return
    const db = await ensureStore()
    if (db === null) {
      sendJson(res, 503, { ok: false, error: 'store 不可用' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const kind = url.searchParams.get('kind') ?? 'week'
    const period = url.searchParams.get('period') ?? ''
    const digest = db.get().digests?.[`${kind}:${period}`] ?? null
    sendJson(res, 200, { ok: true, digest })
  })

  routes.set('/digests/available', async (req, res) => {
    if (!requireMods(res, ['store'])) return
    const db = await ensureStore()
    if (db === null) {
      sendJson(res, 503, { ok: false, error: 'store 不可用' })
      return
    }
    const digests = db.get().digests ?? {}
    const weeks = []
    const months = []
    for (const k of Object.keys(digests)) {
      if (k.startsWith('week:')) weeks.push(k.slice(5))
      else if (k.startsWith('month:')) months.push(k.slice(6))
    }
    weeks.sort()
    months.sort()
    sendJson(res, 200, { ok: true, weeks, months })
  })

  /**
   * 列出**有活动的周期**（不只是已有简报的周期），并带上条数与缓存状态。
   *
   * 为什么需要它：`/digests/available` 只能告诉你"哪些周期已经生成过简报"，
   * 客户端据此无法做周期导航——用户看着 9 月某天，却不知道该往前/往后跳到哪个有数据的周。
   * 本端点让 UI 能：① 在**有活动的周期之间**前后跳；② 提示"这个周期有 N 条条目、尚未生成"。
   */
  routes.set('/digests/periods', async (req, res) => {
    if (!requireMods(res, ['store'])) return
    const db = await ensureStore()
    if (db === null) {
      sendJson(res, 503, { ok: false, error: 'store 不可用' })
      return
    }
    const days = db.get().days ?? {}
    const entriesMap = db.get().entries ?? {}
    const digests = db.get().digests ?? {}

    // ⚠️ 条目数必须从这里数：`days`（buildDays 产出）只有 turns/sessions/tokens，
    // **没有 entries** —— 热力图里的条目数是 buildState 在读取时拿 entries map 现算的。
    // 首版我读了 `days[date].work.entries`，结果所有周期都显示 0 条。
    const entriesByDate = new Map()
    for (const e of Object.values(entriesMap)) {
      const d = e !== null && typeof e === 'object' ? e.date : null
      if (typeof d === 'string' && d !== '') entriesByDate.set(d, (entriesByDate.get(d) ?? 0) + 1)
    }

    const weekMap = new Map()
    const monthMap = new Map()
    const allDates = new Set([...Object.keys(days), ...entriesByDate.keys()])
    for (const date of allDates) {
      const day = days[date]
      const work = day !== null && typeof day === 'object' ? day.work : null
      const turns = Number(work?.turns ?? 0)
      const entries = entriesByDate.get(date) ?? 0
      if (entries === 0 && turns === 0) continue
      const buckets = []
      const wk = isoWeekKeyOf(date)
      if (wk !== null) buckets.push([weekMap, wk])
      buckets.push([monthMap, String(date).slice(0, 7)])
      for (const [map, period] of buckets) {
        let cur = map.get(period)
        if (cur === undefined) {
          cur = { period, days: 0, entries: 0, turns: 0 }
          map.set(period, cur)
        }
        cur.days += 1
        cur.entries += entries
        cur.turns += turns
      }
    }

    const decorate = (map, kind) =>
      [...map.values()]
        .sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0)) // 新 → 旧
        .map((p) => {
          const range = periodRange(kind, p.period)
          return {
            period: p.period,
            from: range === null ? null : range.from,
            to: range === null ? null : range.to,
            days: p.days,
            entries: p.entries,
            turns: p.turns,
            hasDigest: digests[`${kind}:${p.period}`] !== undefined,
          }
        })

    sendJson(res, 200, { ok: true, weeks: decorate(weekMap, 'week'), months: decorate(monthMap, 'month') })
  })

  routes.set('/digest/generate', async (req, res) => {
    const blocked = guardMutation(req)
    if (blocked !== null) {
      sendJson(res, blocked.code, { ok: false, error: blocked.error })
      return
    }
    if (!requireMods(res, ['store', 'fold', 'summarize'])) return
    const db = await ensureStore()
    if (db === null) {
      sendJson(res, 503, { ok: false, error: 'store 不可用' })
      return
    }
    const body = await readJsonBody(req, 64 * 1024)
    if (body === null) {
      sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
      return
    }
    const kind = body.kind === 'month' ? 'month' : 'week'
    const period = typeof body.period === 'string' ? body.period : ''
    if (period === '') {
      sendJson(res, 400, { ok: false, error: '缺少 period' })
      return
    }
    const range = periodRange(kind, period)
    if (range === null) {
      sendJson(res, 400, { ok: false, error: `无法解析周期：${kind}:${period}` })
      return
    }
    const summarizer = createSummarizer()
    if (summarizer === null) {
      sendJson(res, 503, { ok: false, error: '摘要器不可用' })
      return
    }
    const data = db.get()
    const entries = Object.values(data.entries ?? {}).filter(
      (e) => typeof e.date === 'string' && e.date >= range.from && e.date <= range.to,
    )
    try {
      pushProgress({ phase: 'digest', done: 0, total: 1, current: `${kind}:${period}`, finished: false })
      const digest = await summarizer.generateDigest({
        kind,
        period,
        rangeStart: range.from,
        rangeEnd: range.to,
        entries,
        sources: Object.values(data.sources ?? {}),
      })
      const record = {
        kind,
        period,
        rangeStart: range.from,
        rangeEnd: range.to,
        title: digest.title ?? `${period} 简报`,
        headline: digest.headline ?? '',
        items: Array.isArray(digest.items) ? digest.items : [],
        origin: 'llm',
        model: digest.model,
        sourceIds: Object.keys(data.sources ?? {}).length > 0 ? Object.keys(data.sources) : ['local'],
        generatedAt: Date.now(),
        edited: false,
      }
      db.update((draft) => {
        if (draft.digests === undefined) draft.digests = {}
        draft.digests[`${kind}:${period}`] = record
      })
      pushProgress({ phase: 'idle', finished: true, done: 1, current: '' })
      sendJson(res, 200, { ok: true, digest: record })
    } catch (error) {
      pushProgress({ phase: 'idle', finished: true, current: '' })
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  routes.set('/digest/agent-prompt', async (req, res) => {
    const blocked = guardMutation(req)
    if (blocked !== null) {
      sendJson(res, blocked.code, { ok: false, error: blocked.error })
      return
    }
    if (!requireMods(res, ['store', 'fold', 'summarize'])) return
    const db = await ensureStore()
    if (db === null) {
      sendJson(res, 503, { ok: false, error: 'store 不可用' })
      return
    }
    const body = await readJsonBody(req, 64 * 1024)
    if (body === null) {
      sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
      return
    }
    const kind = body.kind === 'month' ? 'month' : 'week'
    const period = typeof body.period === 'string' ? body.period : ''
    const range = period === '' ? null : periodRange(kind, period)
    if (range === null) {
      sendJson(res, 400, { ok: false, error: `无法解析周期：${kind}:${period}` })
      return
    }
    const summarizer = createSummarizer()
    if (summarizer === null) {
      sendJson(res, 503, { ok: false, error: '摘要器不可用' })
      return
    }
    const data = db.get()
    const entries = Object.values(data.entries ?? {}).filter(
      (e) => typeof e.date === 'string' && e.date >= range.from && e.date <= range.to,
    )
    try {
      const prompt = await summarizer.buildAgentPrompt({
        kind,
        period,
        rangeStart: range.from,
        rangeEnd: range.to,
        entries,
        sources: Object.values(data.sources ?? {}),
      })
      sendJson(res, 200, { ok: true, prompt })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  /**
   * 真机模型自检：会**真实发起一次极小的 LLM 调用**（消耗少量 token），
   * 所以做成 POST + 守卫，必须显式触发。
   */
  routes.set('/summarize/probe', async (req, res) => {
    const blocked = guardMutation(req)
    if (blocked !== null) {
      sendJson(res, blocked.code, { ok: false, error: blocked.error })
      return
    }
    const summarizer = createSummarizer()
    if (summarizer === null) {
      sendJson(res, 503, { ok: false, error: '摘要器不可用（summarize 模块未就绪）' })
      return
    }
    if (typeof summarizer.probe !== 'function') {
      sendJson(res, 501, { ok: false, error: 'summarizer.probe 未实现' })
      return
    }
    try {
      const result = await summarizer.probe()
      sendJson(res, 200, { ok: result?.ok === true, ...(result ?? {}) })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  routes.set('/sources', async (req, res) => {
    if (!requireMods(res, ['store'])) return
    const db = await ensureStore()
    if (db === null) {
      sendJson(res, 503, { ok: false, error: 'store 不可用' })
      return
    }
    const data = db.get()
    const sources = data.sources ?? {}
    const sessions = data.sessions ?? {}
    const entries = data.entries ?? {}
    const sessionKeys = Object.keys(sessions)
    const entryRows = Object.values(entries).filter((e) => e !== null && typeof e === 'object')
    // 附上每个来源的体量，供 UI 显示"这个来源有多少内容"并决定是否值得同步。
    const rows = Object.values(sources).map((s) => {
      const prefix = `${s.id}::`
      return {
        ...s,
        sessionCount: sessionKeys.filter((k) => k.startsWith(prefix)).length,
        entryCount: entryRows.filter((e) => e.sourceId === s.id).length,
      }
    })
    sendJson(res, 200, { ok: true, sources: rows, remoteEnabled: resolved.remote.enable === true })
  })

  /**
   * 探测本机 WSL 环境：是否可用、默认发行版、`~/.ssh/config` 里有哪些别名。
   * 只在「添加来源」对话框打开时调一次（会 spawn 一次 wsl.exe，不该被高频端点顺带调用）。
   */
  routes.set('/source/discover', async (req, res) => {
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined || typeof subprocess.spawn !== 'function') {
      sendJson(res, 200, { ok: true, available: false, aliases: [], error: 'subprocess 服务不可用' })
      return
    }
    const script = [
      "f=$HOME/.ssh/config",
      '[ -f "$f" ] || exit 0',
      "grep -hiE '^[[:space:]]*Host[[:space:]]' \"$f\" | sed -E 's/^[[:space:]]*[Hh]ost[[:space:]]+//' | tr ' ' '\\n' | grep -vE '^[*?!]' | grep -v '^$' | sort -u",
    ].join('\n')
    const argv = wslScriptArgv(script)
    const got = await runRemote(argv, { cwd: process.cwd(), timeoutMs: 20000, maxBytes: 256 * 1024 })
    if (got.ok !== true) {
      sendJson(res, 200, {
        ok: true,
        available: false,
        aliases: [],
        error: explainRemoteFailure(got, '<wsl>', 'WSL'),
      })
      return
    }
    const aliases = String(got.stdout ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => /^[A-Za-z0-9._-]{1,128}$/.test(s))
    sendJson(res, 200, { ok: true, available: true, aliases })
  })

  routes.set('/source/add', async (req, res) => {
    const blocked = guardMutation(req)
    if (blocked !== null) {
      sendJson(res, blocked.code, { ok: false, error: blocked.error })
      return
    }
    if (!requireMods(res, ['store', 'remoteSources'])) return
    const body = await readJsonBody(req, 64 * 1024)
    if (body === null) {
      sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
      return
    }
    let source
    try {
      source = mods.remoteSources.normalizeRemoteSource({
        label: body.label,
        sshAlias: body.sshAlias,
        dshHome: body.dshHome,
        wslDistro: typeof body.wslDistro === 'string' && body.wslDistro !== '' ? body.wslDistro : undefined,
        sinceDays: typeof body.sinceDays === 'number' ? body.sinceDays : undefined,
      })
    } catch (error) {
      // 校验失败是**用户输入问题**，回 400 并带上原因（而不是 500）。
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    try {
      await upsertSource(source)
    } catch (error) {
      sendJson(res, 503, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    sendJson(res, 200, { ok: true, source })
  })

  routes.set('/source/delete', async (req, res) => {
    const blocked = guardMutation(req)
    if (blocked !== null) {
      sendJson(res, blocked.code, { ok: false, error: blocked.error })
      return
    }
    if (!requireMods(res, ['store', 'fold'])) return
    const body = await readJsonBody(req, 64 * 1024)
    if (body === null) {
      sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
      return
    }
    const sourceId = typeof body.sourceId === 'string' ? body.sourceId : ''
    if (sourceId === 'local') {
      sendJson(res, 400, { ok: false, error: '本机来源不能删除' })
      return
    }
    const db = await ensureStore()
    if (db === null) {
      sendJson(res, 503, { ok: false, error: 'store 不可用' })
      return
    }
    if (db.get().sources?.[sourceId] === undefined) {
      sendJson(res, 404, { ok: false, error: `来源不存在：${sourceId}` })
      return
    }

    // 一并清掉这个来源的会话、条目、同步账本 —— 否则源没了、数据还在，
    // 会留下一批"来源已删除"的孤儿条目，界面按来源分区时无从归属。
    const prefix = `${sourceId}::`
    let removedSessions = 0
    let removedEntries = 0
    db.update((draft) => {
      if (draft.sessions !== undefined) {
        for (const key of Object.keys(draft.sessions)) {
          if (key.startsWith(prefix)) {
            delete draft.sessions[key]
            removedSessions += 1
          }
        }
      }
      if (draft.entries !== undefined) {
        for (const [id, entry] of Object.entries(draft.entries)) {
          if (entry !== null && typeof entry === 'object' && entry.sourceId === sourceId) {
            delete draft.entries[id]
            removedEntries += 1
          }
        }
      }
      if (draft.entryOrder !== undefined) {
        for (const date of Object.keys(draft.entryOrder)) {
          draft.entryOrder[date] = draft.entryOrder[date].filter((id) => draft.entries[id] !== undefined)
        }
      }
      if (draft.syncLedger !== undefined) delete draft.syncLedger[sourceId]
      if (draft.sources !== undefined) delete draft.sources[sourceId]
    })

    // 立刻重算天聚合，别让界面停留在一个已不存在的来源上
    const after = db.get()
    const days = mods.fold.buildDays(after.sessions ?? {}, {
      includeSubagents: resolved.heatmap.includeSubagents !== false,
      tzOffsetMinutes: tzOffsetMinutes(),
    })
    db.update((draft) => {
      draft.days = days
      draft.updatedAt = Date.now()
    })
    log(`[dsh-logwiki] 已删除来源 ${sourceId}：会话 ${removedSessions}，条目 ${removedEntries}`)
    sendJson(res, 200, { ok: true, sourceId, removedSessions, removedEntries })
  })

  routes.set('/source/prompt', async (req, res) => {
    const blocked = guardMutation(req)
    if (blocked !== null) {
      sendJson(res, blocked.code, { ok: false, error: blocked.error })
      return
    }
    if (!requireMods(res, ['remoteSources'])) return
    const body = await readJsonBody(req, 64 * 1024)
    if (body === null) {
      sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
      return
    }
    const prompt = mods.remoteSources.buildAddSourcePrompt({
      label: typeof body.label === 'string' ? body.label : '',
      sshAlias: typeof body.sshAlias === 'string' ? body.sshAlias : '',
      dshHome: typeof body.dshHome === 'string' ? body.dshHome : '',
      wslDistro: typeof body.wslDistro === 'string' ? body.wslDistro : '',
      sinceDays: typeof body.sinceDays === 'number' ? body.sinceDays : undefined,
      toolName: 'logwiki_import_source',
    })
    sendJson(res, 200, { ok: true, prompt })
  })

  routes.set('/source/sync', async (req, res) => {
    const blocked = guardMutation(req)
    if (blocked !== null) {
      sendJson(res, blocked.code, { ok: false, error: blocked.error })
      return
    }
    if (!requireMods(res, ['store', 'extract', 'fold', 'remote', 'remoteSources'])) return
    const body = await readJsonBody(req, 64 * 1024)
    if (body === null) {
      sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
      return
    }
    const sourceId = typeof body.sourceId === 'string' ? body.sourceId : ''
    if (sourceId === '') {
      sendJson(res, 400, { ok: false, error: '缺少 sourceId' })
      return
    }
    if (remoteRunning !== null) {
      sendJson(res, 409, { ok: false, error: `已有来源正在同步：${remoteRunning}`, running: remoteRunning })
      return
    }
    remoteRunning = sourceId
    // 异步跑：一次同步可能几分钟（远端慢 + 本地解码），不能让 HTTP 请求挂着。
    // 客户端用既有 SSE 进度条观察，完成后拉 /sources 看状态。
    syncSource(sourceId)
      .catch((error) => warn(`[dsh-logwiki] 同步 ${sourceId} 异常：${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        remoteRunning = null
      })
    sendJson(res, 200, { ok: true, running: sourceId, message: `已开始同步，请观察进度条` })
  })

  routes.set('/source/sync-status', (req, res) => {
    sendJson(res, 200, { ok: true, running: remoteRunning })
  })

  // ---------------------------------------------------------------- 分发
  const handler = async (req, res) => {
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      sendJson(res, 400, { ok: false, error: '无法解析请求路径' })
      return
    }
    let end = pathname.slice(PREFIX.length)
    if (end === '') end = '/'

    const route = routes.get(end)
    if (route === undefined) {
      sendJson(res, 404, { ok: false, error: `未知端点 ${end}` })
      return
    }
    try {
      await route(req, res)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warn(`[dsh-logwiki] 端点 ${end} 处理失败: ${message}`)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: message })
    }
  }

  ctx.effect(() => webServer.register({ kind: 'prefix', path: PREFIX, handler }))

  ctx.effect(() => () => {
    for (const res of sseClients) {
      try {
        res.end()
      } catch {
        // 忽略
      }
    }
    sseClients.clear()
    if (store !== null && typeof store.close === 'function') void store.close()
    store = null
  })

  // 异步装载兄弟模块 + 预初始化存储；不阻塞 boot。
  void (async () => {
    await loadModules()
    await ensureStore()
    registerTools()
    log(
      `[dsh-logwiki] v${VERSION} 已挂载：${PREFIX}｜模块 ` +
        Object.keys(mods).map((k) => `${k}:${mods[k] === null ? '✗' : '✓'}`).join(' ') +
        `｜工具 ${registeredTools.length > 0 ? registeredTools.join(',') : '无'}` +
        `｜scan.sinceDays=${resolved.scan.sinceDays} summarize=${resolved.summarize.provider}/${resolved.summarize.model}`,
    )
  })()
}

export { name, inject, VERSION, PREFIX, MUTATION_HEADER, periodRange, tzOffsetMinutes }
export default { name, inject, apply }
