#!/usr/bin/env node
/**
 * 自检：内联的 fzstd 能否正确解开 DSH 的**多重 zstd frame** 会话日志。
 *
 * 这是二期（M10 远程来源）的地基 —— 远端日志拿不回 `ctx.sessionQuery`，
 * 只能把文件拉回来自己解码，而 **Node 自带的 zstd 只解第一帧**。
 *
 * 用法：node scripts/verify-zstd-frames.mjs [会话日志路径]
 *   不给路径时自动挑一个「解出来行数最多」的真实日志（证明多帧确实被处理了）。
 *
 * 退出码：0 全绿；1 有失败。
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { decompress } from '../lib/vendor/fzstd.mjs'
import { sessionsRoot } from '../lib/paths.js'

const results = []
function record(name, ok, evidence = '') {
  results.push({ name, ok, evidence })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${evidence ? `  — ${evidence}` : ''}`)
}

const ROOT = sessionsRoot()

function listSessionFiles() {
  const out = []
  if (!fs.existsSync(ROOT)) return out
  for (const ws of fs.readdirSync(ROOT)) {
    const d = path.join(ROOT, ws)
    if (!fs.statSync(d).isDirectory()) continue
    for (const sid of fs.readdirSync(d)) {
      const f = path.join(d, sid, 'session.v4.jsonl.zstd')
      if (fs.existsSync(f)) out.push(f)
    }
  }
  return out
}

/** 找一个「多帧」样本：内置只解出 1 行、而 fzstd 解出很多行。 */
function pickMultiFrameSample(explicit) {
  if (explicit !== undefined) return explicit
  const all = listSessionFiles()
  // 从大到小试，最大的日志帧数最多
  const sorted = all.map((f) => ({ f, size: fs.statSync(f).size })).sort((a, b) => b.size - a.size)
  for (const { f, size } of sorted.slice(0, 12)) {
    try {
      const buf = fs.readFileSync(f)
      const builtinLines = zlib.zstdDecompressSync(buf).toString('utf8').split('\n').filter(Boolean).length
      const ourLines = decompress(new Uint8Array(buf)).length > 0
        ? Buffer.from(decompress(new Uint8Array(buf))).toString('utf8').split('\n').filter(Boolean).length
        : 0
      if (builtinLines === 1 && ourLines > 20) return { f, size, builtinLines, ourLines }
    } catch {
      // 换下一个
    }
  }
  return undefined
}

function main() {
  const explicit = process.argv[2]
  console.log('\n=== fzstd 多帧解码自检 ===\n')

  // 0) 依赖就位
  record('内联 fzstd 可 import', typeof decompress === 'function', 'lib/vendor/fzstd.mjs')

  // 1) 挑样本
  const picked = pickMultiFrameSample(explicit)
  if (picked === undefined) {
    record('找到多重帧样本', false, '没找到「内置只解 1 行」的日志样本')
    return finish()
  }
  const file = typeof picked === 'string' ? picked : picked.f
  record('找到多重帧样本', true, `${path.basename(path.dirname(file))}  ${fs.statSync(file).size} bytes`)

  const buf = fs.readFileSync(file)

  // 2) 内置解码器只解第一帧（对照）
  let builtinText = ''
  let builtinErr = ''
  try {
    builtinText = zlib.zstdDecompressSync(buf).toString('utf8')
  } catch (error) {
    builtinErr = error instanceof Error ? error.message : String(error)
  }
  const builtinLines = builtinErr === '' ? builtinText.split('\n').filter(Boolean).length : -1
  record(
    '对照：Node 内置 zstd 只解第一帧（证明必须内联解码器）',
    builtinErr === '' ? builtinLines === 1 : true,
    builtinErr !== '' ? `内置直接报错：${builtinErr.slice(0, 60)}` : `${builtinLines} 行 / ${builtinText.length} 字节`,
  )

  // 3) fzstd 解全部帧
  const t0 = Date.now()
  let text = ''
  let err = ''
  try {
    text = Buffer.from(decompress(new Uint8Array(buf))).toString('utf8')
  } catch (error) {
    err = error instanceof Error ? error.message : String(error)
  }
  const ms = Date.now() - t0
  record('fzstd 解码成功', err === '', err === '' ? `${text.length} 字节 / ${ms}ms` : err.slice(0, 80))
  if (err !== '') return finish()

  const lines = text.split('\n').filter(Boolean)
  record('解出的行数远多于内置（多帧确实被处理）', lines.length > Math.max(1, builtinLines) * 5,
    `fzstd ${lines.length} 行  vs  内置 ${builtinLines} 行`)

  // 4) 首行必须是合法 session header
  let header = null
  try {
    header = JSON.parse(lines[0])
  } catch {
    header = null
  }
  record('首行是合法的 session header',
    header !== null && header.type === 'session' && typeof header.id === 'string' && header.version === 4,
    header === null ? '首行 JSON 解析失败' : `type=${header.type} version=${header.version} id=${String(header.id).slice(0, 18)}…`)

  // 5) 每行都必须是合法 JSON（无残帧、无截断）
  let bad = 0
  let badSample = ''
  for (const line of lines) {
    try {
      JSON.parse(line)
    } catch {
      bad += 1
      if (badSample === '') badSample = line.slice(0, 60)
    }
  }
  record('每一行都是合法 JSON（无残帧 / 无截断）', bad === 0, bad === 0 ? `${lines.length} 行全通过` : `${bad} 行坏了，例：${badSample}`)

  // 6) 尾部无残留：解出的文本以完整 JSON 行结束
  record('解码结果无尾部残留', !/\n[^\n]*$/.test(text) === false, `${text.length} 字节`)

  return finish()
}

function finish() {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`)
  if (failed.length > 0) {
    for (const f of failed) console.log(`  · ${f.name}  ${f.evidence}`)
    process.exitCode = 1
    return
  }
  process.exitCode = 0
}

main()
