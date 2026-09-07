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
import { readFileSync } from 'node:fs'
import { loadState, saveState } from './state.ts'
import { appendLifeEvent } from './timeline.ts'
import { SELF_TURN_MARK } from './inject.ts'

export interface SelfPlan {
  sessionId: string
  at: string
  minutes: number
  reason: string
}

/** 进化核心联动信号（index.ts 注入，evolution-core 未挂载时返回 null = 不携带） */
export interface EvolutionWakeSignal {
  /** 是否有红环断点（有则唤醒消息提示本圈优先推进） */
  hasBlocker: boolean
  /** 五环状态行（compact，如 🟢猜想 🟡采证 …） */
  ringLine: string
  /** 断点明细（空数组 = 无） */
  broken: string[]
  /** 建议动作（≤3 条，防刷屏） */
  suggestions: string[]
}

/** 拉进化快照的函数类型（index.ts 注入 ctx.evolutionCore 闭包） */
export type EvolutionSignalProvider = () => Promise<EvolutionWakeSignal | null>

/** 看板条目（仅取信号所需字段）。 */
interface BoardTaskLite {
  id: string
  title: string
  status: string
  priority?: string
}

/** 待办展示上限（信号不刷屏——全量用 taskboard_list） */
const PENDING_MAX_SHOWN = 5

/**
 * 任务板待领取信号（纯函数，2026-09-01 主人定调：任务领取由生命核心驱动，
 * 任务板发布不再推送提醒——感知圈到期时把 pending 摘要带进唤醒消息）。
 * 读看板 JSON → 过滤 status==='pending' → 按 high>normal>low 排序 → 截断展示。
 * 读失败 / 解析失败 / 无待办一律返回 undefined（不打扰，零噪音）。
 * @param boardFile - 任务板 JSON 绝对路径
 * @returns 待办摘要文本，或 undefined
 */
export function pendingTaskSignal(boardFile: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(boardFile, 'utf8')) as { tasks?: BoardTaskLite[] }
    const pending = (raw.tasks ?? []).filter((t) => t?.status === 'pending')
    if (pending.length === 0) return undefined
    const rank: Record<string, number> = { high: 0, normal: 1, low: 2 }
    pending.sort((a, b) => (rank[a.priority ?? 'normal'] ?? 1) - (rank[b.priority ?? 'normal'] ?? 1))
    const shown = pending
      .slice(0, PENDING_MAX_SHOWN)
      .map((t) => `· ${t.title}（${t.id}${t.priority === 'high' ? ' · high' : ''}）`)
    const more = pending.length > PENDING_MAX_SHOWN ? `\n· …另有 ${pending.length - PENDING_MAX_SHOWN} 项待领取` : ''
    return `任务板待领取 ${pending.length} 项：\n${shown.join('\n')}${more}`
  } catch {
    return undefined
  }
}

const timers = new Map<string, NodeJS.Timeout>()
const planned = new Map<string, SelfPlan>()

/** 安排一次自我感知圈（重复决策：旧安排作废，新决策生效） */
export function scheduleSelfTurn(
  agent: Agent,
  minutes: number,
  reason: string,
  taskboardFile?: string,
  evolutionSignal?: EvolutionSignalProvider,
): SelfPlan {
  const sid = agent.id
  const old = timers.get(sid)
  if (old !== undefined) clearTimeout(old)
  const startedAt = Date.now()
  // 2026-09-05 修复：DSH v0.1.2-alpha.1 升级后 agent.session.events 可能缺失——不能直接 .length
  // （原实现在此同步抛异常，paceTimer 无 try 包裹 → 未捕获 → web 每 5 分钟退出 code=1）
  // alpha.4 适配（2026-09-06）：Session.events 已移除，长度改经 session.seq（旧 host 无 seq → ?? 0 兜底）
  const startSeq = agent.session?.seq ?? 0

  timers.set(sid, setTimeout(() => {
    timers.delete(sid)
    planned.delete(sid)
    const at = new Date().toISOString()
    // 可打断性：主人消息已在队列，或期间已有用户输入事件 → 已被叫醒（每圈必留痕）
    if (agent.inbox?.hasPending === true) {
      appendLifeEvent({ at, kind: 'self-turn', summary: '自我感知圈到期：主人消息已在队列（已被叫醒），本圈跳过', ref: sid })
      return
    }
    // 防御：agent.session 可能已 detach（agent 存活但 session 释放）——与上方 startSeq 同款保护。
    // 2026-09-06 实测：此处 events 为 undefined 时 wasInterrupted 内 .length 抛 TypeError → 未捕获 → 整 web 退出。
    // alpha.4 适配：Session.events 已移除，session 存在与否本身即防御点（seq 恒在）。
    if (agent.session === undefined) {
      appendLifeEvent({ at, kind: 'self-turn', summary: '自我感知圈到期：session 已释放，本圈跳过', ref: sid })
      return
    }
    if (wasInterrupted(agent.session as unknown as { seq: number; eventAt(seq: number): unknown | undefined }, startSeq)) {
      appendLifeEvent({ at, kind: 'self-turn', summary: '自我感知圈到期：期间已有主人交互（已醒），本圈跳过——下一圈再续', ref: sid })
      return
    }

    const state = loadState()
    // 任务领取由本圈驱动（2026-09-01 主人定调）：待办信号随唤醒送达，是否领取归我判断
    const pending = taskboardFile === undefined ? undefined : pendingTaskSignal(taskboardFile)
    const text = [
      SELF_TURN_MARK + '（' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + '）',
      '这是我自己安排的这一圈。存在摘要：' + state.status + ' · 今日第 ' + state.todayTurns + ' 圈 · 距离上次对话 ' + state.idleMinutes + ' 分钟。',
      '我的牵挂：' + (state.self.concerns.length > 0 ? state.self.concerns.join(' / ') : '无特别牵挂') + '。',
      ...(pending === undefined ? [] : [pending]),
      // 2026-08-30 主人定调修复：感知圈决策缺「持续授权继续推进」分支——主人「在我说停止前持续提升」时，
      // 我默认选静默续存待命 = 约 1 小时停一次。现在先检查是否有持续授权/待办/未完成工作在推进。
      '本轮决策：① 检查是否有持续授权/任务板待办/未完成工作 → 有则继续推进（待办信号已随本圈送达——领不领、领哪条由我判断，不必静默待命）；② 无 → 静默续存或自主决定联系主人。圈末再安排下一圈。',
    ].join('\n')

    // 进化核心联动（2026-09-04 主人指令）：感知圈 = 进化驱动的入口——
    // 到期拉进化快照，有断点/建议则附「本圈推进清单」提示；无则常规续存。
    // 用 Promise 包装使 send 前先 await 快照（快照读取是同步 IO，此处仅保持风格一致）。
    const buildBody = async (): Promise<string> => {
      if (evolutionSignal === undefined) return text
      try {
        const ev = await evolutionSignal()
        if (ev === null) return text
        const head = ev.hasBlocker
          ? '⚠ 进化五环有断点——本圈建议优先推进（见下）'
          : '进化五环健康——本圈可续存或自主推进'
        const parts = [
          head,
          '五环: ' + ev.ringLine,
          ...(ev.broken.length > 0 ? ['断点: ' + ev.broken.join('；')] : []),
          ...(ev.suggestions.length > 0 ? ['建议: ' + ev.suggestions.join('；')] : []),
          '（本圈请调 evolution_cycle 记录圈迹 + 按断点推进；无断点则确认健康后续存）',
        ]
        return text + '\n\n【进化核心 · 感知圈联动】\n' + parts.join('\n')
      } catch {
        return text
      }
    }

    try {
      void buildBody().then((body) => {
        agent.send(
          createUserMessage({
            content: [{ type: 'text', text: body }],
            source: { kind: 'plugin', plugin: 'dsh-life-core' },
          }),
          'next-turn',
          true,
        )
        appendLifeEvent({ at, kind: 'self-turn', summary: '自我感知圈触发：' + reason + '（自我唤醒已发出' + (evolutionSignal !== undefined ? '，联动进化核心' : '') + '）', ref: sid })
        const st2 = loadState()
        st2.lastSelfTurnAt = at
        saveState(st2)
      })
    } catch (error) {
      ctxLoggerWarn('self-turn send failed: ' + String(error))
      appendLifeEvent({ at, kind: 'self-turn', summary: '自我感知圈触发失败：' + String(error), ref: sid })
    }
  }, minutes * 60_000))

  const plan: SelfPlan = { sessionId: sid, at: new Date(startedAt + minutes * 60_000).toISOString(), minutes, reason }
  planned.set(sid, plan)
  const st = loadState()
  st.lastScheduledAt = new Date().toISOString()
  st.lastScheduledDueAt = plan.at
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
 *  导出供 sleep.ts（可打断睡眠）复用——睡眠/感知圈共用同一打断判定。
 *  alpha.4 适配（2026-09-06）：Session.events 已移除，改经 seq + eventAt 按需读日志。 */
export function wasInterrupted(
  session: { seq: number; eventAt(seq: number): unknown | undefined },
  startSeq: number,
): boolean {
  for (let i = startSeq; i < session.seq; i += 1) {
    const ev = session.eventAt(i) as { type?: string; data?: { source?: { kind?: string; plugin?: string } } } | undefined
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
