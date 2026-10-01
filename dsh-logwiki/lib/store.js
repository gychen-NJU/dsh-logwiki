/**
 * dsh-logwiki · 存储层（**唯一接触 ctx 的模块**）
 *
 * 职责：`ctx.storage` KV unit `dsh_logwiki` 的落盘、200ms 防抖、promise 链写串行化、内存降级。
 *
 * 契约（docs/OVERVIEW.md §3 `lib/store.js`）：
 *   createStore(ctx) → { ready, get(), update(mutator), flush(), writable, close() }
 *   storage 不可用 → 纯内存 + writable=false，**不抛**。
 *
 * 只用已验证的 storage API（同 dsh-usage-stats）：
 *   ctx.get('storage') → storage.backend.get('json') → backend.kv.open({...})
 *   → unit.loadAll() / unit.setGlobal(obj) / unit.close()
 *   其它方法一律不碰（未经验证）。
 */

/** 落盘防抖窗口（ms）。 */
const WRITE_DEBOUNCE_MS = 200
/** KV unit 标识（契约 §1）。 */
const UNIT_NAME = 'dsh_logwiki'
const UNIT_VERSION = 1
/** 当前数据结构版本（写入 schemaVersion）。 */
const SCHEMA_VERSION = 1

const ARRAY_FIELDS = []
const OBJECT_FIELDS = [
  'sources',
  'sessions',
  'days',
  'entries',
  'entryOrder',
  'dayState',
  'digests',
  'syncLedger',
]

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 确定性的全量空 store（契约 §1 的数据模型）。 */
export function createEmptyStore() {
  const store = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: 0,
  }
  for (const key of OBJECT_FIELDS) store[key] = {}
  // 本机来源必须天然存在（契约 §1 sources.local）
  store.sources = {
    local: { id: 'local', kind: 'local', label: '本机', enabled: true, addedAt: 0 },
  }
  for (const key of ARRAY_FIELDS) store[key] = []
  return store
}

/**
 * 把磁盘上读到的对象规整成完整形状：补齐缺失的顶层键，丢弃形状不对的键。
 * 深层对象**不深合并**——磁盘版本就是权威，避免把用户删掉的条目复活。
 */
function normalizeStore(raw) {
  const base = createEmptyStore()
  if (!isObj(raw)) return base
  for (const key of Object.keys(base)) {
    const value = raw[key]
    if (key === 'schemaVersion') {
      base.schemaVersion = typeof value === 'number' && Number.isFinite(value) ? value : SCHEMA_VERSION
      continue
    }
    if (key === 'updatedAt') {
      base.updatedAt = typeof value === 'number' && Number.isFinite(value) ? value : 0
      continue
    }
    if (isObj(value)) base[key] = value
  }
  if (!isObj(base.sources) || Object.keys(base.sources).length === 0) {
    base.sources = createEmptyStore().sources
  }
  return base
}

/** 落盘用的纯 JSON 快照（切断内存对象与 KV 层的引用）。 */
function snapshotOf(store) {
  const out = {}
  for (const key of Object.keys(store)) out[key] = store[key]
  out.schemaVersion = SCHEMA_VERSION
  out.updatedAt = Date.now()
  return JSON.parse(JSON.stringify(out))
}

/**
 * @param {object} ctx Cordis 上下文（只用 `ctx.get('storage')` 与 `ctx.logger`）
 * @returns {{ready: Promise<void>, get(): object, update(mutator: Function): void,
 *            flush(): Promise<void>, writable: boolean, close(): Promise<void>,
 *            loaded: boolean, error: string|null}}
 */
export function createStore(ctx) {
  const store = createEmptyStore()
  const logger = isObj(ctx) && isObj(ctx.logger) ? ctx.logger : undefined

  let unit = null
  let writable = false
  let loaded = false
  let closed = false
  /** storage 初始化失败的原因（诊断用）。 */
  let initError = null

  /** 写串行化：所有落盘排在同一条 promise 链上。 */
  let chain = Promise.resolve()
  /** 待落盘的防抖定时器。 */
  let timer = null
  /** 是否有已改内存但尚未落盘的改动。 */
  let dirty = false
  /** 等待「当前这批改动落盘完成」的 resolver。 */
  let waiters = []

  const warn = (message) => {
    try {
      logger?.warn?.(`[dsh-logwiki] ${message}`)
    } catch {
      /* 日志不可用不该影响数据路径 */
    }
  }

  // ---- 首次加载 ----
  const ready = (async () => {
    if (!isObj(ctx) || typeof ctx.get !== 'function') {
      initError = 'no-ctx'
      warn('store: ctx 不可用，降级为纯内存（只读运行）')
      return
    }
    let storage
    try {
      storage = ctx.get('storage')
    } catch (error) {
      initError = message(error)
      warn(`store: ctx.get('storage') 失败，降级为纯内存：${initError}`)
      return
    }
    if (storage === undefined || storage === null) {
      initError = 'storage-unavailable'
      warn('store: storage 服务不可用，降级为纯内存（writable=false）')
      return
    }
    try {
      const backend = typeof storage.backend?.get === 'function' ? storage.backend.get('json') : undefined
      if (backend === undefined || backend === null || isObj(backend.kv) === false) {
        initError = 'json-backend-unavailable'
        warn('store: storage json 后端不可用，降级为纯内存（writable=false）')
        return
      }
      const opened = await backend.kv.open({
        name: UNIT_NAME,
        version: UNIT_VERSION,
        tables: [],
        hasGlobal: true,
      })
      if (opened === undefined || opened === null) {
        initError = 'unit-open-returned-null'
        warn('store: KV unit 打开失败，降级为纯内存（writable=false）')
        return
      }
      unit = opened
      const snapshot = await opened.loadAll()
      const global = isObj(snapshot) ? snapshot.global : undefined
      const restored = normalizeStore(global)
      for (const key of Object.keys(restored)) store[key] = restored[key]
      writable = true
      loaded = true
      const sessionCount = isObj(store.sessions) ? Object.keys(store.sessions).length : 0
      logger?.info?.(`[dsh-logwiki] store 已加载：${sessionCount} 条会话记录，writable=true`)
    } catch (error) {
      initError = message(error)
      unit = null
      writable = false
      warn(`store: KV 初始化失败，降级为纯内存（writable=false）：${initError}`)
    }
  })()

  function message(error) {
    return error instanceof Error ? error.message : String(error)
  }

  /** 把内存状态真正写进 KV。 */
  async function persist() {
    if (closed || unit === null) return
    const snapshot = snapshotOf(store)
    try {
      await unit.setGlobal(snapshot)
      // 落盘后同步 updatedAt，避免内存与磁盘长期不一致
      store.updatedAt = snapshot.updatedAt
    } catch (error) {
      writable = false
      warn(`store: 落盘失败，已切为只读（writable=false）：${message(error)}`)
    }
  }

  /** 排一次落盘到串行链，返回该次落盘完成的 promise。 */
  function enqueueWrite() {
    const next = chain.then(() => persist(), () => persist())
    chain = next.catch(() => undefined)
    return next
  }

  function settleWaiters() {
    const pending = waiters
    waiters = []
    for (const resolve of pending) resolve()
  }

  /** 立即落盘：取消防抖，排一次写，串行链跑完后再把所有等待者放行。 */
  function flush() {
    if (closed) return Promise.resolve()
    if (timer !== null) {
      // 有防抖中的改动：取消定时器，立刻排一次写
      clearTimeout(timer)
      timer = null
      enqueueWrite()
    } else if (dirty) {
      // 改动还在内存里、尚未排队（极短窗口）：补一次写
      enqueueWrite()
    }
    dirty = false
    if (unit === null) return Promise.resolve()
    return new Promise((resolve) => {
      waiters.push(resolve)
      chain.then(() => settleWaiters(), () => settleWaiters())
    })
  }

  /**
   * 同步改内存 + 排队落盘（200ms 防抖）。
   * @param {(draft: object) => void} mutator 直接改 draft（就是内存对象本身）
   */
  function update(mutator) {
    if (typeof mutator !== 'function') return
    mutator(store)
    store.updatedAt = Date.now()
    dirty = true
    if (closed || unit === null) return // 只读/内存模式：不排队，也不报错
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      dirty = false
      enqueueWrite()
    }, WRITE_DEBOUNCE_MS)
    // 定时器不该吊住进程
    if (typeof timer.unref === 'function') timer.unref()
  }

  /**
   * 内存对象（**活引用**：与 update 的 draft 是同一个对象）。
   * 契约「勿直接改写深层对象」——只读消费，改写一律走 update()。
   */
  function get() {
    return store
  }

  async function close() {
    if (closed) return
    await flush()
    closed = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    const current = unit
    unit = null
    if (current !== null) {
      try {
        await current.close()
      } catch (error) {
        warn(`store: KV 关闭失败：${message(error)}`)
      }
    }
  }

  return {
    ready,
    get,
    update,
    flush,
    get writable() {
      return writable
    },
    close,
    get loaded() {
      return loaded
    },
    get error() {
      return initError
    },
  }
}
