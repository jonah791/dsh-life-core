/**
 * orphan-feed 的标定 —— 它是「探测器 → 出外告警」之间那一环，错了就整条链静默。
 *
 * 三类断言：
 *   ① **选择**：新鲜窗口 / 进程内去重 / 坏行不抛 / 上限保留最新
 *   ② **反空转**：一条正常的发现必须被挑出来（否则选择器恒空 = 没有防线）
 *   ③ **路径三态**：原文 / `'missing'`（父目录在、文件没生成 ⇒ 正常零命中）/ `null`
 *      （父目录都不存在 ⇒ **接线故障**）。第③条是写测试时才发现的洞：两者都抛 ENOENT，
 *      压成一种就会让「路径写错」表现成「至今零命中」——正是要消灭的静默失效。
 *
 * Run: node --test tests/orphan-feed.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ORPHAN_MAX_REPORT,
  describeSuspect,
  orphanFindingsPath,
  readOrphanFindingsFile,
  selectOrphanFindings,
} from '../lib/orphan-feed.js'

const NOW = Date.parse('2026-10-10T08:00:00+08:00')
const SUSPECT = {
  verdict: 'orphan-spinning',
  record: { pid: 17524, ppid: 11176, name: 'chrome.exe' },
  reasons: ['父进程已不存在（孤儿）', '采样窗口内 0.97 核（阈值 0.5）'],
}
const row = (atMs, suspects = [SUSPECT]) =>
  JSON.stringify({ atMs, windowMs: 5000, spinCores: 0.5, sampled: 267, suspects })
const pick = (raw, already = new Set()) => selectOrphanFindings(raw, { nowMs: NOW, already })

test('反空转：一条新鲜发现必须被挑出，且理由说成人读的一行', () => {
  const got = pick(row(NOW - 60_000) + '\n')
  assert.equal(got.length, 1, '正常的发现没被挑出 ⇒ 选择器恒空，防线等于不存在')
  assert.equal(got[0].atMs, NOW - 60_000)
  assert.match(got[0].lines[0], /pid=17524/)
  assert.match(got[0].lines[0], /0\.97 核/)
})

test('超出新鲜窗口的旧发现不重报', () => {
  assert.equal(pick(row(NOW - 25 * 3600 * 1000) + '\n').length, 0)
  assert.equal(pick(row(NOW - 23 * 3600 * 1000) + '\n').length, 1)
})

test('已在集里的不重报（进程内去重）', () => {
  const atMs = NOW - 60_000
  assert.equal(pick(row(atMs) + '\n', new Set([atMs])).length, 0)
})

test('坏行跳过而不抛 —— 半写一行不该让整条链失效', () => {
  const raw = '{"atMs": not-json\n' + '\n' + '[]\n' + '{"noAtMs":1}\n' + row(NOW - 1000) + '\n'
  const got = pick(raw)
  assert.equal(got.length, 1, '坏行应被跳过，好的那条仍要被挑出')
})

test('单次最多报 ORPHAN_MAX_REPORT 条，且保留最新', () => {
  const raw = Array.from({ length: ORPHAN_MAX_REPORT + 4 }, (_, i) => row(NOW - 60_000 * (i + 1))).join('\n')
  const got = pick(raw)
  assert.equal(got.length, ORPHAN_MAX_REPORT)
  const ats = got.map((g) => g.atMs)
  assert.deepEqual(ats, [...ats].sort((a, b) => a - b), '应按时间升序')
  assert.equal(ats[ats.length - 1], NOW - 60_000, '应保留最新的那条')
})

test('describeSuspect 缺字段给占位而不抛', () => {
  assert.doesNotThrow(() => describeSuspect(undefined))
  assert.match(describeSuspect({}), /pid=\?/)
})

test('路径解析与写者同一字面（两端 fallback 不同 = 静默零命中）', () => {
  assert.equal(orphanFindingsPath(undefined), join('E:/alice/.dsh', 'orphan-audit-findings.jsonl'))
  assert.equal(orphanFindingsPath('X:/home'), join('X:/home', 'orphan-audit-findings.jsonl'))
})

test('readOrphanFindingsFile 三态：有内容 / missing（正常零命中）/ null（接线故障）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orphan-feed-'))
  try {
    const file = join(dir, 'orphan-audit-findings.jsonl')
    assert.equal(readOrphanFindingsFile(file), 'missing', '父目录在、文件没生成 ⇒ 正常的零命中')
    writeFileSync(file, row(NOW - 1000) + '\n')
    assert.equal(typeof readOrphanFindingsFile(file), 'string', '有内容 ⇒ 返回原文')
    rmSync(file)
    assert.equal(readOrphanFindingsFile(join(dir, 'no-such-subdir', 'x.jsonl')), null, '父目录不存在 ⇒ 接线故障')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
