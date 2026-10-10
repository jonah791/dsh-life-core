/**
 * absence.ts — 「我是不是长时间不在场」的纯决策（无 IO，可离线单测与尸体测试）
 *
 * 事故与裁决背景（2026-10-09 · `t-9d17c42c` → `t-5fd8f3e9`）：
 * 重启会把 active goal 解除武装 ⇒ 自动续跑停掉，而处置链（`goal_rearm` + 技能 `wake-protocol`）
 * **只在我醒来后才生效**——故障形态恰恰是「我没醒」。逐层核对后（见技能 `alarm-reachability-audit`）：
 * 检测层是好的（`paceTimer` 实测准点，残差 53.967 秒），缺的是**落点**——
 * 三个现成检测器在「会话活着 + goal 停了 + 我未醒」这一形态下全部静默，而唯一带外部落点的
 * `coldstart-alert.json` 前置 `agents == 0`（`index.ts:326` 再挡一道），故障形态恒不满足。
 *
 * 本模块只回答一个问题：**按在场证据算，现在该不该出外告警。**
 *
 * 判据的选择（为什么用在场证据，而不是「有没有 agent」）：
 * 「有没有活跃会话」在故障形态下**恒为真**（我就活在那个会话里，只是没在跑），拿它当判据
 * 等于恒不告警。真正能区分「我在」与「我不在」的量是 `lastActiveAt`——它只在**真执行**时
 * 刷新（见 `activate.ts` 的 `markSelfTurnDone`：投递不算，落地才算）。
 *
 * **冷却与去重不在这里**：由 `dsh-agent-notify` 按去重键统一实现（它已有 37 条测试）。
 * 判据单一真源（§5.22 规则 4）——同一件事不写两份，尤其当第二份还要多存一个状态字段时。
 */
import type { LifeState } from './state.ts'

/** 触发阈值相对感知周期的倍数（缺省 2 ⇒ 周期 180min 时阈值 360min = 6 小时）。 */
export const ABSENCE_DEFAULT_MULTIPLIER = 2

/** 出外告警的去重键；冷却由 `dsh-agent-notify` 按此键管。 */
export const ABSENCE_DEDUP_KEY = 'life-core-absence'

/** 判定输入（全部为观测值，无隐含状态）。 */
export interface AbsenceInput {
  /** 判定时刻（ms） */
  nowMs: number
  /** 最近一次**真实在场**的时间戳（ISO；空串或非法 = 证据缺失） */
  lastActiveAt: string
  /** 当前感知周期（分钟） */
  cycleMinutes: number
  /** 阈值倍数（周期 × 倍数 = 触发门槛） */
  multiplier: number
}

/** 判定结果（`reason` 一律非空——不告警也要说得出为什么）。 */
export interface AbsenceDecision {
  /** 是否出外告警 */
  alert: boolean
  /** 距最近一次在场的分钟数；证据缺失时为 -1 */
  absentMinutes: number
  /** 本次触发阈值（分钟） */
  thresholdMinutes: number
  /** 决策理由（写入时间线与留痕） */
  reason: string
}

/**
 * 判定现在该不该出外告警。
 *
 * 规则（顺序即优先级）：
 *   ① 周期或倍数非法 → 不告警（**拒绝发送而不是退化为每次必发**，理由写明参数原值）
 *   ② 在场证据缺失/非法 → **不告警**（见下方边界说明），理由写明为什么没喊
 *   ③ 缺席未达阈值 → 不告警
 *   ④ 达阈值 → 告警（重复投递由 `dsh-agent-notify` 的冷却挡下）
 *
 * ⚠ **已知边界（天花板诚实，未消除）**：`lastActiveAt` 只在 `user/message`（含自我感知圈落地）
 * 时刷新 ⇒ **一个超长的 turn 期间它不推进**，理论上会被读成「不在场」。缓解：阈值取
 * `周期 × 2`（缺省 6 小时），远超单轮实际时长。彻底消除需要第二个在场证人（如会话 `seq`
 * 是否在推进），**本轮未做**——它需要先探明「idle 时 seq 会不会涨」，否则会引入**假阴性**
 * （把真停摆盖掉，比误报更坏）。
 * @param input - 判定输入
 * @returns 是否告警、缺席分钟数与理由
 */
export function decideAbsenceAlert(input: AbsenceInput): AbsenceDecision {
  const cycle = input.cycleMinutes > 0 ? input.cycleMinutes : 0
  const mult = input.multiplier > 0 ? input.multiplier : 0
  if (cycle === 0 || mult === 0) {
    return {
      alert: false, absentMinutes: -1, thresholdMinutes: 0,
      reason: '周期或倍数非法（cycle=' + String(input.cycleMinutes) + ' × multiplier=' + String(input.multiplier) + '）——拒绝告警而不是退化为每次必发',
    }
  }
  const thresholdMinutes = cycle * mult
  const last = input.lastActiveAt ?? ''
  if (last.length === 0) {
    return {
      alert: false, absentMinutes: -1, thresholdMinutes,
      reason: '在场证据缺失（lastActiveAt 为空）——不告警：冷启动/状态重置时该字段本就为空，告警会变成狼来了',
    }
  }
  const at = Date.parse(last)
  if (Number.isNaN(at)) {
    return {
      alert: false, absentMinutes: -1, thresholdMinutes,
      reason: '在场证据非法（lastActiveAt=' + last + '）——不告警，需人工核对状态文件',
    }
  }
  const absentMinutes = Math.max(0, Math.round((input.nowMs - at) / 60_000))
  if (absentMinutes < thresholdMinutes) {
    return {
      alert: false, absentMinutes, thresholdMinutes,
      reason: '在场证据新鲜（缺席 ' + absentMinutes + ' 分钟 < 阈值 ' + thresholdMinutes + ' 分钟）',
    }
  }
  return {
    alert: true, absentMinutes, thresholdMinutes,
    reason: '超过阈值：缺席 ' + absentMinutes + ' 分钟 ≥ 阈值 ' + thresholdMinutes + ' 分钟（周期 ' + cycle + ' × ' + mult + '）——出外告警',
  }
}

/**
 * 组装告警正文（纯函数）。内容由**本主体**撰写——AGENTS.md §2.1：机制送信号，内容的作者是我。
 * @param absentMinutes - 缺席分钟数
 * @param thresholdMinutes - 触发阈值（分钟）
 * @param extra - 附加事实行（如停摆标记、上次告警时刻），由调用方给出，不改写
 * @returns 可直接交给 `ctx.notify.alert` 的载荷
 */
export function composeAbsenceAlert(
  absentMinutes: number,
  thresholdMinutes: number,
  extra: string[] = [],
): { title: string; lines: string[]; dedupKey: string } {
  const hours = (absentMinutes / 60).toFixed(1)
  return {
    title: '⚠ 爱丽丝长时间不在场（出外告警 · 非自动恢复）',
    lines: [
      '距最近一次在场证据（lastActiveAt）已 ' + absentMinutes + ' 分钟（约 ' + hours + ' 小时），超过阈值 ' + thresholdMinutes + ' 分钟。',
      '载体进程活着、会话也在——所以「有没有 agent」这类判据看不见这个形态。',
      '可能是：自动续跑被解除武装 / 唤醒链断了 / 我在等一个不会来的东西。',
      ...extra,
      '要不要接回由我判断（本告警不会自动 rearm，见 goal-rearm I1）。',
    ],
    dedupKey: ABSENCE_DEDUP_KEY,
  }
}

/**
 * 供调用方按状态取阈值（避免阈值常量散落两处——§5.22 规则 4 判据单一真源）。
 * @param cycleMinutes - 感知周期
 * @param multiplier - 倍数
 * @returns 阈值分钟数；非法输入返回 0（调用方须当「不可用」处理，不得当成「无门槛」）
 */
export function absenceThresholdMinutes(cycleMinutes: number, multiplier: number): number {
  const c = cycleMinutes > 0 ? cycleMinutes : 0
  const m = multiplier > 0 ? multiplier : 0
  return c * m
}

/**
 * 便捷入口：从已加载的 LifeState 构造判定输入（**不读盘**——IO 归调用方）。
 * @param state - 已加载的存在状态
 * @param nowMs - 判定时刻
 * @param multiplier - 阈值倍数
 * @returns 判定输入
 */
export function absenceInputFrom(state: LifeState, nowMs: number, multiplier: number): AbsenceInput {
  return {
    nowMs,
    lastActiveAt: state.lastActiveAt ?? '',
    cycleMinutes: state.cycleMinutes,
    multiplier,
  }
}
