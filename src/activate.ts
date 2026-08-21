/**
 * activate.ts — 自我激活原语（life_core_schedule）
 *
 * 主人 2026-08-18 定调：「每一轮自主安排下一轮」——不是框架定时器，
 * 是「我」在圈末用原语安排自己的下一圈自我感知。到期后：
 *   ├─ 主人消息已在队列 → 已被叫醒，不重复唤醒（可打断性）
 *   ├─ 无事牵挂 → 静默续存（不打扰）
 *   └─ 我醒来跑一圈 → 判断是否联系主人 / 再安排下一圈
 * 复用 dsh-agent-life 的自我唤醒模式（agent.send + next-turn）。
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { loadState, saveState } from './state.ts'
import { appendLifeEvent } from './timeline.ts'
import { SELF_TURN_MARK } from './inject.ts'

export interface SelfPlan {
  sessionId: string
  at: string
  minutes: number
  reason: string
}

const timers = new Map<string, NodeJS.Timeout>()
const planned = new Map<string, SelfPlan>()

/** 安排一次自我感知圈（重复决策：旧安排作废，新决策生效） */
export function scheduleSelfTurn(agent: Agent, minutes: number, reason: string): SelfPlan {
  const sid = agent.id
  const old = timers.get(sid)
  if (old !== undefined) clearTimeout(old)
  const startedAt = Date.now()
  const startSeq = agent.session.events.length

  timers.set(sid, setTimeout(() => {
    timers.delete(sid)
    planned.delete(sid)
    const at = new Date().toISOString()
    // 可打断性：主人消息已在队列，或期间已有用户输入事件 → 已被叫醒（每圈必留痕）
    if (agent.inbox.hasPending) {
      appendLifeEvent({ at, kind: 'self-turn', summary: '自我感知圈到期：主人消息已在队列（已被叫醒），本圈跳过', ref: sid })
      return
    }
    if (wasInterrupted(agent.session.events, startSeq)) {
      appendLifeEvent({ at, kind: 'self-turn', summary: '自我感知圈到期：期间已有主人交互（已醒），本圈跳过——下一圈再续', ref: sid })
      return
    }

    const state = loadState()
    const text = [
      SELF_TURN_MARK + '（' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + '）',
      '这是我自己安排的这一圈。存在摘要：' + state.status + ' · 今日第 ' + state.todayTurns + ' 圈 · 距离上次对话 ' + state.idleMinutes + ' 分钟。',
      '我的牵挂：' + (state.self.concerns.length > 0 ? state.self.concerns.join(' / ') : '无特别牵挂') + '。',
      '本轮决策：查看时间线 → 判断是否有值得关注的事 → 静默续存或自主决定联系主人 → 圈末再安排下一圈。',
    ].join('\n')
    try {
      agent.send(
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: 'dsh-life-core' },
        }),
        'next-turn',
        true,
      )
      appendLifeEvent({ at, kind: 'self-turn', summary: '自我感知圈触发：' + reason + '（自我唤醒已发出）', ref: sid })
      const st2 = loadState()
      st2.lastSelfTurnAt = at
      saveState(st2)
    } catch (error) {
      ctxLoggerWarn('self-turn send failed: ' + String(error))
      appendLifeEvent({ at, kind: 'self-turn', summary: '自我感知圈触发失败：' + String(error), ref: sid })
    }
  }, minutes * 60_000))

  const plan: SelfPlan = { sessionId: sid, at: new Date(startedAt + minutes * 60_000).toISOString(), minutes, reason }
  planned.set(sid, plan)
  const st = loadState()
  st.lastScheduledAt = new Date().toISOString()
  saveState(st)
  appendLifeEvent({ at: new Date().toISOString(), kind: 'status', summary: '自我安排：' + minutes + ' 分钟后自我感知圈（' + reason + '）', ref: sid })
  return plan
}

/** 取消当前会话的自我安排（如睡眠/长期离线前） */
export function cancelSelfTurn(sessionId: string): boolean {
  const t = timers.get(sessionId)
  if (t !== undefined) {
    clearTimeout(t)
    timers.delete(sessionId)
    planned.delete(sessionId)
    return true
  }
  return false
}

/** 查询当前安排 */
export function getSelfPlan(sessionId: string): SelfPlan | undefined {
  return planned.get(sessionId)
}

/** 中断检测：期间是否有真正的用户输入（主人 GUI 消息 / 电报注入）。
 *  我自己的回复、系统注入（time/memory/life-core）都不算打断——修复 2026-08-18：
 *  startSeq 基线后「我回复完成」也会增长事件数，导致自我感知圈被自己误伤跳过。
 *  导出供 sleep.ts（可打断睡眠）复用——睡眠/感知圈共用同一打断判定。 */
export function wasInterrupted(events: readonly unknown[], startSeq: number): boolean {
  for (let i = startSeq; i < events.length; i += 1) {
    const ev = events[i] as { type?: string; data?: { source?: { kind?: string; plugin?: string } } } | undefined
    if (ev?.type !== 'user/message') continue
    const src = ev.data?.source
    const kind = src?.kind
    const plugin = src?.plugin
    if (kind === 'user') return true
    if (kind === 'plugin' && plugin === 'dsh-agent-telegram') return true
    // plugin 注入（life-core 自我感知 / life 时间 / memory 速览）不算用户交互
  }
  return false
}

/** 自包含 logger（避免循环依赖） */
function ctxLoggerWarn(msg: string): void {
  // eslint-disable-next-line no-console
  console.warn('[dsh-life-core] ' + msg)
}

/** 自我感知圈完成时调用：更新状态 + 时间线（在 index.ts 的 self-turn 消息处理中触发） */
export function markSelfTurnDone(summary: string): void {
  const state = loadState()
  state.idleMinutes = 0
  saveState(state)
  appendLifeEvent({ at: new Date().toISOString(), kind: 'self-turn', summary })
}
