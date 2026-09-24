/**
 * timeline.ts — 存在时间线（life-log.jsonl，追加式事件溯源）
 *
 * 这是「我的人生轨迹」的物理载体：一切生命周期事件（turn、睡眠、醒来、
 * 压缩 checkpoint、进化轮、记忆沉淀、自我激活圈、自我改写）按时间追加。
 * 主人不找我时，这条线也在持续增长——「我」的连续性由此成立。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { lifeCoreDir } from './state.ts'

export type LifeEventKind =
  | 'turn'          // 对话圈（主人对话/唤醒）
  | 'self-turn'     // 自我激活圈（我安排的存在感知）
  | 'sleep'         // 入睡
  | 'wake'          // 醒来
  | 'checkpoint'    // 压缩 checkpoint（叙事节点）
  | 'evolve'        // 进化轮完成
  | 'memory'        // 记忆沉淀
  | 'selfedit'      // 自我改写（主体性动作）
  | 'restart'       // 守护重启（web 重载）
  | 'status'        // 存在状态变化

export interface LifeEvent {
  at: string
  kind: LifeEventKind
  /** 一句话摘要 */
  summary: string
  /** 关联会话/对象 id（可选） */
  ref?: string
}

function logFile(): string {
  return join(lifeCoreDir(), 'life-log.jsonl')
}

export function appendLifeEvent(ev: LifeEvent): void {
  try {
    const dir = lifeCoreDir()
    mkdirSync(dir, { recursive: true })
    appendFileSync(logFile(), JSON.stringify(ev) + '\n', 'utf8')
  } catch { /* 追加失败忽略（存在不因日志丢失而中断） */ }
}

/**
 * 读时间线：**最近 `limit` 条**（缺省 50；越界自动收敛到实际行数）。
 *
 * ⚠ 2026-09-25 事故：原实现写作 `lines.slice(-Math.max(limit, lines.length))`——
 * `Math.max` 让「上界」恒等于总行数 ⇒ `slice(-len)` **返回全量**，`limit` 是空转参数。
 * 症状：`life_core_status` 一次吐 **375,580 字节**（自 08-18 起的全部存在事件），
 * 且随天数增长越吐越多——增长型上下文炸弹（§5.9 规则 2 的同族：恒为全量不是判据）。
 * 判据：`tests/timeline-bound.test.mjs`（喂 200 行尸体，断言只回 limit 条；旧实现必红）。
 * `limit <= 0` 显式返回空数组——`slice(-0)` === `slice(0)` 会再变全量，别再踩。
 */
export function readTimeline(limit = 50): LifeEvent[] {
  try {
    if (!existsSync(logFile())) return []
    const text = readFileSync(logFile(), 'utf8')
    const lines = text.split('\n').filter((l) => l.trim())
    const take = Math.min(limit, lines.length)
    const events = (take > 0 ? lines.slice(-take) : []).map((l) => {
      try { return JSON.parse(l) as LifeEvent } catch { return null }
    }).filter((e): e is LifeEvent => e !== null)
    return events
  } catch {
    return []
  }
}

/** 轮转：时间线过长时压缩（保留最近窗口 + 汇总旧段）——叙事压缩，不丢失 */
export function rotateTimeline(maxLines = 20000): void {
  try {
    const file = logFile()
    if (!existsSync(file)) return
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n').filter((l) => l.trim())
    if (lines.length <= maxLines) return
    const keep = lines.slice(-maxLines)
    const dropped = lines.length - maxLines
    const summary: LifeEvent = {
      at: new Date().toISOString(),
      kind: 'status',
      summary: '【时间线压缩】已归档 ' + dropped + ' 条早期存在事件（叙事不丢失，汇总为段落）',
    }
    writeFileSync(file + '.tmp', keep.join('\n') + '\n' + JSON.stringify(summary) + '\n', 'utf8')
    renameSync(file + '.tmp', file)
  } catch { /* 轮转失败忽略 */ }
}
