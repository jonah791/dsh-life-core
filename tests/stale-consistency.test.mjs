/**
 * stale-consistency.test.mjs — **契约测试**：两处独立的「停滞判定」必须同构。
 *
 * 背景：`life-core` 不能 import `taskboard` 的源码（插件之间禁读内部，AGENTS.md §3.4），
 * 所以本仓有**两份**超期判定实现：
 *   · `self-plugins/dsh-agent-taskboard/src/statemachine.ts` 的 `staleOf()` —— 权威（有 I15 契约）
 *   · `self-plugins/dsh-life-core/src/stale-signal.ts` 的 `staleIdsOf()` —— 信号侧（要能读板面就自己判）
 *
 * 两份实现可以独立演进，但**语义分叉必须当场被抓住**——这个文件就是那道网。
 * 它比共享代码轻（不动包结构、不让两个插件焊死），而失败是响的。
 *
 * ⚠ 这是「两个实现 + 一个契约测试」而不是「一个实现两处调用」的代价：
 *   分叉只在测试跑的时候被发现，不在编译时。所以**两个文件改任何一处都必须跑这个测试**。
 *   如果将来出现第三个消费者，就该把判定抽成共享包——那时共享的收益大于耦合的成本。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { staleIdsOf } from '../lib/stale-signal.js'
import { staleOf } from '../../dsh-agent-taskboard/lib/statemachine.js'

const NOW = Date.parse('2026-11-01T06:00:00.000Z')
const DAY = 86_400_000
const iso = (ms) => new Date(ms).toISOString()

/** 跑两边并把结果归一成**排序后的 id 数组**（两边排序规则不同：一边按 id、一边按停滞天数降序）。 */
function both(tasks, opts = {}) {
  const a = staleIdsOf(tasks, { nowMs: NOW, ...opts }).slice().sort()
  const b = staleOf(tasks, { nowMs: NOW, ...opts }).map((t) => String(t.id)).sort()
  return { a, b }
}

/** 断言两边一致，失败时把分歧点原样打出来。 */
function assertSame(tasks, opts = {}, label = '') {
  const { a, b } = both(tasks, opts)
  assert.deepEqual(
    a, b,
    (label === '' ? '' : label + '：') + '两份实现判出了不同的超期集合\n'
    + '  life-core staleIdsOf: ' + JSON.stringify(a) + '\n'
    + '  taskboard staleOf  : ' + JSON.stringify(b),
  )
}

// ——————————————————— 固定样本 ———————————————————

test('一致性 · 基本：只有 updatedAt 的普通任务', () => {
  assertSame([
    { id: 'fresh', status: 'pending', updatedAt: iso(NOW - 1 * DAY) },
    { id: 'stale', status: 'pending', updatedAt: iso(NOW - 5 * DAY) },
  ], {}, '基本')
})

test('一致性 · 终态排除：done/cancelled 无论多老都不算', () => {
  assertSame([
    { id: 'd', status: 'done', updatedAt: iso(NOW - 100 * DAY) },
    { id: 'c', status: 'cancelled', updatedAt: iso(NOW - 100 * DAY) },
    { id: 'p', status: 'pending', updatedAt: iso(NOW - 100 * DAY) },
    { id: 'b', status: 'blocked', updatedAt: iso(NOW - 100 * DAY) },
    { id: 'cl', status: 'claimed', updatedAt: iso(NOW - 100 * DAY) },
  ], {}, '终态排除')
})

test('一致性 · 回退链：updatedAt 优先，其次 claimedAt，最后 createdAt', () => {
  assertSame([
    { id: 'u', status: 'pending', updatedAt: iso(NOW - 10 * DAY), createdAt: iso(NOW) },
    { id: 'c', status: 'pending', claimedAt: iso(NOW - 10 * DAY) },
    { id: 'r', status: 'pending', createdAt: iso(NOW - 10 * DAY) },
    { id: 'mixed', status: 'claimed', updatedAt: iso(NOW - 1 * DAY), claimedAt: iso(NOW - 50 * DAY) },
  ], {}, '回退链')
})

test('一致性 · 边界：恰好等于阈值 **不** 算超期（两边都是「大于」才报）', () => {
  assertSame([
    { id: 'exact3', status: 'pending', updatedAt: iso(NOW - 3 * DAY) },
    { id: 'over3', status: 'pending', updatedAt: iso(NOW - 3 * DAY - 1) },
  ], {}, '阈值边界')
})

test('一致性 · 自定义阈值 staleDays=7', () => {
  assertSame([
    { id: 'a6', status: 'pending', updatedAt: iso(NOW - 6 * DAY) },
    { id: 'a8', status: 'pending', updatedAt: iso(NOW - 8 * DAY) },
  ], { staleDays: 7 }, '自定义阈值')
})

test('一致性 · 时间戳缺失 / 不可解析 ⇒ 两边都跳过', () => {
  assertSame([
    { id: 'none', status: 'pending' },
    { id: 'bad', status: 'pending', updatedAt: '不是日期' },
    { id: 'empty', status: 'pending', updatedAt: '' },
    { id: 'ok', status: 'pending', updatedAt: iso(NOW - 9 * DAY) },
  ], {}, '缺失/坏时间戳')
})

test('一致性 · 空板 / 全终态', () => {
  assertSame([], {}, '空板')
  assertSame([
    { id: 'x', status: 'done', updatedAt: iso(NOW - 99 * DAY) },
  ], {}, '全终态')
})

// ——————————————————— 确定性伪随机（固定种子，可复现） ———————————————————

/**
 * 用固定种子造样本：线性同余，**不依赖 Math.random** ⇒ 每次跑都是同一批数据。
 * 这一点很重要：随机样本若不可复现，失败时无法重放。
 */
function pseudoSamples(n, seed = 20261101) {
  let s = seed >>> 0
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
  const statuses = ['pending', 'claimed', 'blocked', 'done', 'cancelled', 'unknown']
  const out = []
  for (let i = 0; i < n; i++) {
    const status = statuses[Math.floor(next() * statuses.length)]
    const idleDays = Math.floor(next() * 20)
    const shape = Math.floor(next() * 4)
    const t = { id: 'r' + String(i).padStart(3, '0'), status }
    if (shape === 0) t.updatedAt = iso(NOW - idleDays * DAY)
    else if (shape === 1) { t.claimedAt = iso(NOW - idleDays * DAY); t.createdAt = iso(NOW - (idleDays + 5) * DAY) }
    else if (shape === 2) t.createdAt = iso(NOW - idleDays * DAY)
    // shape 3：三个都不给
    out.push(t)
  }
  return out
}

test('★ 一致性 · 200 条确定性伪随机样本（覆盖全部状态 × 四种时间戳形状）', () => {
  const samples = pseudoSamples(200)
  assertSame(samples, {}, '200 条随机样本')
  // 防止样本因某种原因全空（那会让这条测试恒真）
  const { a } = both(samples)
  assert.ok(a.length > 20, '样本里应当有足够多的超期项，否则这条测试没有区分力（实际 ' + String(a.length) + '）')
})

test('★ 一致性 · 同一批样本在 staleDays=1 / 3 / 7 / 30 四个阈值下都同构', () => {
  const samples = pseudoSamples(120, 777)
  for (const days of [1, 3, 7, 30]) {
    assertSame(samples, { staleDays: days }, 'staleDays=' + String(days))
  }
})
