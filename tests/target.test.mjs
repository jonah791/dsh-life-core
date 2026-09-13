// 圈投递目标选举 —— 含现场尸体样本（2026-09-13「感知圈怎么发到别的会话了」事故）
import test from 'node:test'
import assert from 'node:assert/strict'
import { isUserSession, electCircleTarget } from '../lib/target.js'

// 形如真实会话 id：session-<8>-<4>-<4>-<4>-<12>（首段恰好 8 位，否则 isUserSession 判假）
const U = (n) => `session-${String(n).padEnd(8, '0').slice(0, 8)}-0000-0000-0000-000000000000`
const SUB = '0a46064f-0717-4ac7-a7e3-f812f2af667a' // 事故现场：3 个裸 uuid 会话各收到 17 圈

test('isUserSession：session- 前缀才是人用的会话，裸 uuid 是派生的', () => {
  assert.equal(isUserSession(U('879c4ae1')), true)
  assert.equal(isUserSession(SUB), false)
  assert.equal(isUserSession('25598766-a618-4bf0-ac31-ed07c0439631'), false)
  assert.equal(isUserSession(''), false)
})

test('尸体样本：候选里混着 3 个子代理会话 → 必须选用户会话，且排除计数=3', () => {
  const r = electCircleTarget([
    { id: SUB, lastActiveAt: 1_000_000 },
    { id: '52d0a200-14a3-48f7-86ae-f2b67aee9201', lastActiveAt: 2_000_000 },
    { id: '46aa27bc-878a-4de7-b599-ac605b28fa51', lastActiveAt: 3_000_000 },
    { id: U('879c4ae1'), lastActiveAt: 500_000 },
  ], { now: 1_000_000 })
  assert.ok(r)
  assert.equal(r.targetId, U('879c4ae1'))
  assert.equal(r.excludedDerived, 3)
})

test('锚点在候选且新鲜 → 用锚点（哪怕别的会话更活跃）', () => {
  const r = electCircleTarget([
    { id: U('879c4ae1'), lastActiveAt: 900_000 },
    { id: U('ffbdacf2'), lastActiveAt: 999_000 },
  ], { pinned: U('879c4ae1'), now: 1_000_000, pinnedFreshMs: 600_000 })
  assert.equal(r.targetId, U('879c4ae1'))
  assert.match(r.reason, /锚点/)
})

test('锚点腐化（不在候选）→ 改投最近活跃用户会话 + 留理由', () => {
  const r = electCircleTarget([
    { id: U('879c4ae1'), lastActiveAt: 100 },
    { id: U('ffbdacf2'), lastActiveAt: 999_000 },
  ], { pinned: U('deadbeef'), now: 1_000_000 })
  assert.equal(r.targetId, U('ffbdacf2'))
  assert.match(r.reason, /腐化|不在候选/)
})

test('候选全是派生会话 → null（响亮留痕，不投给子代理）', () => {
  const r = electCircleTarget([{ id: SUB, lastActiveAt: 1 }], { now: 2 })
  assert.equal(r, null)
})

test('锚点存在但已滞后 → 仍优先锚点（主会话锚点语义），且理由写明滞后秒数', () => {
  const r = electCircleTarget([{ id: U('879c4ae1'), lastActiveAt: 0 }],
    { pinned: U('879c4ae1'), now: 5_000_000, pinnedFreshMs: 600_000 })
  assert.equal(r.targetId, U('879c4ae1'))
  assert.match(r.reason, /滞后/)
})
