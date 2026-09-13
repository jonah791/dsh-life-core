/**
 * 圈（感知圈/唤醒）投递目标选举 —— 纯函数，可离线尸体测试。
 *
 * 事故（2026-09-13 主人：「感知圈怎么发到别的会话了」）：
 *   原实现 `agents.find(a => (a.session.header.delegationDepth ?? 0) === 0)` 取**列表第一个** root agent，
 *   且 `delegationDepth` 缺失时用 `?? 0` 兜底 ⇒ **裸 uuid 的子代理会话被判成 root**，
 *   于是圈被投进子代理会话与「碰巧排在前面」的其他会话（取证：3 个裸 uuid 会话各收到 17 圈）。
 *
 * 纪律（AGENTS.md §5.18 唤醒/通知投递纪律）：
 *   1. `session-*` 才是人用的会话；裸 uuid 是派生（子代理）会话，**永不投递**；
 *   2. 钉住的锚点只在**新鲜/仍在列表里**时优先，否则回退到最近活跃的用户会话；
 *   3. 每次投递留「为什么是这个目标」的证据行。
 *
 * @module target
 */

/** 用户会话判据：DSH 人类会话形如 `session-<uuid>`；子代理是裸 uuid。 */
export function isUserSession(sessionId: string): boolean {
  return /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)
}

export interface TargetCandidate {
  id: string
  /** 最近一次用户输入时刻（ms）；未知填 0 */
  lastActiveAt: number
}

export interface ElectOptions {
  /** 配置/状态里钉住的锚点会话 id（可为空） */
  pinned?: string
  /** 锚点滞后的容忍窗口（ms），超过即判锚点腐化并改投最近活跃用户会话 */
  pinnedFreshMs?: number
  now?: number
}

export interface ElectResult {
  targetId: string
  /** 裁决理由（写进证据行） */
  reason: string
  /** 被排除的派生会话数（证据行用） */
  excludedDerived: number
}

/**
 * 选举唯一的圈投递目标。
 * 判据优先级：① 锚点仍在候选且新鲜 → 用它；② 否则最近活跃的用户会话；③ 无用户会话 → null（响亮留痕）。
 */
export function electCircleTarget(
  candidates: readonly TargetCandidate[],
  options: ElectOptions = {},
): ElectResult | null {
  const now = options.now ?? Date.now()
  const freshMs = options.pinnedFreshMs ?? 10 * 60_000
  const userSessions = candidates.filter(c => isUserSession(c.id))
  const excludedDerived = candidates.length - userSessions.length
  if (userSessions.length === 0) return null

  const pinned = options.pinned ?? ''
  if (pinned.length > 0) {
    const hit = userSessions.find(c => c.id === pinned)
    if (hit !== undefined) {
      const age = hit.lastActiveAt > 0 ? now - hit.lastActiveAt : Number.POSITIVE_INFINITY
      if (age <= freshMs) {
        return { targetId: hit.id, reason: '锚点在用且新鲜（滞后 ' + Math.round(age / 1000) + 's ≤ ' + Math.round(freshMs / 1000) + 's）', excludedDerived }
      }
      return { targetId: hit.id, reason: '锚点仍在候选但已滞后 ' + Math.round(age / 1000) + 's（仍优先，因它是主会话锚点）', excludedDerived }
    }
  }

  const sorted = [...userSessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  const freshest = sorted[0] as TargetCandidate
  const why = pinned.length > 0 ? '锚点不在候选（腐化/未激活）' : '无锚点'
  return {
    targetId: freshest.id,
    reason: why + ' → 改投最近活跃用户会话（' + new Date(freshest.lastActiveAt || now).toISOString() + '）',
    excludedDerived,
  }
}
