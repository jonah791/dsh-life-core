/**
 * 状态层日界契约：`today()` 必须取**本地**自然日。
 *
 * 事故背景（2026-09-22 08:00 实测捕获）：原实现 `new Date().toISOString().slice(0, 10)`
 * 取的是 **UTC 日历日**，而本机是 UTC+8 ⇒ 本地 08:00 一到 UTC 就跨天，
 * `todayTurns`（「今日第 N 圈」）被腰斩：00:00–08:00 的圈记进"昨天"。
 * 更糟的是同一份状态行里 `inject.ts` 的小时用的是**本地** `getHours()`
 * ⇒ 一行读数混着两个时区（AGENTS.md §5.9 规则 6 的实例）。
 *
 * 判据分两层，区分力不同，**不要只看行为断言**：
 * - 行为断言：只在**本地 00:00–08:00** 这个窗口内才能抓到 UTC 实现（其余时间两者日期相同）。
 * - 构建产物断言：恒有区分力——`lib/` 是线上真正跑的东西，它含 `toISOString` 就是没修好。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { today } from '../lib/state.js'

const here = dirname(fileURLToPath(import.meta.url))

test('构建产物：today() 不得用 toISOString（恒有区分力——lib 即线上）', () => {
  const src = readFileSync(join(here, '..', 'lib', 'state.js'), 'utf8')
  const m = /export function today\(\)[^{]*\{[\s\S]*?\n\}/.exec(src)
  assert.ok(m !== null, '未在 lib/state.js 找到 today() 定义（导出名变了？）')
  assert.ok(
    !/toISOString/.test(m[0]),
    'today() 里出现 toISOString ⇒ 取的是 UTC 日，本地 08:00 会腰斩「今日圈数」',
  )
})

test('行为：today() 等于本地日期（区分力受时间窗限制，见文件头注释）', () => {
  const d = new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  const expected = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
  assert.equal(today(), expected)
})

test('日期键形状：YYYY-MM-DD', () => {
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/)
})
