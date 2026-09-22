// 股票查询 API - Cloudflare Workers
// 主备数据源自动切换

import { fetchQuote as fetchEastmoneyQuote, fetchKline as fetchEastmoneyKline } from './data-sources/eastmoney.js'
import { fetchQuote as fetchSinaQuote, fetchKline as fetchSinaKline } from './data-sources/sina.js'
import {
  fetchUSQuote as fetchTencentUSQuote,
  fetchAQuote as fetchTencentAQuote,
  fetchAKline as fetchTencentAKline,
  fetchUSKline as fetchTencentUSKline
} from './data-sources/tencent.js'

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
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`timeout after ${timeoutMs}ms`)
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
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
    if (path === '/api/quote') {
      const code = url.searchParams.get('code')
      if (!code) {
        return new Response(JSON.stringify({ error: 'Missing code parameter' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      try {
        // 判断是A股还是美股
        let result
        if (code.match(/^(sh|sz)/i)) {
          result = await fetchAStockQuote(code.toLowerCase())
        } else {
          result = await fetchUSQuote(code.toUpperCase())
        }

        return new Response(JSON.stringify({
          success: true,
          data: result.data,
          fromCache: result.fromCache,
          stale: result.stale || false
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
    }

    if (path === '/api/kline') {
      const code = url.searchParams.get('code')
      const period = url.searchParams.get('period') || 'day'
      const count = parseInt(url.searchParams.get('count')) || 100

      if (!code) {
        return new Response(JSON.stringify({ error: 'Missing code parameter' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      try {
        let result
        if (code.match(/^(sh|sz)/i)) {
          result = await fetchAStockKline(code.toLowerCase(), period, count)
        } else {
          result = await fetchUSKline(code.toUpperCase(), period, count)
        }

        // K线接口返回的 result.data 是数组，数组上挂载的 source 在 JSON 序列化时会被忽略
        // （数组只序列化数值索引），所以必须显式取出来写进响应体
        return new Response(JSON.stringify({
          success: true,
          data: result.data,
          source: (result.data && result.data.source) || null,
          fromCache: result.fromCache
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
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
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // 其他路由重定向到首页
    return new Response(JSON.stringify({ error: 'Not found', path }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
}