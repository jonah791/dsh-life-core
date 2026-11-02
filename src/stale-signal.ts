/**
 * stale-signal.ts — 任务板**停滞信号**（边沿触发）。
 *
 * ★ 它治的是什么（2026-11-01 实测）：现有 `taskboard_status` 的停滞判据**不是不响**——
 *   那天板面 33 条任务里 **claimed 0 条、超 3 天无活动 30 条（91%）**，它每天在报「停滞 30 项」。
 *   问题不是「看不见」，是**响得没有意义**：91% 的板面都在响，这个信号已经退化成背景噪音，
 *   而**新变超期的任务混在这 30 条里，看不出来**。
 *
 * ★ 两件事必须分开（这是本文件的核心判断）：
 *   · **(a) 防新账变旧**——某任务**从「没超期」变成「超期」**的那一刻要有人知道 ⇒ **边沿触发**。
 *   · **(b) 清存量**——板子上积的老账需要**一次盘点**决定「做/砍/降级」 ⇒ 电平触发，只需做一次。
 *   现有机制用 (b) 的形状做 (a) 的事 ⇒ 噪音 + 漏报 + 信号归零同时出现。
 *   **本文件只做 (a)**。(b) 归「收工盘点」，不是常驻信号——做成信号会把 91% 噪音原样放回来。
 *
 * ★ 为什么要在这里再实现一份超期判定（而不是 import taskboard 的 `staleOf`）：
 *   插件之间**不许读别人内部**（AGENTS.md §3.4 可重构性判据：删掉那个插件要改多少处）。
 *   life-core 依赖 taskboard 的源码文件，会让两个插件焊死。
 *   ⇒ 各自实现，但**用一致性测试锁住语义**：`tests/stale-consistency.test.mjs` 把同一批样本
 *   喂给本文件的 `staleIdsOf` 与 taskboard 的 `staleOf`，**结果必须逐条相同**。
 *   这样两边可以独立演进，而语义分叉会被测试当场抓住——比共享代码更轻，且失败是响的。
 *
 * ★ 三条硬约束（缺一条它就变成新的噪音源）：
 *   1. **首轮只建基线**：cursor 缺失时**只写不报**。否则激活当天一次吐出 30 条，正是要治的病重演。
 *      （先例：`manor_task_watch` 的 W4「首轮只建基线」）
 *   2. **落盘「这一圈报了什么」**：cursor 同时记 `reportedIds`。只报新增的机制一旦「报了但没送达」，
 *      不留痕就分不出「没新账」与「报失败」——两者在读数上同形。
 *   3. **读失败一律返回 undefined**：板面读不到、cursor 坏了，都不打扰。但**坏 cursor 与缺 cursor
 *      的处置不同**：缺 = 首建（写基线）；坏 = 当作首建但**在返回值里不带信号**（不因为一个坏文件
 *      就把 30 条全当新增报出来）。
 *
 * @module stale-signal
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

/** 板面任务的**最小**形状（只取超期判定要用的字段）。 */
export interface StaleCandidate {
  id: string
  title?: string
  status: string
  updatedAt?: string
  claimedAt?: string
  createdAt?: string
}

/** cursor：跨圈记忆。缺字段一律按「没有」处理，不猜。 */
export interface StaleCursor {
  /** 上次检查的时刻（ISO）。仅作人读参考，不参与判定。 */
  lastCheckMs: number
  /** 上次检查时**已经超期**的 id 集合。本轮「新增」= 当前 − 这个集合。 */
  staleIds: string[]
  /** 上次**实际报出去**的 id。用途：区分「没新账」与「报了但没送达」。 */
  reportedIds: string[]
}

/** 终态集合——与 taskboard 的 `isTerminal` 保持一致（一致性测试会验）。 */
const TERMINAL = new Set(['done', 'cancelled'])

/** 缺省停滞阈值（天）。与 taskboard `STALE_DAYS_DEFAULT` 一致（一致性测试会验）。 */
export const STALE_DAYS_DEFAULT = 3

/** 信号里最多列几条（不刷屏——全量用任务板工具查）。 */
const STALE_MAX_SHOWN = 5

/**
 * 取「最后一次活动时刻」，回退链 `updatedAt → claimedAt → createdAt`。
 *
 * **近似方向是保守的**（老数据没有 `updatedAt` 时用 `claimedAt`/`createdAt`，会把任务判得更久没动）
 * ——这正是停滞检测想要的方向：宁可早提醒，不要装作它在动。
 *
 * @returns epoch ms；三个字段都不可解析时返回 0（调用方据此**跳过**，不判超期）
 */
export function lastTouchMs(task: StaleCandidate): number {
  for (const raw of [task.updatedAt, task.claimedAt, task.createdAt]) {
    if (typeof raw === 'string' && raw !== '') {
      const ms = Date.parse(raw)
      if (Number.isFinite(ms)) return ms
    }
  }
  return 0
}

/** 是否终态。 */
export function isTerminal(task: { status: string }): boolean {
  return TERMINAL.has(String(task.status))
}

/**
 * 当前**超期**任务 id 集合（纯函数）。
 *
 * 判据：非终态 且 `now - lastTouch > staleDays`。时间戳全缺失的任务**不计入**（同 taskboard）。
 * 结果按 id 排序——顺序稳定才能让「集合差」的比较不受遍历顺序影响。
 */
export function staleIdsOf(
  tasks: readonly StaleCandidate[],
  opts: { nowMs: number; staleDays?: number },
): string[] {
  const staleDays = opts.staleDays ?? STALE_DAYS_DEFAULT
  const cutoffMs = staleDays * 86_400_000
  const out: string[] = []
  for (const t of tasks) {
    if (isTerminal(t)) continue
    const ms = lastTouchMs(t)
    if (ms === 0) continue
    if (opts.nowMs - ms <= cutoffMs) continue
    out.push(String(t.id))
  }
  return out.sort()
}

/**
 * 本轮**新增**的超期 id（纯函数）：`now \ prev`。
 *
 * 注意它是**集合差**，不是「所有超期项」——这一个函数就是「边沿触发」的全部实现。
 * 老账（prev 里已有）永远不会再被报一次；只有**第一次变超期**的那一圈会报。
 */
export function newStaleIds(prev: readonly string[], now: readonly string[]): string[] {
  const before = new Set(prev)
  return now.filter((id) => !before.has(id)).sort()
}

/**
 * 生成信号文本（纯函数）。
 *
 * @param ids 本轮新增的 id（非空，调用方保证）
 * @param byId id → 任务（用于取标题）；查不到的 id 只列 id，**不猜标题**
 */
export function renderStaleSignal(
  ids: readonly string[],
  byId: ReadonlyMap<string, StaleCandidate>,
  totalStale: number,
): string {
  const shown = ids.slice(0, STALE_MAX_SHOWN).map((id) => {
    const t = byId.get(id)
    const title = t?.title === undefined || t.title === '' ? '（无标题）' : t.title
    return `· ${title}（${id}）`
  })
  const more = ids.length > STALE_MAX_SHOWN ? `\n· …另有 ${ids.length - STALE_MAX_SHOWN} 项新变超期` : ''
  return [
    `⏳ **新变超期 ${ids.length} 项**（自上次检查以来；老账不再重复报——全量请用任务板工具）：`,
    ...shown,
    more,
    `（当前超期合计 ${totalStale} 项，其中老账 ${totalStale - ids.length} 项未列——那是收工盘点的事，不是告警）`,
  ].filter((s) => s !== '').join('\n')
}

/**
 * cursor 的固定落点：与板面**同目录**的 `stale-cursor.json`。
 *
 * 放同目录的理由：板面与 cursor 必须一起搬。若有人改了 `taskboardFile` 指向另一块板，
 * cursor 跟着走才不会拿旧板的 id 集合去比新板（那会把新板的超期项全判成「老账」而永不报）。
 */
export function cursorPathFor(boardFile: string): string {
  return dirname(boardFile) + '/stale-cursor.json'
}

/** 读 cursor。缺 / 坏都返回 null，由调用方区分处置（**它不替调用方决定**）。 */
export function readCursor(path: string): StaleCursor | null {  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<StaleCursor>
    const ids = Array.isArray(raw.staleIds) ? raw.staleIds.filter((x) => typeof x === 'string') : []
    const reported = Array.isArray(raw.reportedIds) ? raw.reportedIds.filter((x) => typeof x === 'string') : []
    return {
      lastCheckMs: typeof raw.lastCheckMs === 'number' ? raw.lastCheckMs : 0,
      staleIds: ids as string[],
      reportedIds: reported as string[],
    }
  } catch {
    return null
  }
}

/** 写 cursor。写失败**不抛**（信号是附赠，不该让唤醒失败），但调用方会拿到 false。 */
export function writeCursor(path: string, cursor: StaleCursor): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(cursor, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 停滞信号入口：算 → 比对 cursor → 只报新增 → 更新 cursor。
 *
 * @param boardFile 任务板 JSON 路径
 * @param cursorFile cursor 路径（同目录下 `stale-cursor.json`）
 * @param opts.nowMs / staleDays
 * @returns 信号文本；**无新账 / 读失败 / 首轮**一律 undefined（零噪音）
 */
export function staleSignal(
  boardFile: string,
  cursorFile: string,
  opts: { nowMs: number; staleDays?: number },
): string | undefined {
  let tasks: StaleCandidate[] = []
  try {
    const raw = JSON.parse(readFileSync(boardFile, 'utf8')) as { tasks?: StaleCandidate[] }
    if (!Array.isArray(raw.tasks)) return undefined
    tasks = raw.tasks
  } catch {
    return undefined // 板面读不到 ⇒ 不打扰（与 pendingTaskSignal 同款）
  }

  const nowIds = staleIdsOf(tasks, opts)
  const cursor = readCursor(cursorFile)

  // —— 首轮 / cursor 坏：**只建基线，不报** ——
  // 这是本文件最重要的一条保护：少了它，激活当天会把当前所有超期项一次性吐出来。
  if (cursor === null) {
    writeCursor(cursorFile, { lastCheckMs: opts.nowMs, staleIds: nowIds, reportedIds: [] })
    return undefined
  }

  const fresh = newStaleIds(cursor.staleIds, nowIds)
  if (fresh.length === 0) {
    // 没有新账：只刷新 staleIds（cur 里被救活的任务要从集合里掉出去，否则它下次超期会被漏报），
    // reportedIds 清空——上一轮报过的与本轮无关。
    writeCursor(cursorFile, { lastCheckMs: opts.nowMs, staleIds: nowIds, reportedIds: [] })
    return undefined
  }

  const byId = new Map(tasks.map((t) => [String(t.id), t]))
  const text = renderStaleSignal(fresh, byId, nowIds.length)

  // ★ 落盘「这一圈报了什么」：报失败与没新账在这里分得开
  writeCursor(cursorFile, { lastCheckMs: opts.nowMs, staleIds: nowIds, reportedIds: fresh })
  return text
}
