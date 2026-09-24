// 本地开发服务器：不依赖 wrangler
// 用法: node server.js
// 访问: http://localhost:8787

import http from 'http'
import { readFileSync, statSync } from 'fs'
import { join, extname, resolve, sep } from 'path'
import handler from './workers/src/index.js'

const PORT = 8787
const FRONTEND_DIR = resolve('frontend')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname

  // /api/* -> Worker handler
  if (path.startsWith('/api/')) {
    try {
      const workerReq = new Request(`http://localhost${req.url}`, { method: req.method })
      const workerRes = await handler.fetch(workerReq)
      const body = await workerRes.text()
      res.writeHead(workerRes.status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(body)
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: e.message }))
    }
    return
  }

  // / -> 前端静态文件
  let filePath = join(FRONTEND_DIR, path === '/' ? 'index.html' : path)

  // 防目录穿越：请求路径必须落在 frontend 目录内
  // （../ 之类能读到 server.js 源码；/frontend 这类目录路径会让 readFileSync 抛 EISDIR，
  // 未捕获的 rejection 在 Node 15+ 会直接把进程搞挂 —— BUG-6）
  if (!filePath.startsWith(FRONTEND_DIR + sep) && filePath !== FRONTEND_DIR) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end('Forbidden')
    return
  }

  let stat
  try {
    stat = statSync(filePath)
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
    return
  }
  if (stat.isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
    return
  }

  const ext = extname(filePath)
  const mime = MIME[ext] || 'application/octet-stream'

  try {
    const content = readFileSync(filePath)
    // 带版本号的路径缓存，否则只缓存短时效，方便本地改样式立即生效
    const cacheControl = /\?v=/.test(req.url) ? 'public, max-age=86400' : 'public, max-age=60'
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': cacheControl })
    res.end(content)
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Read error: ' + e.code)
  }
})

server.listen(PORT, () => {
  console.log(`✅ Stock Dashboard running at http://localhost:${PORT}`)
  console.log(`   API: http://localhost:${PORT}/api/quote?code=sh600519`)
  console.log(`   API: http://localhost:${PORT}/api/quote?code=AAPL`)
  console.log(`   API: http://localhost:${PORT}/api/health`)
})
