/**
 * pace.test.mjs — 感知圈退避/停摆判定的离线单测（不依赖 web、不依赖 agent）
 *
 * 覆盖 2026-09-12 事故（两天 311 次跳过 + 29 小时零真实感知圈）的修复：
 *   ① 跳过必须退避，不再 due=now 紧转轮；
 *   ② 真实缺席 + 连续跳过达阈值必须响亮告警；
 *   ③ 良性跳过（对话刚发生）不得误报。
 * 运行：node --test tests/pace.test.mjs（在插件根目录；需先 npm run build）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decidePaceSkip,
  absentMinutes,
  PACE_SKIP_BASE_MINUTES,
  PACE_STALL_AFTER_SKIPS,
  PACE_HEALTHY,
} from '../lib/pace.js'

const NOW = Date.parse('2026-09-12T12:57:00.000Z')

/** 判定输入（缺省 = 现场：周期 180 分钟、本次为第一次跳过、1 分钟前刚在场过） */
function input(over = {}) {
  return {
    nowMs: NOW,
    cycleMinutes: 180,
    previousSkipStreak: 0,
    lastActiveAt: new Date(NOW - 60_000).toISOString(),
    reason: '主人消息已在队列（已被叫醒）',
    ...over,
  }
}

test('absentMinutes: 空串/非法时间戳 → -1（未知）', () => {
  assert.equal(absentMinutes('', NOW), -1)
  assert.equal(absentMinutes('not-a-date', NOW), -1)
  assert.equal(absentMinutes(new Date(NOW - 90 * 60_000).toISOString(), NOW), 90)
})

test('decidePaceSkip: 首次跳过 → 退避 5 分钟，下次尝试 = 现在 + 5 分钟', () => {
  const d = decidePaceSkip(input())
  assert.equal(d.skipStreak, 1)
  assert.equal(d.backoffMinutes, PACE_SKIP_BASE_MINUTES)
  assert.equal(d.nextAttemptAtMs, NOW + PACE_SKIP_BASE_MINUTES * 60_000)
})

test('decidePaceSkip: 退避指数增长且封顶一个感知周期（不再 5 分钟紧转轮）', () => {
  const backoff = (streak) => decidePaceSkip(input({ previousSkipStreak: streak - 1 })).backoffMinutes
  assert.deepEqual([backoff(1), backoff(2), backoff(3), backoff(4), backoff(5)], [5, 10, 20, 40, 80])
  assert.equal(backoff(6), 160)
  assert.equal(backoff(7), 180) // raw=320 → 封顶 cycle=180
  assert.equal(backoff(20), 180)
})

test('decidePaceSkip: 周期值非法（0/负）时退避仍有界', () => {
  assert.equal(decidePaceSkip(input({ cycleMinutes: 0, previousSkipStreak: 9 })).backoffMinutes, PACE_SKIP_BASE_MINUTES)
  assert.equal(decidePaceSkip(input({ cycleMinutes: -30, previousSkipStreak: 9 })).backoffMinutes, PACE_SKIP_BASE_MINUTES)
})

test('尸体测试：2026-09-12 现场样本（29 小时无在场 + 连续第 156 次跳过）必须告警', () => {
  const d = decidePaceSkip(input({
    previousSkipStreak: 155,
    lastActiveAt: '2026-09-11T08:04:31.863Z', // 真实日志中的最后一次真实感知圈
  }))
  assert.equal(d.skipStreak, 156)
  assert.equal(d.stalled, true)
  assert.match(d.alarm, /感知圈停摆/)
  assert.match(d.alarm, /1740 分钟无任何在场|17\d\d 分钟无任何在场/)
  assert.match(d.alarm, /主人消息已在队列/)
  // 停摆后立即重试（不再慢慢退避）——下一次 tick 就强发唤醒
  assert.equal(d.nextAttemptAtMs, NOW + 60_000)
})

test('防误报：对话刚发生（1 分钟前在场）时连续跳过也不告警', () => {
  for (const streak of [1, PACE_STALL_AFTER_SKIPS, 50]) {
    const d = decidePaceSkip(input({ previousSkipStreak: streak - 1 }))
    assert.equal(d.stalled, false, 'streak=' + streak)
    assert.equal(d.alarm, '')
  }
})

test('防误报：缺席恰好等于 2×周期（边界）不告警，越界才告警', () => {
  const cycle = 180
  const onBoundary = decidePaceSkip(input({
    previousSkipStreak: PACE_STALL_AFTER_SKIPS - 1,
    lastActiveAt: new Date(NOW - cycle * 2 * 60_000).toISOString(),
  }))
  assert.equal(onBoundary.stalled, false)
  const beyond = decidePaceSkip(input({
    previousSkipStreak: PACE_STALL_AFTER_SKIPS - 1,
    lastActiveAt: new Date(NOW - (cycle * 2 * 60_000 + 60_000)).toISOString(),
  }))
  assert.equal(beyond.stalled, true)
})

test('防误报：阈值前（未达 PACE_STALL_AFTER_SKIPS 次）即使真实缺席也未告警', () => {
  const d = decidePaceSkip(input({
    previousSkipStreak: PACE_STALL_AFTER_SKIPS - 2, // 本次为第 5 次
    lastActiveAt: '2026-09-11T08:04:31.863Z',
  }))
  assert.equal(d.skipStreak, PACE_STALL_AFTER_SKIPS - 1)
  assert.equal(d.stalled, false)
})

test('保守侧：在场时间未知（空串/非法）视为缺席，达阈值即告警（缺少证据时宁可响亮）', () => {
  const unknown = decidePaceSkip(input({ previousSkipStreak: PACE_STALL_AFTER_SKIPS - 1, lastActiveAt: '' }))
  assert.equal(unknown.stalled, true)
  assert.match(unknown.alarm, /在场时间未知/)
  const invalid = decidePaceSkip(input({ previousSkipStreak: PACE_STALL_AFTER_SKIPS - 1, lastActiveAt: 'oops' }))
  assert.equal(invalid.stalled, true)
})

test('PACE_HEALTHY: 成功触发后的归零常量（真触发路径用它复位）', () => {
  assert.deepEqual(PACE_HEALTHY, { paceSkipStreak: 0, paceStalledAt: '', paceLastSkipReason: '' })
})
