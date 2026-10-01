/**
 * dsh-logwiki · 本机路径派生
 *
 * 为什么单独一个文件：本插件是**零构建 ESM + 绝对路径直挂**（不进任何 node_modules，
 * 也没有 package.json 依赖解析），同时又是一个**公开仓库** —— 所以任何
 * `C:/Users/<某人>/...` 这类字面量都是两重错误：既泄漏私有信息，换台机器也直接失效。
 *
 * 纪律：本文件是**唯一**允许触碰"家目录 / DSH 主目录 / npm 全局前缀"的地方，
 * 而且必须是**派生**而不是写死。派生优先级：
 *   显式环境变量 → $DSH_HOME → 各平台惯例目录
 *
 * 只 import node: 内置模块。
 */

import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'

/** DSH 主目录环境变量名（与 dsh 本体一致）。 */
export const DSH_HOME_ENV = 'DSH_HOME'
/** 显式覆盖 vendor 解析根的环境变量（`path.delimiter` 分隔多个）。 */
export const VENDOR_ROOTS_ENV = 'DSH_LOGWIKI_VENDOR_ROOTS'

/**
 * DSH 主目录。`$DSH_HOME` 优先（**纯空白视为未设**，与 dsh 的 treat-as-unset 口径一致），
 * 否则退回各平台惯例位置 `~/.dsh`。
 * @returns {string} 绝对路径
 */
export function dshHome() {
  const raw = process.env[DSH_HOME_ENV]
  const fromEnv = typeof raw === 'string' ? raw.trim() : ''
  return fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** 会话日志根：`$DSH_HOME/sessions`。 */
export function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

/** profile 根：`$DSH_HOME/profiles`。 */
export function profilesRoot() {
  return join(dshHome(), 'profiles')
}

/**
 * `$DSH_HOME/profiles` 下的全部 profile 目录（**排序**，保证解析顺序可复现）。
 * 目录不存在或无权限时返回空数组，绝不抛。
 * @returns {string[]}
 */
export function profileDirs() {
  try {
    return readdirSync(profilesRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(profilesRoot(), entry.name))
      .sort()
  } catch {
    return []
  }
}

/**
 * 可能装着 `@deepseek-ai/*` 的 node_modules 根，**按优先级**排列。
 * 只返回真实存在的目录（不存在的一律滤掉，避免把无效根塞进 attempts）。
 *
 * 覆盖的三种安装形态：
 *   1. npm 全局装 dsh          → `<npm 前缀>/node_modules/@deepseek-ai/dsh/node_modules`
 *      （profile 里的 `@deepseek-ai/*` 通常是指向这里的 junction）
 *   2. 各 profile 自带的依赖   → `$DSH_HOME/profiles/<name>/node_modules`
 *   3. 桌面端（Electron 托管） → `<resources>/app.asar/dsh/node_modules`
 *      —— 桌面端把 dsh 本体打进 asar，没有 npm 全局安装也能跑
 *
 * @returns {string[]}
 */
export function vendorRoots() {
  const roots = []
  const push = (value) => {
    if (typeof value === 'string' && value !== '' && !roots.includes(value)) roots.push(value)
  }

  // 0) 显式覆盖：给非标准布局（自定义前缀、容器内、CI）留的逃生口
  const override = process.env[VENDOR_ROOTS_ENV]
  if (typeof override === 'string' && override.trim() !== '') {
    for (const part of override.split(delimiter)) push(part.trim())
  }

  // 1) profile 层：$DSH_HOME/profiles/node_modules（多 profile 共享的 junction 层）
  push(join(profilesRoot(), 'node_modules'))

  // 2) 各 profile 自己的 node_modules
  for (const dir of profileDirs()) push(join(dir, 'node_modules'))

  // 3) 桌面端：Electron 运行时（app.asar 内的 dsh）；开发运行则是 resources/app
  const resources = typeof process.resourcesPath === 'string' ? process.resourcesPath : ''
  if (resources !== '') {
    push(join(resources, 'app.asar', 'dsh', 'node_modules'))
    push(join(resources, 'app', 'dsh', 'node_modules'))
  }

  // 4) npm 全局前缀
  for (const prefix of npmGlobalPrefixes()) {
    push(join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'))
    push(join(prefix, 'node_modules'))
  }

  return roots.filter((root) => existsSync(root))
}

/**
 * 候选的 npm 全局前缀（**没有** `node_modules` 后缀）。
 * 纯推导：环境变量 → 平台惯例目录 → 由当前 node 可执行文件反推 → POSIX 常见路径。
 * @returns {string[]}
 */
export function npmGlobalPrefixes() {
  const out = []
  const fromEnv = process.env.npm_config_prefix
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') out.push(fromEnv.trim())

  // Windows：npm 默认把全局包放在 %APPDATA%\npm
  const appData = process.env.APPDATA
  if (typeof appData === 'string' && appData.trim() !== '') out.push(join(appData.trim(), 'npm'))

  // 由 node 自身反推：<prefix>/bin/node → <prefix>
  const exec = process.execPath
  if (typeof exec === 'string' && exec !== '') {
    const prefix = dirname(dirname(exec))
    if (prefix !== '' && prefix !== '.' && prefix !== '/') out.push(prefix)
  }

  // POSIX 系统包管理器
  out.push('/usr/local', '/usr')
  return out
}

/**
 * 在候选 node_modules 根里找 `<pkg>/<rest...>`，返回**第一个存在的**绝对路径。
 * @param {string} pkg 包名（可含 scope，如 `@deepseek-ai/dsh-llm`）
 * @param {...string} rest 包内相对路径段
 * @returns {string|null} 绝对路径；全部候选都没命中时 null
 */
export function findInNodeModules(pkg, ...rest) {
  for (const root of vendorRoots()) {
    const candidate = join(root, pkg, ...rest)
    if (existsSync(candidate)) return candidate
  }
  return null
}
