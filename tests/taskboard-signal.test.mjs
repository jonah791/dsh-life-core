/**
 * pendingTaskSignal 离线单测（2026-09-01 主人定调：任务领取由生命核心驱动）。
 * node --test 跑 lib 产物（dsh-plugin-testability 纪律）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pendingTaskSignal } from '../lib/activate.js'

const dir = join(tmpdir(), 'dsh-life-core-test-' + process.pid)
mkdirSync(dir, { recursive: true })
const board = (name, tasks) => {
  const file = join(dir, name)
  writeFileSync(file, JSON.stringify({ tasks }), 'utf8')
  return file
}

test.after(() => rmSync(dir, { recursive: true, force: true }))

test('pending 任务生成信号（含 id 与标题）', () => {
  const file = board('a.json', [
    { id: 't-1', title: '写周报', status: 'pending', priority: 'normal' },
    { id: 't-2', title: '已完成', status: 'done', priority: 'high' },
  ])
  const out = pendingTaskSignal(file)
  assert.ok(out)
  assert.match(out, /任务板待领取 1 项/)
  assert.match(out, /· 写周报（t-1）/)
  assert.doesNotMatch(out, /已完成|t-2/)
})

test('按优先级排序：high 在前', () => {
  const file = board('b.json', [
    { id: 't-low', title: '低', status: 'pending', priority: 'low' },
    { id: 't-high', title: '高', status: 'pending', priority: 'high' },
    { id: 't-norm', title: '中', status: 'pending', priority: 'normal' },
  ])
  const out = pendingTaskSignal(file)
  assert.ok(out)
  const order = [...out.matchAll(/t-(\w+)/g)].map((m) => m[1])
  assert.deepEqual(order.slice(0, 3), ['high', 'norm', 'low'])
  assert.match(out, /t-high.*high/, 'high 项应标注优先级')
})

test('超过 5 项截断并提示剩余', () => {
  const tasks = Array.from({ length: 8 }, (_, i) => ({ id: 't-' + i, title: '任务' + i, status: 'pending' }))
  const out = pendingTaskSignal(board('c.json', tasks))
  assert.ok(out)
  assert.match(out, /任务板待领取 8 项/)
  assert.match(out, /另有 3 项待领取/)
  assert.equal([...out.matchAll(/· 任务\d+（/g)].length, 5)
})

test('无 pending 返回 undefined（零噪音）', () => {
  assert.equal(pendingTaskSignal(board('d.json', [{ id: 't-1', title: 'x', status: 'claimed' }])), undefined)
  assert.equal(pendingTaskSignal(board('e.json', [])), undefined)
})

test('文件缺失/坏 JSON 返回 undefined（静默失败）', () => {
  assert.equal(pendingTaskSignal(join(dir, 'nope.json')), undefined)
  const broken = join(dir, 'broken.json')
  writeFileSync(broken, '{ not json', 'utf8')
  assert.equal(pendingTaskSignal(broken), undefined)
})
