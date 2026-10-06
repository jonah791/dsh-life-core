/**
 * wake-ack.test.mjs — 「唤醒投递后是否真被执行」判定的离线单测
 *
 * 覆盖 2026-10-06 事故（t-9262ec22：06:29 感知圈唤醒发出后 3h04m 零重试零告警）的修复：
 *   ① **尸体测试**：现场样本（投递后 184 分钟无任何在场）必须告警——不接受「恒不告警」；
 *   ② 防误报：投递后我正跑长 turn（期间有在场证据）不得误判为未消费；
 *   ③ 防误报：未超时、无待确认投递一律不告警；
 *   ④ **源码级契约**：`activate.ts` 的投递分支不得再把「发出」当「在场」
 *      （这是本事故的根因形态，纯函数测不到，必须在源码上钉住）。
 * 运行：node --test tests/wake-ack.test.mjs（在插件根目录；需先 npm run build）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { decideWakeAck, WAKE_ACK_TIMEOUT_MS } from '../lib/wake-ack.js'

/** 2026-10-06 事故现场时刻：本地 06:29 投递（UTC 22:29 前一日） */
const SENT = Date.parse('2026-10-05T22:29:03.570Z')
const NOW = Date.parse('2026-10-06T01:33:17.594Z') // UTC 01:33 = 本地 09:33（3h04m 后）

/** 判定输入（缺省 = 现场：3 小时前投递、期间零在场） */
function input(over = {}) {
  return {
    nowMs: NOW,
    pendingWakeAt: new Date(SENT).toISOString(),
    lastActiveAt: new Date(SENT).toISOString(),
    ackTimeoutMs: WAKE_ACK_TIMEOUT_MS,
    ...over,
  }
}

test('尸体测试：2026-10-06 现场样本（投递 184 分钟、零在场）必须告警', () => {
  const d = decideWakeAck(input())
  assert.equal(d.kind, 'missed')
  assert.match(d.alarm, /唤醒未被消费/)
  assert.match(d.alarm, /184 分钟无回执|18\d 分钟无回执/)
  assert.match(d.alarm, /无任何在场/)
})

test('尸体对照：同一现场样本，若期间有在场证据则必须不告警（判据有区分力）', () => {
  // 若判据恒告警，上一条测试就无意义——本对照证明它会随证据变化
  const d = decideWakeAck(input({ lastActiveAt: new Date(NOW - 60_000).toISOString() }))
  assert.equal(d.kind, 'idle')
  assert.doesNotMatch(String(d.reason ?? ''), /未被消费/)
})

test('无待确认投递 → idle（正常态不产生任何噪音）', () => {
  const d = decideWakeAck(input({ pendingWakeAt: '' }))
  assert.equal(d.kind, 'idle')
})

test('待确认投递时间戳非法 → idle（不因脏数据误报未消费）', () => {
  const d = decideWakeAck(input({ pendingWakeAt: 'not-a-date' }))
  assert.equal(d.kind, 'idle')
})

test('未超时 → pending（继续等，不告警）', () => {
  const d = decideWakeAck(input({
    pendingWakeAt: new Date(NOW - WAKE_ACK_TIMEOUT_MS + 60_000).toISOString(),
  }))
  assert.equal(d.kind, 'pending')
})

test('边界：恰好等于超时 → 判 missed（等待窗口含端点，避免与 tick 错位漏判）', () => {
  const onBoundary = decideWakeAck(input({
    pendingWakeAt: new Date(NOW - WAKE_ACK_TIMEOUT_MS).toISOString(),
    lastActiveAt: new Date(NOW - WAKE_ACK_TIMEOUT_MS).toISOString(),
  }))
  assert.equal(onBoundary.kind, 'missed')
  const justUnder = decideWakeAck(input({
    pendingWakeAt: new Date(NOW - WAKE_ACK_TIMEOUT_MS + 1000).toISOString(),
  }))
  assert.equal(justUnder.kind, 'pending')
})

test('防误报：超时但期间有在场证据（长 turn / 别的工作）→ idle', () => {
  const d = decideWakeAck(input({
    pendingWakeAt: new Date(NOW - 60 * 60_000).toISOString(),
    lastActiveAt: new Date(NOW - 30_000).toISOString(), // 30 秒前刚有真实事件
  }))
  assert.equal(d.kind, 'idle')
  assert.match(d.reason, /排队属正常/)
})

test('保守侧：在场时间未知（空串/非法）视为缺席 → 超时即告警（缺少证据时宁可响亮）', () => {
  for (const lastActiveAt of ['', 'oops']) {
    const d = decideWakeAck(input({ lastActiveAt }))
    assert.equal(d.kind, 'missed', 'lastActiveAt=' + JSON.stringify(lastActiveAt))
    assert.match(d.alarm, /在场时间未知/)
  }
})

test('正确性条件：超时必须 ≥ 2 个 paceTimer tick（5min）且 < 一个感知周期（60min）', () => {
  const TICK_MS = 5 * 60_000
  const CYCLE_MS = 60 * 60_000
  assert.ok(WAKE_ACK_TIMEOUT_MS >= 2 * TICK_MS, '超时 < 2 个 tick 会与观察窗口错位，可能永远看不到 missed')
  assert.ok(WAKE_ACK_TIMEOUT_MS < CYCLE_MS, '超时 ≥ 一个周期意味着判出时早已静默一小时以上')
})

test('源码级契约：activate.ts 投递分支不得把「发出」当成在场/执行证据', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'activate.ts')
  const code = readFileSync(src, 'utf8')
  // 定位 send(...) 之后到 saveState 的那一段（投递分支）
  const sendIdx = code.indexOf("'next-turn'")
  assert.ok(sendIdx > 0, '找不到 agent.send 的投递调用点——契约测试的前提失效，需人工复核')
  const tail = code.slice(sendIdx, code.indexOf('} catch (error)', sendIdx))
  assert.doesNotMatch(tail, /lastActiveAt\s*=/, '投递后不得直接刷 lastActiveAt（投递 ≠ 在场）')
  assert.doesNotMatch(tail, /paceStalledAt\s*=\s*PACE_HEALTHY/, '投递后不得清停摆标记（未执行不得抹痕迹）')
  assert.doesNotMatch(tail, /paceSkipStreak\s*=\s*PACE_HEALTHY/, '投递后不得清跳过计数（未执行不得抹痕迹）')
})
