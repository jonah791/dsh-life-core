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
  decidePaceStall,
  absentMinutes,
  PACE_SKIP_BASE_MINUTES,
  PACE_STALL_AFTER_SKIPS,
  PACE_HEALTHY,
  PACE_MAX_DUE_AHEAD_FACTOR,
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

// ─────────────────────────────────────────────────────────────────────────────
// decidePaceStall —— 「呼吸**压根没到期**」（2026-10-09 · goal round 27）
//
// 它覆盖的是 `decidePaceSkip` **够不到**的那一类：tick 的两条早退路径
// （`!(cycle>0)` 与 `dueMs > nowMs`）原本**无日志、无告警、无状态**。
// ⚠ 它**不查**「已过 due 却没醒」——那条路径在 tick 里不可能持续（`now>=due` 就会走到 scheduleSelfTurn），
//   把它写成判据只会得到恒为假的检查。
// ─────────────────────────────────────────────────────────────────────────────

const STALL_T0 = Date.parse('2026-10-09T06:00:00.000Z')

test('呼吸停摆：正常态（周期 180、无手动安排）⇒ 不停摆', () => {
  const d = decidePaceStall({ nowMs: STALL_T0, cycleMinutes: 180, dueAt: '' })
  assert.equal(d.stalled, false)
  assert.equal(d.code, 'none')
  assert.equal(d.alarm, '')
})

test('呼吸停摆：合法的手动排程（到期在 1 个周期内）⇒ 不停摆', () => {
  const due = new Date(STALL_T0 + 90 * 60_000).toISOString()
  assert.equal(decidePaceStall({ nowMs: STALL_T0, cycleMinutes: 180, dueAt: due }).stalled, false)
})

// 尸体样本 1：**cycle 腐化** —— 旧实现在这条路径上 `return` 得干干净净（无日志无告警）。
test('尸体：cycleMinutes = 0 / 负数 / NaN / Infinity ⇒ 停摆告警（旧实现在此静默 return）', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const d = decidePaceStall({ nowMs: STALL_T0, cycleMinutes: bad, dueAt: '' })
    assert.equal(d.stalled, true, 'cycle=' + String(bad) + ' 竟未告警')
    assert.equal(d.code, 'cycle-invalid')
    assert.match(d.alarm, /压根没到期/)
    assert.match(d.alarm, /cycleMinutes=/)
  }
})

// 尸体样本 2：**排定到期远在未来** —— 旧实现被「尊重手动安排」闸门永久挡住且无任何信号。
test('尸体：dueAt 远在未来（超过 周期 × 2）⇒ 停摆告警', () => {
  const due = new Date(STALL_T0 + 10 * 3600_000).toISOString()   // 领先 10h > 180min×2=6h
  const d = decidePaceStall({ nowMs: STALL_T0, cycleMinutes: 180, dueAt: due })
  assert.equal(d.stalled, true)
  assert.equal(d.code, 'due-too-far')
  assert.match(d.alarm, /远在未来/)
  assert.match(d.alarm, /状态腐化/)
})

test('尸体：dueAt 不可解析 ⇒ 停摆告警（不静默吞掉坏值）', () => {
  const d = decidePaceStall({ nowMs: STALL_T0, cycleMinutes: 180, dueAt: 'not-a-date' })
  assert.equal(d.stalled, true)
  assert.match(d.alarm, /不可解析/)
  assert.match(d.alarm, /not-a-date/)
})

test('边界：dueAt 恰好 = 周期 × 2 ⇒ 不停摆（> 才算超界）；多 1 秒 ⇒ 停摆', () => {
  const limit = 180 * 60_000 * PACE_MAX_DUE_AHEAD_FACTOR
  assert.equal(decidePaceStall({ nowMs: STALL_T0, cycleMinutes: 180, dueAt: new Date(STALL_T0 + limit).toISOString() }).stalled, false)
  assert.equal(decidePaceStall({ nowMs: STALL_T0, cycleMinutes: 180, dueAt: new Date(STALL_T0 + limit + 1000).toISOString() }).stalled, true)
})

test('上界随周期走：周期改小 ⇒ 同一个 dueAt 从「合法」变「超界」', () => {
  const due = new Date(STALL_T0 + 90 * 60_000).toISOString()
  assert.equal(decidePaceStall({ nowMs: STALL_T0, cycleMinutes: 180, dueAt: due }).stalled, false)
  assert.equal(decidePaceStall({ nowMs: STALL_T0, cycleMinutes: 30, dueAt: due }).stalled, true)
})

test('已过期的 dueAt（过去时刻）⇒ 不停摆（该醒就醒，是 tick 的职责，不是判据的）', () => {
  const due = new Date(STALL_T0 - 5 * 60_000).toISOString()
  assert.equal(decidePaceStall({ nowMs: STALL_T0, cycleMinutes: 180, dueAt: due }).stalled, false)
})

test('上界倍数覆盖：maxDueAheadFactor=0.5 ⇒ 领先 2 小时即告警', () => {
  const due = new Date(STALL_T0 + 2 * 3600_000).toISOString()
  assert.equal(decidePaceStall({ nowMs: STALL_T0, cycleMinutes: 180, dueAt: due, maxDueAheadFactor: 0.5 }).stalled, true)
  assert.equal(decidePaceStall({ nowMs: STALL_T0, cycleMinutes: 180, dueAt: due, maxDueAheadFactor: 1 }).stalled, false)
})

test('尸体：maxDueAheadFactor 非法（0/负/NaN）⇒ 回退到缺省常量，不变成「永不告警」', () => {
  const due = new Date(STALL_T0 + 10 * 3600_000).toISOString()
  for (const bad of [0, -3, Number.NaN]) {
    const d = decidePaceStall({ nowMs: STALL_T0, cycleMinutes: 180, dueAt: due, maxDueAheadFactor: bad })
    assert.equal(d.stalled, true, 'factor=' + String(bad) + ' 竟回退成永不告警')
  }
})
