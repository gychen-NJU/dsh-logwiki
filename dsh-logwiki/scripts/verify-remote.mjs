#!/usr/bin/env node
/**
 * 自检：二期「远程来源」的纯逻辑层（`lib/remote.js`）。
 *
 * 重点覆盖三类容易出人命的地方：
 *   ① **注入安全** —— 别名/路径里塞 shell 元字符必须被拒；
 *   ② **转义** —— 远端脚本必须被 base64 包裹，原始脚本文本不得出现在 argv 里；
 *   ③ **端到端** —— 用真实日志走一遍 base64 → 解码 → 解析 → 指纹（与本地同一 extract.js）。
 *
 * 用法：node scripts/verify-remote.mjs
 * 退出码：0 全绿；1 有失败。
 */

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

import * as R from '../lib/remote.js'
import * as RS from '../lib/remote-sources.js'
import * as EX from '../lib/extract.js'

const results = []
const pending = []
function check(name, fn) {
  try {
    const ret = fn()
    // 允许传 async 函数：把 Promise 收进 pending，末尾统一 await。
    // （首版忽略了这一点，导致 async 断言失败时 Promise 拒绝逃逸，整脚本崩掉而不是记 FAIL。）
    if (ret !== null && typeof ret === 'object' && typeof ret.then === 'function') {
      pending.push(
        ret.then(
          () => {
            results.push({ name, ok: true, evidence: '' })
            console.log(`PASS  ${name}`)
          },
          (error) => {
            const msg = error instanceof Error ? error.message : String(error)
            results.push({ name, ok: false, evidence: msg })
            console.log(`FAIL  ${name}  — ${msg.split('\n')[0].slice(0, 140)}`)
          },
        ),
      )
      return
    }
    results.push({ name, ok: true, evidence: '' })
    console.log(`PASS  ${name}`)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    results.push({ name, ok: false, evidence: msg })
    console.log(`FAIL  ${name}  — ${msg.split('\n')[0].slice(0, 140)}`)
  }
}
function mustThrow(name, fn, matcher) {
  check(name, () => {
    let threw = false
    let msg = ''
    try {
      fn()
    } catch (error) {
      threw = true
      msg = error instanceof Error ? error.message : String(error)
    }
    assert.equal(threw, true, '本应抛错但没有')
    if (matcher !== undefined) assert.match(msg, matcher)
  })
}

console.log('\n=== 二期远程来源 · 纯逻辑层自检 ===\n')
console.log('--- A. 注入安全：别名 ---')
check('合法别名通过', () => {
  for (const a of ['rocs', 'olivia', 'my-host_1', 'a.b.c', 'HPC2']) assert.equal(R.assertSafeAlias(a), a)
})
for (const bad of ['a; rm -rf /', 'a b', 'a$(whoami)', 'a`id`', "a'b", 'a|b', 'a>b', 'a\nb', '', 'a&b']) {
  mustThrow(`拒绝别名 ${JSON.stringify(bad)}`, () => R.assertSafeAlias(bad), /别名不合法/)
}

console.log('\n--- B. 注入安全：远端路径 ---')
check('合法绝对路径通过', () => {
  assert.equal(R.assertSafeRemotePath('/home/u/.dsh'), '/home/u/.dsh')
  assert.equal(R.assertSafeRemotePath('/root/.dsh/'), '/root/.dsh') // 去尾部斜杠
})
for (const bad of ['relative/path', '', '/home/u/.dsh; rm -rf /', "/home/u/it's", '/home/u/$(id)', '/home/u/`id`', '/home/u/a b', '/home/../etc', '/home/u/a|b']) {
  mustThrow(`拒绝路径 ${JSON.stringify(bad)}`, () => R.assertSafeRemotePath(bad))
}

console.log('\n--- C. 转义：远端脚本必须 base64 包裹 ---')
check('argv 形状正确（wsl.exe → sh -lc → ssh）', () => {
  const argv = R.buildSshArgv({ alias: 'rocs', script: 'hostname' })
  assert.deepEqual(argv.slice(0, 4), ['wsl.exe', '-e', 'sh', '-lc'])
  assert.equal(argv.length, 5)
  assert.match(argv[4], /^ssh rocs 'echo [A-Za-z0-9+/=]+ \| base64 -d \| sh'$/)
})
check('危险脚本的原文**不出现**在 argv 里（只有 base64）', () => {
  const nasty = "echo 'a b' | grep \"x$y\" ; rm -rf /tmp/z\nls -la"
  const argv = R.buildSshArgv({ alias: 'rocs', script: nasty })
  const joined = argv.join(' ')
  assert.equal(joined.includes('rm -rf'), false, '原始脚本泄漏进 argv 了')
  assert.equal(joined.includes('$y'), false)
  assert.equal(joined.includes('\n'), false)
  // 但解码后必须与原文完全一致
  const m = /^echo ([A-Za-z0-9+/=]+) \| base64 -d \| sh$/.exec(argv[4].slice(argv[4].indexOf("'") + 1, -1))
  assert.notEqual(m, null)
  assert.equal(Buffer.from(m[1], 'base64').toString('utf8'), nasty)
})
check('带 wslDistro 时插入 -d', () => {
  const argv = R.buildSshArgv({ alias: 'rocs', script: 'hostname', wslDistro: 'Ubuntu-22.04' })
  assert.deepEqual(argv.slice(0, 4), ['wsl.exe', '-d', 'Ubuntu-22.04', '-e'])
})
mustThrow('wslDistro 也做字符集校验', () => R.buildSshArgv({ alias: 'rocs', script: 'x', wslDistro: 'a;b' }))
mustThrow('远端脚本为空要拒', () => R.buildSshArgv({ alias: 'rocs', script: '' }))

console.log('\n--- D. 远端清单脚本 ---')
check('index 命令含 dshHome 与 mtime 窗口', () => {
  const cmd = R.buildIndexCommand({ dshHome: '/home/u/.dsh', sinceDays: 90 })
  assert.match(cmd, /find \/home\/u\/\.dsh\/sessions/)
  assert.match(cmd, /-name 'session\.v4\.jsonl\.zstd'/)
  assert.match(cmd, /-mtime -90/)
  assert.match(cmd, /-printf '%T@ %s %p\\n'/)
})
check('sinceDays 非法时回落 90 且不能注入', () => {
  const cmd = R.buildIndexCommand({ dshHome: '/home/u/.dsh', sinceDays: Number('x') })
  assert.match(cmd, /-mtime -90/)
})
check('fetch 命令只含校验过的路径', () => {
  assert.equal(R.buildFetchCommand('/home/u/.dsh/sessions/a/session.v4.jsonl.zstd'),
    'base64 -w0 /home/u/.dsh/sessions/a/session.v4.jsonl.zstd')
})

console.log('\n--- E. 清单解析 ---')
check('解析正常输出（路径含空格也吃得住）', () => {
  const stdout = [
    '1790000000.5 1234 /home/u/.dsh/sessions/p--a--/s1/session.v4.jsonl.zstd',
    '1790000100 2048 /home/u/.dsh/sessions/p --b--/s2/session.v4.jsonl.zstd',
    '__LOGWIKI_INDEX_END__',
  ].join('\n')
  const { entries, malformed } = R.parseIndex(stdout)
  assert.equal(entries.length, 2)
  assert.equal(malformed.length, 0)
  assert.equal(entries[0].path, '/home/u/.dsh/sessions/p--a--/s1/session.v4.jsonl.zstd')
  assert.equal(entries[0].size, 1234)
  assert.equal(entries[0].mtimeMs, 1790000000.5 * 1000)
  assert.equal(entries[1].path, '/home/u/.dsh/sessions/p --b--/s2/session.v4.jsonl.zstd')
})
check('坏行进 malformed 且不污染结果', () => {
  const { entries, malformed } = R.parseIndex('garbage\n1 2\n\n1790000000 10 /ok/f\n')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].path, '/ok/f')
  assert.equal(malformed.length, 2)
})
check('空输入安全', () => {
  assert.deepEqual(R.parseIndex(''), { entries: [], malformed: [] })
  assert.deepEqual(R.parseIndex(undefined), { entries: [], malformed: [] })
})

console.log('\n--- F. 同步规划 ---')
check('窗口外的跳过', () => {
  const now = 1_800_000_000_000
  const index = [
    { path: '/new', mtimeMs: now - 86400000, size: 10 },
    { path: '/old', mtimeMs: now - 400 * 86400000, size: 10 },
  ]
  const p = R.planSync({ index, ledger: {}, now, sinceDays: 90, maxFiles: 10, maxBytes: 1000 })
  assert.deepEqual(p.fetch.map((e) => e.path), ['/new'])
  assert.equal(p.skippedOld, 1)
})
check('账本命中的跳过（增量）', () => {
  const now = 1_800_000_000_000
  const e = { path: '/a', mtimeMs: now - 1000, size: 42 }
  const p = R.planSync({ index: [e], ledger: { '/a': { mtimeMs: e.mtimeMs, size: 42 } }, now, sinceDays: 90, maxFiles: 10, maxBytes: 1000 })
  assert.equal(p.fetch.length, 0)
  assert.equal(p.skippedUnchanged, 1)
})
check('size 变了要重拉', () => {
  const now = 1_800_000_000_000
  const e = { path: '/a', mtimeMs: now - 1000, size: 43 }
  const p = R.planSync({ index: [e], ledger: { '/a': { mtimeMs: e.mtimeMs, size: 42 } }, now, sinceDays: 90, maxFiles: 10, maxBytes: 1000 })
  assert.deepEqual(p.fetch.map((x) => x.path), ['/a'])
})
check('**从新到旧**排序', () => {
  const now = 1_800_000_000_000
  const index = [
    { path: '/mid', mtimeMs: now - 2 * 86400000, size: 1 },
    { path: '/newest', mtimeMs: now - 1 * 86400000, size: 1 },
    { path: '/older', mtimeMs: now - 3 * 86400000, size: 1 },
  ]
  const p = R.planSync({ index, ledger: {}, now, sinceDays: 90, maxFiles: 10, maxBytes: 1000 })
  assert.deepEqual(p.fetch.map((e) => e.path), ['/newest', '/mid', '/older'])
})
check('maxFiles 上限生效', () => {
  const now = 1_800_000_000_000
  const index = Array.from({ length: 10 }, (_, i) => ({ path: `/f${i}`, mtimeMs: now - i * 1000, size: 1 }))
  const p = R.planSync({ index, ledger: {}, now, sinceDays: 90, maxFiles: 3, maxBytes: 1e9 })
  assert.equal(p.fetch.length, 3)
  assert.equal(p.skippedOverBudget, 7)
})
check('maxBytes 上限生效（不会因为一个超大文件就全拉）', () => {
  const now = 1_800_000_000_000
  const index = [
    { path: '/huge', mtimeMs: now - 1000, size: 5000 },
    { path: '/small', mtimeMs: now - 2000, size: 100 },
  ]
  const p = R.planSync({ index, ledger: {}, now, sinceDays: 90, maxFiles: 10, maxBytes: 1000 })
  assert.deepEqual(p.fetch.map((e) => e.path), ['/small'])
  assert.equal(p.skippedOverBudget, 1)
  assert.equal(p.totalBytes, 100)
})

console.log('\n--- G. 端到端：真实日志 → 指纹 ---')
const ROOT = 'C:/Users/13676/.dsh/sessions'
function pickRealLog() {
  if (!fs.existsSync(ROOT)) return undefined
  let best
  for (const ws of fs.readdirSync(ROOT)) {
    const d = path.join(ROOT, ws)
    if (!fs.statSync(d).isDirectory()) continue
    for (const sid of fs.readdirSync(d)) {
      const f = path.join(d, sid, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(f)) continue
      const size = fs.statSync(f).size
      if (size > 200000 && (best === undefined || size > best.size)) best = { f, size }
    }
  }
  return best
}
const real = pickRealLog()
if (real === undefined) {
  console.log('SKIP  找不到真实日志样本')
} else {
  const buf = fs.readFileSync(real.f)
  check(`真实日志解码（${real.size} bytes，多重帧）`, () => {
    const text = R.decodeSessionLog(buf)
    const lines = text.split('\n').filter(Boolean)
    assert.ok(lines.length > 50, `解出的行数太少：${lines.length}`)
    for (const l of lines) JSON.parse(l) // 每行都必须是合法 JSON
  })
  check('base64 往返（模拟远端 base64 -w0 传回）', () => {
    const payload = buf.toString('base64') // 相当于远端 `base64 -w0` 的 stdout
    const back = R.decodeBase64Payload(payload)
    assert.equal(Buffer.compare(back, buf), 0, '往返后字节不一致')
  })
  check('base64 载荷容忍换行/空白', () => {
    const wrapped = buf.toString('base64').replace(/(.{60})/g, '$1\n')
    assert.equal(Buffer.compare(R.decodeBase64Payload(wrapped), buf), 0)
  })
  check('端到端：base64 → 解码 → 解析 → extract 指纹', () => {
    const fp = R.remotePayloadToFingerprint(buf.toString('base64'), { extract: EX, sourceId: 'remote-test' })
    assert.notEqual(fp, null, '返回了 null')
    assert.equal(fp.sourceId, 'remote-test')
    assert.equal(typeof fp.sessionId, 'string')
    assert.ok(fp.sessionId !== '')
    assert.equal(typeof fp.fingerprint, 'string')
    assert.ok(fp.fingerprint.length >= 8)
    assert.equal(typeof fp.perDay, 'object')
    console.log(`       ↳ sessionId=${fp.sessionId.slice(0, 24)}… turns=${fp.turns} 天=${Object.keys(fp.perDay).length} fp=${fp.fingerprint.slice(0, 12)}`)
  })
  check('与本地口径一致：extractSession 与 readSession 走同一个函数', () => {
    // 同一条日志，先走"远端路径"（手工解码），再走"本地路径"（模拟 sessionQuery 给出同样 events）
    const parsed = R.parseSessionLog(R.decodeSessionLog(buf))
    const viaRemote = EX.extractSession({ header: parsed.header, events: parsed.events, title: parsed.title })
    const viaLocal = EX.extractSession({ header: parsed.header, events: parsed.events })
    assert.equal(viaRemote.sessionId, viaLocal.sessionId)
    assert.equal(viaRemote.turns, viaLocal.turns)
    assert.deepEqual(Object.keys(viaRemote.perDay).sort(), Object.keys(viaLocal.perDay).sort())
  })
}

console.log('\n--- H. 纯函数约束 ---')
check('remote.js 不 import node: 之外的东西（除内联 fzstd 与 extract）', () => {
  const src = fs.readFileSync(new URL('../lib/remote.js', import.meta.url), 'utf8')
  const imports = [...src.matchAll(/^import .*?from '([^']+)'/gm)].map((m) => m[1])
  for (const spec of imports) {
    assert.ok(spec === './vendor/fzstd.mjs', `出现了未预期的 import：${spec}`)
  }
})
check('remote.js 不接触 ctx（二期由 index.js 注入执行器）', () => {
  const raw = fs.readFileSync(new URL('../lib/remote.js', import.meta.url), 'utf8')
  // 必须**先剥掉注释**再查：文件头注释里为了说明设计理由提到了 `ctx.subprocess` / `ctx.timeout`，
  // 那是文档不是代码。首版断言直接扫原文，误报了一次。
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const hit = /\bctx\s*\./.exec(code)
  assert.equal(hit, null, `代码里出现了 ctx. 引用：${hit === null ? '' : code.slice(Math.max(0, hit.index - 40), hit.index + 40)}`)
})

console.log('\n--- I. 来源定义与「添加来源」闭环 ---')
check('归一化合法来源', () => {
  const s = RS.normalizeRemoteSource({ label: 'rocs', sshAlias: 'rocs', dshHome: '/home/u/.dsh/', sinceDays: 30, now: 123 })
  assert.equal(s.id, 'rocs')
  assert.equal(s.kind, 'remote')
  assert.equal(s.dshHome, '/home/u/.dsh') // 去尾斜杠
  assert.equal(s.sinceDays, 30)
  assert.equal(s.enabled, true)
  assert.equal(s.lastSyncStatus, 'never')
  assert.equal(s.addedAt, 123)
})
check('中文名派生安全 id', () => {
  const s = RS.normalizeRemoteSource({ label: '东京 VPS', sshAlias: 'tokyo', dshHome: '/root/.dsh' })
  assert.match(s.id, /^[a-z0-9][a-z0-9_-]{0,31}$/)
  assert.equal(s.label, '东京 VPS')
})
mustThrow('拒绝占用保留 id local', () => RS.normalizeRemoteSource({ label: 'x', id: 'local', sshAlias: 'a', dshHome: '/a' }), /保留名/)
mustThrow('拒绝空名称', () => RS.normalizeRemoteSource({ label: '  ', sshAlias: 'a', dshHome: '/a' }), /名称不能为空/)
mustThrow('拒绝坏别名（透传 remote 的校验）', () => RS.normalizeRemoteSource({ label: 'x', sshAlias: 'a;b', dshHome: '/a' }), /别名不合法/)
mustThrow('拒绝相对 dshHome', () => RS.normalizeRemoteSource({ label: 'x', sshAlias: 'a', dshHome: 'rel/path' }), /绝对路径/)
mustThrow('拒绝坏 id', () => RS.normalizeRemoteSource({ label: 'x', id: 'Bad Id', sshAlias: 'a', dshHome: '/a' }), /id 不合法/)

check('缺失字段被识别（→ 提示词里要求用 ask_user_question 问）', () => {
  const miss = RS.missingFields({})
  assert.deepEqual(miss.map((m) => m.key), ['sshAlias', 'dshHome'])
  assert.deepEqual(RS.missingFields({ sshAlias: 'rocs', dshHome: '/a' }), [])
})

check('「添加来源」提示词含全部必需要素', () => {
  const p = RS.buildAddSourcePrompt({ label: 'rocs', sshAlias: 'rocs', dshHome: '/home/u/.dsh', sinceDays: 30 })
  assert.match(p, /f2a-ssh/)                       // 需求：默认使用 f2a-ssh 技能
  assert.match(p, /ControlMaster/)                 // 2FA 的正确解法
  assert.match(p, /ask_user_question/)             // 缺信息要问
  assert.match(p, /logwiki_import_source/)         // 落库工具
  assert.match(p, /session\.v4\.jsonl\.zstd/)      // 远端日志文件名
  assert.match(p, /30 天/)
  assert.equal(/需要你问/.test(p), false, '信息齐全时不应再标记"需要你问"')
})
check('信息缺失时提示词明确要求先问', () => {
  const p = RS.buildAddSourcePrompt({ label: '新服务器' })
  assert.match(p, /第一步：遇到任何缺失或不确定的信息/)
  assert.match(p, /\*\*（用户未填 —— 需要你问）\*\*/)
  assert.match(p, /sshAlias/)
  assert.match(p, /dshHome/)
})
check('信息齐全时也保留"该问就问"的指令（需求：要考虑智能体索要信息的情况）', () => {
  const p = RS.buildAddSourcePrompt({ label: 'rocs', sshAlias: 'rocs', dshHome: '/home/u/.dsh' })
  assert.match(p, /ask_user_question/)      // 无条件出现
  assert.match(p, /不要自己编一个值/)
  assert.equal(/需要你问/.test(p), false, '信息齐全时不应再标记某字段"需要你问"')
})
check('提示词提醒"不要反复重试直连"（f2a-ssh 的禁忌）', () => {
  const p = RS.buildAddSourcePrompt({ label: 'x', sshAlias: 'a', dshHome: '/a' })
  assert.match(p, /不要反复重试直连/)
})

console.log('\n--- J. logwiki_import_source 工具 ---')
check('工具定义形状正确（parameters 用 DSL，output.schema 用 JSON Schema）', () => {
  const tool = RS.makeImportSourceTool({ upsertSource: () => {} })
  assert.equal(tool.name, 'logwiki_import_source')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(tool.parameters.sshAlias.required, true)          // DSL：required 在属性内
  assert.deepEqual(tool.output.schema.required, ['ok', 'sourceId', 'label', 'sinceDays']) // JSON Schema：数组
  assert.equal(typeof tool.output.render, 'function')
})
check('execute 写入归一化后的来源并返回可渲染结果', async () => {
  const saved = []
  const tool = RS.makeImportSourceTool({ upsertSource: (s) => saved.push(s), now: () => 999 })
  return tool.execute({ label: 'rocs', sshAlias: 'rocs', dshHome: '/home/u/.dsh/', sinceDays: 30 }).then((r) => {
    assert.deepEqual(r, { ok: true, sourceId: 'rocs', label: 'rocs', sinceDays: 30 })
    assert.equal(saved.length, 1)
    assert.equal(saved[0].dshHome, '/home/u/.dsh')
    assert.equal(saved[0].addedAt, 999)
  })
})
check('execute 对非法输入抛错（不会写脏数据）', async () => {
  const saved = []
  const tool = RS.makeImportSourceTool({ upsertSource: (s) => saved.push(s) })
  let threw = false
  try {
    await tool.execute({ label: 'x', sshAlias: 'a;rm -rf /', dshHome: '/a' })
  } catch {
    threw = true
  }
  assert.equal(threw, true, '本应抛错')
  assert.equal(saved.length, 0, '抛错时不应写入')
})

await Promise.all(pending)

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  · ${f.name}  ${f.evidence}`)
  process.exitCode = 1
} else {
  process.exitCode = 0
}
