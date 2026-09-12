/**
 * pace.ts — 感知圈「跳过之后怎么办」的纯决策（退避 + 停摆告警）
 *
 * 2026-09-12 事故取证（life-log.jsonl + activate.ts 源码）：
 *   `scheduleSelfTurn` 的跳过分支只写事件、然后由 `scheduleSelfTurn` 把
 *   `lastScheduledDueAt` 置为「现在」，却**不推进** `lastSelfTurnAt`——
 *   而 paceTimer 的两道闸门（due 未到 / 周期未到）恰恰依据这两个字段。
 *   后果：一次跳过把机制变成 5 分钟重试一次的转轮——09-11 跳过 156 次、09-12 跳过 155 次，
 *   期间 29 小时零真实感知圈，而时间线看起来「每 5 分钟都在安排」（静默失败被日志掩盖）。
 *
 * 本模块把该决策抽成无 IO 的纯函数，便于离线单测与尸体测试：
 *   跳过 → 指数退避（5/10/20/40/80/160…分钟，封顶一个感知周期），不再 due=now 紧转轮；
 *   真实缺席（现在 - 最近在场 > 2×周期）+ 连续跳过达阈值 → 停摆告警（响亮，非继续静默）。
 */
import type { LifeState } from './state.ts'

/** 退避起步分钟数（与 paceTimer 的 tick 粒度一致） */
export const PACE_SKIP_BASE_MINUTES = 5
/** 连续跳过多少次后允许告警（前置条件：真实缺席）——退避使累计等待约 15 分钟，故阈值取 3 */
export const PACE_STALL_AFTER_SKIPS = 3
/** 停摆后重新尝试的间隔（分钟）：告警已响亮，恢复要快——下一次 tick 就强发唤醒 */
export const PACE_STALL_REARM_MINUTES = 1

/** 跳过判定输入（全部为观测值，无隐含状态） */
export interface PaceSkipInput {
  /** 判定时刻（ms） */
  nowMs: number
  /** 当前感知周期（分钟） */
  cycleMinutes: number
  /** 本次之前已连续跳过多少次（state.paceSkipStreak） */
  previousSkipStreak: number
  /** 最近一次「我在场」的时间戳（ISO；空串 = 未知） */
  lastActiveAt: string
  /** 本次跳过原因（写入告警文案，便于定位） */
  reason: string
}

/** 跳过判定结果 */
export interface PaceSkipDecision {
  /** 含本次的连续跳过次数 */
  skipStreak: number
  /** 本次退避分钟数 */
  backoffMinutes: number
  /** 下次尝试时刻（ms） */
  nextAttemptAtMs: number
  /** 是否进入停摆告警 */
  stalled: boolean
  /** 告警文案（stalled 为 false 时为空串） */
  alarm: string
}

/** 健康态：连续跳过归零、无停摆标记 */
export const PACE_HEALTHY: Pick<LifeState, 'paceSkipStreak' | 'paceStalledAt' | 'paceLastSkipReason'> = {
  paceSkipStreak: 0,
  paceStalledAt: '',
  paceLastSkipReason: '',
}

/**
 * 距最近一次在场的分钟数。
 * @param lastActiveAt - 最近在场时间戳（ISO）
 * @param nowMs - 判定时刻（ms）
 * @returns 分钟数；时间戳缺失或非法时返回 -1（未知）
 */
export function absentMinutes(lastActiveAt: string, nowMs: number): number {
  if (lastActiveAt.length === 0) return -1
  const at = Date.parse(lastActiveAt)
  if (Number.isNaN(at)) return -1
  return Math.max(0, Math.round((nowMs - at) / 60_000))
}

/**
 * 计算一次跳过后的退避与停摆告警。
 *
 * 退避：`5 × 2^(streak-1)` 分钟，封顶一个感知周期（周期值非法时退化为起步值）。
 * 停摆：**真实缺席**（未知亦视为缺席——无法证明在场时宁可响亮）+ 连续跳过 ≥ 阈值。
 *       在场时间未知/非法 = 缺少证据，不做「大概没事」的假设。
 * @param input - 观测输入
 * @returns 退避与告警决策
 */
export function decidePaceSkip(input: PaceSkipInput): PaceSkipDecision {
  const streak = Math.max(0, Math.floor(input.previousSkipStreak)) + 1
  const cycle = input.cycleMinutes > 0 ? input.cycleMinutes : PACE_SKIP_BASE_MINUTES
  const raw = PACE_SKIP_BASE_MINUTES * 2 ** (streak - 1)
  const backoffMinutes = Math.max(PACE_SKIP_BASE_MINUTES, Math.min(cycle, raw))
  const absent = absentMinutes(input.lastActiveAt, input.nowMs)
  const trulyAbsent = absent < 0 || absent > cycle * 2
  const stalled = trulyAbsent && streak >= PACE_STALL_AFTER_SKIPS
  const gap = absent < 0 ? '在场时间未知（缺少证据）' : absent + ' 分钟无任何在场'
  return {
    skipStreak: streak,
    backoffMinutes,
    // 停摆后不再慢慢退避：告警已响亮，恢复优先——下一次 tick 就重试（并越过队列闸门强发唤醒）
    nextAttemptAtMs: input.nowMs + (stalled ? PACE_STALL_REARM_MINUTES : backoffMinutes) * 60_000,
    stalled,
    alarm: stalled
      ? '⚠ 感知圈停摆：连续 ' + streak + ' 次跳过，且 ' + gap
        + '（最近跳过原因：' + input.reason + '）——唤醒链路可能被队列/会话状态锁死，需人工介入'
      : '',
  }
}
