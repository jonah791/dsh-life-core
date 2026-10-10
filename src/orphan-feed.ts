/**
 * orphan-feed — 读「孤儿进程巡检」的发现，交给出外告警。
 *
 * 为什么需要它（2026-10-10）：巡检器 `DSH-Orphan-Audit` 每 30 分钟把「父已死且在烧核」的
 * 进程写进 `<DSH_HOME>/orphan-audit-findings.jsonl`，但**写文件不是响**——此前唯一读者是
 * 「下一次醒来的我」，于是标榜的 30 分钟颗粒度是假的，真实报知时延 = 感知圈周期。
 * 技能 `alarm-reachability-audit` 第 3 层对此的判据：「谁会读它？答不上具体主体 ⇒ 这条防线
 * 在故障形态下等于不存在」。本模块就是那个主体。
 *
 * ⚠ **路径解析必须与写者逐字一致**：写者（`scripts/orphan-process-audit.mjs`）用
 * `process.env.DSH_HOME || 'E:/alice/.dsh'`。两端 fallback 若不同，缺 DSH_HOME 时
 * 一端写 `E:\\alice\\.dsh`、一端找 `C:\\Users\\<u>\\.dsh` ⇒ **静默零命中**，
 * 而这正是本模块要消灭的那类失败。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 只报 24 小时内的发现：更老的已被「下一次醒来的我」看过，重放等于刷屏。 */
export const ORPHAN_FRESH_MS = 24 * 3600 * 1000
/** 单次最多报几条：探测器只在命中时追加，正常常年为空；上限是防历史堆积后重启刷屏。 */
export const ORPHAN_MAX_REPORT = 3

/** 发现文件的路径（与写者同一字面，见模块头）。 */
export function orphanFindingsPath(dshHome: string | undefined): string {
  return join(dshHome || 'E:/alice/.dsh', 'orphan-audit-findings.jsonl')
}

export interface OrphanFinding {
  atMs: number
  lines: string[]
}

/** 把一条 suspect 说成人读的一行（缺字段给占位，不抛）。 */
export function describeSuspect(suspect: unknown): string {
  const s = (suspect ?? {}) as { verdict?: unknown; record?: Record<string, unknown>; reasons?: unknown }
  const r = s.record ?? {}
  const why = Array.isArray(s.reasons) ? s.reasons.join(' · ') : ''
  return `${String(s.verdict ?? '?')} pid=${String(r.pid ?? '?')} ${String(r.name ?? '?')} ppid=${String(r.ppid ?? '?')} — ${why}`
}

/**
 * 纯选择：从 jsonl 原文挑出「还该报」的发现。
 *
 * 三条纪律都在这里：**坏行跳过不抛**（半写一行不该让整条链失效）· **新鲜窗口**
 * （老发现不重放）· **已在集里的不重报**（进程内去重，重启后由 notify 的 dedupKey 兜）。
 */
export function selectOrphanFindings(
  raw: string,
  opts: { nowMs: number; already: ReadonlySet<number>; freshMs?: number; max?: number },
): OrphanFinding[] {
  const freshMs = opts.freshMs ?? ORPHAN_FRESH_MS
  const max = opts.max ?? ORPHAN_MAX_REPORT
  const out: OrphanFinding[] = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text) continue
    let row: { atMs?: unknown; suspects?: unknown }
    try {
      row = JSON.parse(text)
    } catch {
      continue
    }
    const atMs = Number(row?.atMs)
    if (!Number.isFinite(atMs)) continue
    if (atMs < opts.nowMs - freshMs) continue
    if (opts.already.has(atMs)) continue
    const suspects = Array.isArray(row?.suspects) ? row.suspects : []
    out.push({ atMs, lines: suspects.map(describeSuspect) })
  }
  // 写者是**追加**（`appendFileSync`）⇒ 文件天然按时间升序。仍显式排序：本函数的语义是
  // 「报告最新 max 条」，不该依赖文件顺序这个隐含契约——顺序一变就会静默改成报最旧几条。
  return out.sort((a, b) => a.atMs - b.atMs).slice(-max)
}

/**
 * 读发现文件。三种返回，**故意不压成两种**：
 *   - 原文        ⇒ 有内容
 *   - `'missing'` ⇒ **父目录在，但文件还没生成** ⇒ 至今零命中（正常）
 *   - `null`      ⇒ 父目录都不存在（或读失败）⇒ **接线故障**，调用方必须响亮
 *
 * 为什么必须分开（写测试时发现的洞）：两者都抛 `ENOENT`，若都给 `'missing'`，
 * 那么「我把路径写错了」会表现成「至今零命中」——**正是本模块要消灭的那类静默失效**。
 * 观测不反噬主流程：任何异常都被吞成本函数的返回值（§5.22 规则 3）。
 */
export function readOrphanFindingsFile(path: string): string | 'missing' | null {
  if (!existsSync(dirname(path))) return null
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    return (error as { code?: string })?.code === 'ENOENT' ? 'missing' : null
  }
}
