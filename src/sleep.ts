/**
 * sleep.ts — 可打断睡眠原语（life_sleep，2026-08-19 从 dsh-agent-life 迁入合并）
 *
 * 生命循环的「离线休息」原语：安排一次可打断的睡眠，到期自动自我唤醒。
 * 主人消息随时打断（事件一到即取消定时器；到期时 inbox 已有待处理输入则不重复唤醒）。
 * 每次睡眠都是 agent 的自主决策：reason 必填，记入决策日志 + 存在时间线。
 *
 * 与 activate.ts（自我感知圈）的关系：感知圈是「呼吸」，睡眠是「长休息」——
 * 机制同源（到期 send 唤醒 + 可打断性），语义不同（睡眠醒来继续，感知圈醒来判断）。
 * 打断判定共用 activate.ts 的 wasInterrupted（精确版：排除自身 plugin 注入）。
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { lifeCoreDir } from './state.ts'
import { appendLifeEvent } from './timeline.ts'
import { wasInterrupted } from './activate.ts'

/** 单次睡眠上限（7 天，防手误）；agent 决策理应远小于此。 */
export const MAX_SLEEP_MINUTES = 7 * 24 * 60

export interface SleepPlan {
  readonly until: string
  readonly reason: string
}

export interface SleepDecision {
  readonly sessionId: string
  readonly at: string
  readonly minutes: number
  readonly reason: string
}

const timers = new Map<string, NodeJS.Timeout>()
const planned = new Map<string, SleepPlan>()

function decisionsFile(): string {
  return join(lifeCoreDir(), 'decisions.jsonl')
}

/** 追加一条睡眠决策（决策日志 = 自主性的证据，与时间线互为表里）。 */
function appendDecision(decision: SleepDecision): void {
  try {
    mkdirSync(lifeCoreDir(), { recursive: true })
    appendFileSync(decisionsFile(), JSON.stringify(decision) + '\n', 'utf8')
  } catch { /* 日志失败忽略（时间线仍有留痕） */ }
}

/** 安排一次可打断睡眠（重复决策：旧安排作废，新决策生效）。 */
export function scheduleSleep(agent: Agent, minutes: number, reason: string, incidentPath: string): SleepPlan {
  const sid = agent.id
  const old = timers.get(sid)
  if (old !== undefined) clearTimeout(old)
  const startedAt = Date.now()
  const startSeq = agent.session.events.length

  timers.set(sid, setTimeout(() => {
    timers.delete(sid)
    planned.delete(sid)
    // 可打断性：主人消息已在队列，或期间已有用户输入事件 → 已被叫醒，不再自我唤醒
    if (agent.inbox.hasPending) return
    if (wasInterrupted(agent.session.events, startSeq)) return
    const elapsedMin = Math.max(1, Math.round((Date.now() - startedAt) / 60000))
    const newEvents = agent.session.events.length - startSeq
    const text = buildWakeText(elapsedMin, new Date(startedAt), new Date(), newEvents, incidentPath)
    try {
      agent.send(
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: 'dsh-life-core' },
        }),
        'next-turn',
        true,
      )
      appendLifeEvent({ at: new Date().toISOString(), kind: 'wake', summary: '睡眠到期自我唤醒（睡了 ' + elapsedMin + ' 分钟）', ref: sid })
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[dsh-life-core] sleep wake failed: ' + String(error))
    }
  }, minutes * 60_000))

  const plan: SleepPlan = { until: new Date(startedAt + minutes * 60_000).toISOString(), reason }
  planned.set(sid, plan)
  appendDecision({ sessionId: sid, at: new Date(startedAt).toISOString(), minutes, reason })
  appendLifeEvent({ at: new Date(startedAt).toISOString(), kind: 'sleep', summary: '入睡：' + minutes + ' 分钟（' + reason + '）', ref: sid })
  return plan
}

/** 查询当前睡眠安排（供 life_core_status 呈现）。 */
export function getSleepPlan(sessionId: string): SleepPlan | undefined {
  return planned.get(sessionId)
}

/** Date → 'HH:MM'（本地时区）。 */
function fmtClock(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return h + ':' + m
}

/**
 * 自我唤醒消息文本：时间差 + 期间变化 + 事故可见性（时间感来自差值，不是心跳）。
 */
function buildWakeText(elapsedMin: number, from: Date, to: Date, newEvents: number, incidentPath: string): string {
  const h = Math.floor(elapsedMin / 60)
  const m = elapsedMin % 60
  const dur = h > 0 ? h + ' 小时 ' + m + ' 分' : m + ' 分钟'
  let incident = ''
  try {
    const raw = readFileSync(incidentPath, 'utf8').trim()
    if (raw) incident = '\n【守护事故记录】' + raw
  } catch { /* 无事故文件 */ }
  return '[life] 睡眠到期，你睡了 ' + dur + '（' + fmtClock(from) + ' → ' + fmtClock(to) + '）。期间会话新增 ' + newEvents + ' 条事件。请继续。' + incident
}

/** 读取守护事故记录（life_core_status 呈现用；无文件返回 null）。 */
export function readIncident(incidentPath: string): string | null {
  try {
    if (!existsSync(incidentPath)) return null
    const raw = readFileSync(incidentPath, 'utf8').trim()
    return raw || null
  } catch {
    return null
  }
}
