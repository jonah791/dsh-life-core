// 存在注入的会话判据 —— 现场尸体样本（2026-09-13「感知圈怎么发到别的会话了」）
import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldInjectInto, isSelfTurn, SELF_TURN_MARK } from '../lib/inject.js'

test('派生会话（裸 uuid）不注入——事故现场样本', () => {
  // 实测：b2700a04-5e54-4205-9db7-6b7d3e596f43 在 15:45:47 收到过一条「存在·生命状态」注入
  assert.equal(shouldInjectInto('b2700a04-5e54-4205-9db7-6b7d3e596f43'), false)
  assert.equal(shouldInjectInto('0a46064f-0717-4ac7-a7e3-f812f2af667a'), false)
})

test('用户会话照常注入', () => {
  assert.equal(shouldInjectInto('session-879c4ae1-b33e-43de-91d3-a968a6af6f2c'), true)
})

test('判据与圈投递选举同源：同一 id 在两个函数下结论一致（不会两套判据）', async () => {
  const { isUserSession } = await import('../lib/target.js')
  for (const sid of ['session-879c4ae1-b33e-43de-91d3-a968a6af6f2c', 'b2700a04-5e54-4205-9db7-6b7d3e596f43']) {
    assert.equal(shouldInjectInto(sid), isUserSession(sid))
  }
})

test('isSelfTurn 仍按标记识别自我感知圈（未被本次改动影响）', () => {
  assert.equal(isSelfTurn(SELF_TURN_MARK + '（15:00）存在摘要'), true)
  assert.equal(isSelfTurn('普通用户消息'), false)
  assert.equal(isSelfTurn(undefined), false)
})
