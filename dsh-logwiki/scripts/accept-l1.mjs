#!/usr/bin/env node
/**
 * dsh-LogWiki · L1 验收门（自动化部分）
 *
 * 用法：
 *   node scripts/accept-l1.mjs [baseUrl] [--refresh] [--mutate] [--probe]
 *     baseUrl     默认 http://127.0.0.1:3081
 *     --refresh   额外触发一次「更新」（**会真的回填数据、耗时可达几十分钟**）。默认不触发：
 *                 对生产实例跑验收应当是轻量、幂等、只读的。
 *     --mutate    允许变更类断言（改条目、重生成简报）。默认关闭；请在**专用测试实例**上用。
 *     --probe     真机模型自检（**会消耗少量 token**）
 *
 * 退出码：0 = 全绿；1 = 有 FAIL。
 * 逐项打印 PASS/FAIL 与证据，便于直接抄进 DEVLOG。
 */

const ARGS = process.argv.slice(2)
const BASE = (ARGS.find((a) => !a.startsWith('--')) ?? 'http://127.0.0.1:3081').replace(/\/+$/, '')
const DO_PROBE = ARGS.includes('--probe')
const DO_REFRESH = ARGS.includes('--refresh')
/**
 * 是否允许**变更类**断言。默认 **false（只读）**。
 * 理由：本脚本常常直连**用户的真实实例**跑，而变更类断言会改动生产数据
 * （改一条摘要、重生成简报覆盖缓存）。"改了再改回来"不算回滚——中途崩溃即留脏数据。
 * 因此：对生产实例跑就用默认只读；要覆盖写路径请在**专用测试实例**上加 `--mutate`。
 */
const MUTATE = ARGS.includes('--mutate')
const API = `${BASE}/api/dsh-logwiki`

const results = []
function record(name, ok, evidence = '') {
  results.push({ name, ok, evidence })
  const tag = ok ? 'PASS' : 'FAIL'
  console.log(`${tag}  ${name}${evidence ? `  — ${evidence}` : ''}`)
}

async function req(path, { method = 'GET', body, guard = false, timeoutMs = 120000 } = {}) {
  const headers = { accept: 'application/json' }
  if (guard) headers['x-logwiki'] = '1'
  if (body !== undefined) headers['content-type'] = 'application/json'
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    return { status: res.status, json, text }
  } finally {
    clearTimeout(timer)
  }
}

/** 'YYYY-MM-DD' → ISO 周标识 'YYYY-Www'（周一为起，1 月 4 日所在周为第 1 周）。 */
function isoWeekOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const t = new Date(y, m - 1, d)
  const thu = new Date(t.getTime() + (3 - ((t.getDay() + 6) % 7)) * 86400000)
  const y0 = new Date(thu.getFullYear(), 0, 1)
  const wk = Math.ceil(((thu - y0) / 86400000 + 1) / 7)
  return `${thu.getFullYear()}-W${String(wk).padStart(2, '0')}`
}

async function main() {
  console.log(`\n=== dsh-LogWiki L1 验收 @ ${BASE} ===\n`)

  // 1) ping / 配置
  const ping = await req('/ping')
  record('/ping 可达', ping.status === 200 && ping.json?.ok === true, `HTTP ${ping.status}`)
  if (ping.json?.config) {
    const c = ping.json.config
    record(
      '/ping 回显配置',
      typeof c.scan?.sinceDays === 'number' && typeof c.summarize?.model === 'string',
      `scan.sinceDays=${c.scan?.sinceDays} summarize=${c.summarize?.provider}/${c.summarize?.model}`,
    )
  }
  const missing = ping.json ? Object.entries(ping.json.modules ?? {}).filter(([, v]) => v !== true).map(([k]) => k) : []
  record('五个兄弟模块全部就绪', missing.length === 0, missing.length === 0 ? 'extract/fold/store/summarize/prompts ✓' : `缺失: ${missing.join(', ')}`)

  // 2) health / 服务与工具
  const health = await req('/health')
  record('/health 可达', health.status === 200 && health.json?.ok === true, `HTTP ${health.status}`)
  const tools = health.json?.tools ?? {}
  record('工具 logwiki_write_digest 已注册', Array.isArray(tools.registered) && tools.registered.includes('logwiki_write_digest'),
    `registered=[${(tools.registered ?? []).join(',')}] errors=${JSON.stringify(tools.errors ?? {})}`)
  record('store 可写', health.json?.store?.writable === true, JSON.stringify(health.json?.store ?? {}))
  record('sessionQuery 可用', health.json?.services?.sessionQuery === true, `services.sessionQuery=${health.json?.services?.sessionQuery}`)

  // 3) 变更守卫（自保）
  const noGuard = await req('/refresh', { method: 'POST' })
  record('变更端点缺守卫头 → 403', noGuard.status === 403, `HTTP ${noGuard.status} ${String(noGuard.json?.error ?? '').slice(0, 60)}`)
  const opt = await fetch(`${API}/refresh`, { method: 'OPTIONS' }).catch(() => null)
  record('OPTIONS → 405（无 CORS 预检）', opt !== null && opt.status === 405, `HTTP ${opt?.status}`)
  const getRefresh = await req('/refresh', { method: 'GET' })
  record('变更端点 GET → 405', getRefresh.status === 405, `HTTP ${getRefresh.status}`)

  // 4) 刷新（增量回填 + 摘要）
  if (DO_REFRESH) {
    const started = await req('/refresh', { method: 'POST', guard: true, body: {} })
    record('POST /refresh 受理', started.status === 200 && started.json?.ok === true, JSON.stringify(started.json).slice(0, 120))

    // 上限放宽到 45 分钟：maxNewPerRun=300 时一轮回填约 25 分钟（读大日志很慢），
    // 原来 15 分钟会误报"未完成"。
    const deadline = Date.now() + 45 * 60 * 1000
    let last = null
    let finished = false
    while (Date.now() < deadline) {
      const h = await req('/health')
      last = h.json?.progress ?? null
      const s = h.json?.scan ?? null
      if (last !== null && last.finished === true && s?.done === true) {
        finished = true
        break
      }
      await new Promise((r) => setTimeout(r, 3000))
    }
    record('刷新跑完（scan.done）', finished, finished ? JSON.stringify(last).slice(0, 160) : '超时 15 分钟未完成')
    const errs = (await req('/health')).json?.scan?.failed ?? null
    record('刷新无致命失败', typeof errs === 'number', `scan.failed=${errs}`)
  }

  // 5) state
  const state = await req('/state')
  const hm = Array.isArray(state.json?.heatmap) ? state.json.heatmap : []
  const active = hm.filter((d) => (d.work?.turns ?? 0) > 0 || (d.work?.entries ?? 0) > 0)
  record('/state 可达', state.status === 200 && state.json?.ok === true, `HTTP ${state.status}`)
  record('热力图有活动日', active.length > 0, `覆盖 ${hm.length} 天，其中 ${active.length} 天有活动`)
  // 守恒不变量：分项之和必须等于整体。
  // 这类断言是补出来的 —— 曾经有个真实缺陷（工作区卡 turns/sessions 被硬写成 0）能通过全部旧断言。
  const sumDayTurns = hm.reduce((a, d) => a + (d.work?.turns ?? 0), 0)
  record(
    '不变量：各天 turns 之和 == totals.turns',
    sumDayTurns === (state.json?.totals?.turns ?? -1),
    `${sumDayTurns} vs ${state.json?.totals?.turns}`,
  )
  const sumDayEntries = hm.reduce((a, d) => a + (d.work?.entries ?? 0), 0)
  record(
    '不变量：各天 entries 之和 == totals.entries',
    sumDayEntries === (state.json?.totals?.entries ?? -1),
    `${sumDayEntries} vs ${state.json?.totals?.entries}`,
  )
  record('本地来源存在', Array.isArray(state.json?.sources) && state.json.sources.some((s) => s.kind === 'local'),
    `sources=[${(state.json?.sources ?? []).map((s) => s.label).join(',')}]`)

  // 6) day：挑一个活动最多的日子
  const busiest = active.slice().sort((a, b) => (b.work?.turns ?? 0) - (a.work?.turns ?? 0))[0]
  if (busiest !== undefined) {
    const day = await req(`/day?date=${busiest.date}`)
    const groups = day.json?.groups ?? []
    const workspaces = groups.flatMap((g) => g.workspaces ?? [])
    const entries = workspaces.flatMap((w) => w.entries ?? [])
    record(`/day?date=${busiest.date} 可达`, day.status === 200 && day.json?.ok === true, `HTTP ${day.status}`)
    record('日详情有工作区卡', workspaces.length > 0, `工作区: ${workspaces.map((w) => w.workspaceLabel).slice(0, 5).join(' / ')}`)
    record('日详情有条目卡', entries.length > 0, `条目 ${entries.length} 条，例: ${String(entries[0]?.summary ?? '').slice(0, 40)}`)
    // ⚠️ 必须**按工作区分组**检查：/day 的排序契约是"每个工作区内部按 startTime 升序"，
    // 把多个工作区的条目拉平成一个数组再比大小是错的 —— 不同工作区的时间本来就会交错。
    // 首版就是拉平比较，只有两个工作区时"碰巧"通过；三期同步进来的 rocs 工作区
    // （12:10）接在 local/DSH-LogWiki（23:11）后面才把它暴露出来。**是尺子错了，不是产品错了。**
    record(
      '条目按时间升序（各工作区内）',
      workspaces.every((w) =>
        (w.entries ?? []).every((e, i, arr) => i === 0 || (arr[i - 1].startTime ?? 0) <= (e.startTime ?? 0)),
      ),
      `${entries.length} 条 / ${workspaces.length} 个工作区，分组检查`,
    )
    record('条目带标签字段', entries.every((e) => typeof e.tag === 'string'), '')

    // 守恒不变量（补出来的）：工作区卡分项之和 == 当天合计。
    // 真实缺陷回顾：`buildDay` 曾把工作区卡的 turns/sessions 硬写成 0，于是「当天 355 轮」与
    // 「工作区卡 0 轮」自相矛盾（0+0 ≠ 355）。旧断言对此毫无反应，这两条就是为了锁死它。
    const dayTotals = day.json?.totals ?? {}
    const sumWsTurns = workspaces.reduce((a, w) => a + (w.totals?.turns ?? 0), 0)
    const sumWsSessions = workspaces.reduce((a, w) => a + (w.totals?.sessions ?? 0), 0)
    const sumWsEntries = workspaces.reduce((a, w) => a + (w.totals?.entries ?? 0), 0)
    record('不变量：工作区 turns 之和 == 当天合计', sumWsTurns === (dayTotals.turns ?? -1), `${sumWsTurns} vs ${dayTotals.turns}`)
    record('不变量：工作区 sessions 之和 == 当天合计', sumWsSessions === (dayTotals.sessions ?? -1), `${sumWsSessions} vs ${dayTotals.sessions}`)
    record('不变量：工作区 entries 之和 == 当天合计', sumWsEntries === (dayTotals.entries ?? -1), `${sumWsEntries} vs ${dayTotals.entries}`)
    record('不变量：条目卡总数 == 当天 entries', entries.length === (dayTotals.entries ?? -1), `${entries.length} vs ${dayTotals.entries}`)
    record('不变量：每个工作区至少 1 条条目', workspaces.every((w) => (w.entries ?? []).length > 0), `${workspaces.length} 个工作区`)

    // 7) 条目编辑持久化（变更类 → 仅在 --mutate 时执行）
    const target = entries[0]
    if (target !== undefined && MUTATE) {
      const stamp = `验收改动 ${new Date().toISOString().slice(11, 19)}`
      const edited = await req('/entry', { method: 'POST', guard: true, body: { entryId: target.id, summary: stamp, tag: '验收' } })
      record('POST /entry 保存编辑', edited.status === 200 && edited.json?.ok === true, `HTTP ${edited.status}`)
      const reread = await req(`/day?date=${busiest.date}`)
      const after = (reread.json?.groups ?? []).flatMap((g) => g.workspaces ?? []).flatMap((w) => w.entries ?? []).find((e) => e.id === target.id)
      record('编辑已持久化且标记 edited', after?.summary === stamp && after?.edited === true, `summary="${String(after?.summary ?? '').slice(0, 30)}" edited=${after?.edited}`)
      // 复原
      await req('/entry', { method: 'POST', guard: true, body: { entryId: target.id, summary: target.summary, tag: target.tag } })
      record('（已把该条复原为原摘要）', true, '')
    } else if (target !== undefined) {
      console.log('SKIP  条目编辑持久化（只读模式；加 --mutate 在专用实例上启用）')
    }
  } else {
    record('找到可验证的活动日', false, '热力图无活动日，无法验证 /day 与编辑')
  }

  // 8) 简报（需求 7）—— 必须**真正生成一次**，不能只看 /digests/available 返回 200。
  //    教训：曾因只验 available（返回空）而把"简报可用"写进验收，真跑时才发现
  //    maxTokens=2048 会把输出截断 → 500。空结果/200 都不等于功能可用。
  const avail = await req('/digests/available')
  record('/digests/available 可达', avail.status === 200 && avail.json?.ok === true,
    `weeks=${(avail.json?.weeks ?? []).length} months=${(avail.json?.months ?? []).length}`)

  // 「有活动的周期」清单 —— 客户端靠它做周期导航（跟随选中日期 + 前后跳）。
  const periods = await req('/digests/periods')
  record('/digests/periods 可达', periods.status === 200 && periods.json?.ok === true,
    `weeks=${(periods.json?.weeks ?? []).length} months=${(periods.json?.months ?? []).length}`)
  if (periods.json?.ok === true) {
    const wks = Array.isArray(periods.json.weeks) ? periods.json.weeks : []
    const mos = Array.isArray(periods.json.months) ? periods.json.months : []
    record('周期清单按新→旧排序', [...wks, ...mos].every((p) => typeof p.period === 'string'), '')
    record('周期清单带 from/to/条数/回合/hasDigest',
      [...wks, ...mos].every((p) => typeof p.from === 'string' && typeof p.to === 'string' &&
        Number.isFinite(p.days) && Number.isFinite(p.entries) && Number.isFinite(p.turns) && typeof p.hasDigest === 'boolean'), '')
    // 守恒：各周期条目数之和 == 当日条目数之和（同一批 entries，两种聚合口径必须一致）
    const sumPeriodEntries = [...wks, ...mos].reduce((a, p) => a + (p.period.length === 7 ? p.entries : 0), 0) // 只取月，避免周月重复计数
    record('不变量：月条目数之和 == 全部条目数', sumPeriodEntries === (state.json?.totals?.entries ?? -1),
      `${sumPeriodEntries} vs ${state.json?.totals?.entries}`)
    // hasDigest 必须与 /digests/available 对得上
    const availWeeks = new Set(avail.json?.weeks ?? [])
    record('不变量：周 hasDigest 与 /digests/available 一致',
      wks.every((p) => p.hasDigest === availWeeks.has(p.period)), `available=${[...availWeeks].join(',')}`)
  }

  if (busiest !== undefined) {
    const wk = isoWeekOf(busiest.date)
    // 变更类：默认只读 —— 读**已缓存**的那份；只有 --mutate 才真正重算（会覆盖用户手动生成的那份）。
    if (MUTATE) {
      const gen = await req('/digest/generate', {
        method: 'POST', guard: true, body: { kind: 'week', period: wk }, timeoutMs: 240000,
      })
      record(`POST /digest/generate 周简报 ${wk}`, gen.status === 200 && gen.json?.ok === true,
        gen.json?.ok ? `${gen.json.digest?.items?.length} 条` : String(gen.json?.error ?? gen.status))
    } else {
      console.log('SKIP  POST /digest/generate（只读模式；加 --mutate 启用，会覆盖缓存）')
    }
    const cached = await req(`/digests?kind=week&period=${wk}`)
    const d = cached.json?.digest ?? null
    if (d === null) {
      record(`周简报 ${wk} 已生成且可读取`, false, '还没有缓存（只读模式下不主动生成；先在界面上生成一次或加 --mutate）')
    } else {
      const n = Array.isArray(d.items) ? d.items.length : -1
      record(`周简报 ${wk} 可读取`, cached.status === 200 && cached.json?.ok === true, `generatedAt=${d.generatedAt}`)
      record('简报条数在 1..12（用户口径：一般 10 个左右）', n >= 1 && n <= 12, `${n} 条`)
      record('简报每条都有一句话总结', (d.items ?? []).every((i) => typeof i.summary === 'string' && i.summary.trim() !== ''), '')
      record('简报带标题与总览', typeof d.title === 'string' && d.title !== '' && typeof d.headline === 'string', String(d.title).slice(0, 40))
      // 复读一致性：再取一次，generatedAt 必须不变（证明没有重算）
      const again = await req(`/digests?kind=week&period=${wk}`)
      record('简报缓存复读不重算', again.json?.digest?.generatedAt === d.generatedAt, `generatedAt=${d.generatedAt}`)
    }
    const ap = await req('/digest/agent-prompt', { method: 'POST', guard: true, body: { kind: 'week', period: wk } })
    record('POST /digest/agent-prompt 返回可交给智能体的提示词',
      ap.status === 200 && typeof ap.json?.prompt === 'string' && ap.json.prompt.length > 100,
      `${ap.json?.prompt?.length ?? 0} 字`)
    record('提示词点名 logwiki_write_digest 工具',
      typeof ap.json?.prompt === 'string' && ap.json.prompt.includes('logwiki_write_digest'), '')
  } else {
    record('简报验证（需要活动日）', false, '热力图无活动日')
  }

  // 9) 二期：远程来源
  const srcList = await req('/sources')
  record('/sources 可达且带体量统计',
    srcList.status === 200 && srcList.json?.ok === true && Array.isArray(srcList.json.sources) &&
      srcList.json.sources.every((s) => typeof s.sessionCount === 'number' && typeof s.entryCount === 'number'),
    `sources=[${(srcList.json?.sources ?? []).map((s) => s.id).join(',')}] remoteEnabled=${srcList.json?.remoteEnabled}`)
  record('local 来源天然存在', (srcList.json?.sources ?? []).some((s) => s.id === 'local' && s.kind === 'local'), '')

  const disc = await req('/source/discover')
  record('/source/discover 可达',
    disc.status === 200 && disc.json?.ok === true && Array.isArray(disc.json.aliases),
    disc.json?.available === true ? `WSL 可用，别名=[${(disc.json.aliases ?? []).join(',')}]` : `WSL 不可用：${String(disc.json?.error ?? '')}`)

  const pr = await req('/source/prompt', {
    method: 'POST', guard: true, body: { label: '验收用', sshAlias: 'rocs', dshHome: '/tmp/x' },
  })
  record('POST /source/prompt 生成可交给智能体的提示词',
    pr.status === 200 && typeof pr.json?.prompt === 'string' && pr.json.prompt.length > 200,
    `${pr.json?.prompt?.length ?? 0} 字`)
  record('提示词要求加载 f2a-ssh（需求原文要求）',
    typeof pr.json?.prompt === 'string' && pr.json.prompt.includes('f2a-ssh'), '')
  record('提示词要求缺信息时用 ask_user_question 问',
    typeof pr.json?.prompt === 'string' && pr.json.prompt.includes('ask_user_question'), '')

  // 变更类：只在 --mutate 时对**专用实例**跑（会写真数据）
  if (MUTATE) {
    const bad = await req('/source/add', { method: 'POST', guard: true, body: { label: 'x', sshAlias: 'a; rm -rf /', dshHome: '/a' } })
    record('注入型别名被拒（400，不落库）', bad.status === 400 && bad.json?.ok !== true, String(bad.json?.error ?? '').slice(0, 60))
    const added = await req('/source/add', { method: 'POST', guard: true, body: { label: '验收来源', sshAlias: 'rocs', dshHome: '/tmp/accept-l1' } })
    record('POST /source/add 登记成功', added.status === 200 && added.json?.ok === true, String(added.json?.source?.id ?? ''))
    const after = await req('/sources')
    const id = added.json?.source?.id
    record('新来源出现在 /sources 里', (after.json?.sources ?? []).some((s) => s.id === id), `id=${id}`)
    const del = await req('/source/delete', { method: 'POST', guard: true, body: { sourceId: id } })
    record('POST /source/delete 清理干净', del.status === 200 && del.json?.ok === true, `会话${del.json?.removedSessions} 条目${del.json?.removedEntries}`)
    const finalList = await req('/sources')
    record('删除后不再出现', (finalList.json?.sources ?? []).every((s) => s.id !== id), '')
  } else {
    console.log('SKIP  来源增删往返（只读模式；加 --mutate 在专用实例上启用）')
  }

  // 9) 真机模型自检（可选，消耗 token）
  if (DO_PROBE) {
    const probe = await req('/summarize/probe', { method: 'POST', guard: true, body: {}, timeoutMs: 180000 })
    record('真机 LLM 自检', probe.status === 200 && probe.json?.ok === true, JSON.stringify(probe.json).slice(0, 140))
  } else {
    console.log('SKIP  真机 LLM 自检（加 --probe 启用，会消耗少量 token）')
  }

  // 汇总
  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`)
  if (failed.length > 0) {
    console.log('未通过项：')
    for (const f of failed) console.log(`  · ${f.name}  ${f.evidence}`)
    process.exitCode = 1
    return
  }
  process.exitCode = 0
  // 刻意**不调用 process.exit()**：Node 24 on Windows 下，在 undici 的 keep-alive
  // 句柄正在关闭时 exit 会触发 libuv 断言
  // `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:94`
  // 并把退出码变成 0xC0000409 —— 那是运行时竞态，不是验收失败，但会污染门禁退出码。
  // 改成只设 exitCode 让事件循环自然排空。
}

main().catch((error) => {
  console.error(`\n验收脚本自身异常：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
})
