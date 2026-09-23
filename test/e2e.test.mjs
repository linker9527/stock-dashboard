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

  console.log('\n=== 4. 腾讯 A股兜底源（数据源层，名称交由路由层补全）===')
  // 注意：直接调数据源时 A股 name 是 null（腾讯返回 GBK，CF 的 TextDecoder 只有 UTF-8），
  // 路由层会用东财搜索接口补成中文名。这里只验证数值字段。
  const expect = { 'sh600519': [1000, '贵州茅台'], 'sz300750': [100, '宁德时代'], 'sz000001': [8, '平安银行'] }
  for (const code of ['sh600519', 'sz300750', 'sz000001']) {
    try {
      const q = await tencent.fetchAQuote(code)
      const [min, label] = expect[code]
      const ok = q.name === null && q.price >= min
      console.log(`  ${ok ? '✅' : '⚠️'} ${code} (${label}): 价格=${q.price} 涨跌%=${q.changePercent} PE=${q.pe} PB=${q.pb} name=${q.name}`)
    } catch (e) { console.log(`  ❌ ${code}: ${e.message}`) }
  }

  console.log('\n=== 4b. 路由层名称补全（走 /api/quote，降级后应为正确中文）===')
  const realFetch = globalThis.fetch
  for (const [label, match, code] of [
    ['东财挂->新浪(乱码源)', 'push2', 'sh600519'],
    ['东财+新浪挂->腾讯(null源)', '___BOTH___', 'sz000002'],
  ]) {
    globalThis.fetch = async (u, o) => {
      const hit = match === '___BOTH___'
        ? (typeof u === 'string' && (u.includes('push2') || u.includes('sinajs')))
        : (typeof u === 'string' && u.includes(match))
      if (hit) throw new Error('down: ' + match)
      return realFetch(u, o)
    }
    const r = await call(`/api/quote?code=${code}`)
    const d = r.json.data || {}
    const garbled = !d.name || /\uFFFD/.test(d.name) || /[^\x00-\x7F\u4E00-\u9FFF]/.test(d.name)
    console.log(`  ${garbled ? '❌' : '✅'} ${label.padEnd(24)} src=${String(d.source).padEnd(9)} name=${JSON.stringify(d.name)}`)
  }
  globalThis.fetch = realFetch

  console.log('\n=== 5. 腾讯美股行情 ===')
  for (const sym of ['NVDA', 'MSFT', 'GOOGL', 'AMZN']) {
    try {
      const q = await tencent.fetchUSQuote(sym)
      console.log(`  ✅ ${q.name.padEnd(20)} 价格=${q.price} 涨跌%=${q.changePercent} PE=${q.pe}`)
    } catch (e) { console.log(`  ❌ ${sym}: ${e.message}`) }
  }

  console.log('\n=== 6. 无效代码必须报错（不能返回脏数据）===')
  // BUG-10：sh600000 是浦发银行的有效代码，原断言把有效代码当无效代码，前提错误。
  // 这里只保留真正不存在的代码，并用 /api/quote 验证路由层校验。
  for (const code of ['sz999999', 'sh999999', 'sh000000']) {
    const r = await call(`/api/quote?code=${code}`)
    console.log(`  ${r.status === 500 ? '✅' : '⚠️'} ${code} -> ${r.status} ${(r.json.error || '').slice(0, 50)}`)
  }

  console.log('\n=== 6b. 有效代码必须返回真实数据（BUG-10 反例）===')
  const valid = await call('/api/quote?code=sh600000')
  const vd = valid.json.data || {}
  console.log(`  ${vd.name === '浦发银行' ? '✅' : '❌'} sh600000 -> ${vd.name} ${vd.price} (有效代码，不应报错)`)

  console.log('\n=== 6c. 参数注入 / 非法格式必须 400（BUG-7）===')
  for (const c of ['sh600519&fltt=9&fields=f1', '99999999', 'sh600519..', 'AAPL;rm', "%27%20DROP"]) {
    const r = await call(`/api/quote?code=${encodeURIComponent(c)}`)
    console.log(`  ${r.status === 400 ? '✅' : '❌'} ${c.padEnd(28)} -> ${r.status}`)
  }

  console.log('\n=== 6d. count 限幅（BUG-7）===')
  for (const [n, want] of [[-5, 1], [0, 1], [99999999, 1000], ['abc', 100], [10, 10]]) {
    const r = await call(`/api/kline?code=sh600519&count=${encodeURIComponent(String(n))}`)
    const got = r.json.data ? r.json.data.length : -1
    console.log(`  ${got === want ? '✅' : '❌'} count=${String(n).padEnd(9)} -> rows=${got}`)
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
