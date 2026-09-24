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
  return name ? { ...quote, name } : quote
}

// 代码白名单校验：code 会被拼进上游 URL，必须挡掉非法字符，否则可注入上游 query
function normalizeAStockCode(code) {
  const raw = String(code).toLowerCase()
  if (/^(sh|sz)\d{6}$/.test(raw)) return raw
  if (/^\d{6}$/.test(raw)) return (/^(6|9|5)/.test(raw) ? 'sh' : 'sz') + raw
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

// count 限幅，避免 lmt=-5 / lmt=99999999 透传到上游
function clampCount(v, fallback = 100) {
  const n = parseInt(v, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1000, Math.max(1, n))
}

// 缓存层：同一个请求 3 秒内不重复打外部接口，避免高频刷新被限流
const cache = new Map()
const CACHE_TTL = 3000 // 3秒

async function getCached(key, fetchFn) {
  const now = Date.now()
  const cached = cache.get(key)
  
  if (cached && now - cached.time < CACHE_TTL) {
    return { data: cached.data, fromCache: true }
  }

  try {
    const data = await fetchFn()
    cache.set(key, { data, time: now })
    
    // 清理过期缓存
    if (cache.size > 1000) {
      for (const [k, v] of cache.entries()) {
        if (now - v.time > 30000) cache.delete(k)
      }
    }
    
    return { data, fromCache: false }
  } catch (e) {
    // 主备都失败时返回旧缓存
    if (cached) {
      return { data: cached.data, fromCache: true, stale: true }
    }
    throw e
  }
}

// A股查询：主东财 → 备新浪 → 兜底腾讯
async function fetchAStockQuote(code) {
  const cacheKey = `quote_a_${code}`

  return getCached(cacheKey, async () => {
    // 按优先级依次尝试，记录每个源的错误便于排查
    const attempts = []

    try {
      const data = await fetchEastmoneyQuote(code)
      data.source = 'eastmoney'
      return data
    } catch (e) {
      attempts.push(`eastmoney: ${e.message}`)
    }

    try {
      const data = await fetchSinaQuote(code)
      data.source = 'sina'
      return data
    } catch (e) {
      attempts.push(`sina: ${e.message}`)
    }

    try {
      return await fetchTencentAQuote(code)
    } catch (e) {
      attempts.push(`tencent: ${e.message}`)
    }

    throw new Error(`All sources failed | ${attempts.join(' | ')}`)
  })
}

// 港股查询：主东财（mkt 116，UTF-8 中文名）→ 备腾讯
// 东财港股实测返回 f58="腾讯控股"，是 UTF-8 JSON，不会乱码。
// 腾讯港股 p[1] 是 GBK 中文，但 p[46] 是英文名（TENCENT），所以降级后名称仍是干净的。
async function fetchHKStockQuote(code) {
  const cacheKey = `quote_hk_${code}`

  return getCached(cacheKey, async () => {
    const attempts = []

    try {
      const data = await fetchEastmoneyQuote(code)
      data.source = 'eastmoney'
      return data
    } catch (e) {
      attempts.push(`eastmoney: ${e.message}`)
    }

    try {
      const data = await fetchTencentHKQuote(code)
      return data
    } catch (e) {
      attempts.push(`tencent: ${e.message}`)
    }

    throw new Error(`HK quote failed | ${attempts.join(' | ')}`)
  })
}

// 港股K线：主东财 → 备腾讯 fqkline
async function fetchHKStockKline(code, period, count) {
  const cacheKey = `kline_hk_${code}_${period}_${count}`

  return getCached(cacheKey, async () => {
    const attempts = []

    try {
      const rows = await fetchEastmoneyKline(code, period, count)
      rows.source = 'eastmoney'
      return rows
    } catch (e) {
      attempts.push(`eastmoney: ${e.message}`)
    }

    try {
      const rows = await fetchTencentHKKline(code, period, count)
      rows.source = 'tencent'
      return rows
    } catch (e) {
      attempts.push(`tencent: ${e.message}`)
    }

    throw new Error(`HK kline failed | ${attempts.join(' | ')}`)
  })
}

// A股K线：主东财 → 备新浪 → 兜底腾讯
// 返回 K线数组，数组上挂载 source 字段便于路由层透出
async function fetchAStockKline(code, period, count) {
  const cacheKey = `kline_a_${code}_${period}_${count}`

  return getCached(cacheKey, async () => {
    const attempts = []

    try {
      const rows = await fetchEastmoneyKline(code, period, count)
      rows.source = 'eastmoney'
      return rows
    } catch (e) { attempts.push(`eastmoney: ${e.message}`) }

    try {
      const rows = await fetchSinaKline(code, period, count)
      rows.source = 'sina'
      return rows
    } catch (e) { attempts.push(`sina: ${e.message}`) }

    try {
      const rows = await fetchTencentAKline(code, period, count)
      rows.source = 'tencent'
      return rows
    } catch (e) { attempts.push(`tencent: ${e.message}`) }

    throw new Error(`A股K线全部失败 | ${attempts.join(' | ')}`)
  })
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
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`

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
    high: Math.max(...(quote.high || []).filter(v => v !== null)),
    low: Math.min(...(quote.low || []).filter(v => v !== null)),
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
  })
}

// Yahoo 美股K线（备源）
// 注意：Yahoo 返回的数组里可能有 null，且 slice+indexOf 组合会错乱，
// 这里改为先取最后 N 个索引，再按原索引对齐取 OHLC
async function fetchYahooKline(symbol, period, count) {
  const range = period === 'day' ? '6mo' : period === 'week' ? '2y' : '5d'
  const interval = period === 'day' ? '1d' : period === 'week' ? '1wk' : '5m'
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
        // 1=沪市(sh) 0=深市(sz) 105=纳斯达克(us) 106=纽交所(us) 116=港股(hk)
        const prefixMap = { '1': 'sh', '0': 'sz', '105': '', '106': '', '116': 'hk' }

        const items = rawItems.map(item => {
          const mkt = String(item.MktNum)
          const rawCode = item.Code
          // A股和港股用 sh/sz/hk 前缀，美股直接用原始代码
          let prefix = prefixMap[mkt]
          if (prefix === undefined) prefix = 'sh'
          return {
            code: prefix ? prefix + rawCode.toLowerCase() : rawCode,
            name: item.Name,
            market: mkt,
            rawCode: rawCode
          }
        }).filter(x => x.name && x.code)

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
        // 按市场分流：A股(sh/sz) / 港股(hk) / 美股(其余)
        let aCode = normalizeAStockCode(code)
        let hkCode = null
        let usCode = null
        if (aCode) {
          aCode = aCode
        } else if (/^hk/i.test(code)) {
          hkCode = normalizeHKCode(code)
        } else {
          usCode = normalizeUSCode(code)
        }

        if (!aCode && !hkCode && !usCode) {
          return new Response(JSON.stringify({
            error: 'Invalid code format. Use sh600519 / sz000001 / hk00700 / AAPL'
          }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } })
        }

        let result
        if (aCode) {
          result = await fetchAStockQuote(aCode)
          // 备用源（新浪/腾讯）返回的中文名是 GBK 乱码，降级时补全为 UTF-8 中文
          result.data = await fillNameIfMissing(result.data)
        } else if (hkCode) {
          result = await fetchHKStockQuote(hkCode)
          result.data = await fillNameIfMissing(result.data)
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

      try {
        const aCode = normalizeAStockCode(code)
        const hkCode = /^hk/i.test(code) ? normalizeHKCode(code) : null
        const usCode = (!aCode && !hkCode) ? normalizeUSCode(code) : null

        if (!aCode && !hkCode && !usCode) {
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
          fromCache: result.fromCache
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

    // 其他路由重定向到首页
    return new Response(JSON.stringify({ error: 'Not found', path }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
    })
  }
}