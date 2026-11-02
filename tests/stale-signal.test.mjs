/**
 * stale-signal.test.mjs — 停滞信号（边沿触发）的判据层离线验收。
 *
 * 对应改进方案 §3.4 的四条判据。**两条正例之外的两条反例才是核心**：
 * 正例只能证明「它活着」，反例才证明「它不是噪音源」。
 *   P1-1 正例：新变超期的被报
 *   P1-2 反例：一直超期的老账**不报**        ← 治 91% 噪音
 *   P1-3 反例：救活后再超期**要再报一次**    ← 治「一次报过就永远沉默」
 *   P1-4 反例：首轮**不刷屏**                ← 治「激活当天吐 30 条」
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cursorPathFor, newStaleIds, readCursor, staleIdsOf, staleSignal, STALE_DAYS_DEFAULT,
} from '../lib/stale-signal.js'

const NOW = Date.parse('2026-11-01T06:00:00.000Z')
const DAY = 86_400_000
const iso = (ms) => new Date(ms).toISOString()

/** 造一条任务：`idleDays` 天没有活动。 */
function task(id, idleDays, extra = {}) {
  return { id, title: '任务 ' + id, status: 'pending', updatedAt: iso(NOW - idleDays * DAY), ...extra }
}

/** 建临时板面 + 返回三件套路径。 */
function setup(tasks) {
  const dir = mkdtempSync(join(tmpdir(), 'stale-'))
  const boardFile = join(dir, 'tasks.json')
  writeFileSync(boardFile, JSON.stringify({ tasks }))
  return { dir, boardFile, cursorFile: cursorPathFor(boardFile) }
}

// ————————————————— P1-4 首轮不刷屏 —————————————————

test('★ P1-4 首轮（cursor 不存在）⇒ **不报**，但必须写出基线', () => {
  const { boardFile, cursorFile } = setup([task('a', 5), task('b', 10)])
  const sig = staleSignal(boardFile, cursorFile, { nowMs: NOW })

  assert.equal(sig, undefined, '首轮不许把当前全部超期项吐出来')
  assert.equal(existsSync(cursorFile), true, '基线必须落盘——否则下一轮还是首轮，永远不报')
  const c = readCursor(cursorFile)
  assert.deepEqual(c.staleIds, ['a', 'b'])
  assert.deepEqual(c.reportedIds, [], '首轮什么都没报，reportedIds 必须为空')
})

test('P1-4b cursor **坏掉**时与缺失同款处置（不把全部当新增）', () => {
  const { boardFile, cursorFile } = setup([task('a', 5)])
  writeFileSync(cursorFile, '{ 这不是 JSON')
  const sig = staleSignal(boardFile, cursorFile, { nowMs: NOW })
  assert.equal(sig, undefined, '坏 cursor 的失败方向必须是「不报」，不是「全报」')
  // 且它会把 cursor 重建成合法基线
  const c = readCursor(cursorFile)
  assert.deepEqual(c.staleIds, ['a'])
})

// ————————————————— P1-2 老账不报 —————————————————

test('★ P1-2 反例：一直超期的老账**不报**（这条就是治噪音的那一条）', () => {
  const { boardFile, cursorFile } = setup([task('a', 5), task('b', 10), task('c', 20)])
  staleSignal(boardFile, cursorFile, { nowMs: NOW }) // 建基线：三条都超期

  // 时间过去，三条仍然超期且一动不动
  const sig = staleSignal(boardFile, cursorFile, { nowMs: NOW + 3_600_000 })
  assert.equal(sig, undefined, '没有新变超期 ⇒ 必须沉默。这正是与「超阈值就报」的分野')
})

// ————————————————— P1-1 新变超期被报 —————————————————

test('★ P1-1 正例：新变超期的那条**被报**，老账不出现在信号里', () => {
  // a 早就超期；b 还没到 3 天阈值
  const { boardFile, cursorFile } = setup([task('a', 5), task('b', 2)])
  staleSignal(boardFile, cursorFile, { nowMs: NOW }) // 基线：只有 a

  // b 变超期（2 天 → 4 天）
  writeFileSync(boardFile, JSON.stringify({ tasks: [task('a', 5), task('b', 4)] }))
  const sig = staleSignal(boardFile, cursorFile, { nowMs: NOW + 60_000 })

  assert.ok(sig !== undefined, '应当有信号')
  assert.match(sig, /新变超期 1 项/)
  assert.match(sig, /任务 b/, '新变超期的那条要在里面')
  assert.doesNotMatch(sig, /任务 a/, '老账 a 不许出现在信号里（这正是治噪音的判据）')
})

test('P1-1b 信号里写明「老账未列」——读者不会把「只报 1 条」误读成「只有 1 条超期」', () => {
  const { boardFile, cursorFile } = setup([task('a', 5), task('b', 5), task('c', 5)])
  staleSignal(boardFile, cursorFile, { nowMs: NOW }) // 基线 a/b/c
  writeFileSync(boardFile, JSON.stringify({ tasks: [task('a', 5), task('b', 5), task('c', 5), task('d', 9)] }))
  const sig = staleSignal(boardFile, cursorFile, { nowMs: NOW + 60_000 })
  assert.match(sig, /当前超期合计 4 项/)
  assert.match(sig, /老账 3 项未列/)
})

// ————————————————— P1-3 救活后再超期 —————————————————

test('★ P1-3 反例：超期 → 被 touch（不再超期）→ 再次超期，**要再报一次**', () => {
  const { boardFile, cursorFile } = setup([task('a', 5)])
  staleSignal(boardFile, cursorFile, { nowMs: NOW }) // 基线含 a

  // a 被 touch：从超期集合里掉出去
  writeFileSync(boardFile, JSON.stringify({ tasks: [task('a', 0)] }))
  assert.equal(staleSignal(boardFile, cursorFile, { nowMs: NOW + 1000 }), undefined)

  // a 又变超期——这是一次**新的**变旧，不是同一次的重复
  writeFileSync(boardFile, JSON.stringify({ tasks: [task('a', 5)] }))
  const sig = staleSignal(boardFile, cursorFile, { nowMs: NOW + 2000 })
  assert.ok(sig !== undefined, '救活后再超期必须再报——否则任务「一报就免疫」')
  assert.match(sig, /任务 a/)
})

// ————————————————— 纯函数层 —————————————————

test('newStaleIds 是**集合差**，不是「全部当前超期」', () => {
  assert.deepEqual(newStaleIds(['a', 'b'], ['a', 'b', 'c']), ['c'])
  assert.deepEqual(newStaleIds(['a', 'b'], ['a', 'b']), [])
  assert.deepEqual(newStaleIds([], ['z', 'a']), ['a', 'z'], '输出排序稳定')
})

test('staleIdsOf：终态不进集合、时间戳全缺不计入、阈值边界是「大于」', () => {
  const tasks = [
    { id: 'done', status: 'done', updatedAt: iso(NOW - 100 * DAY) },
    { id: 'cancel', status: 'cancelled', updatedAt: iso(NOW - 100 * DAY) },
    { id: 'nots', status: 'pending' }, // 三个时间戳都缺
    { id: 'exact', status: 'pending', updatedAt: iso(NOW - STALE_DAYS_DEFAULT * DAY) }, // 恰好等于阈值
    { id: 'over', status: 'pending', updatedAt: iso(NOW - (STALE_DAYS_DEFAULT * DAY + 1000)) },
  ]
  assert.deepEqual(staleIdsOf(tasks, { nowMs: NOW }), ['over'])
})

test('staleIdsOf 回退链 updatedAt → claimedAt → createdAt（与 taskboard 同构）', () => {
  const tasks = [
    { id: 'byClaimed', status: 'pending', claimedAt: iso(NOW - 10 * DAY) },
    { id: 'byCreated', status: 'pending', createdAt: iso(NOW - 10 * DAY) },
    // updatedAt 优先：虽然 createdAt 很老，但 updatedAt 很新 ⇒ 不算超期
    { id: 'fresh', status: 'pending', updatedAt: iso(NOW - 1 * DAY), createdAt: iso(NOW - 100 * DAY) },
  ]
  assert.deepEqual(staleIdsOf(tasks, { nowMs: NOW }), ['byClaimed', 'byCreated'])
})

test('板面读不到 ⇒ undefined（零噪音，与 pendingTaskSignal 同款）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stale-missing-'))
  const sig = staleSignal(join(dir, 'nope.json'), join(dir, 'cursor.json'), { nowMs: NOW })
  assert.equal(sig, undefined)
})

test('板面顶层不是对象 / tasks 不是数组 ⇒ undefined（不猜）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stale-badshape-'))
  const boardFile = join(dir, 'tasks.json')
  writeFileSync(boardFile, JSON.stringify({ tasks: '不是数组' }))
  assert.equal(staleSignal(boardFile, join(dir, 'c.json'), { nowMs: NOW }), undefined)
})

test('落盘「这一圈报了什么」：reportedIds 记录本轮实际报出去的 id', () => {
  const { boardFile, cursorFile } = setup([task('a', 2)])
  staleSignal(boardFile, cursorFile, { nowMs: NOW }) // 基线（a 未超期）
  writeFileSync(boardFile, JSON.stringify({ tasks: [task('a', 5)] }))
  staleSignal(boardFile, cursorFile, { nowMs: NOW + 1000 })
  const c = readCursor(cursorFile)
  assert.deepEqual(c.reportedIds, ['a'], '报过的要留痕——否则「没新账」与「报了没送达」分不开')
})
