/**
 * absence.test.mjs — 「不在场」出外告警判据的测试
 *
 * 分层：纯决策（decideAbsenceAlert / absenceThresholdMinutes / composeAbsenceAlert）。
 * 尸体样本的重点是**别让它变成狼来了**（冷启动误报）与**别让它退化成每次必发**（刷屏）。
 *
 * ⚠ 天花板（诚实标注）：本文件证明**判据有区分力**；它**不**证明告警送得出去
 * （送达由 `dsh-agent-notify` 自己的 37 条测试与生产前身覆盖）。
 * 冷却/去重**不在本模块**——由 `dsh-agent-notify` 按去重键统一实现（判据单一真源）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideAbsenceAlert, absenceThresholdMinutes, composeAbsenceAlert, absenceInputFrom, ABSENCE_DEDUP_KEY,
} from '../lib/absence.js'

const MIN = 60_000
const T0 = Date.parse('2026-10-09T06:00:00.000Z')
const iso = (offsetMin) => new Date(T0 - offsetMin * MIN).toISOString()

/** 缺省场景：周期 180 分钟、阈值 2× ⇒ 360 分钟 */
function input(absentMin, extra = {}) {
  return {
    nowMs: T0,
    lastActiveAt: absentMin < 0 ? '' : iso(absentMin),
    cycleMinutes: 180,
    multiplier: 2,
    ...extra,
  }
}

test('在场证据新鲜（缺席 5 分钟 < 阈值 360）⇒ 不告警，理由报出分钟数', () => {
  const d = decideAbsenceAlert(input(5))
  assert.equal(d.alert, false)
  assert.equal(d.absentMinutes, 5)
  assert.match(d.reason, /新鲜/)
})

test('达阈值（缺席 400 ≥ 360）⇒ 告警', () => {
  const d = decideAbsenceAlert(input(400))
  assert.equal(d.alert, true)
  assert.equal(d.absentMinutes, 400)
  assert.equal(d.thresholdMinutes, 360)
  assert.match(d.reason, /超过阈值/)
})

test('边界：缺席**恰好等于**阈值 ⇒ 告警（>= 语义，与 tick 粒度错位时不会漏判）', () => {
  assert.equal(decideAbsenceAlert(input(360)).alert, true)
})

test('边界:缺席恰差 1 分钟 ⇒ 不告警', () => {
  assert.equal(decideAbsenceAlert(input(359)).alert, false)
})

test('阈值随周期走：周期改小到 60 分钟 ⇒ 阈值 120，缺席 130 即告警', () => {
  const d = decideAbsenceAlert(input(130, { cycleMinutes: 60 }))
  assert.equal(d.thresholdMinutes, 120)
  assert.equal(d.alert, true)
})

// 尸体样本 1：周期/倍数非法必须**拒绝告警**，而不是退化成「每次必发」——否则一个写错的
// 配置会变成对主人的刷屏器（§5.12 防刷屏）。
test('尸体：cycle=0 / multiplier=0 / 负数 → 拒绝告警（不退化为每次必发）', () => {
  for (const bad of [{ cycleMinutes: 0 }, { multiplier: 0 }, { cycleMinutes: -1 }, { multiplier: -1 }]) {
    const d = decideAbsenceAlert(input(9999, bad))
    assert.equal(d.alert, false, JSON.stringify(bad) + ' 竟放行')
    assert.match(d.reason, /非法/)
  }
})

// 尸体样本 2：冷启动/状态重置时 lastActiveAt 为空 ⇒ **不得告警**。
// 这条是「狼来了」的守门人：fresh 状态下该字段本就为空，若判为「不在场」，
// 每次重装/清状态都会给主人发一条吓人的消息。
test('尸体：在场证据缺失（lastActiveAt 为空）→ 不告警，理由说明为什么不喊', () => {
  const d = decideAbsenceAlert(input(-1))
  assert.equal(d.alert, false, '证据缺失竟告警——冷启动会误报')
  assert.equal(d.absentMinutes, -1)
  assert.match(d.reason, /证据缺失/)
})

// 尸体样本 3：证据非法（不可解析）⇒ 不告警但理由可读（不空吞、不猜数字）
test('尸体：在场证据非法 → 不告警，理由含原值', () => {
  const d = decideAbsenceAlert(input(0, { lastActiveAt: 'not-a-date' }))
  assert.equal(d.alert, false)
  assert.match(d.reason, /非法/)
  assert.match(d.reason, /not-a-date/)
})

// 尸体样本 4：**时钟回退**（lastActiveAt 在未来）⇒ 缺席算 0，不告警。
// 不夹紧就会得到负数缺席，进而在别处被当成「异常大」或「极小」两种误读。
// ⚠ 夹具注意：`input(n)` 用 `n < 0` 表示「空串」，所以「未来时刻」必须**显式**给 ISO，
//    否则测的是「证据缺失」分支而不是本分支（本条第一版就写错了，被自己抓出来）。
test('尸体：lastActiveAt 在未来（时钟回退）→ 缺席夹为 0，不告警', () => {
  const d = decideAbsenceAlert(input(0, { lastActiveAt: iso(-120) })) // 未来 120 分钟
  assert.equal(d.absentMinutes, 0)
  assert.equal(d.alert, false)
  assert.match(d.reason, /新鲜/)
})

test('阈值常量单一真源：absenceThresholdMinutes 与判定结果一致', () => {
  assert.equal(absenceThresholdMinutes(180, 2), 360)
  assert.equal(decideAbsenceAlert(input(400)).thresholdMinutes, absenceThresholdMinutes(180, 2))
})

test('阈值常量：非法输入得 0（调用方须当不可用，不得当成无门槛）', () => {
  assert.equal(absenceThresholdMinutes(0, 2), 0)
  assert.equal(absenceThresholdMinutes(180, 0), 0)
  assert.equal(absenceThresholdMinutes(-180, -2), 0)
})

test('composeAbsenceAlert：含缺席分钟 / 小时 / 阈值 / 「不自动 rearm」声明 / 稳定去重键', () => {
  const p = composeAbsenceAlert(400, 360)
  assert.equal(p.dedupKey, ABSENCE_DEDUP_KEY)
  const text = [p.title, ...p.lines].join('\n')
  assert.match(text, /400 分钟/)
  assert.match(text, /6\.7 小时/)
  assert.match(text, /阈值 360 分钟/)
  assert.match(text, /不会自动 rearm/)
  assert.match(text, /会话也在/)   // 点明「agents>0 判据看不见它」这一形态
})

test('composeAbsenceAlert：附加事实行按序并入（调用方给的事实不被改写）', () => {
  const p = composeAbsenceAlert(400, 360, ['感知圈停摆标记：2026-10-09T02:05:00Z', '上次出外告警：无'])
  const text = p.lines.join('\n')
  assert.ok(text.includes('感知圈停摆标记：2026-10-09T02:05:00Z'))
  assert.ok(text.includes('上次出外告警：无'))
})

test('absenceInputFrom：从 LifeState 取在场证据（不读盘）', () => {
  const state = { lastActiveAt: iso(500), cycleMinutes: 180 }
  const i = absenceInputFrom(state, T0, 2)
  assert.equal(i.lastActiveAt, iso(500))
  assert.equal(i.cycleMinutes, 180)
  assert.equal(i.multiplier, 2)
  assert.equal(decideAbsenceAlert(i).alert, true)
})

test('absenceInputFrom：state 缺字段时给空串（判定层会走「证据缺失」分支，不炸）', () => {
  const i = absenceInputFrom({}, T0, 2)
  assert.equal(i.lastActiveAt, '')
  assert.equal(decideAbsenceAlert(i).alert, false)
})
