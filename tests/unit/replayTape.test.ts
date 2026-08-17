import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * 回放服务。
 *
 * 用户回传诊断包之后，作者要能把当时那一轮的决策原样重放到真实站点上——
 * 探索走偏这类问题光看结果图谱判断不出来，得看它当时依据什么做的决定。
 * 这里守住回放最容易坏的两点：顺序，以及录像放完之后不能乱给动作。
 */
const PORT = 4197
const dir = mkdtempSync(join(tmpdir(), 'ufc-tape-'))
const tapeFile = join(dir, 'pack.json')

const act = (name: string, kind = 'click'): Record<string, unknown> => ({
  action: kind,
  targetIdx: 0,
  reason: name,
  screen: { id: name, title: name, lane: 'main', kind: 'normal' },
  edgeLabel: name,
})

let server: ChildProcess

async function ask(url: string, elements: number): Promise<Record<string, unknown>> {
  const res = await fetch(`http://localhost:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'replay',
      messages: [{ role: 'user', content: `当前地址：${url}\n可交互元素：\n${'[0] <button> 下一步\n'.repeat(elements)}` }],
    }),
  })
  const json = (await res.json()) as { choices: Array<{ message: { content: string } }> }
  return JSON.parse(json.choices[0].message.content) as Record<string, unknown>
}

beforeAll(async () => {
  // 诊断包形态（作者手上多半只有这个），而不是原始的 ai.jsonl
  writeFileSync(
    tapeFile,
    JSON.stringify({
      project: { targetUrl: 'http://localhost:1/a' },
      ai: [
        { kind: 'decide', ask: { step: 1, url: 'http://localhost:1/a', elements: 1 }, action: act('第一步') },
        { kind: 'parse-error', ask: { step: 2 }, error: '不该被回放' },
        { kind: 'decide', ask: { step: 2, url: 'http://localhost:1/b', elements: 1 }, action: act('第二步') },
      ],
    })
  )
  server = spawn(process.execPath, ['tests/mock-ai/server.mjs', String(PORT), 'replay', tapeFile], {
    cwd: process.cwd(),
    stdio: 'ignore',
  })
  for (let i = 0; i < 50; i += 1) {
    try {
      await fetch(`http://localhost:${PORT}/`)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
})

afterAll(() => server?.kill())

describe('AI 决策回放', () => {
  it('按录像顺序返回当时的决策，跳过失败的那几次', async () => {
    const a = await ask('http://localhost:1/a', 1)
    expect((a.screen as { title: string }).title).toBe('第一步')

    // 解析失败那条不是一次有效决策，回放时不能占一个位置
    const b = await ask('http://localhost:1/b', 1)
    expect((b.screen as { title: string }).title).toBe('第二步')
  })

  it('录像放完之后收束，不再瞎给动作', async () => {
    const c = await ask('http://localhost:1/c', 1)
    expect(c.action, '录像放完应当结束探索，而不是继续编造操作').toBe('done')
  })
})
