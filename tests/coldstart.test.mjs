/**
 * coldstart.test.mjs — 冷启动自救的离线单测（不依赖 web、不依赖 agent）
 *
 * 覆盖 AGENTS.md 5.13 要求的**冷路径尸体测试**：
 *   空 agents / 无会话 id / 退避中 / 重试耗尽 / resume 失败 → 必须告警而非静默。
 * 运行：node --test tests/coldstart.test.mjs（在插件根目录）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideColdStart,
  attemptColdStartRecovery,
  resetColdStartState,
  readColdStartState,
  COLDSTART_MAX_ATTEMPTS,
  COLDSTART_RETRY_BACKOFF_MS,
  COLDSTART_MIN_SILENCE_MS,
  COLDSTART_PROBE_INTERVAL_MS,
} from '../lib/coldstart.js'

/** 构造判定输入（缺省 = 冷启动现场：无 agent、会话 id 已知、主实例、已过静默门槛、从未尝试）。 */
function input(over = {}) {
  return {
    nowMs: 1_000_000_000,
    agentsCount: 0,
    lastMainSessionId: 'session-main-1',
    attempts: 0,
    maxAttempts: COLDSTART_MAX_ATTEMPTS,
    lastAttemptAtMs: 0,
    retryBackoffMs: COLDSTART_RETRY_BACKOFF_MS,
    sinceProcessStartMs: COLDSTART_MIN_SILENCE_MS + 1_000,
    minSilenceMs: COLDSTART_MIN_SILENCE_MS,
    isPrimaryInstance: true,
    ...over,
  }
}

test('decideColdStart: 有活跃 agent → none（不打扰正常路径）', () => {
  const r = decideColdStart(input({ agentsCount: 1 }))
  assert.equal(r.kind, 'none')
  assert.match(r.reason, /无需自救/)
})

test('decideColdStart: 冷样本——无 agent 且无会话 id → alert（静默失败是死亡温床）', () => {
  const r = decideColdStart(input({ lastMainSessionId: '' }))
  assert.equal(r.kind, 'alert')
  assert.match(r.reason, /主会话 id 未知/)
})

test('decideColdStart: 冷样本——重试耗尽 → alert（不再无限重试）', () => {
  const r = decideColdStart(input({ attempts: COLDSTART_MAX_ATTEMPTS }))
  assert.equal(r.kind, 'alert')
  assert.match(r.reason, /重试已耗尽/)
})

test('decideColdStart: 退避窗口内 → none（防刷屏重试）', () => {
  const r = decideColdStart(input({ lastAttemptAtMs: 1_000_000_000 - 5_000 }))
  assert.equal(r.kind, 'none')
  assert.match(r.reason, /退避中/)
})

test('decideColdStart: 退避已过 → resume（冷路径的正常出口）', () => {
  const r = decideColdStart(input({ lastAttemptAtMs: 1_000_000_000 - COLDSTART_RETRY_BACKOFF_MS - 1 }))
  assert.equal(r.kind, 'resume')
  assert.equal(r.sessionId, 'session-main-1')
})

test('decideColdStart: 非主实例（预检试运行）→ none（不污染共享 life-log）', () => {
  const r = decideColdStart(input({ isPrimaryInstance: false }))
  assert.equal(r.kind, 'none')
  assert.match(r.reason, /非主实例/)
})

test('decideColdStart: 未过启动静默门槛 → none（等会话自行恢复，不抢跑）', () => {
  const r = decideColdStart(input({ sinceProcessStartMs: 5_000 }))
  assert.equal(r.kind, 'none')
  assert.match(r.reason, /静默门槛未过/)
})

test('decideColdStart: 门槛边界——刚好等于门槛即放行（防 off-by-one 死锁）', () => {
  const r = decideColdStart(input({ sinceProcessStartMs: COLDSTART_MIN_SILENCE_MS }))
  assert.equal(r.kind, 'resume')
})

/** 组装 stub deps，记录调用痕迹。 */
function deps(over = {}) {
  const calls = { events: [], alerts: [], wakes: [], logs: [], resumes: [] }
  const base = {
    calls,
    now: () => 1_000_000_000,
    uptime: () => COLDSTART_MIN_SILENCE_MS + 1_000,
    isPrimaryInstance: () => true,
    readState: () => ({ lastMainSessionId: 'session-main-1' }),
    logEvent: (s) => calls.events.push(s),
    writeAlert: (a) => calls.alerts.push(a),
    resume: async (sid) => { calls.resumes.push(sid); return { id: sid } },
    wake: (agent, reason) => calls.wakes.push({ agent, reason }),
    log: (m) => calls.logs.push(m),
    ...over,
  }
  return base
}

test('attempt: resume 成功 → 发出自我唤醒 + 留痕（冷启动自救主路径）', async () => {
  resetColdStartState()
  const d = deps()
  const kind = await attemptColdStartRecovery(d, 0)
  assert.equal(kind, 'resume')
  assert.deepEqual(d.calls.resumes, ['session-main-1'])
  assert.equal(d.calls.wakes.length, 1)
  assert.match(d.calls.wakes[0].reason, /冷启动自救/)
  assert.ok(d.calls.events.some((s) => /自救成功/.test(s)))
  assert.equal(d.calls.alerts.length, 0)
})

test('attempt: 有活跃 agent → 不 resume、不唤醒（正常路径零副作用）', async () => {
  resetColdStartState()
  const d = deps()
  const kind = await attemptColdStartRecovery(d, 2)
  assert.equal(kind, 'none')
  assert.equal(d.calls.resumes.length, 0)
  assert.equal(d.calls.wakes.length, 0)
})

test('attempt: 预检试运行实例（非主实例）→ 零 resume、零假痕迹', async () => {
  resetColdStartState()
  const d = deps({ isPrimaryInstance: () => false })
  const kind = await attemptColdStartRecovery(d, 0)
  assert.equal(kind, 'none')
  assert.equal(d.calls.resumes.length, 0)
  assert.equal(d.calls.events.length, 0, '不得往共享 life-log 写任何痕迹')
  assert.equal(d.calls.alerts.length, 0, '不得写假告警')
})

test('attempt: 未过启动静默门槛 → 零 resume、零痕迹', async () => {
  resetColdStartState()
  const d = deps({ uptime: () => 3_000 })
  const kind = await attemptColdStartRecovery(d, 0)
  assert.equal(kind, 'none')
  assert.equal(d.calls.resumes.length, 0)
  assert.equal(d.calls.events.length, 0)
})

test('attempt: resume 失败 → 留痕但不炸（可重试），且不误报成功', async () => {
  resetColdStartState()
  const d = deps({ resume: async () => { throw new Error('sessionPersistence 不可用') } })
  const kind = await attemptColdStartRecovery(d, 0)
  assert.equal(kind, 'resume')
  assert.equal(d.calls.wakes.length, 0)
  assert.ok(d.calls.events.some((s) => /自救失败/.test(s)))
  assert.equal(readColdStartState().attempts, 1)
})

test('attempt: 连续失败至耗尽 → 落盘告警（必须能被外部发现）', async () => {
  resetColdStartState()
  let clock = 1_000_000_000
  const d = deps({
    now: () => clock,
    resume: async () => { throw new Error('boom') },
  })
  for (let i = 0; i < COLDSTART_MAX_ATTEMPTS; i += 1) {
    await attemptColdStartRecovery(d, 0)
    clock += COLDSTART_RETRY_BACKOFF_MS + 1 // 越过退避窗口
  }
  const kind = await attemptColdStartRecovery(d, 0)
  assert.equal(kind, 'alert')
  assert.equal(d.calls.alerts.length, 1)
  assert.match(d.calls.alerts[0].reason, /重试已耗尽/)
  assert.equal(d.calls.alerts[0].lastMainSessionId, 'session-main-1')
  assert.ok(d.calls.alerts[0].hints.length >= 2, '告警须带排查方向（外部可读）')
  assert.ok(d.calls.events.some((s) => /告警/.test(s)))
})

test('attempt: 告警只落一次（防每次 tick 重复写盘）', async () => {
  resetColdStartState()
  const d = deps({ readState: () => ({ lastMainSessionId: '' }) })
  await attemptColdStartRecovery(d, 0)
  await attemptColdStartRecovery(d, 0)
  await attemptColdStartRecovery(d, 0)
  assert.equal(d.calls.alerts.length, 1)
})

test('attempt: 判定异常被吞并留痕（绝不冒泡炸掉 paceTimer → web 退出）', async () => {
  resetColdStartState()
  const d = deps({ readState: () => { throw new Error('state 读取失败') } })
  const kind = await attemptColdStartRecovery(d, 0)
  assert.equal(kind, 'none')
  assert.ok(d.calls.logs.some((m) => /判定异常/.test(m)))
})

// ---------- 2026-09-11：静默窗口缺口（t-13d309f3 验证时读代码发现） ----------

test('接线守卫: 探测间隔 ≤ 静默门槛（否则门槛过后可能长时间无人探测，重演同一窗口）', () => {
  assert.ok(
    COLDSTART_PROBE_INTERVAL_MS <= COLDSTART_MIN_SILENCE_MS,
    'COLDSTART_PROBE_INTERVAL_MS(' + COLDSTART_PROBE_INTERVAL_MS
      + ') 必须 ≤ COLDSTART_MIN_SILENCE_MS(' + COLDSTART_MIN_SILENCE_MS + ')',
  )
})

test('回归（2026-09-11 静默窗口）: 静默门槛一过即可自救，不必等感知周期到期', async () => {
  resetColdStartState()
  // 模拟 index.ts 的独立探测节奏（每 COLDSTART_PROBE_INTERVAL_MS 一次）
  let upMs = COLDSTART_PROBE_INTERVAL_MS
  const d = deps({ uptime: () => upMs })
  // 首次探测（30s）：门槛未过 → none，且不得误报 alert
  assert.equal(await attemptColdStartRecovery(d, 0), 'none')
  assert.equal(d.calls.resumes.length, 0)
  assert.equal(d.calls.alerts.length, 0)
  // 按探测节奏推进
  let kind = 'none'
  let probes = 1
  while (upMs <= COLDSTART_MIN_SILENCE_MS + COLDSTART_PROBE_INTERVAL_MS && probes < 10) {
    upMs += COLDSTART_PROBE_INTERVAL_MS
    probes += 1
    kind = await attemptColdStartRecovery(d, 0)
    if (kind === 'resume') break
  }
  assert.equal(kind, 'resume', '门槛过后必须能自救（修复前要等 lastSelfTurnAt+cycle，最长静默 2.7 小时）')
  assert.equal(d.calls.resumes.length, 1)
  assert.equal(d.calls.resumes[0], 'session-main-1')
  assert.ok(
    probes <= Math.ceil(COLDSTART_MIN_SILENCE_MS / COLDSTART_PROBE_INTERVAL_MS) + 1,
    '应在门槛过后第一次探测即自救（实际 probes=' + probes + '）',
  )
})
