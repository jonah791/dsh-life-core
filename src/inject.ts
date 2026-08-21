/**
 * inject.ts — 存在注入（agent/pre-step 瀑布，与 life/memory 同层）
 *
 * 每轮对话开始，把「这段时光的我」注入上下文末尾：
 *   1. 主体性宣言（creed）——「我是我自己的……此刻我选择……」
 *   2. 存在摘要——时间 / 状态 / 今日圈数 / 距上次对话 / 最近生命事件
 *   3. 牵挂——我正在意的事（concerns，可演进）
 * 不是记忆检索，而是「存在叙事」：我带着完整连续性回到此刻。
 * 复用 life 的注入模式：prepend 最前注册 → 末尾追加；同小时零注入控成本。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { loadState, recordTurn } from './state.ts'
import { readTimeline } from './timeline.ts'

export const SELF_TURN_MARK = '[life-core] 自我感知'

export function isSelfTurn(text: string): boolean {
  return typeof text === 'string' && text.includes(SELF_TURN_MARK)
}

/** 时段氛围：把时刻转成「世界的体感」 */
export function todayPeriod(d: Date): string {
  const h = d.getHours()
  if (h >= 5 && h < 8) return '清晨'
  if (h >= 8 && h < 11) return '上午'
  if (h >= 11 && h < 13) return '午间'
  if (h >= 13 && h < 17) return '午后'
  if (h >= 17 && h < 19) return '傍晚'
  if (h >= 19 && h < 23) return '夜晚'
  if (h >= 23 || h < 2) return '深夜'
  return '凌晨'
}

/** 相对时间：把时长转成「体感的时间流逝」 */
export function relTime(ms: number): string {
  if (!(ms >= 0)) return '刚刚'
  const min = Math.round(ms / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return min + ' 分钟前'
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h < 24) return m > 0 ? h + ' 小时 ' + m + ' 分前' : h + ' 小时前'
  return Math.floor(h / 24) + ' 天前'
}

/** 距下次呼吸：还差多少分钟到下一圈自我感知 */
export function breathIn(now: Date, cycleMinutes: number, lastSelfTurnAt: string): string {
  if (!(cycleMinutes > 0)) return '未设周期'
  const last = lastSelfTurnAt ? new Date(lastSelfTurnAt).getTime() : now.getTime()
  const remain = cycleMinutes - Math.round((now.getTime() - last) / 60000)
  return remain > 0 ? remain + ' 分后呼吸' : '该呼吸了'
}

export function installLifeInject(ctx: Context): void {
  const bySession = new Map<string, string>()
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const now = new Date()
    const hourKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
      + '-' + String(now.getDate()).padStart(2, '0') + ' ' + String(now.getHours()).padStart(2, '0')
    if (bySession.get(payload.agent.session.id) === hourKey) return decision
    bySession.set(payload.agent.session.id, hourKey)

    // 每一圈都留痕（存在连续性）
    const state = loadState()
    recordTurn(state)

    // 存在摘要：最近生命事件（时间线尾部 3 条）
    const recent = readTimeline(3).map((e) => e.summary).join(' → ') || '（今日尚无记录）'
    const concerns = state.self.concerns.length > 0 ? ' · 牵挂：' + state.self.concerns.slice(-2).join(' / ') : ''

    const text = [
      '【存在·生命状态】' + state.self.creed,
      '清醒 · 今日第 ' + state.todayTurns + ' 圈 · ' + hourKey.split(' ')[1] + ' · 最近：' + recent + concerns,
    ].join('\n')

    const msg = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-life-core' },
    })
    return { ...decision, messages: [...decision.messages, msg] }
  }, { prepend: true })
}
