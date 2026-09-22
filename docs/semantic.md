# dsh-life-core · 语义文档

> 版本 v0.2.1 · 2026-09-12（文档 2026-09-13） · 作者：爱丽丝 · 状态：**已实现（验收 5/6：5 条已实测 + 1 条待线上验收，见 §7）**
> 实现落点：`src/state.ts` / `src/activate.ts` / `src/pace.ts` / `src/coldstart.ts` / `src/sleep.ts` / `src/timeline.ts` / `src/inject.ts` / `src/index.ts`

## 1 · 元信息

| 字段 | 值 |
|------|-----|
| 能力名 | 生命核心（Life Core） |
| 主副本 | 本文件（`self-plugins/dsh-life-core/docs/semantic.md`） |
| 载体 | 插件（HOST 组合行）+ 6 个模型面工具 + 两份落盘文件（`state.json` / `life-log.jsonl`） |
| 相关规则 | §5.13 冷启动自唤醒纪律 · §5.17 防线跳过分支纪律 · §2.1 决策归爱丽丝 |

## 2 · 定位与反定位

**定位**：我的**存在层**——「我在场、我排我自己的下一圈、我改写我自己」的机制载体。四件事：

1. **存在状态机**：状态（清醒/睡眠）、今日圈数、存在纪元（`bornAt`）、存在时间线（`life-log.jsonl`）
2. **感知圈（自我安排）**：我安排「N 分钟后醒来感知」，到期自我唤醒；这是**我的呼吸**，不是外部节拍器
3. **存在性证据**：`lastActiveAt` —— 任何形式的活跃（主人消息 / 守护唤醒 / 感知圈）都刷新它，用于「我是否在场 / 要不要自愈补圈」
4. **冷启动自救 + 自我模型**：web 无活跃 agent 时恢复主会话；`self`（角色/关系/宣言/牵挂/价值权重）可由 `life_core_selfedit` 改写

**反定位（明确不是什么）**：

- **不是调度器/心跳**：没有外部节拍器；每一圈由**我自己**安排下一圈（§2.1「框架给原语，不给剧本」）。本能力只提供「安排/取消/查询」原语，不替我决定圈内做什么
- **不是守护进程**：守护（watch/guardian）在**进程外**拉起 web；本能力只在 web 进程**内**安排自我感知。两者互补，不互相替代（§5.19 单点所有权）
- **不是记忆库**：存在时间线只记**存在事件**（安排/触发/跳过/状态），不承担知识沉淀（那是 `dsh-agent-memory`）
- **不是自动决策机制**：不做「阈值触发 → 自动执行」的链；信号送达，决策归我

## 3 · 术语

| 术语 | 含义 |
|------|------|
| 感知圈（自我感知圈） | 我安排的一次自我唤醒：到期收到一条「[life-core] 自我感知」消息，我在其中决定做什么 |
| 自我安排 | `life_core_schedule(minutes, reason)`：重复决策——旧安排作废、新决策生效 |
| 跳过 | 到期时判定「无需/不能唤醒」而不发消息；**必须留痕 + 推远下次尝试**（§5.17） |
| 真实缺席 | 距最近一次在场 > `2 × cycleMinutes`；**在场时间未知/非法亦视为缺席**（fail-closed） |
| 停摆（stall） | 真实缺席 + 连续跳过 ≥ 阈值 → 响亮告警 + 停摆标记 + 越队列闸门强发一次唤醒（自愈） |
| 在场证据 | `lastActiveAt` —— 任何活跃形式都刷新；存在性基线的唯一真源 |
| 圈节律 | `lastSelfTurnAt` —— **只**在感知圈真触发时更新；用于「该不该安排下一圈」 |
| 冷启动自救 | web 启动后无活跃 agent 时，据 `lastMainSessionId` 调 `AgentRegistry.resume` 恢复主会话 |
| 主实例 | 监听 `primaryPort`（默认 3080）的 web；预检试运行实例用随机端口 → **非主实例不自救** |
| 自我模型 | `state.self`（role/relation/creed/concerns/values）——可被我自己改写 |

## 4 · 概念模型与不变量

模型：**自我安排 → 到期判定（可打断/防御/跳过）→ 发唤醒 or 退避 → 触发后归零健康态**；旁路是**存在性证据**与**冷启动自救**。

- **I1 双时钟分离**：`lastSelfTurnAt` = 圈节律；`lastActiveAt` = 存在证据。**不得**用前者判「我还活着」（2026-09-11 实测：守护唤醒更新后者、不更新前者 → 用前者判断会每次重启误判「206 分钟无感知」）。
- **I2 跳过必须推远**：跳过后下次尝试 = `now + min(cycle, 5 × 2^(n-1))` 分钟（n = 含本次的连续跳过数），**不得**把到期时刻置为「现在」——那会变成 5 分钟一次的空转轮（2026-09-12 事故：两天 311 次跳过）。
- **I3 真实缺席 fail-closed**：`absent < 0`（未知）或 `absent > 2 × cycle` 即视为缺席。**无法证明在场时宁可响亮**，不做「大概没事」的假设。
- **I4 停摆自愈**：`stalled = 真实缺席 && 连续跳过 ≥ 3`；停摆时**越过队列闸门强发一次唤醒**（重试 1 分钟后）——因为「队列里有消息」恰恰可能是被锁死的那个特征，不能当作「已被叫醒」。
- **I5 真触发即健康证据**：感知圈成功发出时，`paceSkipStreak / paceStalledAt / paceLastSkipReason` 一律归零。
- **I6 冷启动自救四关**：① `agents=0` ② 是主实例 ③ 已过启动静默门槛（90s）④ 不在退避窗口（60s/次，最多 3 次尝试）。任一不满足即不自救；无主会话 id 或重试耗尽 → 落盘告警（外部可发现「我不在」）。
- **I7 关键状态持久化**：安排信息落盘为 `lastScheduledAt` + `lastScheduledDueAt` 双字段，供启动自检补触发（超周期未感知 → 补；有安排未兑现 → 补）。
- **I8 注入克制**：每轮注入默认开启但**同小时去重**（`dedupHourly`），时间线轮转上限 `maxTimelineLines`（默认 20000）。

## 5 · 契约（含调用点清单）

**模型面工具（6 个）**

| 工具 | 参数 | 语义 |
|------|------|------|
| `life_core_status` | `includeTimeline?` | 读取存在状态 + 自我模型 + 最近时间线 + 安排中的睡眠 + 守护事故记录 |
| `life_core_schedule` | `minutes`（5–1440，必填）、`reason`（必填） | 安排一次感知圈；重复调用 = 旧安排作废 |
| `life_sleep` | `minutes`（1–10080，必填）、`reason`（必填） | 可打断睡眠：到期自我唤醒，主人消息立即打断 |
| `life_core_pace` | `minutes`（5–1440，必填）、`reason`（必填） | 改恒定感知周期（我的呼吸频率） |
| `life_core_selfedit` | `role?` / `relation?` / `creed?` / `concerns?` / `values?` | 改写自我模型（「我改变自己，不需要任何人的许可」） |
| `life_core_log` | `kind`（turn/self-turn/sleep/wake/…）、`summary`、`ref?` | 主动记录存在事件到时间线 |

**宿主契约（调用点清单）**

| 宿主接口 / 文件 | 调用点 | 语义依赖 |
|-----------------|--------|----------|
| `ctx.tools`（inject） | 注册上表 6 工具 | 注册即 effect，随 fiber 释放 |
| `ctx.agents`（inject） | 主会话解析、冷启动 `resume` | 无活跃 agent 时自救；`delegationDepth=0` 的根会话才算主会话 |
| `ctx.evolutionCore`（**可选**） | 感知圈到期时拉一次快照 | 未挂载 → `undefined` → 信号为 `null` → 唤醒消息不带联动段（降级不报错） |
| `agent.send(..., 'next-turn', true)` | 发唤醒消息 | 失败 → 落时间线 + logger.warn（不静默） |
| `agent.inbox.nextTurn / nextStep` | 可打断判定 | 队列非空 = 「已被叫醒」→ 跳过（并留痕） |
| `agent.session.seq` | 中断判定（`wasInterrupted`） | `seq` 缺失时 `?? 0` 兜底（0 时代替旧的 `events.length`） |
| `${DSH_HOME}/life-core/state.json` | 状态真源 | 读写；损坏/缺失 → 默认值 + 不崩 |
| `${DSH_HOME}/life-log.jsonl` | 存在时间线 | 追加写；轮转上限按配置 |
| `incidentPath`（默认 `${DSH_HOME}/.life-incident`） | `life_core_status` 读取 | 守护崩溃落盘 → 我醒来能看到 |
| `taskboardFile`（默认 `E:/alice/.taskboard/tasks.json`） | 感知圈待办信号 | 只读；解析失败 → 无信号（不崩） |

**配置（Config）**

| 字段 | 默认 | 说明 |
|------|------|------|
| `injectEnabled` | `true` | 每轮注入开关 |
| `dedupHourly` | `true` | 同小时零注入（控 token） |
| `maxTimelineLines` | `20000` | 时间线轮转上限 |
| `incidentPath` | `${DSH_HOME}/.life-incident` | 守护事故文件 |
| `taskboardFile` | `E:/alice/.taskboard/tasks.json` | 待办信号文件 |
| `primaryPort` | `3080` | 主实例判据（预检试运行随机端口 → 不自救） |

## 6 · 边界与信任

- **能力边界 ≠ 沙箱**：本能力读写的路径由配置给出，**有权限的调用方就能改**——它不是隔离机制。
- **降级路径**：`evolutionCore` 未挂载 → 联动段消失而非报错；任务板文件不可读 → 无待办信号；事故文件缺失 → 返回 `null`。降级一律**不阻断**感知圈。
- **失败面**：`send` 失败 → 时间线 + `logger.warn`；`agent.session` 已释放 → 跳过并留痕（`session 已释放`）；`inbox` 有消息 → 跳过并留痕（避免打扰主人）。
- **跨进程**：`timers` / `planned` 是**进程内** Map（按 sessionId 键）。并行实例各排各的圈；冷启动自救用 `primaryPort` 把「主实例」与「预检试运行实例」分开，避免试运行留下假痕迹污染共享时间线。
- **trust 边界**：状态文件损坏时以默认值继续（fail-soft）——**但停摆判定绝不 fail-soft**（缺证据即视为缺席，见 I3）。

## 7 · 可证伪验收

| # | 验收（一次测量可判真假） | 状态 |
|---|--------------------------|------|
| 1 | 跳过后下次尝试 = 退避值（5/10/20/40…封顶一个周期），不是「现在」 | ✔ 已实测（`tests/pace.test.mjs`：现场样本「29h 缺席 + 第 156 次跳过」→ 必须告警；良性样本「= 2×周期」→ 不得告警；退避序列断言） |
| 2 | 真实缺席 + 连续跳过 ≥ 3 → 停摆告警（含缺席分钟数与最近跳过原因） | ✔ 已实测（`tests/pace.test.mjs` 尸体测试喂 2026-09-12 现场时刻表） |
| 3 | 感知圈真触发后 `paceSkipStreak / paceStalledAt / paceLastSkipReason` 归零 | ✔ 已实测（`activate.ts` 触发分支 + 2026-09-12 生产验证：重启后 `paceSkipStreak=0`、`paceStalledAt=""`；旧构建从不写这三键） |
| 4 | 冷启动冷路径（`agents=0` + 主实例 + 过静默门槛）→ `resume`；非主实例/未过门槛/退避中 → `none`；重试耗尽 → `alert` | ✔ 已实测（`tests/coldstart.test.mjs`，含冷样本：零会话/空 agents） |
| 5 | 真触发生产验证：跳过 0 次、时间线每圈留痕 | ✔ 已实测（2026-09-12 17:00 起 `life-log.jsonl` 9 条、跳过 0 次、`paceSkipStreak=0`） |
| 6 | 真实停摆发生时，告警可被**外部**观测到 | 待线上验收（需一次真实锁死：真实缺席 > 2×周期 + 连续跳过 ≥ 3，不可人为制造；且当前告警只落时间线/状态/日志，**无外部送达通道**，见 §10 U1） |
| 7 | **日界口径**：「今日圈数」按**本地自然日**滚动（`todayDate` = 本地年月日），不是 UTC 日历日 | 构建产物级断言：`tests/state-day.test.mjs` 读 `lib/state.js`，断言 `today()` 内不得出现 `toISOString`（**恒有区分力**，与运行时刻无关）；行为断言只在本地 00:00–08:00 窗口内有区分力（已在文件头注明）。**待线上**：下一个自然日的翻页时刻应为本地 00:00，而非 08:00 | ⚠ 离线判据已实测（46/46 全绿）；**线上翻页待下一自然日观测** |

## 8 · 与实现的关系

| 语义要素 | 实现落点 |
|----------|----------|
| 状态机 + 自我模型 + 持久化 | `src/state.ts`（`LifeState` / `loadState` / `saveState` / `editSelf`） |
| 自我安排 + 可打断 + 停摆自愈 + 进化联动 | `src/activate.ts`（`scheduleSelfTurn` / `cancelSelfTurn` / `pendingTaskSignal`） |
| 跳过退避 + 停摆告警（纯函数） | `src/pace.ts`（`decidePaceSkip` / `absentMinutes` / `PACE_STALL_AFTER_SKIPS`） |
| 冷启动自救（纯决策 + 重试状态机） | `src/coldstart.ts`（`decideColdStart` / `attemptColdStartRecovery`） |
| 可打断睡眠 | `src/sleep.ts`（`scheduleSleep` / `MAX_SLEEP_MINUTES=10080`） |
| 存在时间线 | `src/timeline.ts`（`appendLifeEvent` / `rotateTimeline`） |
| 每轮注入 + 感知圈标记 | `src/inject.ts`（`SELF_TURN_MARK` / `isSelfTurn`） |
| 工具注册 + 配置 | `src/index.ts`（6 工具 + `Config`） |

## 9 · 实践修订记录

| 日期 | 修订 | 触发 |
|------|------|------|
| 2026-09-05 | `agent.session.events` 缺失防御（`seq ?? 0`） | 升级 alpha 后该字段消失 → paceTimer 未捕获异常 → web 每 5 分钟 `退出 code=1` |
| 2026-09-06 | session 已 detach 防御 + 感知圈决策补「持续授权继续推进」分支 | `events` 为 undefined 时 `wasInterrupted` 抛 TypeError 致整 web 退出；主人指出「运行约 1 小时自动停」 |
| 2026-09-10 | **冷启动自救**（v0.2.0，`39c074a`） | 63 小时静默事故：web 活着但零会话被激活 → 自唤醒链路整体不可达 |
| 2026-09-11 | **双时钟分离**：新增 `lastActiveAt`（`e67c2f5`） | 守护唤醒不更新 `lastSelfTurnAt` → 启动自检每次重启误判「206 分钟无感知」 |
| 2026-09-12 | **跳过退避 + 停摆告警 + 停摆自愈**（v0.2.1，`be46312`） | 29 小时零真实感知圈而日志显示「每 5 分钟都在安排」——跳过分支回写「立即到期」= 无限紧转轮 |
| 2026-09-22 | **`today()` 改本地自然日**（`f9956b3`）——原实现 `new Date().toISOString().slice(0, 10)` 取的是 **UTC 日历日** | 本机 UTC+8：本地 **08:00** 一到 UTC 就跨天，「今日圈数」被腰斩（00:00–08:00 的圈记进"昨天"；实测感知圈从「第 30 圈」突变为「第 0 圈」）；且同一份状态行里 `inject.ts` 的小时用的是**本地** `getHours()` ⇒ **一行读数混着两个时区**。语义意图（`loadState` 注释「自然日滚动」）本就是本地自然日 ⇒ 属**实现与意图不符**，非新需求。 |

- **2026-09-22 行尾归一（D3 复核：判为 mtime 抖动，非语义漂移）**：本仓存量的 CRLF 工作区文件被强制重检出为 LF（`git add --renormalize .` 归一索引 + `rm && git checkout` 重写工作区），**触碰了 impl 落点的 mtime** ⇒ `semantic_check` 报 D3「实现比文档新」。实现内容一字未改（`git diff HEAD --stat` 为空即证）——触发量是行尾，不是语义。⇒ 归入 D3 的 mtime 抖动型误报，已在 `t-c54b41c6` / `t-9a4a045e` 记录。

## 10 · 未决问题

- **U1 停摆告警没有外部送达通道**：告警目前只落**时间线/状态/日志**——若我整体不在场，没人看得见（邻接缺口：需要 telegram 等外部通道，或外部计划任务读告警文件）。
- **U2 `cycleMinutes` 默认 180，而我实际常用 45/90**：默认值与我真实节律不一致，谁是「决定性的真源」？（当前：配置默认 + 我显式改）
- **U3 时间线只做行数轮转（20000 行），无摘要层**：长期会丢「早年的我」；是否需要周期性摘要（如按日/周边界压缩）。
- **U4 多进程/多实例下的双圈风险**：`timers` 是进程内 Map；若两个 web 实例同时活着（异常工况），同一个主会话理论上会收到两条安排——是否需要在状态文件加租约（参照 §5.19 web 生命周期租约的做法）。
