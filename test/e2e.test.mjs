// 端到端测试：缓存层 / stale 降级 / 主备源 / 边界行为
// 直接加载真实 index.js，模拟 Cloudflare Workers 的 fetch handler
import handler from '../workers/src/index.js'
import * as tencent from '../workers/src/data-sources/tencent.js'

async function call(path) {
  const res = await handler.fetch(new Request('https://api.test' + path))
  return { status: res.status, json: await res.json() }
}

async function main() {
  console.log('=== 1. 缓存层：连续3次请求同一代码，第2、3次应命中缓存 ===')
  const t0 = Date.now()
  let r1 = await call('/api/quote?code=sh600519')
  const ms1 = Date.now() - t0
  let r2 = await call('/api/quote?code=sh600519')
  const ms2 = Date.now() - t0
  let r3 = await call('/api/quote?code=sh600519')
  const ms3 = Date.now() - t0
  console.log(`  第1次: ${ms1}ms cache=${r1.json.fromCache}`)
  console.log(`  第2次: ${ms2}ms cache=${r2.json.fromCache}  (应为 true)`)
  console.log(`  第3次: ${ms3}ms cache=${r3.json.fromCache}  (应为 true)`)
  console.log(`  ${r2.json.fromCache && r3.json.fromCache ? '✅ 缓存命中正常' : '❌ 缓存未命中'}`)

  console.log('\n=== 2. stale 降级：外部全部失败时返回旧缓存 ===')
  const origFetch = globalThis.fetch
  const origNow = Date.now
  try {
    await call('/api/quote?code=sz000001')          // 先造缓存
    globalThis.fetch = async () => { throw new Error('network unreachable') }
    Date.now = () => 9999999999999                   // 推到缓存过期之后
    const res = await call('/api/quote?code=sz000001')
    console.log(`  status=${res.status} stale=${res.json.stale} cache=${res.json.fromCache}`)
    console.log(`  数据=${res.json.data && res.json.data.name} ${res.json.data && res.json.data.price}`)
    console.log(`  ${res.json.stale === true ? '✅ 正确返回 stale 旧数据' : '❌ stale 标记异常'}`)
  } catch (e) {
    console.log(`  ❌ 异常: ${e.message}`)
  } finally {
    globalThis.fetch = origFetch
    Date.now = origNow
  }

  console.log('\n=== 3. 缓存 TTL 3 秒后应失效重拉 ===')
  await new Promise(r => setTimeout(r, 3200))
  const r4 = await call('/api/quote?code=sz000001')
  console.log(`  ${r4.json.fromCache ? '❌ 3.2秒后仍未失效' : '✅ 过期后重新拉取'}`)

  console.log('\n=== 4. 腾讯 A股兜底源 ===')
  for (const code of ['sh600519', 'sz300750', 'sz000001']) {
    try {
      const q = await tencent.fetchAQuote(code)
      console.log(`  ✅ ${q.name} 价格=${q.price} 涨跌%=${q.changePercent} PE=${q.pe} PB=${q.pb}`)
    } catch (e) { console.log(`  ❌ ${code}: ${e.message}`) }
  }

  console.log('\n=== 5. 腾讯美股行情 ===')
  for (const sym of ['NVDA', 'MSFT', 'GOOGL', 'AMZN']) {
    try {
      const q = await tencent.fetchUSQuote(sym)
      console.log(`  ✅ ${q.name.padEnd(20)} 价格=${q.price} 涨跌%=${q.changePercent} PE=${q.pe}`)
    } catch (e) { console.log(`  ❌ ${sym}: ${e.message}`) }
  }

  console.log('\n=== 6. 无效代码必须报错（不能返回脏数据）===')
  for (const code of ['sz999999', 'sh600000']) {
    try {
      const q = await tencent.fetchAQuote(code)
      console.log(`  ⚠️ ${code}: 返回了 ${q.name} ${q.price}`)
    } catch (e) { console.log(`  ✅ ${code} 正确抛错`) }
  }

  console.log('\n=== 7. 分钟K线必须显式抛错（腾讯不支持）===')
  for (const [fn, label, args] of [
    [tencent.fetchUSKline, '美股AAPL min5', ['AAPL', 'min5', 30]],
    [tencent.fetchAKline,  'A股sh600519 min5', ['sh600519', 'min5', 30]]
  ]) {
    try { await fn(...args); console.log(`  ❌ ${label}: 应该抛错但没有`) }
    catch (e) { console.log(`  ✅ ${label} 正确抛错: ${e.message}`) }
  }

  console.log('\n=== 8. 美股日/周K线（腾讯主源）===')
  for (const p of ['day', 'week']) {
    try {
      const rows = await tencent.fetchUSKline('AAPL', p, 10)
      const last = rows[rows.length - 1]
      console.log(`  ✅ ${p}: ${rows.length} 根 末根=${last.time} O=${last.open} C=${last.close}`)
    } catch (e) { console.log(`  ❌ ${p}: ${e.message}`) }
  }

  console.log('\n=== 9. 错误处理分支 ===')
  for (const p of ['/api/quote', '/api/kline', '/api/unknown']) {
    const r = await call(p)
    console.log(`  ${p} -> ${r.status} "${r.json.error || 'ok'}"`)
  }
}

main().catch(e => console.log('FATAL', e))
