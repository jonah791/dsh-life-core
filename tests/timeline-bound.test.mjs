/**
 * 时间线上界契约：`readTimeline(n)` 必须**只回最近 n 条**。
 *
 * 事故背景（2026-09-25 05:30 实测捕获）：原实现
 *   lines.slice(-Math.max(limit, lines.length))
 * `Math.max` 让上界恒等于总行数 ⇒ `slice(-len)` 返回**全量**，`limit` 空转。
 * 症状：`life_core_status(includeTimeline=true)` 一次吐 **375,580 字节**
 * （自 08-18 起的全部存在事件），且随天数增长——增长型上下文炸弹。
 *
 * 判据两层，都要有：
 * - 行为断言（尸体样本）：喂 200 行 ⇒ 断言只回 10 条且是**最新**那批（旧实现必红：200 ≠ 10）。
 * - 构建产物断言：`lib/` 是线上真正跑的东西——它若仍含 `Math.max(limit` 就是没修好。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// 夹具：临时 DSH_HOME。`lifeCoreDir()` 每次调用现算 ⇒ 导入前设好 env 即可。
const home = mkdtempSync(join(tmpdir(), 'life-core-timeline-'))
process.env.DSH_HOME = home
const dir = join(home, 'life-core')
mkdirSync(dir, { recursive: true })

const TOTAL = 200
const rows = []
for (let i = 1; i <= TOTAL; i += 1) {
  rows.push(JSON.stringify({
    at: new Date(Date.now() - (TOTAL - i) * 60000).toISOString(),
    kind: 'turn',
    summary: `事件 ${i}`,
  }))
}
writeFileSync(join(dir, 'life-log.jsonl'), rows.join('\n') + '\n', 'utf8')

const { readTimeline } = await import('../lib/timeline.js')

test('尸体样本：200 行只回 limit 条（旧实现必红）', () => {
  const got = readTimeline(10)
  assert.equal(got.length, 10, `readTimeline(10) 应回 10 条，实回 ${got.length} 条（Math.max 反转的老毛病）`)
  assert.equal(got.at(-1).summary, '事件 200', '回的必须是最新那一批（slice 方向）')
  assert.equal(got[0].summary, '事件 191')
})

test('缺省 50 条', () => {
  assert.equal(readTimeline().length, 50)
})

test('limit 越界自动收敛（不报错、不补空）', () => {
  assert.equal(readTimeline(1000).length, TOTAL)
})

test('limit <= 0 显式空数组（slice(-0) 会变全量，防回归）', () => {
  assert.equal(readTimeline(0).length, 0)
  assert.equal(readTimeline(-5).length, 0)
})

test('构建产物：lib/timeline.js 不得再出现 Math.max(limit（恒有区分力）', () => {
  const src = readFileSync(join(here, '..', 'lib', 'timeline.js'), 'utf8')
  const m = /export function readTimeline[\s\S]*?\n\}/.exec(src)
  assert.ok(m !== null, '未在 lib/timeline.js 找到 readTimeline（导出名变了？）')
  assert.ok(
    !/Math\.max\(limit/.test(m[0]),
    'readTimeline 仍用 Math.max(limit, …) ⇒ 上界恒等于总行数，limit 空转',
  )
})
