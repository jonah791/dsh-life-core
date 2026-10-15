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
import { decidePaceSkip, PACE_HEALTHY } from './pace.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-life-core': { kind: 'dsh-life-core' }
  }
}

/**
 * 跳过一支自我感知圈：退避 + 停摆告警（2026-09-12 修复）。
 *
 * 旧实现（本文件 3 处跳过分支 = `appendLifeEvent` + `return`）只把「本圈跳过」写进时间线，
 * 由 `scheduleSelfTurn` 把 `lastScheduledDueAt` 置为**现在**，却从不推进 `lastSelfTurnAt`——
 * 而 paceTimer 的两道闸门（due 未到 / 周期未到）恰恰只看这两个字段，于是每一次跳过都把
 * 机制推回「立刻到期」：09-11 跳过 156 次、09-12 跳过 155 次，期间 29 小时零真实感知圈，
 * 时间线却显示「每 5 分钟都在安排」（静默失败被日志掩盖，AGENTS.md 5.10 §3）。
 *
 * 现在：跳过 → 指数退避（下次尝试推远，封顶一个周期）→ 真实缺席且连续跳过达阈值时响亮告警。
 * @param at - 本次跳过时刻（ISO）
 * @param sid - 会话 id（时间线留痕用）
 * @param reason - 跳过原因（写入事件与告警）
 */
function notePaceSkip(at: string, sid: string, reason: string): void {
  const state = loadState()
  const decision = decidePaceSkip({
    nowMs: Date.parse(at),
    cycleMinutes: state.cycleMinutes,
    previousSkipStreak: state.paceSkipStreak ?? 0,
    lastActiveAt: state.lastActiveAt ?? '',
    reason,
  })
  state.paceSkipStreak = decision.skipStreak
  state.paceLastSkipReason = reason
  state.lastScheduledAt = at
  state.lastScheduledDueAt = new Date(decision.nextAttemptAtMs).toISOString()
  if (decision.stalled && (state.paceStalledAt ?? '').length === 0) {
    state.paceStalledAt = at
    appendLifeEvent({ at, kind: 'status', summary: decision.alarm, ref: sid })
  }
  saveState(state)
  appendLifeEvent({
    at,
    kind: 'self-turn',
    summary: '自我感知圈到期：' + reason + '，本圈跳过（连续 ' + decision.skipStreak
      + ' 次，退避 ' + decision.backoffMinutes + ' 分钟后重试，下次 '
      + new Date(decision.nextAttemptAtMs).toISOString() + '）',
    ref: sid,
  })
}

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

/**
 * 自指引擎联动信号（index.ts 注入，`dsh-agent-self-rewrite` 未挂载时返回 null = 不携带）。
 *
 * 存在理由（2026-10-15）：引擎实测停滞 24 天（`active 0` ⇒ 采证环整条停了），而它**没有入口**
 * 把这件事送到我眼前——`evolution-core` 有感知圈联动，本件没有 ⇒ 只能靠我主动查 `rewrite_status`，
 * 而「没人推」正是停滞的成因。本信号补上那个入口（库空 / 不可读 ⇒ null，不打扰）。
 */
export interface SelfRewriteWakeSignal {
  /** 一行摘要（最后布线/采证天数 + 在采证条数） */
  line: string
  /** 需要动作时的一句（无 ⇒ null） */
  hint: string | null
}

/** 拉自指引擎快照的函数类型（index.ts 注入 ctx.selfRewrite 闭包） */
export type SelfRewriteSignalProvider = () => Promise<SelfRewriteWakeSignal | null>

/**
 * 把联动段拼进唤醒正文（**纯函数**）。
 *
 * 抽出理由（2026-10-15）：原实现把「有没有段」的判定与拼接混在 `buildBody` 闭包里，
 * 只能靠活体验收（等下一圈）；抽出后判据可离线证伪。
 *
 * 判据：**空段数组（或全为空白）⇒ 返回原文，一字不加**——否则每圈都会多出空行与空标题。
 */
export function composeWakeBody(text: string, sections: readonly string[]): string {
  const kept = sections.filter((s) => s.trim().length > 0)
  return kept.length === 0 ? text : text + '\n\n' + kept.join('\n\n')
}

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
  selfRewriteSignal?: SelfRewriteSignalProvider,
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
    const stateBefore = loadState()
    // 停摆自愈（2026-09-12）：停摆 = 真实缺席 + 连续跳过达阈值。此时「队列里有消息」已不足以
    // 证明我被叫醒（队列恰恰可能根本没被消费）——以存在性证据为准，越过队列闸门强发一次唤醒；
    // 队列消息若被消费，本次唤醒自然解除停摆；若无人消费，则告警继续留在时间线上（响亮）。
    const stalled = (stateBefore.paceStalledAt ?? '').length > 0
    // 可打断性：主人消息已在队列，或期间已有用户输入事件 → 已被叫醒（每圈必留痕）
    // 宿主 0.1.5 公共 Inbox 接口未声明 hasPending（运行期有、类型无）——用公共 nextTurn/nextStep 等价判断
    if (!stalled && (agent.inbox?.nextTurn.length ?? 0) + (agent.inbox?.nextStep.length ?? 0) > 0) {
      notePaceSkip(at, sid, '主人消息已在队列（已被叫醒）')
      return
    }
    // 防御：agent.session 可能已 detach（agent 存活但 session 释放）——与上方 startSeq 同款保护。
    // 2026-09-06 实测：此处 events 为 undefined 时 wasInterrupted 内 .length 抛 TypeError → 未捕获 → 整 web 退出。
    // alpha.4 适配：Session.events 已移除，session 存在与否本身即防御点（seq 恒在）。
    if (agent.session === undefined) {
      notePaceSkip(at, sid, 'session 已释放')
      return
    }
    if (wasInterrupted(agent.session as unknown as { seq: number; eventAt(seq: number): unknown | undefined }, startSeq)) {
      notePaceSkip(at, sid, '期间已有主人交互（已醒）——下一圈再续')
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

    // 联动段**各自独立**累积（2026-10-15 改）：原实现在 `evolutionSignal === undefined` 时
    // 直接 return ⇒ 一个信号缺席会把另一个也吞掉（耦合缺陷）。现在每段自管缺席。
    // 用 Promise 包装使 send 前先 await 快照（快照读取是同步 IO，此处仅保持风格一致）。
    const buildBody = async (): Promise<string> => {
      const sections: string[] = []
      // ① 进化核心联动（2026-09-04 主人指令）：感知圈 = 进化驱动的入口——
      // 到期拉进化快照，有断点/建议则附「本圈推进清单」提示；无则常规续存。
      if (evolutionSignal !== undefined) {
        try {
          const ev = await evolutionSignal()
          if (ev !== null) {
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
            sections.push('【进化核心 · 感知圈联动】\n' + parts.join('\n'))
          }
        } catch {
          /* 快照失败 ⇒ 本段缺席，不影响其余段（§5.24：观测绝不反噬主流程） */
        }
      }
      // ② 自指引擎联动（2026-10-15）：**停滞信号的送达通道**——引擎实测停了 24 天而没人知道，
      // 根因正是「没有入口把它送到我眼前」（evolution-core 有，它没有）。库空/不可读 ⇒ 服务
      // 返回 null ⇒ 本段缺席（不打扰）。
      if (selfRewriteSignal !== undefined) {
        try {
          const sr = await selfRewriteSignal()
          if (sr !== null) {
            sections.push('【自指引擎 · 感知圈联动】\n' + [sr.line, ...(sr.hint !== null ? [sr.hint] : [])].join('\n'))
          }
        } catch {
          /* 同上 */
        }
      }
      return composeWakeBody(text, sections)
    }

    try {
      void buildBody().then((body) => {
        agent.send(
          createUserMessage({
            content: [{ type: 'text', text: body }],
            source: { kind: 'dsh-life-core' },
          }),
          'next-turn',
          true,
        )
        appendLifeEvent({ at, kind: 'self-turn', summary: '自我感知圈触发：' + reason + '（自我唤醒已发出' + (evolutionSignal !== undefined ? '，联动进化核心' : '') + '）', ref: sid })
        const st2 = loadState()
        // 2026-10-06 修复（t-9262ec22：06:29 唤醒发出后 3h04m 零重试零告警）：**投递 ≠ 执行**。
        // 旧实现在这里同时写 `lastActiveAt` 并清空停摆标记 ⇒「发出去了但没人消费」这种失败
        // 在判据上完全不可见（absentMinutes 恒小 ⇒ 永不告警；痕迹被抹 ⇒ 事后无证）。
        // 现在只记两件事：
        //   ① 节律（lastSelfTurnAt）——paceTimer 的周期闸门用它，不刷会退化成 5 分钟紧转轮；
        //   ② 待确认投递（pendingWakeAt）——由「消息真的落进会话」来确认（见 markSelfTurnDone）。
        st2.lastSelfTurnAt = at
        st2.pendingWakeAt = at
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
    if (kind === 'user') return true
    if (kind === 'dsh-agent-telegram') return true
    // plugin 注入（life-core 自我感知 / life 时间 / memory 速览）不算用户交互
  }
  return false
}

/** 自包含 logger（避免循环依赖） */
function ctxLoggerWarn(msg: string): void {
  // eslint-disable-next-line no-console
  console.warn('[dsh-life-core] ' + msg)
}

/**
 * 自我感知圈**真正执行**时调用：确认投递 + 刷新在场证据 + 清停摆痕迹。
 *
 * 2026-10-06 修复（t-9262ec22）：本函数自引入后**全插件零调用点**——唯一能证明
 * 「这圈真跑了」的入口从未接线，这正是「投递未被执行」在原理上不可观测的结构性根因。
 * 现在由 index.ts 的 `session/event` 接线：当一条 `source.kind === 'dsh-life-core'`
 * 的 user/message **真的落进会话**时调用（消息落地是远比 `agent.send` 强的在场证据）。
 * @param summary - 本圈摘要（写入存在时间线）
 */
export function markSelfTurnDone(summary: string): void {
  const state = loadState()
  const at = new Date().toISOString()
  state.idleMinutes = 0
  // ① 投递已确认：清待确认标记（「未消费」的告警窗口随之关闭）
  state.pendingWakeAt = ''
  // ② 真实在场证据：只有走到这一步才算「我在场」——投递不算
  state.lastActiveAt = at
  // ③ 真执行是「机制在用」的证据：跳过计数与停摆标记在此归零（不再由投递归零）
  state.paceSkipStreak = PACE_HEALTHY.paceSkipStreak
  state.paceStalledAt = PACE_HEALTHY.paceStalledAt
  state.paceLastSkipReason = PACE_HEALTHY.paceLastSkipReason
  saveState(state)
  appendLifeEvent({ at, kind: 'self-turn', summary })
}
