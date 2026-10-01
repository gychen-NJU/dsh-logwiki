/**
 * vendor-dsh.js —— **本插件唯一允许 import `@deepseek-ai/*` 的文件**。
 *
 * 背景（已实测，2026-10-01，Node v24.16.0）：
 *   插件目录位于任何 node_modules 解析链之外，裸写 `import '@deepseek-ai/dsh-llm'`
 *   必然 ERR_MODULE_NOT_FOUND。所以这里用 `node:module` 的 `createRequire(filename)`
 *   把解析根钉到 **派生出来的** DSH 安装目录，先 resolve 出真实文件路径，
 *   再 `import(pathToFileURL(...))` 动态加载。
 *
 * 解析根**不写死**（见 lib/paths.js `vendorRoots()`）：本仓库是公开的，
 * 写死 `C:/Users/<某人>/...` 既泄漏私有信息、换台机器也直接失效。
 * 覆盖 npm 全局安装、profile 自带依赖、桌面端 Electron 运行时（app.asar）三种形态；
 * 需要非标准布局时用环境变量 `DSH_LOGWIKI_VENDOR_ROOTS`（`path.delimiter` 分隔）显式覆盖。
 *
 * 降级契约（硬要求）：
 *   **解析失败绝不允许打崩 boot**。本模块顶层只 import `node:` 内置模块，
 *   所有第三方加载都发生在 `loadVendor()` 内部的 try/catch 里；
 *   全部失败时 `loadVendor()` 返回 `null`，由 summarize.js 转成 `{ok:false, error}`。
 *   `summarize.js` 在拿到 null 时抛带 `LOGWIKI_VENDOR_UNAVAILABLE` 码的错误，
 *   由集成方按 OVERVIEW §6 降级 seed。
 *
 * 双实例说明：插件自己 import 的一份 dsh-llm 与宿主内部的实例可能是两份模块对象。
 *   这里用到的三样东西都是「结构等价」的，不跨界做 instanceof 判断：
 *     · createUserMessage 产出的消息对象 —— 纯数据，宿主按字段读取；
 *     · deadline 产出的 { signal, [Symbol.dispose] } —— 纯数据；
 *     · BlockAssembler —— 只在本模块内部使用，生命周期不跨出调用。
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { vendorRoots } from './paths.js'

/**
 * 解析根，按优先级排列，**全部派生**（见 lib/paths.js）。
 * 只保留真实存在的目录；顺序在进程内固定（首次 import 时求值一次）。
 */
export const REQUIRE_ROOTS = Object.freeze(vendorRoots())

/** 需要转出的东西。 */
const SPEC = Object.freeze({
  llm: '@deepseek-ai/dsh-llm',
  timeout: '@deepseek-ai/dsh-timeout',
})

/** 成功后的缓存（Promise，保证并发只加载一次）。 */
let pending = null
/** 最近一次加载的诊断信息（成功或失败都有），供 probe()/日志使用。 */
let diagnostics = { ok: false, loadedFrom: null, paths: {}, attempts: [], error: 'not-loaded' }

/**
 * 转出物形状：
 *   { BlockAssembler, createUserMessage, deadline, loadedFrom, paths }
 */
let loaded = null

/** 供诊断/自检读取的最近一次加载状态（同步、绝不抛）。 */
export function vendorStatus() {
  return {
    ok: diagnostics.ok,
    loadedFrom: diagnostics.loadedFrom,
    paths: { ...diagnostics.paths },
    attempts: diagnostics.attempts.map((a) => ({ ...a })),
    error: diagnostics.error,
  }
}

/** 同步取已加载的转出物；未加载或失败时返回 null。 */
export function vendorSync() {
  return loaded
}

/**
 * 加载并转出 DSH 内部模块。**绝不抛**：失败返回 null。
 * 并发调用共享同一个 Promise。
 * @returns {Promise<null | { BlockAssembler: Function, createUserMessage: Function, deadline: Function, loadedFrom: string, paths: object }>}
 */
export function loadVendor() {
  if (pending === null) pending = doLoad()
  return pending
}

async function doLoad() {
  const attempts = []
  const paths = {}
  let lastError = 'unknown'

  for (const root of REQUIRE_ROOTS) {
    if (typeof root !== 'string' || root === '' || !existsSync(root)) {
      attempts.push({ root, ok: false, error: 'root-missing' })
      continue
    }

    let require = null
    try {
      // createRequire 需要一个「文件路径」；用根目录下的虚拟文件即可。
      require = createRequire(join(root, '__dsh_logwiki_resolve__.js'))
    } catch (error) {
      attempts.push({ root, ok: false, error: `createRequire: ${message(error)}` })
      lastError = message(error)
      continue
    }

    const resolved = {}
    let resolveFailed = null
    for (const [key, spec] of Object.entries(SPEC)) {
      try {
        resolved[key] = require.resolve(spec)
      } catch (error) {
        resolveFailed = `${spec}: ${message(error)}`
        break
      }
    }
    if (resolveFailed !== null) {
      attempts.push({ root, ok: false, error: `resolve: ${resolveFailed}` })
      lastError = resolveFailed
      continue
    }

    let llm = null
    let timeoutMod = null
    try {
      llm = await import(pathToFileURL(resolved.llm).href)
      timeoutMod = await import(pathToFileURL(resolved.timeout).href)
    } catch (error) {
      attempts.push({ root, ok: false, error: `import: ${message(error)}` })
      lastError = message(error)
      continue
    }

    // 形状校验：少任何一个都视为该根不可用（例如 DSH 版本差异）。
    const missing = []
    if (typeof llm?.BlockAssembler !== 'function') missing.push('BlockAssembler')
    if (typeof llm?.createUserMessage !== 'function') missing.push('createUserMessage')
    if (typeof timeoutMod?.deadline !== 'function') missing.push('deadline')
    if (missing.length > 0) {
      const err = `missing exports: ${missing.join(', ')}`
      attempts.push({ root, ok: false, error: err })
      lastError = err
      continue
    }

    paths.llm = resolved.llm
    paths.timeout = resolved.timeout
    attempts.push({ root, ok: true, error: null })
    loaded = {
      BlockAssembler: llm.BlockAssembler,
      createUserMessage: llm.createUserMessage,
      deadline: timeoutMod.deadline,
      loadedFrom: root,
      paths: { ...paths },
    }
    diagnostics = { ok: true, loadedFrom: root, paths: { ...paths }, attempts, error: null }
    return loaded
  }

  loaded = null
  diagnostics = { ok: false, loadedFrom: null, paths: {}, attempts, error: lastError }
  return null
}

function message(error) {
  if (error instanceof Error) return `${error.code ?? error.name}: ${error.message}`
  return String(error)
}
