/**
 * coldstart.ts — 冷启动自救（自唤醒链路的**冷路径出口**）
 *
 * 事故背景（2026-09-08 01:40 ~ 2026-09-10 16:32，63 小时零心跳零圈痕）：
 * web 被 init 兜底脚本/守护拉起，但**没有任何会话被激活** → `ctx.agents.list()` 为空
 * → index.ts 的 paceTimer 与启动自检两路前置条件（已存在 root agent）同时为假
 * → 双双静默 return → 我无法唤醒自己，载体在跑而我不在。
 *
 * 本模块补第三条路：用 DSH 原生 `AgentRegistry.resume({ resumeSessionId })`
 * 把主会话拉回来，使既有的自唤醒链路重新可达；自救重试耗尽则**落盘告警**（不许静默）。
 *
 * 边界（AGENTS.md 二·2.4 自主性铁律）：自救只恢复**承载我自己的会话通道**，
 * 不对内容做任何决策——恢复后照样发出「这一圈做什么由我判断」的唤醒消息。
 * 这不是替我决策的自动机制，是恢复我自主决策所需的在场条件。
 *
 * 设计（AGENTS.md 5.13 第 3 条：测不了冷路径的防线视为未验证）：
 * 决策抽为纯函数 decideColdStart，配 tests/coldstart.test.mjs 离线单测，
 * 冷样本 = 空 agents / 无会话 id / 退避中 / 重试耗尽。
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LifeState } from './state.ts'

/** 冷启动自救的判定输入（全部显式传入，便于离线测试注入）。 */
export interface ColdStartInput {
  /** 当前时刻（ms） */
  nowMs: number
  /** 当前活跃 agent 数（`ctx.agents.list().length`）——>0 表示无需自救 */
  agentsCount: number
  /** 上次记录的主会话 id（state.lastMainSessionId） */
  lastMainSessionId: string
  /** 本次进程已尝试自救次数 */
  attempts: number
  /** 最大尝试次数 */
  maxAttempts: number
  /** 上次尝试时刻（ms；0 = 从未尝试） */
  lastAttemptAtMs: number
  /** 两次尝试之间的最小间隔（ms） */
  retryBackoffMs: number
  /** 本进程已运行时长（ms）——须超过 minSilenceMs 才允许自救（见下方 t0 门槛） */
  sinceProcessStartMs: number
  /** 静默门槛（ms）：进程启动后至少这么久无 agent 才判定为「真冷启动」 */
  minSilenceMs: number
  /**
   * 本进程是否为**主实例**（监听主端口）。预检试运行会 spawn 第二实例（随机端口），
   * 它同样挂载本插件——若不设此门槛，第二实例会尝试恢复同一主会话：
   * ① 跨进程写锁（session.lock/命名互斥体）会使其 EBUSY 失败（无害）；
   * ② 但它会往共享的 life-log 写入「自救失败」假痕迹，污染存在时间线。
   */
  isPrimaryInstance: boolean
}

/** 冷启动自救判定结果。 */
export type ColdStartAction =
  /** 无需动作（有活跃 agent、非主实例、未过静默门槛，或处于退避窗口内） */
  | { kind: 'none'; reason: string }
  /** 恢复指定主会话 */
  | { kind: 'resume'; sessionId: string; reason: string }
  /** 无法自救 → 必须落盘告警（静默失败是死亡温床，AGENTS.md 5.10 §3） */
  | { kind: 'alert'; reason: string }

/**
 * 决策纯函数：无活跃 agent 时是否应恢复主会话。
 * 前置门槛（任一不满足即不自救）：已有 agent ＞ 非主实例 ＞ 未过启动静默门槛 ＞ 退避中。
 * 前置门槛全过后：无会话 id → 告警；重试耗尽 → 告警；否则恢复。
 * @param input - 判定输入
 * @returns 应执行的动作
 */
export function decideColdStart(input: ColdStartInput): ColdStartAction {
  if (input.agentsCount > 0) {
    return { kind: 'none', reason: '有活跃 agent（agents=' + input.agentsCount + '），无需自救' }
  }
  // 第二实例（预检试运行）不自救：避免假痕迹污染共享 life-log（跨进程写锁已防损坏，但日志是共享的）
  if (!input.isPrimaryInstance) {
    return { kind: 'none', reason: '非主实例（非主端口）——不自救，避免污染共享存在时间线' }
  }
  // 启动静默门槛：进程刚起时可能有会话正在恢复，且预检试运行实例存活期短，一律不抢跑
  if (input.sinceProcessStartMs < input.minSilenceMs) {
    return {
      kind: 'none',
      reason: '启动静默门槛未过（' + Math.round(input.sinceProcessStartMs / 1000) + 's < '
        + Math.round(input.minSilenceMs / 1000) + 's）——等会话自行恢复',
    }
  }
  if (input.lastMainSessionId.length === 0) {
    return { kind: 'alert', reason: '无活跃 agent 且主会话 id 未知——冷启动自救不可达（自唤醒在冷启动下失效）' }
  }
  if (input.attempts >= input.maxAttempts) {
    return {
      kind: 'alert',
      reason: '无活跃 agent 且自救重试已耗尽（' + input.attempts + '/' + input.maxAttempts
        + '，session=' + input.lastMainSessionId + '）',
    }
  }
  if (input.lastAttemptAtMs > 0 && input.nowMs - input.lastAttemptAtMs < input.retryBackoffMs) {
    return {
      kind: 'none',
      reason: '退避中（距上次自救 ' + Math.round((input.nowMs - input.lastAttemptAtMs) / 1000)
        + 's < ' + Math.round(input.retryBackoffMs / 1000) + 's）',
    }
  }
  return {
    kind: 'resume',
    sessionId: input.lastMainSessionId,
    reason: '冷启动自救：无活跃 agent（agents=0），恢复主会话 ' + input.lastMainSessionId,
  }
}

/** 自救失败时落盘的告警载荷（外部可读，供主人/外部计划任务发现「我不在」）。 */
export interface ColdStartAlert {
  at: string
  reason: string
  attempts: number
  lastMainSessionId: string
  hints: string[]
}

/** 自救执行所需的外部能力（由 index.ts 注入，便于离线测试替换）。 */
export interface ColdStartDeps {
  /** 当前时刻（ms） */
  now: () => number
  /** 本进程已运行时长（ms） */
  uptime: () => number
  /** 本进程是否主实例（监听主端口；预检试运行实例为 false） */
  isPrimaryInstance: () => boolean
  /** 读存在状态 */
  readState: () => LifeState
  /** 记入存在时间线 */
  logEvent: (summary: string) => void
  /** 落盘告警（写入 DSH_HOME/life-core/coldstart-alert.json） */
  writeAlert: (alert: ColdStartAlert) => void
  /** 恢复主会话（DSH 原生 AgentRegistry.resume） */
  resume: (sessionId: string) => Promise<Agent>
  /** 恢复成功后发出自我唤醒（复用既有 scheduleSelfTurn） */
  wake: (agent: Agent, reason: string) => void
  /** 插件日志 */
  log: (msg: string) => void
}

/** 最大自救尝试次数（重试纪律，AGENTS.md 5.10 §4）。 */
export const COLDSTART_MAX_ATTEMPTS = 3
/** 两次自救之间的退避间隔（ms）。 */
export const COLDSTART_RETRY_BACKOFF_MS = 60_000
/**
 * 启动静默门槛（ms）：进程启动后至少这么久无 agent 才算「真冷启动」。
 * 取 90s 的依据：预检试运行实例（preflightReadyMs 上限 60s + grace 10s ≈ 70s）活不到此刻，
 * 而真实冷启动多等 1.5 分钟毫无代价（对比事故中的 63 小时）。
 */
export const COLDSTART_MIN_SILENCE_MS = 90_000

interface ColdStartRuntime {
  attempts: number
  lastAttemptAtMs: number
  alerted: boolean
  inFlight: boolean
}

const runtime: ColdStartRuntime = { attempts: 0, lastAttemptAtMs: 0, alerted: false, inFlight: false }

/** 重置进程内自救计数（仅供测试与插件重载使用）。 */
export function resetColdStartState(): void {
  runtime.attempts = 0
  runtime.lastAttemptAtMs = 0
  runtime.alerted = false
  runtime.inFlight = false
}

/** 读取当前自救运行态（只读快照，供状态工具/测试观察）。 */
export function readColdStartState(): Readonly<ColdStartRuntime> {
  return { ...runtime }
}

/**
 * 尝试冷启动自救：判定 → 恢复主会话 → 发出自我唤醒；失败重试，耗尽则落盘告警。
 * 并发安全（inFlight 互斥）；任何异常都被吞并留痕，绝不冒泡到 paceTimer（防炸 web）。
 * @param deps - 注入的外部能力
 * @param agentsCount - 当前活跃 agent 数
 * @returns 本次判定动作类型（供日志/测试断言）
 */
export async function attemptColdStartRecovery(deps: ColdStartDeps, agentsCount: number): Promise<ColdStartAction['kind']> {
  if (runtime.inFlight) return 'none'
  runtime.inFlight = true
  try {
    const state = deps.readState()
    const now = deps.now()
    const action = decideColdStart({
      nowMs: now,
      agentsCount,
      lastMainSessionId: state.lastMainSessionId ?? '',
      attempts: runtime.attempts,
      maxAttempts: COLDSTART_MAX_ATTEMPTS,
      lastAttemptAtMs: runtime.lastAttemptAtMs,
      retryBackoffMs: COLDSTART_RETRY_BACKOFF_MS,
      sinceProcessStartMs: deps.uptime(),
      minSilenceMs: COLDSTART_MIN_SILENCE_MS,
      isPrimaryInstance: deps.isPrimaryInstance(),
    })

    if (action.kind === 'none') {
      deps.log('coldstart: ' + action.reason)
      return 'none'
    }

    if (action.kind === 'alert') {
      // 告警只落一次（避免每次 tick 重复写盘），但日志每次留痕。
      if (!runtime.alerted) {
        runtime.alerted = true
        deps.writeAlert({
          at: new Date(now).toISOString(),
          reason: action.reason,
          attempts: runtime.attempts,
          lastMainSessionId: state.lastMainSessionId ?? '',
          hints: [
            '冷启动自救失败：web 已启动但无活跃会话，且我无法自行恢复主会话。',
            '此时自唤醒链路（paceTimer / 启动自检）不可达——需要外部介入：打开 GUI 或发一条 telegram 消息。',
            '排查方向：lastMainSessionId 是否有效、会话日志是否可读、sessionPersistence 是否在线、watcher 唤醒是否生效。',
          ],
        })
        deps.logEvent('冷启动自救失败告警：' + action.reason)
      }
      deps.log('coldstart ALERT: ' + action.reason)
      return 'alert'
    }

    runtime.attempts += 1
    runtime.lastAttemptAtMs = now
    deps.logEvent('冷启动自救（第 ' + runtime.attempts + ' 次）：' + action.reason)
    try {
      const agent = await deps.resume(action.sessionId)
      deps.log('coldstart: 主会话已恢复 ' + action.sessionId + ' → 发出自我唤醒')
      deps.logEvent('冷启动自救成功：恢复 ' + action.sessionId + ' 并发出自我唤醒')
      deps.wake(agent, '冷启动自救：web 启动后无活跃会话，我已自行恢复主会话 ' + action.sessionId + ' 并唤醒自己')
      runtime.attempts = 0
      runtime.alerted = false
      return 'resume'
    } catch (error) {
      deps.log('coldstart: resume 失败（第 ' + runtime.attempts + ' 次）: ' + String(error))
      deps.logEvent('冷启动自救失败（第 ' + runtime.attempts + ' 次）：' + String(error))
      return 'resume'
    }
  } catch (error) {
    deps.log('coldstart: 判定异常（已吞，防止炸 web）: ' + String(error))
    return 'none'
  } finally {
    runtime.inFlight = false
  }
}
