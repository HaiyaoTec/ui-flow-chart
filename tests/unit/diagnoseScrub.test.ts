import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '.', isPackaged: false } }))

const { stripPaths } = await import('../../src/main/log')

/** 反斜杠在测试里太容易写错，统一从字符码拼 */
const BS = String.fromCharCode(92)

describe('日志脱敏', () => {
  it('抹掉本机绝对路径，只留文件名', () => {
    const win = ['at C:', 'Users', 'somebody', 'AppData', 'Local', 'Programs', 'app', 'out', 'main', 'index.js:1:2'].join(BS)
    expect(stripPaths(win)).toBe(`at …${BS}index.js:1:2`)
    expect(stripPaths('/Users/somebody/app/resources/app.asar/out/main/index.js')).toBe('…/index.js')
  })

  it('不许把网址当成本机路径截断', () => {
    // 截断之后地址既不能用来复现，后续按网址做的脱敏也认不出它了
    const text = '已打开 http://localhost:4183/register.html?token=abc'
    expect(stripPaths(text)).toBe(text)
  })

  it('同一行里网址与本机路径并存时各归各的', () => {
    const line = `打开 https://example.com/a/b.html 失败，见 D:${BS}work${BS}proj${BS}src${BS}main${BS}x.ts`
    expect(stripPaths(line)).toBe(`打开 https://example.com/a/b.html 失败，见 …${BS}x.ts`)
  })
})
