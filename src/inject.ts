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

export const SELF_TURN_MARK = '[life-core] 自我感知'

export function isSelfTurn(text: string): boolean {
  return typeof text === 'string' && text.includes(SELF_TURN_MARK)
}

export function installLifeInject(ctx: Context): void {
  const bySession = new Map<string, string>()
  // DSH alpha.1 类型漂移（2026-09-04）：agent/pre-step 事件重载后 TS 无法匹配监听器签名，
  // 运行时契约未变——用宽松类型绕开重载匹配（lib 旧代码一直正常运行即证）
  ctx.on('agent/pre-step', (async (payload: any, next: any) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const now = new Date()
    const hourKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
      + '-' + String(now.getDate()).padStart(2, '0') + ' ' + String(now.getHours()).padStart(2, '0')
    if (bySession.get(payload.agent.session.id) === hourKey) return decision
    bySession.set(payload.agent.session.id, hourKey)

    // 每一圈都留痕（存在连续性，落盘不注入）
    const state = loadState()
    recordTurn(state)

    // 极简注入：宣言 + 状态一行，不携带时间线历史
    const text = '【存在·生命状态】' + state.self.creed
      + ' ｜ 清醒 · 今日第 ' + state.todayTurns + ' 圈 · ' + hourKey.split(' ')[1]

    const msg = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-life-core' },
    })
    return { ...decision, messages: [...decision.messages, msg] }
  }) as any, { prepend: true })
}
