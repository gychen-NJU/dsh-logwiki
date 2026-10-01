/**
 * dsh-logwiki · 远程来源的定义与「添加来源」闭环（二期 M9）
 *
 * 与 `lib/remote.js` 一样是**纯逻辑 / 可注入**的：不接触 ctx，写入走注入的回调。
 * 这样它能离线测试（见 `scripts/verify-remote.mjs` 的 I 段）。
 *
 * 设计依据（用户需求原文）：
 *   · 「允许添加其他DSH的来源…可以点击比如"添加来源"这样的按钮之后，在打开的对话框输入联系服务器的信息」
 *   · 「会话中添加服务器时，**默认使用 f2a-ssh 技能**，以便处理如果遇到F2A验证的情况」
 *   · 「在点击添加来源在会话框中表述服务器，然后发送给智能体时，
 *      **可能会遇到智能体索要信息的情况**，也需要帮我把这种情况考虑进去」
 *
 * 因此本模块的核心是 `buildAddSourcePrompt()`：它把「要做什么、缺什么该问谁、怎么落库」
 * 写成一段自包含的提示词，交给智能体去执行 —— 因为 2FA 需要真人参与，只有对话里的智能体能处理。
 */

import { assertSafeAlias, assertSafeRemotePath, buildIndexCommand, REMOTE_SESSION_FILE } from './remote.js'

/** 来源 id 白名单（会作为 store 的键、也会出现在条目主键里）。 */
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

/** 保留 id：本地来源固定用 `local`。 */
export const LOCAL_SOURCE_ID = 'local'

/**
 * 校验并归一化一个远程来源的定义。
 * @param {{id?: string, label: string, sshAlias: string, wslDistro?: string,
 *          dshHome: string, sinceDays?: number, now?: number}} input
 * @returns {{id, kind:'remote', label, sshAlias, wslDistro, dshHome, sinceDays,
 *            enabled: true, addedAt, lastSyncAt: null, lastSyncStatus: 'never', lastError: null}}
 * @throws {Error} 任一字段不合法
 */
export function normalizeRemoteSource(input) {
  const label = typeof input?.label === 'string' ? input.label.trim() : ''
  if (label === '') throw new Error('来源名称不能为空')
  if (label.length > 32) throw new Error('来源名称过长（≤32 字）')

  const id = input?.id === undefined || input.id === '' ? slugOf(label) : String(input.id)
  if (!SOURCE_ID_RE.test(id)) {
    throw new Error(`来源 id 不合法（只允许小写字母/数字/下划线/连字符，≤32）：${id}`)
  }
  if (id === LOCAL_SOURCE_ID) throw new Error(`来源 id 不能占用保留名 "${LOCAL_SOURCE_ID}"`)

  const sshAlias = assertSafeAlias(input?.sshAlias)
  const dshHome = assertSafeRemotePath(input?.dshHome)
  const wslDistro = input?.wslDistro === undefined || input.wslDistro === '' ? undefined : assertSafeAlias(input.wslDistro)
  const sinceDays = Number.isFinite(input?.sinceDays) && input.sinceDays > 0 ? Math.floor(input.sinceDays) : 90

  return {
    id,
    kind: 'remote',
    label,
    sshAlias,
    ...(wslDistro === undefined ? {} : { wslDistro }),
    dshHome,
    sinceDays,
    enabled: true,
    addedAt: Number.isFinite(input?.now) ? input.now : Date.now(),
    lastSyncAt: null,
    lastSyncStatus: 'never',
    lastError: null,
  }
}

/** 从名称派生一个安全的 id（中文等非 ASCII 会退化成哈希后缀）。 */
export function slugOf(label) {
  const ascii = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (ascii !== '') return ascii.slice(0, 32)
  let h = 0
  for (const ch of String(label)) h = (h * 31 + ch.codePointAt(0)) | 0
  return `src-${(h >>> 0).toString(36)}`
}

/**
 * 对话框里用户没填的字段 —— 提示词会要求智能体**用 ask_user_question 去问**，
 * 而不是瞎猜或直接失败。（这正是需求里"智能体索要信息"的那种情况。）
 */
export function missingFields(input) {
  const miss = []
  if (!nonEmpty(input?.sshAlias)) miss.push({ key: 'sshAlias', ask: '要连接的 SSH 主机别名（WSL ~/.ssh/config 里配置的那个，例如 rocs）' })
  if (!nonEmpty(input?.dshHome)) miss.push({ key: 'dshHome', ask: '远端机器上 DSH 的主目录绝对路径（一般是 ~/.dsh，请让用户在服务器上确认后给出）' })
  return miss
}

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() !== ''
}

/**
 * 构造「添加来源」的提示词 —— 由客户端写进会话输入框，用户确认后发给智能体。
 *
 * 为什么必须走智能体而不是插件自己连：目标服务器常有 **2FA**，DSH 内置 SSH 客户端
 * （ssh2）既不读 WSL 的 `~/.ssh/config`、也无法完成交互式验证，**必须借道 WSL 里的
 * OpenSSH ControlMaster**（就是 `f2a-ssh` 技能描述的那套）。而"用户在手机上点确认"
 * 这一步只有对话里的智能体能等。
 *
 * @param {{label?: string, sshAlias?: string, wslDistro?: string, dshHome?: string,
 *          sinceDays?: number, toolName?: string}} spec
 * @returns {string} Markdown 提示词
 */
export function buildAddSourcePrompt(spec = {}) {
  const label = nonEmpty(spec.label) ? spec.label.trim() : '（未命名，请向用户确认一个短名称，例如 rocs）'
  const tool = nonEmpty(spec.toolName) ? spec.toolName : 'logwiki_import_source'
  const miss = missingFields(spec)
  const sinceDays = Number.isFinite(spec.sinceDays) && spec.sinceDays > 0 ? Math.floor(spec.sinceDays) : 90

  const lines = []
  lines.push('# 任务：为 LogWiki 任务日历添加一个远程 DSH 来源')
  lines.push('')
  lines.push('## 已知信息（来自「添加来源」对话框）')
  lines.push(`- 来源名称：${label}`)
  lines.push(`- SSH 主机别名：${nonEmpty(spec.sshAlias) ? spec.sshAlias : '**（用户未填 —— 需要你问）**'}`)
  lines.push(`- WSL 发行版：${nonEmpty(spec.wslDistro) ? spec.wslDistro : '（未指定，用默认发行版即可）'}`)
  lines.push(`- 远端 DSH 主目录：${nonEmpty(spec.dshHome) ? spec.dshHome : '**（用户未填 —— 需要你问）**'}`)
  lines.push(`- 回填窗口：最近 ${sinceDays} 天`)
  lines.push('')

  // 这一段**无条件出现**：用户明确要求"把智能体索要信息的情况考虑进去"。
  // 就算对话框填全了，后续仍可能要问（路径不存在 / 别名连不上 / 2FA 需要用户操作），
  // 所以提示词始终给出"该问就问、别猜"的指令 —— 首版只在字段缺失时才写这段，是错的。
  lines.push('## ⚠️ 第一步：遇到任何缺失或不确定的信息，一律用 `ask_user_question` 问用户，不要猜')
  if (miss.length > 0) {
    lines.push('对话框里下面这几项没填，请**一次性**问清：')
    for (const m of miss) lines.push(`- \`${m.key}\`：${m.ask}`)
    lines.push('拿到答复后再继续；用户没答全就再问一次。')
  } else {
    lines.push('对话框里的信息已经齐了。但**若在后续任何一步发现异常**——路径不存在、别名连不上、')
    lines.push('远端根本没有 `sessions` 目录、或需要用户到服务器/WSL 里确认什么——')
    lines.push('**同样用 `ask_user_question` 问用户**，不要自己编一个值硬着头皮往下做。')
  }
  lines.push('')

  lines.push('## 第二步：先用 skill 工具加载 `f2a-ssh` 技能（**不要跳过**）')
  lines.push('目标服务器很可能要求两步验证（2FA）。DSH 内置的 SSH 工具用 ssh2 库，')
  lines.push('**不读 WSL 的 `~/.ssh/config`、也无法完成交互式 2FA**，直连必然失败。')
  lines.push('正确做法是 `f2a-ssh` 技能里那套：借道 WSL 里的 OpenSSH，用 ControlMaster 建一条主连接，')
  lines.push('之后的命令都复用它（`ssh -O check <别名>` 可验活）。2FA 只在建主连接时发生一次。')
  lines.push('')
  lines.push('- 若主连接已存在 → 直接进入第三步。')
  lines.push('- 若需要 2FA：push 型（手机确认）可等待；键盘输入型（验证码）请**提示用户在 WSL 终端里自己执行** `ssh -fN <别名>`，并等他确认完成。**不要反复重试直连。**')
  lines.push('')

  lines.push('## 第三步：确认远端确实有 DSH 会话日志')
  lines.push(`执行（路径以用户给的 DSH 主目录为准）：`)
  lines.push('')
  lines.push('```')
  lines.push(`wsl.exe -e sh -lc "ssh <别名> 'ls -d <远端DSH主目录>/sessions && find <远端DSH主目录>/sessions -maxdepth 3 -name ${REMOTE_SESSION_FILE} | head -5'"`)
  lines.push('```')
  lines.push('')
  lines.push(`预期能看到若干 \`${REMOTE_SESSION_FILE}\`。若目录不存在，请回报用户并向其确认正确路径。`)
  lines.push('')

  lines.push('## 第四步：落库')
  lines.push(`把来源写入 LogWiki —— 调用工具 \`${tool}\`，参数：`)
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify({ label, sshAlias: spec.sshAlias ?? '<问到的别名>', wslDistro: spec.wslDistro ?? null, dshHome: spec.dshHome ?? '<问到的路径>', sinceDays }, null, 2))
  lines.push('```')
  lines.push('')
  lines.push('## 第五步：回报')
  lines.push('告诉用户：来源已添加、名字是什么、远端有多少个会话日志待同步，')
  lines.push('并说明**下一步在「任务日历」面板点「更新」即可把远端任务拉进来**（界面上会以该来源名单独分区展示）。')
  lines.push('')
  lines.push('> 注意：本次只负责**登记来源**。真正拉取会话由插件在「更新」时通过同一个 ControlMaster 复用连接完成；')
  lines.push('> 若那时主连接已失效，插件会提示需要重新建立连接，再走一次本流程即可。')

  return lines.join('\n')
}

/**
 * `logwiki_import_source` 工具的**定义**。
 * 工具自身不做 LLM 工作，只校验 + 落库（形状同 meow-memory 的 memory_dream）。
 *
 * @param {{upsertSource: (source: object) => void, now?: () => number}} deps
 */
export function makeImportSourceTool(deps) {
  if (typeof deps?.upsertSource !== 'function') throw new Error('makeImportSourceTool 需要 upsertSource 回调')
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()

  return {
    name: 'logwiki_import_source',
    description:
      '把一个远程 DSH 来源登记进 LogWiki 任务日历，之后它的会话会作为一个独立来源分区出现在日历里。' +
      '用于「添加来源」流程：先用 f2a-ssh 技能确认能连上远端、且远端有 DSH 会话日志，再调用本工具登记。',
    parameters: {
      label: { type: 'string', required: true, description: '来源的短名称，例如 rocs（会显示在日历的来源分区上）' },
      sshAlias: { type: 'string', required: true, description: 'WSL ~/.ssh/config 里的主机别名（只允许字母数字点下划线连字符）' },
      dshHome: { type: 'string', required: true, description: '远端机器上 DSH 主目录的绝对路径，例如 /home/user/.dsh' },
      wslDistro: { type: 'string', description: 'WSL 发行版名（留空用默认发行版）' },
      sinceDays: { type: 'number', description: '只同步最近多少天的会话，默认 90' },
    },
    output: {
      // output.schema 是真正的 JSON Schema（required 是数组）——与上面 parameters 的 DSL 方言不同
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          sourceId: { type: 'string' },
          label: { type: 'string' },
          sinceDays: { type: 'integer' },
        },
        required: ['ok', 'sourceId', 'label', 'sinceDays'],
      },
      render: (_args, value) => [
        { type: 'text', text: `已登记远程来源「${value.label}」（id=${value.sourceId}，窗口 ${value.sinceDays} 天）。在「任务日历」点「更新」即可拉取。` },
      ],
    },
    async execute(args) {
      const source = normalizeRemoteSource({
        label: args?.label,
        sshAlias: args?.sshAlias,
        dshHome: args?.dshHome,
        wslDistro: args?.wslDistro ?? undefined,
        sinceDays: typeof args?.sinceDays === 'number' ? args.sinceDays : undefined,
        now: now(),
      })
      deps.upsertSource(source)
      return { ok: true, sourceId: source.id, label: source.label, sinceDays: source.sinceDays }
    },
  }
}

/** 供集成层取用：这个来源要跑哪些远端命令。 */
export function remoteSourceCommands(source) {
  return {
    index: buildIndexCommand({ dshHome: source.dshHome, sinceDays: source.sinceDays }),
  }
}
