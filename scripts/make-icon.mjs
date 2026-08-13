/**
 * 生成应用图标：build/icon.svg（设计源）、build/icon.png（512）、build/icon.ico（多尺寸）。
 *
 *   node scripts/make-icon.mjs
 *
 * 为什么自己写光栅器：工程里没有 sharp / ImageMagick，也不想为一个图标再引一条原生依赖；
 * 试过用 Electron 的 Chromium 渲染 SVG，但 ESM 入口下 app.whenReady 不返回，不值得纠缠。
 * 图形本身只有圆角矩形与粗线段，用带超采样的距离场画出来完全够用，抗锯齿也可控。
 *
 * 几何只在这里定义一次，SVG 与位图都由它生成，两者不会走样。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const G = 256 // 设计栅格

/* --------------------------------- 设计 --------------------------------- */

/**
 * 一个由三段粗圆角笔画拼出的 F：竖干 + 上横 + 中横。
 *
 * 造型语言取自 Notion Calendar 那类图标——笔画很粗、端头全圆。
 * 绿底白笔而不是浅底绿笔：浅底那版在 512px 下清楚，缩到任务栏的 32px、
 * 侧边栏的 22px 就只剩几像素笔画，浅绿压浅灰几乎看不出形状。
 * 几何与颜色跟渲染层的 Logo 组件（src/renderer/src/components/Logo.tsx）保持一致。
 */
const C = {
  // 底色斜向渐变的两端
  from: [0x3f, 0xd4, 0x85],
  to: [0x0b, 0x82, 0x50],
  ink: [0xff, 0xff, 0xff],
}

const BAR = 40 // 笔画粗细
// 整体略右移做光学配平：F 天生左重，机械居中看着会偏左
const STEM = [[92, 70], [92, 190]] // 竖干
const ARMS = [
  [[92, 70], [186, 70]], // 上横
  [[92, 128], [166, 128]], // 中横
]
const STROKES = [...ARMS, STEM]

/* ------------------------------- 距离场绘制 ------------------------------ */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** 圆角矩形的有符号距离：内部为负 */
function sdRoundRect(px, py, { x, y, w, h, r }) {
  const cx = x + w / 2
  const cy = y + h / 2
  const qx = Math.abs(px - cx) - (w / 2 - r)
  const qy = Math.abs(py - cy) - (h / 2 - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

/** 点到线段的距离，用于画有圆头的粗线 */
function sdSegment(px, py, [x1, y1], [x2, y2]) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : clamp01(((px - x1) * dx + (py - y1) * dy) / len2)
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

/** 4×4 超采样，取覆盖率作为 alpha */
function coverage(px, py, size, inside) {
  const S = 4
  let hit = 0
  for (let sy = 0; sy < S; sy++) {
    for (let sx = 0; sx < S; sx++) {
      const gx = ((px + (sx + 0.5) / S) / size) * G
      const gy = ((py + (sy + 0.5) / S) / size) * G
      if (inside(gx, gy)) hit++
    }
  }
  return hit / (S * S)
}

/**
 * source-over 合成，直通 alpha（PNG 存的就是直通 alpha，不是预乘）。
 *
 * 早先按预乘的写法算颜色、又按直通写进 PNG：边缘半透明像素的 RGB 被乘暗了一次，
 * 显示时再乘一次 alpha，于是轮廓外圈挂着一圈发暗的脏边。
 * 正确做法是把结果颜色除回 outA。
 */
function over(dst, i, rgb, a) {
  if (a <= 0) return
  const da = dst[i + 3] / 255
  const outA = a + da * (1 - a)
  if (outA <= 0) return
  const keep = da * (1 - a)
  for (let k = 0; k < 3; k++) dst[i + k] = Math.round((rgb[k] * a + dst[i + k] * keep) / outA)
  dst[i + 3] = Math.round(outA * 255)
}

/** 斜向渐变：沿左上→右下投影取色，与 Logo 组件的 x1/y1 0.1 → x2/y2 0.9 对齐 */
function gradient(gx, gy) {
  const t = clamp01((gx + gy - 0.2 * G) / (1.6 * G))
  return C.from.map((v, k) => Math.round(v + (C.to[k] - v) * t))
}

const inBar = (gx, gy, [a, b]) => sdSegment(gx, gy, a, b) <= BAR / 2

function render(size) {
  const buf = Buffer.alloc(size * size * 4, 0)
  const bgShape = { x: 0, y: 0, w: G, h: G, r: 58 }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4

      // 背景：圆角方块 + 斜向绿色渐变
      const gx = ((x + 0.5) / size) * G
      const gy = ((y + 0.5) / size) * G
      const aBg = coverage(x, y, size, (gx2, gy2) => sdRoundRect(gx2, gy2, bgShape) <= 0)
      over(buf, i, gradient(gx, gy), aBg)

      // 三笔取并集一次画完：分笔叠加会在交叠处的半覆盖像素上留下接缝
      const aInk = coverage(x, y, size, (gx2, gy2) => STROKES.some((s) => inBar(gx2, gy2, s)))
      over(buf, i, C.ink, aInk)
    }
  }
  return buf
}

/* --------------------------------- PNG ---------------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function toPng(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.writeUInt8(8, 8) // 位深
  ihdr.writeUInt8(6, 9) // RGBA
  // 每行前置一个过滤器字节（0 = None）
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* --------------------------------- ICO ---------------------------------- */

/** ICO 直接内嵌 PNG（Vista 起支持）：6 字节头 + 每张 16 字节目录项 + 各 PNG 数据 */
function toIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + dir.length
  entries.forEach((e, i) => {
    const at = i * 16
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, at) // 256 在这里必须写 0
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, at + 1)
    dir.writeUInt16LE(1, at + 4) // 平面数
    dir.writeUInt16LE(32, at + 6) // 位深
    dir.writeUInt32LE(e.png.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += e.png.length
  })
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

/* --------------------------------- SVG ---------------------------------- */

const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`

const NL = String.fromCharCode(10)

function toSvg() {
  const bar = ([a, b]) => `M${a[0]} ${a[1]} L${b[0]} ${b[1]}`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${G} ${G}" width="${G}" height="${G}">
  <!-- 本文件由 scripts/make-icon.mjs 生成，改设计请改那里的几何常量 -->
  <defs>
    <linearGradient id="bg" x1="0.1" y1="0.1" x2="0.9" y2="0.9">
      <stop offset="0" stop-color="${hex(C.from)}" />
      <stop offset="1" stop-color="${hex(C.to)}" />
    </linearGradient>
  </defs>
  <rect width="${G}" height="${G}" rx="58" fill="url(#bg)" />
  <g stroke="${hex(C.ink)}" stroke-width="${BAR}" stroke-linecap="round" fill="none">
${STROKES.map((a) => `    <path d="${bar(a)}" />`).join(NL)}
  </g>
</svg>
`
}

/* --------------------------------- 输出 ---------------------------------- */

const SIZES = [16, 24, 32, 48, 64, 128, 256]
mkdirSync(join(root, 'build'), { recursive: true })

const entries = SIZES.map((size) => ({ size, png: toPng(render(size), size) }))
writeFileSync(join(root, 'build/icon.ico'), toIco(entries))
writeFileSync(join(root, 'build/icon.png'), toPng(render(512), 512))
writeFileSync(join(root, 'build/icon.svg'), toSvg())
console.log(`icon.ico（${SIZES.join('/')}）、icon.png 512、icon.svg 已生成`)
