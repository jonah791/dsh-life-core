/**
 * clock-format.test.mjs — 时间显示必须走本地时区（2026-10-29 补，事故驱动）。
 *
 * 事故经过：`life_core_status` 的 render 对 `sleep.until` / `paceStalledAt` / 时间线 `at`
 * 三处各自就地 `.slice(11, 16)`。这些字段都是 `toISOString()` 产出的 **UTC** 串，
 * 于是「睡眠至本地 08:03」被显示成「至 00:03」。我读到的第一个念头是
 * 「睡眠没排上」，接着去查 state.json 的 pendingWakeAt、查 decisions.jsonl，
 * 白花了好几轮——而真相只是显示层的时区。
 *
 * 同错误被写三遍的根因：`fmtClock`（本地 HH:MM）一直存在于 sleep.ts 且正确
 * （唤醒消息在用），但**没导出**，render 拿不到 ⇒ 三处各自另写一路。
 * 单一真源不导出，等于不存在。
 *
 * 判据分两层：
 *   ① 行为 —— 输出等于本地时刻（任意时区都成立，不依赖本机 TZ）
 *   ② 尸体 —— 源码里不许再出现就地截取；改回旧写法即红
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { fmtClock, fmtIsoClock } from '../lib/sleep.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ISO = '2026-10-29T00:03:00.000Z'

/** 用运行时自己的本地语义算出期望值——这样断言不绑定某个具体时区。 */
function expectedLocal(iso) {
  const d = new Date(iso)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

test('行为：ISO(UTC) → 本地 HH:MM（等于 getHours/getMinutes 的拼法）', () => {
  assert.equal(fmtIsoClock(ISO), expectedLocal(ISO))
})

test('行为：Date 直传同样走本地（fmtClock 与 fmtIsoClock 同源）', () => {
  assert.equal(fmtClock(new Date(ISO)), expectedLocal(ISO))
})

test('尸体：与「就地截 UTC 字面值」不同 —— 改回 .slice(11,16) 即红', (t) => {
  if (new Date().getTimezoneOffset() === 0) {
    // 本机就是 UTC：UTC 串与本地时刻同值，这条判据在这里**没有分辨力**。
    // 如实跳过并说出来，不能让它静默通过变成一条假证据。
    t.skip('本机时区为 UTC ⇒ 本地与 UTC 同值，此判据无法区分（不是通过，是不适用）')
    return
  }
  assert.notEqual(
    fmtIsoClock(ISO),
    ISO.slice(11, 16),
    '显示结果等于 UTC 字面值 ⇒ 时区没转，正是本次事故的形态',
  )
})

test('失败行为：空值 → 空串（不编造 00:00）', () => {
  assert.equal(fmtIsoClock(''), '')
  assert.equal(fmtIsoClock(null), '')
  assert.equal(fmtIsoClock(undefined), '')
})

test('失败行为：不可解析 → **原样返回入参**（保留坏值可见，不伪造 NaN:NaN）', () => {
  assert.equal(fmtIsoClock('not-a-time'), 'not-a-time')
  assert.equal(fmtIsoClock('2026-13-45T99:99:99Z'), '2026-13-45T99:99:99Z')
})

/**
 * 剥掉行注释再匹配。判据的目标是「render 代码里不许就地截取 UTC」，
 * 不是「文件里任何地方不许提到这个写法」——注释里引用它（说明为什么要禁）是合法的，
 * 不剥会把说明文字判成违规（第一次跑就撞上了这个假红）。
 *
 * 粗实现：按行丢掉 `//` 之后的部分。字符串字面量里的 `//`（URL 之类）会被误切，
 * 但对「这处截取在不在」这个是非判断没有影响。
 */
function stripLineComments(src) {
  return src
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//')
      return i === -1 ? line : line.slice(0, i)
    })
    .join('\n')
}

test('尸体：index.ts 的代码里不再有就地截取 UTC 时刻（正则容忍逗号空格差异）', () => {
  const src = stripLineComments(readFileSync(join(HERE, '..', 'src', 'index.ts'), 'utf8'))
  const hits = src.match(/\.slice\(11,\s*16\)/g) ?? []
  assert.deepEqual(
    hits,
    [],
    '发现 ' + hits.length + ' 处 .slice(11, 16)：时间显示必须走 fmtIsoClock，就地截取只会截出 UTC',
  )
})
