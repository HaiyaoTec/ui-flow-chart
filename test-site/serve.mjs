// 零依赖静态服务，供离线确定性测试使用。
//   node test-site/serve.mjs [port]
// 除了发文件，还把每个请求的 UA 与 Sec-CH-UA 记到 requests.log，
// 用于断言「首个请求就带移动 UA」——设备模拟必须在导航前生效。
import { createReadStream, existsSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const PORT = Number(process.argv[2] || 4173)
const LOG = join(ROOT, 'requests.log')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

writeFileSync(LOG, '', 'utf8')

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  appendFileSync(
    LOG,
    JSON.stringify({
      t: Date.now(),
      path: url.pathname,
      ua: req.headers['user-agent'] ?? '',
      chUa: req.headers['sec-ch-ua'] ?? '',
      chMobile: req.headers['sec-ch-ua-mobile'] ?? '',
      chPlatform: req.headers['sec-ch-ua-platform'] ?? '',
    }) + '\n',
    'utf8'
  )

  if (url.pathname === '/__requests') {
    const lines = readFileSync(LOG, 'utf8').trim()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(lines ? `[${lines.split('\n').join(',')}]` : '[]')
    return
  }

  /*
   * 可控延迟的页面。
   *
   * 预览「加载期间不许以陈旧矩形显示」这条约束，只有在加载慢到跨过兜底档位时
   * 才可能被违反；本地测试站毫秒级返回，竞态窗口根本打不开。
   */
  if (url.pathname === '/slow.html') {
    const ms = Math.min(Number(url.searchParams.get('ms') || 4000), 20000)
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' })
      res.end(
        '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<body style="margin:0;font:16px sans-serif">slow</body>'
      )
    }, ms)
    return
  }

  let rel = decodeURIComponent(url.pathname)
  if (rel === '/' || rel === '') rel = '/index.html'
  const file = join(ROOT, normalize(rel).replace(/^(\.\.[/\\])+/, ''))

  if (!existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('404')
    return
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  createReadStream(file).pipe(res)
})

server.listen(PORT, () => {
  console.log(`test-site: http://localhost:${PORT}`)
})
