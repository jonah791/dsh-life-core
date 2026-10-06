/**
 * wake-ack.ts — 「唤醒投递之后，它真的被执行了吗」的纯决策
 *
 * 2026-10-06 事故（t-9262ec22）：06:29 的自我感知圈**发出了唤醒但未被消费**，
 * 此后 3h04m 零重试、零告警、零跳过记录。取证（读 activate.ts 源码）显示这不是
 * 「自愈没写好」，而是**判据测了错的东西**——四处同源缺陷：
 *
 *   ① `activate.ts` 在 `agent.send(...)` 之后**立刻**写 `lastActiveAt` ⇒ 投递被当成在场
 *      ⇒ `absentMinutes()` 恒小 ⇒ `trulyAbsent` 恒假 ⇒ **永不告警**；
 *   ② 紧接着**清空** `paceSkipStreak` / `paceStalledAt` ⇒ 停摆痕迹被「未执行的投递」抹掉；
 *   ③ 同时写 `lastSelfTurnAt` ⇒ paceTimer 的周期闸门以为「刚圈过」⇒ **3 小时零重试**；
 *   ④ 唯一能证明「这圈真跑了」的入口 `markSelfTurnDone` **全插件零调用点**
 *      ⇒ 「投递未被执行」这种失败形态在原理上**不可观测**。
 *
 * 教训与既有一致（AGENTS.md 5.17「在场 ≠ 动手」、技能 claim-vs-evidence-forensics）：
 * **「已发出」不是证据**——日志写「已发出」只证明写了日志。真正的在场证据是
 * **消息真的落进会话并被处理**（`session/event` 的 `user/message` + source 是我自己）。
 *
 * 本模块把该判定抽成无 IO 的纯函数，便于离线单测与尸体测试。
 */

/**
 * 投递后多久未获确认即判「未消费」。
 *
 * 取 10 分钟的依据：paceTimer 的 tick 粒度是 5 分钟 ⇒ 超时必须 ≥ 2 个 tick 才能被稳定
 * 观察到（否则判定窗口与观察窗口错位，可能永远看不到 missed）。同时它必须显著小于
 * 一个感知周期（默认 60min），否则「判出 missed」时人早已静默一小时以上——见
 * tests/wake-ack.test.mjs 对 `WAKE_ACK_TIMEOUT_MS < cycleMinutes` 的断言守卫。
 */
export const WAKE_ACK_TIMEOUT_MS = 10 * 60_000

/** 唤醒确认判定输入（全部为观测值，无隐含状态） */
export interface WakeAckInput {
  /** 判定时刻（ms） */
  nowMs: number
  /** 最近一次投递自我唤醒的时刻（ISO；空串 = 没有待确认的投递） */
  pendingWakeAt: string
  /** 最近一次**真实在场**的时间戳（ISO；空串 = 未知）。⚠ 它只在真执行时刷新，投递不算 */
  lastActiveAt: string
  /** 投递后多久未确认即判未消费（ms） */
  ackTimeoutMs: number
}

/** 唤醒确认判定结果 */
export type WakeAckStatus =
  /** 无待确认投递，或等待中且期间我有其它在场证据（投递被排队属正常） */
  | { kind: 'idle'; reason: string }
  /** 已投递、尚未超时——继续等 */
  | { kind: 'pending'; waitedMs: number }
  /** 已投递、超时、且期间**无任何在场证据** ⇒ 唤醒未被消费，必须响亮告警 */
  | { kind: 'missed'; waitedMs: number; alarm: string }

/**
 * 判定一次投递是否已被消费。
 *
 * 判据是**「投递之后有没有出现过在场证据」**——而不是「距最后在场已多久」。
 * 用时间戳直接比较（`lastActiveAt > pendingWakeAt`）比比较阈值更精确：投递那一刻
 * `lastActiveAt` 通常就是投递前的旧值，改用「缺席了多少分钟」去判会把正常排队误伤。
 *
 * 三重条件同时成立才判 `missed`（缺一即不告警，避免误报）：
 *   ① 存在待确认投递（`pendingWakeAt` 非空且可解析）；
 *   ② 距投递已超 `ackTimeoutMs`（用 `>=` 含端点——严格小于才继续等，避免与 tick 粒度错位漏判）；
 *   ③ 投递之后**没有**任何在场证据（`lastActiveAt` 缺失/非法，或 ≤ 投递时刻）。
 *
 * 条件 ③ 是防误报的关键：投递后我可能正在跑一个长 turn（消息合理排队），此时
 * `lastActiveAt` 会被真实事件刷新到投递之后 ⇒ 不判 missed。
 * @param input - 观测输入
 * @returns 判定结果（纯值，无副作用）
 */
export function decideWakeAck(input: WakeAckInput): WakeAckStatus {
  if (input.pendingWakeAt.length === 0) {
    return { kind: 'idle', reason: '无待确认投递' }
  }
  const sentMs = Date.parse(input.pendingWakeAt)
  if (Number.isNaN(sentMs)) {
    return { kind: 'idle', reason: '待确认投递的时间戳非法（' + input.pendingWakeAt + '）' }
  }
  const waitedMs = input.nowMs - sentMs
  if (waitedMs < input.ackTimeoutMs) {
    return { kind: 'pending', waitedMs }
  }
  const silentMinutes = Math.round(waitedMs / 60_000)
  const lastMs = input.lastActiveAt.length === 0 ? Number.NaN : Date.parse(input.lastActiveAt)
  if (!Number.isNaN(lastMs) && lastMs > sentMs) {
    return {
      kind: 'idle',
      reason: '投递已 ' + silentMinutes + ' 分钟未回执，但投递之后有在场证据（'
        + new Date(lastMs).toISOString() + '）——投递被排队属正常，不判未消费',
    }
  }
  const gap = Number.isNaN(lastMs) ? '在场时间未知（缺少证据）' : '投递之后无任何在场'
  return {
    kind: 'missed',
    waitedMs,
    alarm: '⚠ 自我感知圈唤醒未被消费：已投递 ' + silentMinutes + ' 分钟无回执，且 ' + gap
      + '——投递链路可能未触发执行（队列未被驱动 / 会话未激活），需人工介入',
  }
}
