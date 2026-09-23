/**
 * wasInterrupted —— 睡眠/感知圈的「主人打断」判定（0.1.7 契约回归 + 尸体样本）。
 *
 * 背景（2026-09-23 修）：0.1.7 移除了 `MessageSourceMap.plugin`，生产者改为按生产者分立的 kind。
 * dsh-agent-telegram 现发 `source: { kind: 'dsh-agent-telegram' }`
 * （证据：self-plugins/dsh-agent-telegram/src/index.ts:767）。
 * 本文件在修复前**不存在**——该路径此前无任何测试覆盖，故 bug 长期静默。
 *
 * 尸体样本纪律：v3 形状（kind:'plugin' + plugin 字段）必须**不**被判为打断。
 * 若有人把这条断言「改绿」，等于把已移除的契约重新请回来。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { wasInterrupted } from '../lib/activate.js'

/** 用事件数组构造 SessionLike（seq = 事件数） */
const sess = (events) => ({ seq: events.length, eventAt: (i) => events[i] })
const userMsg = (source) => ({ type: 'user/message', data: { source } })

test('wasInterrupted：GUI 用户消息（kind=user）算打断', () => {
  assert.equal(wasInterrupted(sess([userMsg({ kind: 'user' })]), 0), true)
})

test('wasInterrupted：Telegram 消息（kind=dsh-agent-telegram，0.1.7 形状）算打断', () => {
  assert.equal(wasInterrupted(sess([userMsg({ kind: 'dsh-agent-telegram' })]), 0), true)
})

test('尸体样本：v3 形状（kind=plugin + plugin=dsh-agent-telegram）**不**算打断——0.1.7 已移除该 source 形状', () => {
  assert.equal(wasInterrupted(sess([userMsg({ kind: 'plugin', plugin: 'dsh-agent-telegram' })]), 0), false)
})

test('wasInterrupted：其他插件注入不算打断（自我感知圈不被自己误伤）', () => {
  assert.equal(wasInterrupted(sess([userMsg({ kind: 'dsh-life-core' })]), 0), false)
  assert.equal(wasInterrupted(sess([userMsg({ kind: 'dsh-agent-memory' })]), 0), false)
})

test('wasInterrupted：只算窗口 [startSeq, seq) 内的事件', () => {
  const s = sess([userMsg({ kind: 'user' }), userMsg({ kind: 'dsh-agent-telegram' })])
  assert.equal(wasInterrupted(s, 2), false)
  assert.equal(wasInterrupted(s, 1), true)
})

test('wasInterrupted：脏事件（undefined/缺 data/缺 source/非 user-message）不抛且保守判「未打断」', () => {
  const s = sess([undefined, {}, { type: 'assistant/message', data: {} }, { type: 'user/message' }, { type: 'user/message', data: {} }])
  assert.equal(wasInterrupted(s, 0), false)
})
