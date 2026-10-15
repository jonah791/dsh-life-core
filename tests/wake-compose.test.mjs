/**
 * wake-compose.test.mjs — 联动段拼接的离线测试（2026-10-15 抽出纯函数后补）。
 *
 * 存在理由：`buildBody` 原本把「有没有段」的判定与拼接混在闭包里 ⇒ 只能靠活体验收
 * （等下一圈感知圈）。抽出 `composeWakeBody` 后判据可离线证伪。
 *
 * 核心判据：**没有段 ⇒ 返回原文，一字不加**（否则每圈多一段空气）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { composeWakeBody } from '../lib/activate.js'

const TEXT = '这是我自己的这一圈。存在摘要：清醒 · 今日第 3 圈。'

test('无段 ⇒ 返回原文，**逐字符相等**（不加空行、不加标题）', () => {
  assert.equal(composeWakeBody(TEXT, []), TEXT)
})

test('尸体：全为空白/空串的段 ⇒ 同样返回原文（证明过滤真的生效，不是只判长度）', () => {
  assert.equal(composeWakeBody(TEXT, ['', '   ', '\n']), TEXT)
})

test('单段 ⇒ 原文 + 空行 + 段（分隔符是 \\n\\n，不是单换行）', () => {
  assert.equal(composeWakeBody(TEXT, ['【自指引擎 · 感知圈联动】\n最后布线 24 天前']),
    TEXT + '\n\n【自指引擎 · 感知圈联动】\n最后布线 24 天前')
})

test('两段 ⇒ 顺序保持、段间也是 \\n\\n（不吞段、不换序）', () => {
  const out = composeWakeBody(TEXT, ['A段', 'B段'])
  assert.equal(out, TEXT + '\n\nA段\n\nB段')
  assert.ok(out.indexOf('A段') < out.indexOf('B段'), '顺序必须保持')
})

test('空白段夹在有效段之间 ⇒ 只丢空白段，有效段照常（不因一个空段整批丢弃）', () => {
  assert.equal(composeWakeBody(TEXT, ['A段', '  ', 'B段']), TEXT + '\n\nA段\n\nB段')
})
