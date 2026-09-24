// 回归测试：BUG_REPORT_2 的新发现问题（NEW-1/2/3/5/6/7/11/12）
// 全程 mock globalThis.fetch，离线可跑
import handler from '../workers/src/index.js'
import * as tencent from '../workers/src/data-sources/tencent.js'

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')) }
}

const realFetch = globalThis.fetch
const mockFetch = fn => { globalThis.fetch = fn }
const restore = () => { globalThis.fetch = realFetch }
const jsonResp = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
const textResp = (t, status = 200) => new Response(t, { status })

async function call(path) {
  const res = await handler.fetch(new Request('https://api.test' + path))
  return { status: res.status, json: await res.json() }
}

async function main() {
  // ========== NEW-2：搜索路由 107 映射 + 未知市场过滤 ==========
  console.log('\n=== NEW-2 搜索：107→裸代码，未知市场(155)丢弃 ===')
  mockFetch(async url => {
    url = String(url)
    if (url.includes('searchapi.eastmoney.com')) {
      return jsonResp({ QuotationCodeTable: { Data: [
        { Code: 'SPY', Name: 'SPDR标普500ETF', MktNum: 107 },
        { Code: 'JPM', Name: '摩根大通', MktNum: 106 },
        { Code: 'QQQ', Name: '纳指ETF', MktNum: 105 },
        { Code: '00700', Name: '腾讯控股', MktNum: 116 },
        { Code: 'BRK', Name: '布鲁克斯麦克唐纳', MktNum: 155 },  // 伦敦，应丢弃
      ] } })
    }
    throw new Error('unexpected ' + url)
  })
  {
    const r = await call('/api/search?q=spy')
    const codes = r.json.data.map(x => x.code)
    ok('107 (SPY) → 裸代码不加 sh', codes.includes('SPY'), JSON.stringify(codes))
    ok('105/106 (QQQ/JPM) 保持裸代码', codes.includes('QQQ') && codes.includes('JPM'))
    ok('116 (00700) → hk00700', codes.includes('hk00700'))
    ok('155 未知市场被丢弃', !codes.some(c => c.toLowerCase().includes('brk')))
  }
  restore()

  // ========== NEW-5：非法 period 返回 400，min60 映射 klt=60 ==========
  console.log('\n=== NEW-5 K线 period 白名单 ===')
  {
    let fetchCount = 0
    mockFetch(async () => { fetchCount++; throw new Error('should not fetch') })
    const r = await call('/api/kline?code=sh600519&period=abc')
    ok('period=abc → 400', r.status === 400, 'status=' + r.status)
    ok('非法 period 不打上游', fetchCount === 0)
    const r2 = await call('/api/kline?code=sh600519&period=weekly')
    ok('period=weekly(拼写错误) → 400', r2.status === 400)
  }
  {
    let captured = ''
    mockFetch(async url => {
      url = String(url)
      if (url.includes('push2his.eastmoney.com')) {
        captured = url
        return jsonResp({ data: { klines: ['2026-09-24 10:30,100,101,102,99,1000,x,y'] } })
      }
      throw new Error('unexpected ' + url)
    })
    const r = await call('/api/kline?code=sh600996&period=min60&count=5')
    ok('min60 → 东财 klt=60', captured.includes('klt=60'), captured.slice(0, 120))
    ok('min60 返回成功', r.status === 200 && r.json.success)
  }
  restore()

  // ========== NEW-3：补名失败时 name 置 null，不乱码直达 ==========
  console.log('\n=== NEW-3 补名失败 → name=null（不直达乱码）===')
  {
    const arr = new Array(30).fill('1')
    arr[0] = '贵州\ufffd'          // 乱码名（U+FFFD）
    arr[1] = '100'; arr[2] = '99'; arr[3] = '101'; arr[4] = '102'; arr[5] = '98'
    arr[8] = '1000'; arr[9] = '100000'
    mockFetch(async url => {
      url = String(url)
      if (url.includes('push2.eastmoney.com')) throw new Error('push2 down')
      if (url.includes('hq.sinajs.cn')) return textResp(`var hq_str_sh600995="${arr.join(',')}"`)
      if (url.includes('searchapi.eastmoney.com')) throw new Error('searchapi down')
      throw new Error('unexpected ' + url)
    })
    const r = await call('/api/quote?code=sh600995')
    ok('降级到新浪', r.json.data && r.json.data.source === 'sina', 'src=' + (r.json.data || {}).source)
    ok('乱码被清成 null', r.json.data && r.json.data.name === null, 'name=' + JSON.stringify((r.json.data || {}).name))
  }
  restore()

  // ========== NEW-3b：补名成功结果写回缓存，TTL 内不重复打 searchapi ==========
  console.log('\n=== NEW-3b 补名写回缓存 ===')
  {
    let searchHits = 0
    const arr = new Array(30).fill('1')
    arr[0] = '\ufffd\ufffd\ufffd'
    arr[1] = '100'; arr[2] = '99'; arr[3] = '101'; arr[4] = '102'; arr[5] = '98'
    mockFetch(async url => {
      url = String(url)
      if (url.includes('push2.eastmoney.com')) throw new Error('push2 down')
      if (url.includes('hq.sinajs.cn')) return textResp(`var hq_str_sh600994="${arr.join(',')}"`)
      if (url.includes('searchapi.eastmoney.com')) {
        searchHits++
        return jsonResp({ QuotationCodeTable: { Data: [{ Code: '600994', Name: '测试股份', MktNum: 1 }] } })
      }
      throw new Error('unexpected ' + url)
    })
    const r1 = await call('/api/quote?code=sh600994')
    const r2 = await call('/api/quote?code=sh600994')
    ok('第一次补名成功', r1.json.data.name === '测试股份', 'name=' + r1.json.data.name)
    ok('第二次命中缓存且名字仍在', r2.json.fromCache === true && r2.json.data.name === '测试股份')
    ok('searchapi 只被调 1 次', searchHits === 1, 'hits=' + searchHits)
  }
  restore()

  // ========== NEW-1：腾讯美股 K线按实时 p[2] 选后缀 ==========
  console.log('\n=== NEW-1 美股K线后缀：p[2]=JPM.N → kline 用 .N ===')
  {
    let klineUrl = ''
    mockFetch(async url => {
      url = String(url)
      if (url.startsWith('https://qt.gtimg.cn/q=usJPM')) {
        // 实测布局：p[0]=200 p[1]=中文名 p[2]=JPM.N（带交易所后缀）
        return textResp('v_usJPM="200~摩根大通~JPM.N~310.00~' + '1~'.repeat(60) + '"')
      }
      if (url.includes('ifzq.gtimg.cn')) {
        klineUrl = url
        return textResp(JSON.stringify({ code: 0, data: { 'usJPM.N': { day: [
          ['2026-09-22', '300', '301', '302', '299', '1000'],
          ['2026-09-23', '301', '302', '303', '300', '1100'],
        ] } } }))
      }
      throw new Error('unexpected ' + url)
    })
    const rows = await tencent.fetchUSKline('JPM', 'day', 5)
    ok('K线请求带 .N 后缀', klineUrl.includes('usJPM.N'), klineUrl.slice(0, 110))
    ok('返回完整多根', rows.length === 2, 'rows=' + rows.length)
    // 后缀缓存：第二次不再打实时行情
    let quoteHits = 0
    mockFetch(async url => {
      url = String(url)
      if (url.startsWith('https://qt.gtimg.cn/q/usJPM')) { quoteHits++; throw new Error('should be cached') }
      if (url.includes('ifzq.gtimg.cn')) {
        return textResp(JSON.stringify({ code: 0, data: { 'usJPM.N': { day: [
          ['2026-09-22', '300', '301', '302', '299', '1000'],
          ['2026-09-23', '301', '302', '303', '300', '1100'],
        ] } } }))
      }
      throw new Error('unexpected ' + url)
    })
    await tencent.fetchUSKline('JPM', 'day', 5)
    ok('后缀缓存生效（第二次不打实时行情）', quoteHits === 0)
  }
  {
    // 只回 1 根 → 显式抛错（残缺数据比报错更糟）
    mockFetch(async url => {
      url = String(url)
      if (url.startsWith('https://qt.gtimg.cn/q=usXYZW')) return textResp('v_usXYZW="200~测试~XYZW.OQ~1~' + '1~'.repeat(60) + '"')
      if (url.includes('ifzq.gtimg.cn')) {
        return textResp(JSON.stringify({ code: 0, data: { 'usXYZW.OQ': { day: [['2026-09-24', '1', '1', '1', '1', '1']] } } }))
      }
      throw new Error('unexpected ' + url)
    })
    let threw = false
    try { await tencent.fetchUSKline('XYZW', 'day', 5) } catch (e) { threw = /partial/i.test(e.message) }
    ok('只回 1 根时抛错走降级', threw)
  }
  restore()

  // ========== NEW-7：in-flight 去重 ==========
  console.log('\n=== NEW-7 并发同 code 只打一次上游 ===')
  {
    let hits = 0
    mockFetch(async url => {
      url = String(url)
      if (url.includes('push2.eastmoney.com')) {
        hits++
        await new Promise(r => setTimeout(r, 80))  // 制造并发窗口
        return jsonResp({ rc: 0, data: { f43: 1680.5, f58: '贵州茅台', f47: 1, f48: 2 } })
      }
      if (url.includes('searchapi.eastmoney.com')) return jsonResp({ QuotationCodeTable: { Data: [] } })
      throw new Error('unexpected ' + url)
    })
    const [r1, r2, r3] = await Promise.all([
      call('/api/quote?code=sh600993'),
      call('/api/quote?code=sh600993'),
      call('/api/quote?code=sh600993'),
    ])
    ok('上游只被调 1 次', hits === 1, 'hits=' + hits)
    ok('三个请求都拿到数据', [r1, r2, r3].every(r => r.json.success && r.json.data.price === 1680.5))
  }
  restore()

  // ========== NEW-6：K线接口透传 stale ==========
  console.log('\n=== NEW-6 K线 stale 透传 ===')
  {
    mockFetch(async url => {
      url = String(url)
      if (url.includes('push2his.eastmoney.com')) {
        return jsonResp({ data: { klines: ['2026-09-23,100,101,102,99,1000,x,y'] } })
      }
      throw new Error('unexpected ' + url)
    })
    await call('/api/kline?code=sh600992&count=5')   // 造缓存
    mockFetch(async () => { throw new Error('all down') })
    const origNow = Date.now
    Date.now = () => 9999999999999
    const r = await call('/api/kline?code=sh600992&count=5')
    Date.now = origNow
    ok('全源失败返回旧 K线且带 stale', r.json.stale === true && r.json.fromCache === true, 'stale=' + r.json.stale)
    ok('stale K线仍带 source', r.json.source === 'eastmoney')
  }
  restore()

  // ========== NEW-11：裸 5 位数字 → 港股 ==========
  console.log('\n=== NEW-11 裸 00700 → hk00700 ===')
  {
    let captured = ''
    mockFetch(async url => {
      url = String(url)
      if (url.includes('push2.eastmoney.com')) {
        captured = url
        return jsonResp({ rc: 0, data: { f43: 438.4, f58: '腾讯控股', f47: 1, f48: 2 } })
      }
      if (url.includes('searchapi.eastmoney.com')) return jsonResp({ QuotationCodeTable: { Data: [] } })
      throw new Error('unexpected ' + url)
    })
    const r = await call('/api/quote?code=00700')
    ok('按港股请求（secid=116.00700）', captured.includes('secid=116.00700'), captured.slice(0, 110))
    ok('返回 hk00700 数据', r.json.success && r.json.data.code === 'hk00700' && r.json.data.name === '腾讯控股')
  }
  restore()

  // ========== NEW-12：北交所显式拒绝 ==========
  console.log('\n=== NEW-12 北交所号段 400 ===')
  {
    let fetchCount = 0
    mockFetch(async () => { fetchCount++; throw new Error('should not fetch') })
    for (const code of ['830799', '920001', 'bj430047']) {
      const r = await call('/api/quote?code=' + code)
      ok(`${code} → 400`, r.status === 400, 'status=' + r.status)
    }
    ok('北交所不打上游', fetchCount === 0)
  }
  restore()

  console.log('\n-----------------------------------')
  console.log(`通过 ${pass} / 失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error('测试运行异常:', e); process.exit(1) })
