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

const C = {
  bgTop: [0x1b, 0x22, 0x30],
  bgBottom: [0x0f, 0x13, 0x1b],
  node: [0x43, 0xcd, 0x85],
  nodeEnd: [0x8a, 0xf2, 0xb6],
  // 连接段与节点同色：小尺寸下深一档的连线会直接消失，同色反而让整体成为一个完整轮廓
  link: [0x43, 0xcd, 0x85],
}

/**
 * 2×2 网格里三个等大的圆角方块，空出右上角；两段短连接把它们串成
 * 「向下再向右」的一条路径。留白本身就是构图的一部分。
 *
 * 不画箭头：箭头在 16px 下只会糊成一个疙瘩，而方向感其实靠终点那块更亮的绿就够了。
 * 小尺寸优先的取舍——实心块比描边耐缩，连接段粗到 12/256（16px 下不到 1px 但仍连得住），
 * 全图只有五个形状，没有任何装饰细节。
 */
const N = 72 // 节点边长
const R = 20 // 节点圆角
const NODES = [
  { x: 40, y: 40, w: N, h: N, r: R, c: C.node },
  { x: 40, y: 144, w: N, h: N, r: R, c: C.node },
  { x: 144, y: 144, w: N, h: N, r: R, c: C.nodeEnd },
]
const LINK_W = 14
// 连接段正好填满两块之间的空隙，不出头、不留缝
const LINES = [
  [[76, 112], [76, 144]], // 向下
  [[112, 180], [144, 180]], // 向右
]
const ARROWS = []

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

function over(dst, i, rgb, a) {
  if (a <= 0) return
  const inv = 1 - a
  dst[i] = Math.round(rgb[0] * a + dst[i] * inv)
  dst[i + 1] = Math.round(rgb[1] * a + dst[i + 1] * inv)
  dst[i + 2] = Math.round(rgb[2] * a + dst[i + 2] * inv)
  dst[i + 3] = Math.round(255 * a + dst[i + 3] * inv)
}

/** 点在三角形内：三条边的叉积同号 */
function inTriangle(px, py, [[ax, ay], [bx, by], [cx, cy]]) {
  const s1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
  const s2 = (cx - bx) * (py - by) - (cy - by) * (px - bx)
  const s3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx)
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)
}

const onLink = (gx, gy) =>
  LINES.some(([a, b]) => sdSegment(gx, gy, a, b) <= LINK_W / 2) ||
  ARROWS.some((t) => inTriangle(gx, gy, t))

function render(size) {
  const buf = Buffer.alloc(size * size * 4, 0)
  const bgShape = { x: 0, y: 0, w: G, h: G, r: 56 }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4

      // 背景：圆角方块 + 纵向渐变
      const aBg = coverage(x, y, size, (gx, gy) => sdRoundRect(gx, gy, bgShape) <= 0)
      if (aBg > 0) {
        const t = (y + 0.5) / size
        const rgb = C.bgTop.map((v, k) => Math.round(v + (C.bgBottom[k] - v) * t))
        over(buf, i, rgb, aBg)
      }

      // 连线先画，节点压在上面
      over(buf, i, C.link, coverage(x, y, size, onLink))

      for (const n of NODES) {
        over(buf, i, n.c, coverage(x, y, size, (gx, gy) => sdRoundRect(gx, gy, n) <= 0))
      }
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

function toSvg() {
  const links = LINES.map(([a, b]) => `    <path d="M${a[0]} ${a[1]} L${b[0]} ${b[1]}" />`).join('\n')
  const arrows = ARROWS.map(
    (t) => `  <polygon points="${t.map(([x, y]) => `${x},${y}`).join(' ')}" fill="${hex(C.link)}" />`
  ).join('\n')
  const nodes = NODES.map(
    (n) => `  <rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${n.r}" fill="${hex(n.c)}" />`
  ).join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${G} ${G}" width="${G}" height="${G}">
  <!-- 本文件由 scripts/make-icon.mjs 生成，改设计请改那里的几何常量 -->
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${hex(C.bgTop)}" />
      <stop offset="1" stop-color="${hex(C.bgBottom)}" />
    </linearGradient>
  </defs>
  <rect width="${G}" height="${G}" rx="56" fill="url(#bg)" />
  <g fill="none" stroke="${hex(C.link)}" stroke-width="${LINK_W}" stroke-linecap="round">
${links}
  </g>
${arrows}
${nodes}
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
