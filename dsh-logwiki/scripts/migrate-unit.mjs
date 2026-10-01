#!/usr/bin/env node
/**
 * dsh-LogWiki · storage unit 迁移（把老库挂到新的实例 unit 上）
 *
 * 为什么需要它：多实例分库后，每个实例用**自己的** unit（`dsh_logwiki_<profile>`），
 * 而历史数据都在旧的 `dsh_logwiki` 里 —— 不迁移的话，重启后日历会显示为空。
 *
 * ⚠️ **不能只改文件名**：DSH 的 JSON 存储单元在文件头里写着 `unit.name`，
 * 打开时会校验 `unit.name === 期望名`，不一致直接抛
 * `missing or foreign unit header`。所以本脚本会**同时改写头部**。
 *
 * 用法：
 *   node scripts/migrate-unit.mjs <目标unit> [--from dsh_logwiki] [--dry-run] [--force]
 *
 * 例：
 *   node scripts/migrate-unit.mjs dsh_logwiki_web       # 老库 → web 实例
 *   node scripts/migrate-unit.mjs dsh_logwiki_desktop   # 老库 → 桌面端实例
 *
 * 行为：默认**不覆盖**已存在的目标 unit（避免把已经跑起来的新数据冲掉）；
 *       要覆盖得显式给 --force。源文件**永不改动**。
 * 退出码：0 成功/无操作；1 出错；2 用法错误。
 */

import fs from 'node:fs'
import path from 'node:path'

import { dshHome } from '../lib/paths.js'
import { UNIT_NAME_RE } from '../lib/store.js'

const ARGS = process.argv.slice(2)
const flag = (name) => ARGS.includes(name)
const valueOf = (name, fallback) => {
  const i = ARGS.indexOf(name)
  return i >= 0 && ARGS[i + 1] !== undefined ? ARGS[i + 1] : fallback
}
const target = ARGS.find((a) => !a.startsWith('--'))
const source = valueOf('--from', 'dsh_logwiki')
const dryRun = flag('--dry-run')
const force = flag('--force')

function die(message, code = 1) {
  console.error(`✗ ${message}`)
  process.exitCode = code
}

if (target === undefined) {
  die('缺少目标 unit 名。用法：node scripts/migrate-unit.mjs <目标unit> [--from dsh_logwiki] [--dry-run] [--force]', 2)
} else if (!UNIT_NAME_RE.test(target)) {
  // 先把最常见的误用拦下来：DSH 的 unit 名不允许点号/连字符
  die(`目标 unit 名不合法：${JSON.stringify(target)}（DSH 要求 ${String(UNIT_NAME_RE)}，例如 dsh_logwiki_web）`, 2)
} else {
  const dir = path.join(dshHome(), 'storages')
  const src = path.join(dir, `${source}.json`)
  const dst = path.join(dir, `${target}.json`)

  if (!fs.existsSync(src)) {
    die(`源 unit 不存在：${src}\n  （如果已经迁移过、或从不曾用过默认 unit，本步可以直接跳过）`)
  } else if (fs.existsSync(dst) && !force) {
    console.log(`= 目标已存在，跳过（要覆盖请加 --force）：${dst}`)
  } else {
    let doc
    try {
      doc = JSON.parse(fs.readFileSync(src, 'utf8'))
    } catch (error) {
      die(`源文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
    }
    if (doc === undefined) {
      // die() 已经报错，走到这里就结束
    } else if (doc?.unit?.name !== source) {
      die(`源文件头部的 unit.name 是 ${JSON.stringify(doc?.unit?.name)}，与文件名 ${source} 不符，拒绝迁移`)
    } else {
      const global = doc.global ?? {}
      const counts = {
        sessions: Object.keys(global.sessions ?? {}).length,
        entries: Object.keys(global.entries ?? {}).length,
        sources: Object.keys(global.sources ?? {}).length,
      }
      doc.unit.name = target
      const text = `${JSON.stringify(doc, null, 2)}\n`
      const sizeKb = (fs.statSync(src).size / 1024).toFixed(1)
      console.log(`源：${src}（${sizeKb} KB，unit.name=${source}）`)
      console.log(`    global 概况：会话 ${counts.sessions} · 条目 ${counts.entries} · 来源 ${counts.sources}`)
      console.log(`目标：${dst}（unit.name 将改写为 ${target}）`)
      if (dryRun) {
        console.log('--dry-run：只检查，不写文件。')
      } else {
        fs.writeFileSync(dst, text, 'utf8')
        console.log(`✓ 已写入 ${dst}（${(fs.statSync(dst).size / 1024).toFixed(1)} KB）`)
        console.log('  源文件未改动。重启对应实例后即可看到数据；两个实例要各自跑一次本命令。')
      }
    }
  }
}
