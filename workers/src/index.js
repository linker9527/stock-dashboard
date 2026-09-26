// 股票查询 API - Cloudflare Workers
// 主备数据源自动切换

import { fetchQuote as fetchEastmoneyQuote, fetchKline as fetchEastmoneyKline } from './data-sources/eastmoney.js'
import { fetchQuote as fetchSinaQuote, fetchKline as fetchSinaKline } from './data-sources/sina.js'
import {
  fetchUSQuote as fetchTencentUSQuote,
  fetchAQuote as fetchTencentAQuote,
  fetchHKQuote as fetchTencentHKQuote,
  fetchAKline as fetchTencentAKline,
  fetchHKKline as fetchTencentHKKline,
  fetchUSKline as fetchTencentUSKline
} from './data-sources/tencent.js'

import { fetchTimeout } from './http.js'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400'
}

// Yahoo 从国内访问经常直接无响应（不是 4xx/5xx，而是 TCP 挂起），
// fetch 默认无超时会一直卡住，必须显式设置超时，否则单个请求能拖垮整个 Worker
const YAHOO_TIMEOUT_MS = 6000

async function fetchWithTimeout(url, options = {}, timeoutMs = YAHOO_TIMEOUT_MS) {
  return fetchTimeout(url, options, timeoutMs)
}

// ========== 名称补全 ==========
//
// BUG-2：A股备用源返回的中文名是乱码。
// 根因：新浪声明 charset=GB18030（实测字节 185,243,214,221 = "贵州"），
//       腾讯返回 GBK，而 fetch 的 response.text() 固定按 UTF-8 解码。
// 不能用 new TextDecoder('gbk') 解决：Cloudflare Workers 的 TextDecoder 仅支持
//       UTF-8（官方文档 developers.cloudflare.com/workers/runtime-apis/encoding
//       明确写 "represents a UTF-8 decoder"），部署后必然失效；本地 Node 支持
//       GBK 能跑通，属于典型的"本地过、线上崩"。
// 方案：改走一个"UTF-8 的名称源"，而不是解码 GBK。
//       东财搜索接口（searchapi.eastmoney.com）返回 UTF-8 中文，用 6 位代码
//       查一次即可拿到正确名称（实测 600519->贵州茅台 000001->平安银行）。
// 效果：主源东财是 UTF-8 JSON 本身就没问题；降级到新浪/腾讯时由这里补齐。

const EASTMONEY_SEARCH_TOKEN = 'D43BF722C8E3FBAFAFD3C795D0F0FC45'
// marketNum -> sh/sz，与 /api/search 路由的 prefixMap 保持一致
const MARKET_PREFIX = { '1': 'sh', '0': 'sz' }

async function resolveANameByCode(code) {
  const rawCode = String(code).replace(/^(sh|sz|hk)/i, '')
  if (!/^\d{6}$/.test(rawCode)) return null

  try {
    const url = 'https://searchapi.eastmoney.com/api/suggest/get?input='
      + encodeURIComponent(rawCode)
      + '&type=14&token=' + EASTMONEY_SEARCH_TOKEN

    const resp = await fetchTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!resp.ok) return null

    const data = await resp.json()
    const items = (data.QuotationCodeTable && data.QuotationCodeTable.Data) || []

    // 精确匹配：代码相同 + 市场号能映射出前缀
    // 注意必须比 MarketNum，600519 与 00519 这类跨市场同号代码不能混
    for (const it of items) {
      if (String(it.Code) !== rawCode) continue
      const prefix = MARKET_PREFIX[String(it.MktNum)]
      if (prefix && prefix + rawCode === String(code).toLowerCase()) {
        return it.Name || null
      }
    }
  } catch (e) {
    // 补全失败不影响行情返回，静默降级（名称留空，前端显示代码）
  }
  return null
}

// 判断名称是否合法（非乱码）。
// GBK 内容被当 UTF-8 读会产生 U+FFFD 替换字符，这是最可靠的乱码特征。
// 合法范围只放两种：ASCII 可打印（英文全名）+ CJK 基本汉字区（中文名）。
// 其余高位字符（私用区、拉丁扩展等）一律视为乱码，宁可补全也不留乱码。
function isGarbledName(s) {
  if (!s || typeof s !== 'string') return true
  for (const ch of s) {
    const c = ch.codePointAt(0)
    if (c === 0xfffd) return true             // UTF-8 替换字符 = 必然乱码
    if (c < 0x80) continue                    // ASCII 可打印
    if (c >= 0x4e00 && c <= 0x9fff) continue  // CJK 基本汉字区
    return true                               // 其它高位字符视为乱码
  }
  return false
}

async function fillNameIfMissing(quote) {
  if (!quote) return quote
  // 名称合法（东财 UTF-8 中文名 / 腾讯英文名）则不重复请求。
  // 注意：必须检测乱码而不是判空——新浪降级时返回的是 "???????" 这种
  // 非空乱码字符串，判空会直接漏过（BUG-2 漏判点）。
  if (!isGarbledName(quote.name)) return quote

  const name = await resolveANameByCode(quote.code)
  // 补名失败也要把乱码清掉（置 null）：乱码是非空字符串，会让前端
  // `d.name || code` 兜底失效，乱码直达页面（NEW-3）。
  // 置 null 后前端显示代码，符合 README 设计意图。
  return { ...quote, name: name || null }
}

// 代码白名单校验：code 会被拼进上游 URL，必须挡掉非法字符，否则可注入上游 query
function normalizeAStockCode(code) {
  const raw = String(code).toLowerCase()
  if (/^(sh|sz)\d{6}$/.test(raw)) return raw
  if (/^bj\d{6}$/.test(raw)) return null   // 北交所不支持，显式拒绝
  if (/^\d{6}$/.test(raw)) {
    // 北交所号段（4/8/920 开头）同样显式拒绝，而不是静默归到深市然后查不到（NEW-12）
    if (/^(4|8|920)/.test(raw)) return null
    return (/^(6|9|5)/.test(raw) ? 'sh' : 'sz') + raw
  }
  return null
}

function normalizeUSCode(code) {
  const raw = String(code).toUpperCase()
  // 美股 ticker 允许字母/点/连字符，长度 1-5（覆盖 BRK-B、BF-B 等）
  return /^[A-Z][A-Z.\-]{0,4}$/.test(raw) ? raw : null
}

function normalizeHKCode(code) {
  const raw = String(code).toLowerCase().replace(/^hk/, '')
  return /^\d{4,5}$/.test(raw) ? 'hk' + raw : null
}

// 代码分流：A股(sh/sz前缀或6位数字) / 港股(hk前缀或裸4-5位数字) / 美股(其余字母)
// 裸 5 位 "00700" 是港股常见写法，页面提示词也这么教，必须认（NEW-11）
function classifyCode(code) {
  const raw = String(code).trim()
  const aCode = normalizeAStockCode(code)
  if (aCode) return { aCode }
  // 北交所（4/8/920 开头）显式拒绝，不落入美股分支（BUG-1）
  if (/^(4|8[0-49]|920)\d{5}$/.test(raw)) return { unsupported: true }
  if (/^hk/i.test(raw) || /^\d{4,5}$/.test(raw)) {
    return { hkCode: normalizeHKCode(raw) }
  }
  // 纯前缀无数字（如 "sh"）不算美股（BUG-10）
  if (/^(sh|sz|bj)$/i.test(raw)) return { unsupported: true }
  return { usCode: normalizeUSCode(raw) }
}

// count 限幅，避免 lmt=-5 / lmt=99999999 透传到上游
function clampCount(v, fallback = 100) {
  const n = parseInt(v, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1000, Math.max(1, n))
}

// 缓存层：同一个请求 3 秒内不重复打外部接口，避免高频刷新被限流
const cache = new Map()
const CACHE_TTL = 3000 // 3秒（行情）
const CACHE_TTL_KLINE = 300000 // 5分钟（日K数据一天才变一次）
const inflight = new Map() // key -> 进行中的 Promise

async function getCached(key, fetchFn, ttl = CACHE_TTL) {
  const now = Date.now()
  const cached = cache.get(key)

  if (cached && now - cached.time < ttl) {
    return { data: cached.data, fromCache: true }
  }

  // in-flight 去重：并发同 key 请求共享同一个上游 Promise，
  // 否则首屏 render + 全局轮询 + visibilitychange 撞窗口时会重复打上游（NEW-7）
  const pending = inflight.get(key)
  if (pending) return pending

  const p = (async () => {
    try {
      const data = await fetchFn()
      cache.set(key, { data, time: Date.now() })

      // 清理过期缓存
      if (cache.size > 1000) {
        const t = Date.now()
        for (const [k, v] of cache.entries()) {
          if (t - v.time > 30000) cache.delete(k)
        }
      }

      return { data, fromCache: false }
    } catch (e) {
      // 主备都失败时返回旧缓存
      if (cached) {
        return { data: cached.data, fromCache: true, stale: true }
      }
      throw e
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, p)
  return p
}

// A股查询：主腾讯（CF 出口稳定）→ 备新浪 → 兜底东财
async function fetchAStockQuote(code) {
  const cacheKey = `quote_a_${code}`

  return getCached(cacheKey, async () => {
    // 按优先级依次尝试，记录每个源的错误便于排查
    const attempts = []
    let data = null

    try {
      data = await fetchTencentAQuote(code)
      data.source = 'tencent'
    } catch (e) {
      attempts.push(`tencent: ${e.message}`)
      try {
        data = await fetchSinaQuote(code)
        data.source = 'sina'
      } catch (e2) {
        attempts.push(`sina: ${e2.message}`)
        try {
          data = await fetchEastmoneyQuote(code)
          data.source = 'eastmoney'
        } catch (e3) {
          attempts.push(`eastmoney: ${e3.message}`)
        }
      }
    }

    if (!data) throw new Error(`All sources failed | ${attempts.join(' | ')}`)

    // 降级源（新浪/腾讯）的 A股中文名是 GBK 乱码，在这里补成 UTF-8 名后
    // 才入缓存——补全结果一起缓存，TTL 内不再重复打 searchapi（NEW-3）
    return await fillNameIfMissing(data)
  })
}

// 港股查询：主腾讯（CF 出口稳定，英文名）→ 备东财（中文名）
// 腾讯港股 p[46] 是英文名（TENCENT），东财被 CF 拦截时降级到这里拿中文名。
async function fetchHKStockQuote(code) {
  const cacheKey = `quote_hk_${code}`

  return getCached(cacheKey, async () => {
    const attempts = []
    let data = null

    try {
      data = await fetchTencentHKQuote(code)
      data.source = 'tencent'
    } catch (e) {
      attempts.push(`tencent: ${e.message}`)
      try {
        data = await fetchEastmoneyQuote(code)
        data.source = 'eastmoney'
      } catch (e2) {
        attempts.push(`eastmoney: ${e2.message}`)
      }
    }

    if (!data) throw new Error(`HK quote failed | ${attempts.join(' | ')}`)
    return await fillNameIfMissing(data)
  })
}

// 港股K线：主腾讯（CF 出口稳定）→ 备东财
async function fetchHKStockKline(code, period, count) {
  const cacheKey = `kline_hk_${code}_${period}_${count}`

  return getCached(cacheKey, async () => {
    const attempts = []

    try {
      const rows = await fetchTencentHKKline(code, period, count)
      rows.source = 'tencent'
      return rows
    } catch (e) {
      attempts.push(`tencent: ${e.message}`)
    }

    try {
      const rows = await fetchEastmoneyKline(code, period, count)
      rows.source = 'eastmoney'
      return rows
    } catch (e) {
      attempts.push(`eastmoney: ${e.message}`)
    }

    throw new Error(`HK kline failed | ${attempts.join(' | ')}`)
  }, CACHE_TTL_KLINE)
}

// A股K线：主腾讯（CF 出口稳定）→ 备新浪 → 兜底东财
// 返回 K线数组，数组上挂载 source 字段便于路由层透出
async function fetchAStockKline(code, period, count) {
  const cacheKey = `kline_a_${code}_${period}_${count}`

  return getCached(cacheKey, async () => {
    const attempts = []

    try {
      const rows = await fetchTencentAKline(code, period, count)
      rows.source = 'tencent'
      return rows
    } catch (e) { attempts.push(`tencent: ${e.message}`) }

    try {
      const rows = await fetchSinaKline(code, period, count)
      rows.source = 'sina'
      return rows
    } catch (e) { attempts.push(`sina: ${e.message}`) }

    try {
      const rows = await fetchEastmoneyKline(code, period, count)
      rows.source = 'eastmoney'
      return rows
    } catch (e) { attempts.push(`eastmoney: ${e.message}`) }

    throw new Error(`A股K线全部失败 | ${attempts.join(' | ')}`)
  }, CACHE_TTL_KLINE)
}

// 美股查询：主腾讯（国内稳定）→ 备 Yahoo
async function fetchUSQuote(symbol) {
  const cacheKey = `quote_us_${symbol}`
  const cleanSymbol = symbol.toUpperCase()

  return getCached(cacheKey, async () => {
    // 腾讯接口在国内访问稳定，字段全，作为主源
    try {
      return await fetchTencentUSQuote(cleanSymbol)
    } catch (e1) {
      // Yahoo 从国内访问可能超时，仅作兜底
      try {
        return await fetchYahooQuote(cleanSymbol)
      } catch (e2) {
        throw new Error(`US quote failed | tencent: ${e1.message} | yahoo: ${e2.message}`)
      }
    }
  })
}

// Yahoo Finance 美股行情（备源）
async function fetchYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1d&interval=1d`

  const response = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    }
  })

  if (!response.ok) {
    throw new Error(`Yahoo API error: ${response.status}`)
  }

  const data = await response.json()

  if (!data.chart || !data.chart.result || !data.chart.result[0]) {
    throw new Error(`Yahoo API: no data for ${symbol}`)
  }

  const chart = data.chart.result[0]
  const meta = chart.meta
  const quote = chart.indicators.quote[0]
  const closes = (quote.close || []).filter(v => v !== null)

  if (closes.length === 0) {
    throw new Error(`Yahoo API: empty closes for ${symbol}`)
  }

  const last = closes[closes.length - 1]
  const prevClose = meta.chartPreviousClose || meta.previousClose || last

  return {
    code: symbol,
    name: symbol, // Yahoo 不提供中文名
    price: last,
    change: last - prevClose,
    changePercent: prevClose > 0 ? ((last - prevClose) / prevClose) * 100 : 0,
    high: (() => { const arr = (quote.high || []).filter(v => v !== null); return arr.length ? Math.max(...arr) : null; })(),
    low: (() => { const arr = (quote.low || []).filter(v => v !== null); return arr.length ? Math.min(...arr) : null; })(),
    open: (quote.open || [])[0],
    prevClose: prevClose,
    volume: (quote.volume || []).filter(v => v !== null).slice(-1)[0],
    marketCap: null,
    pe: meta.trailingPE || null,
    pb: null,
    source: 'yahoo'
  }
}

// 美股K线：主腾讯 → 备 Yahoo
async function fetchUSKline(symbol, period, count) {
  const cacheKey = `kline_us_${symbol}_${period}_${count}`
  const cleanSymbol = symbol.toUpperCase()

  return getCached(cacheKey, async () => {
    try {
      const rows = await fetchTencentUSKline(cleanSymbol, period, count)
      rows.source = 'tencent'
      return rows
    } catch (e1) {
      try {
        const rows = await fetchYahooKline(cleanSymbol, period, count)
        rows.source = 'yahoo'
        return rows
      } catch (e2) {
        throw new Error(`US kline failed | tencent: ${e1.message} | yahoo: ${e2.message}`)
      }
    }
  }, CACHE_TTL_KLINE)
}

// Yahoo 美股K线（备源）
// 注意：Yahoo 返回的数组里可能有 null，且 slice+indexOf 组合会错乱，
// 这里改为先取最后 N 个索引，再按原索引对齐取 OHLC
async function fetchYahooKline(symbol, period, count) {
  // period 已在路由层过白名单（day/week/min5/min60）
  const rangeMap = { day: '6mo', week: '2y', min5: '5d', min60: '1mo' }
  const intMap = { day: '1d', week: '1wk', min5: '5m', min60: '60m' }
  const range = rangeMap[period] || '6mo'
  const interval = intMap[period] || '1d'
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`

  const response = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    }
  })
  if (!response.ok) throw new Error(`Yahoo Kline HTTP ${response.status}`)

  const data = await response.json()

  if (!data.chart || !data.chart.result || !data.chart.result[0]) {
    throw new Error('Yahoo Kline: no data')
  }

  const chart = data.chart.result[0]
  const timestamps = chart.timestamp || []
  const quote = (chart.indicators.quote || [])[0]
  if (!quote) throw new Error('Yahoo Kline: no indicators')

  // 取最后 count 个时间戳对应的原始索引，逐个按索引取 OHLC
  const indexes = timestamps.map((_, i) => i).slice(-count)
  if (indexes.length === 0) throw new Error('Yahoo Kline: empty timestamps')

  return indexes.map(i => ({
    time: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
    open: quote.open && quote.open[i],
    close: quote.close && quote.close[i],
    high: quote.high && quote.high[i],
    low: quote.low && quote.low[i],
    volume: quote.volume && quote.volume[i]
  }))
}

export default {
  async fetch(request) {
    const url = new URL(request.url)
    const path = url.pathname
    
    // CORS 头
    const corsHeaders = CORS_HEADERS

    // 处理 OPTIONS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    // API 路由
    // 搜索接口：支持中文/英文/代码，前端直接请求会被跨域阻止，这里做代理
    if (path === '/api/search') {
      const keyword = url.searchParams.get('q')
      if (!keyword || !keyword.trim()) {
        return new Response(JSON.stringify({ success: true, data: [] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
        })
      }

      try {
        const encoded = encodeURIComponent(keyword.trim())
        const searchUrl = `https://searchapi.eastmoney.com/api/suggest/get?input=${encoded}&type=14&token=D43BF722C8E3FBAFAFD3C795D0F0FC45`

        const response = await fetchWithTimeout(searchUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        })
        if (!response.ok) throw new Error(`search HTTP ${response.status}`)

        const data = await response.json()
        const rawItems = data.QuotationCodeTable?.Data || []

        // market -> 前缀，统一转成本项目使用的代码格式
        // 1=沪市(sh) 0=深市(sz) 105=纳斯达克(us) 106=纽交所(us) 107=NYSE Arca/Amex(us) 116=港股(hk)
        const prefixMap = { '1': 'sh', '0': 'sz', '105': '', '106': '', '107': '', '116': 'hk' }
        // 搜索结果的 code 会被前端拼进 DOM id 和自选列表，必须过白名单
        //（与前端 isSafeCode 对齐）。上游 Code 异常时丢弃该条而不是放行（NEW-14）
        const SAFE_SEARCH_CODE = /^(sh|sz)\d{6}$|^hk\d{4,5}$|^[A-Za-z][A-Za-z.\-]{0,4}$/

        const items = rawItems.map(item => {
          const mkt = String(item.MktNum)
          const rawCode = String(item.Code ?? '')
          // A股和港股用 sh/sz/hk 前缀，美股直接用原始代码
          const prefix = prefixMap[mkt]
          // 未知市场（伦敦 155 等）直接丢弃：曾经默认套 sh，
          // 把 Arca ETF 变成 shspy、把海外票变成 shbrk 这种垃圾代码（NEW-2）
          if (prefix === undefined) return null
          const code = prefix ? prefix + rawCode.toLowerCase() : rawCode
          if (!SAFE_SEARCH_CODE.test(code)) return null
          return {
            code: code,
            name: item.Name,
            market: mkt,
            rawCode: rawCode
          }
        }).filter(x => x && x.name && x.code)

        return new Response(JSON.stringify({ success: true, data: items.slice(0, 10) }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
        })
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
        })
      }
    }

    if (path === '/api/quote') {
      const code = url.searchParams.get('code')
      if (!code) {
        return new Response(JSON.stringify({ error: 'Missing code parameter' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
        })
      }

      try {
        // 按市场分流：A股(sh/sz/6位) / 港股(hk前缀或裸4-5位) / 美股(其余)
        const { aCode, hkCode, usCode, unsupported } = classifyCode(code)

        if (unsupported || (!aCode && !hkCode && !usCode)) {
          return new Response(JSON.stringify({
            error: 'Invalid code format. Use sh600519 / sz000001 / hk00700 / AAPL'
          }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } })
        }

        let result
        if (aCode) {
          // 名称补全已挪进 fetchAStockQuote 的 fetchFn，补全结果随缓存一起存（NEW-3）
          result = await fetchAStockQuote(aCode)
        } else if (hkCode) {
          result = await fetchHKStockQuote(hkCode)
        } else {
          result = await fetchUSQuote(usCode)
        }

        return new Response(JSON.stringify({
          success: true,
          data: result.data,
          fromCache: result.fromCache,
          stale: result.stale || false
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
        })
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
        })
      }
    }

    if (path === '/api/kline') {
      const code = url.searchParams.get('code')
      const period = url.searchParams.get('period') || 'day'
      const count = clampCount(url.searchParams.get('count'))

      if (!code) {
        return new Response(JSON.stringify({ error: 'Missing code parameter' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
        })
      }

      // period 白名单：非法值（拼错的 weekly、任意垃圾）曾经静默落进 5 分钟分支，
      // 返回错周期数据还标记成功（NEW-5）
      const VALID_PERIODS = new Set(['day', 'week', 'min5', 'min60'])
      if (!VALID_PERIODS.has(period)) {
        return new Response(JSON.stringify({
          error: `Invalid period "${period}". Use day / week / min5 / min60`
        }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } })
      }

      try {
        const { aCode, hkCode, usCode, unsupported } = classifyCode(code)

        if (unsupported || (!aCode && !hkCode && !usCode)) {
          return new Response(JSON.stringify({
            error: 'Invalid code format. Use sh600519 / sz000001 / hk00700 / AAPL'
          }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } })
        }

        let result
        if (aCode) {
          result = await fetchAStockKline(aCode, period, count)
        } else if (hkCode) {
          result = await fetchHKStockKline(hkCode, period, count)
        } else {
          result = await fetchUSKline(usCode, period, count)
        }

        // K线接口返回的 result.data 是数组，数组上挂载的 source 在 JSON 序列化时会被忽略
        // （数组只序列化数值索引），所以必须显式取出来写进响应体
        return new Response(JSON.stringify({
          success: true,
          data: result.data,
          source: (result.data && result.data.source) || null,
          fromCache: result.fromCache,
          stale: result.stale || false   // 对齐 quote 接口：全源失败返回旧 K线时前端能给"旧"提示（NEW-6）
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
        })
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
        })
      }
    }

    // 健康检查
    if (path === '/api/health') {
      return new Response(JSON.stringify({ 
        status: 'ok', 
        cacheSize: cache.size,
        timestamp: Date.now() 
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
      })
    }

    // 非 API 请求 → 前端静态文件
    // ASSETS 是 wrangler [assets] 的绑定，只在 Cloudflare 环境存在；
    // 本地 Node（测试/server.js）没有这个全局，兜底回 404 JSON，
    // 否则任何未匹配路径都会 ReferenceError（e2e 第 9 节曾因此 FATAL 崩掉）
    if (typeof ASSETS !== 'undefined' && ASSETS) {
      return ASSETS.fetch(request)
    }
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
    })
  }
}