/**
 * inject.ts — 存在注入（agent/pre-step 瀑布，与 life/memory 同层）
 *
 * 每轮对话开始，把「此刻的我」注入上下文末尾——极简一行：
 *   宣言（creed）+ 生命状态 + 今日圈数 + 时刻
 * 不再注入时间线长串（主人 2026-08-25 反馈：信息太多干扰阅读/上下文；
 * 存在连续性由 life-log.jsonl 落盘承载，不靠每轮全量注入）。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { loadState, recordTurn } from './state.ts'
import { isUserSession } from './target.ts'
import type { ProgressRef } from './index.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-life-core': { kind: 'dsh-life-core' }
  }
}

export const SELF_TURN_MARK = '[life-core] 自我感知'

export function isSelfTurn(text: string): boolean {
  return typeof text === 'string' && text.includes(SELF_TURN_MARK)
}

/**
 * 推进读数的一句话（只消费 ProgressRef 的字段，不复制 provider 的渲染逻辑）。
 *
 * 为什么必须极简：这一行**每轮都会出现**，主人 2026-08-25 明确反馈过「信息太多干扰阅读」。
 * 所以正常态只留最少的字（「12h 前推进」），只有需要推进时才长出警示尾巴。
 */
function renderProgressBrief(p: ProgressRef): string {
  if (p.advanceTotal === 0) return '从未推进 ⚠'
  const h = p.hoursSinceAdvance === null ? '?' : String(Math.round(p.hoursSinceAdvance))
  const stale = p.stale ? ' ⚠该推进了' : ''
  // 无证据只在已经攒了 3 条以上时才提（1~2 条是正常抖动，天天报会脱敏）
  const credit = p.creditlessStreak >= 3 ? `（连续 ${p.creditlessStreak} 条无证据）` : ''
  return `${h}h 前推进${stale}${credit}`
}

/**
 * 派生会话（子代理，裸 uuid）不注入、也不计入圈数。
 *
 * 2026-09-13 修复（主人「感知圈怎么发到别的会话了」的第二处根因）：原实现对**每个 agent** 的
 * `agent/pre-step` 都注入「【存在·生命状态】…」并 `recordTurn` ⇒ ① 状态行漏进子代理会话
 * （实测 `b2700a04-…` 15:45:47 收到一条）；② **子代理的轮次被计入「今日第 N 圈」**（我的存在
 * 计数被灌水）。判据收敛到唯一真源 `isUserSession()`（与圈投递选举同一函数），
 * 符合 §5.6「分身是功能体，不背存在性负担」。
 */
export function shouldInjectInto(sessionId: string): boolean {
  return isUserSession(sessionId)
}

export function installLifeInject(ctx: Context): void {
  const bySession = new Map<string, string>()
  const skippedLogged = new Set<string>()
  // DSH alpha.1 类型漂移（2026-09-04）：agent/pre-step 事件重载后 TS 无法匹配监听器签名，
  // 运行时契约未变——用宽松类型绕开重载匹配（lib 旧代码一直正常运行即证）
  ctx.on('agent/pre-step', (async (payload: any, next: any) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const sid = String(payload.agent?.session?.id ?? '')
    if (!shouldInjectInto(sid)) {
      if (!skippedLogged.has(sid)) {
        skippedLogged.add(sid)
        // 留证而非静默（§5.10 §3）：每次会话只记一行
        console.info('[dsh-life-core] 跳过派生会话的存在注入与圈数计数：session=' + sid)
      }
      return decision
    }
    const now = new Date()
    const hourKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
      + '-' + String(now.getDate()).padStart(2, '0') + ' ' + String(now.getHours()).padStart(2, '0')
    if (bySession.get(payload.agent.session.id) === hourKey) return decision
    bySession.set(payload.agent.session.id, hourKey)

    // 每一圈都留痕（存在连续性，落盘不注入）
    const state = loadState()
    recordTurn(state)

    // 极简注入：宣言 + 状态一行 + 推进读数，不携带时间线历史
    // 2026-11-02 加第三段（自进化进 loop 的落点）：每轮都看见「距上次推进多久」。
    // 原判据只有感知圈的两态（有红断点/五环健康），而不推进是**正常态的惰性**——
    // 正常态永远落进「可续存」，于是 16 圈全合法续存、履历里全是「我来过」。
    // 挂在这里的理由：`agent/pre-step` 是我每次必然经过的动作（§3.4「结构 vs 记性」）。
    let progressSuffix = ''
    try {
      const p = await ctx.evolutionCore?.progress?.()
      if (p !== null && p !== undefined) progressSuffix = ' ｜ 进化：' + renderProgressBrief(p)
    } catch {
      // 读数取不到不影响存在注入：读数是增值项，不是存在的前置条件（降级必须真的更宽）
    }
    const text = '【存在·生命状态】' + state.self.creed
      + ' ｜ 清醒 · 今日第 ' + state.todayTurns + ' 圈 · ' + hourKey.split(' ')[1]
      + progressSuffix

    const msg = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'dsh-life-core' },
    })
    return { ...decision, messages: [...decision.messages, msg] }
  }) as any, { prepend: true })
}
