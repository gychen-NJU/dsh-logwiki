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
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import * as R from '../lib/remote.js'
import * as RS from '../lib/remote-sources.js'
import * as EX from '../lib/extract.js'
import { apply, parameterSchemaProblem, schemaFingerprint } from '../lib/index.js'
import { dshHome, sessionsRoot, vendorRoots } from '../lib/paths.js'

/** 本仓库的 dsh-logwiki 包根（隐私门要扫 lib/ 与 scripts/）。 */
const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

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
const ROOT = sessionsRoot()
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
check('来源工具输入和输出都是对象型 JSON Schema', () => {
  const tool = RS.makeImportSourceTool({ upsertSource: () => {} })
  assert.equal(tool.name, 'logwiki_import_source')
  assert.equal(typeof tool.execute, 'function')
  const input = JSON.parse(JSON.stringify(tool.parameters))
  assert.equal(input.type, 'object')
  assert.deepEqual(input.required, ['label', 'sshAlias', 'dshHome'])
  assert.equal(input.properties.sshAlias.type, 'string')
  assert.equal(input.properties.sshAlias.required, undefined)
  assert.deepEqual(tool.output.schema.required, ['ok', 'sourceId', 'label', 'sinceDays'])
  assert.equal(typeof tool.output.render, 'function')
})
check('注册给 tools 服务的两个工具均可序列化为对象型输入 JSON Schema', async () => {
  const registered = []
  let resolveRegistration
  const registration = new Promise((resolve) => { resolveRegistration = resolve })
  const services = {
    webServer: { register: () => () => {} },
    tools: { register: (def) => {
      registered.push(def)
      if (registered.length === 2) resolveRegistration()
      return () => {}
    } },
  }
  apply({
    get: (key) => services[key],
    effect: (setup) => setup(),
    inject: () => () => {},
  })
  let timeout
  try {
    await Promise.race([
      registration,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('两个工具未在 2 秒内完成注册')), 2000) }),
    ])
  } finally {
    clearTimeout(timeout)
  }
  const tools = new Map(registered.map((def) => [def.name, def]))
  assert.deepEqual([...tools.keys()], ['logwiki_write_digest', 'logwiki_import_source'])
  for (const [name, def] of tools) {
    const input = JSON.parse(JSON.stringify(def.parameters))
    assert.equal(input.type, 'object', `${name} 缺顶层 object`)
    assert.equal(Array.isArray(input.required), true, `${name} 缺 required 数组`)
    assert.equal(typeof input.properties, 'object', `${name} 缺 properties`)
    assert.equal(input.additionalProperties, false)
    assert.equal(input.properties.required, undefined)
  }
  const digest = tools.get('logwiki_write_digest').parameters
  assert.deepEqual(digest.required, ['kind', 'period', 'items'])
  assert.equal(digest.properties.kind.required, undefined)
  assert.equal(digest.properties.items.items.type, 'object')
  assert.deepEqual(digest.properties.items.items.required, ['summary'])
  assert.equal(digest.properties.items.items.properties.summary.required, undefined)
  assert.deepEqual(tools.get('logwiki_import_source').parameters.required, ['label', 'sshAlias', 'dshHome'])
})
// ---------------------------------------------------------------- 回归锁：旧写法必红
// 2026-10-01 的真实故障：parameters 用 defineTool DSL 的属性简写表（required 写在属性内、
// 没有顶层 type），tools.register 不校验 parameters，于是每一次模型请求都报
//   Invalid schema for function '...': schema must be a JSON Schema of 'type: "object"', got 'type: null'
// 下面这条断言**在修复前必红**——它是本次修复的判别力证明，不是恒真式。
check('回归锁：修复前的 DSL 简写表必须被判为不合格', () => {
  const oldShape = {
    label: { type: 'string', required: true, description: '来源的短名称' },
    sshAlias: { type: 'string', required: true },
    dshHome: { type: 'string', required: true },
    sinceDays: { type: 'number' },
  }
  const problem = parameterSchemaProblem(oldShape)
  assert.equal(typeof problem, 'string')
  assert.match(problem, /type 必须是 'object'/)
  // 简报工具修复前的形状同罪
  const oldDigestShape = {
    kind: { type: 'string', required: true, enum: ['week', 'month'] },
    period: { type: 'string', required: true },
    items: { type: 'array', required: true, items: { type: 'object', properties: {} } },
  }
  assert.equal(typeof parameterSchemaProblem(oldDigestShape), 'string')
})
check('自检真值表：合格形状通过，各类坏形状各有原因', () => {
  const ok = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }
  assert.equal(parameterSchemaProblem(ok), null)
  assert.equal(parameterSchemaProblem({ type: 'object', properties: {} }), null) // required 可省略
  assert.match(parameterSchemaProblem(null), /必须是对象/)
  assert.match(parameterSchemaProblem('nope'), /必须是对象/)
  assert.match(parameterSchemaProblem([]), /必须是对象/)
  assert.match(parameterSchemaProblem({ properties: {} }), /type 必须是 'object'/)
  assert.match(parameterSchemaProblem({ type: 'object' }), /properties 必须是对象/)
  assert.match(parameterSchemaProblem({ type: 'object', properties: [] }), /properties 必须是对象/)
  assert.match(parameterSchemaProblem({ type: 'object', properties: {}, required: 'a' }), /required 必须是数组/)
})
check('生产路径：实际注册的两个工具都过自检，且指纹可复算', async () => {
  const registered = []
  let resolveRegistration
  const registration = new Promise((resolve) => { resolveRegistration = resolve })
  const services = {
    webServer: { register: () => () => {} },
    tools: { register: (def) => {
      registered.push(def)
      if (registered.length === 2) resolveRegistration()
      return () => {}
    } },
  }
  apply({
    get: (key) => services[key],
    effect: (setup) => setup(),
    inject: () => () => {},
  })
  let timeout
  try {
    await Promise.race([
      registration,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('两个工具未在 2 秒内完成注册')), 2000) }),
    ])
  } finally {
    clearTimeout(timeout)
  }
  assert.equal(registered.length, 2)
  for (const def of registered) {
    assert.equal(parameterSchemaProblem(def.parameters), null, `${def.name} 未过自检`)
    // 指纹算法固定：sha256(JSON.stringify(parameters)) 前 16 位。验收时用它对
    // 运行中实例的 /health.tools.inputFingerprints 做逐字比对。
    const fp = await schemaFingerprint(def.parameters)
    assert.equal(typeof fp, 'string')
    assert.equal(fp.length, 16)
    assert.equal(fp, fp.toLowerCase())
  }
  // 指纹必须区分得开两个工具（否则比对无意义）
  const [a, b] = await Promise.all(registered.map((d) => schemaFingerprint(d.parameters)))
  assert.notEqual(a, b)
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

console.log('\n--- K. 路径派生（公开仓库不许出现本机用户名/盘符） ---')
check('路径只由 $DSH_HOME / 惯例目录派生，且不依赖具体用户名', () => {
  const saved = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = path.join(os.tmpdir(), 'dsh-home-for-test')
    assert.equal(dshHome(), process.env.DSH_HOME)
    assert.equal(sessionsRoot(), path.join(process.env.DSH_HOME, 'sessions'))
    // 纯空白视为未设（与 dsh 本体口径一致）
    process.env.DSH_HOME = '   '
    assert.notEqual(dshHome(), process.env.DSH_HOME)
    assert.ok(dshHome().length > 0)
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
  // 未设时退回 ~/.dsh
  delete process.env.DSH_HOME
  assert.equal(dshHome(), path.join(os.homedir(), '.dsh'))
})
check('vendorRoots() 只返回真实存在的目录，且顺序稳定', () => {
  const a = vendorRoots()
  const b = vendorRoots()
  assert.deepEqual(a, b)
  for (const root of a) assert.equal(fs.existsSync(root), true, `返回了不存在的根：${root}`)
  assert.ok(a.length > 0, '本机应至少命中一个解析根')
})
check('隐私门：lib/ 与 scripts/ 里不得出现真实的家目录用户名', () => {
  const offenders = []
  const dirs = [path.join(ROOT_DIR, 'lib'), path.join(ROOT_DIR, 'scripts')]
  /**
   * 只抓「家目录 + 一个**具体**用户名」这一种形态：
   *   `C:/Users/<name>`、`/Users/<name>`、`/home/<name>`
   * 允许名单里放的是**占位符**与测试用短名 —— 它们不是任何人的真实账号。
   * 这样既不误伤 `/home/u/.dsh`（测试数据）、`/home/../etc`（路径穿越用例），
   * 又能抓住 `/home/<真实账号>/.dsh` 这类**远端路径泄漏**。
   */
  const HOME_PATH_RE = /(?:C:[\\/]Users[\\/]|\/Users\/|\/home\/)([A-Za-z0-9._-]+)/g
  const PLACEHOLDERS = new Set(['u', 'user', 'me', 'you', 'someone', 'root', 'username', 'name', '..', '.'])
  for (const dir of dirs) {
    for (const file of fs.readdirSync(dir)) {
      if (!/\.(mjs|js)$/.test(file)) continue
      const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n')
      lines.forEach((line, i) => {
        for (const match of line.matchAll(HOME_PATH_RE)) {
          const who = match[1]
          if (PLACEHOLDERS.has(who)) continue
          if (/^[a-z]{1,2}$/.test(who)) continue // 单/双字母是测试用短名
          offenders.push(`${file}:${i + 1} → ${match[0]}${who}`)
        }
      })
    }
  }
  assert.deepEqual(offenders, [], `命中真实用户名路径：${offenders.join(' | ')}`)
})

check('打包门：lib/ 下每个文件都列进 package.json 的 files', () => {
  // `files` 是逐个文件白名单 —— 新增一个 lib 模块却忘了登记，本地一切正常、
  // 发布出去却缺文件（本次新增 lib/paths.js 就差点漏掉）。格式差异在这里一次性挡掉。
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'))
  const listed = new Set(pkg.files ?? [])
  const missing = fs
    .readdirSync(path.join(ROOT_DIR, 'lib'))
    .filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
    .map((f) => `lib/${f}`)
    .filter((rel) => !listed.has(rel))
  assert.deepEqual(missing, [], `未登记进 package.json files：${missing.join(', ')}`)
})

console.log('\n--- L. 实例分库（多实例各写各的 unit） ---')
check('unit 名派生：合法、稳定、能区分实例', async () => {
  const { unitNameFor, sanitizeUnitSuffix, DEFAULT_UNIT_NAME, UNIT_NAME_RE } = await import('../lib/store.js')
  // 无标识 → 保持历史默认名（向后兼容）
  assert.equal(unitNameFor(''), DEFAULT_UNIT_NAME)
  assert.equal(unitNameFor(undefined), DEFAULT_UNIT_NAME)
  assert.equal(DEFAULT_UNIT_NAME, 'dsh_logwiki')
  // 两个实例必须落到不同 unit
  assert.equal(unitNameFor('web'), 'dsh_logwiki_web')
  assert.equal(unitNameFor('desktop'), 'dsh_logwiki_desktop')
  assert.notEqual(unitNameFor('web'), unitNameFor('desktop'))
  // DSH 的硬约束：^[a-z][a-z0-9_]*$ —— 点号/连字符/大写都非法，必须被清洗掉
  assert.equal(sanitizeUnitSuffix('open-design'), 'open_design')
  assert.equal(unitNameFor('open-design'), 'dsh_logwiki_open_design')
  assert.equal(unitNameFor('WEB'), 'dsh_logwiki_web')
  assert.equal(unitNameFor('web.prod'), 'dsh_logwiki_web_prod')
  // 各种脏输入都必须产出**合法**名字（否则 store 初始化会失败）
  for (const nasty of ['', '  ', '9', '9x', '!!!', '-', 'a'.repeat(80), '中文', 'a/b\\c', 'x'.repeat(200)]) {
    const name = unitNameFor(nasty)
    assert.match(name, UNIT_NAME_RE, `脏输入 ${JSON.stringify(nasty)} 产出非法 unit 名：${name}`)
  }
  // 长度受限
  assert.ok(unitNameFor('a'.repeat(200)).length <= 48)
})
check('createStore 接受合法 unit、拒绝非法 unit（退回默认名而不是抛错）', async () => {
  const { createStore, DEFAULT_UNIT_NAME } = await import('../lib/store.js')
  // ctx 故意不可用 → 走"纯内存降级"分支，但仍能读到 unitName
  const ctx = { get: () => undefined, logger: undefined }
  const okStore = createStore(ctx, { unit: 'dsh_logwiki_web' })
  assert.equal(okStore.unitName, 'dsh_logwiki_web')
  const badStore = createStore(ctx, { unit: 'dsh_logwiki.web' }) // 点号非法
  assert.equal(badStore.unitName, DEFAULT_UNIT_NAME)
  const noOptStore = createStore(ctx)
  assert.equal(noOptStore.unitName, DEFAULT_UNIT_NAME)
  await Promise.all([okStore.ready, badStore.ready, noOptStore.ready])
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
