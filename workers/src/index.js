// 股票查询 API - Cloudflare Workers
// 主备数据源自动切换

import { fetchQuote as fetchEastmoneyQuote, fetchKline as fetchEastmoneyKline } from './data-sources/eastmoney.js'
import { fetchQuote as fetchSinaQuote, fetchKline as fetchSinaKline } from './data-sources/sina.js'

// 缓存层：同一个请求3秒内不重复调接口
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

// A股查询：主东财，备新浪
async function fetchAStockQuote(code) {
  const cacheKey = `quote_a_${code}`
  
  return getCached(cacheKey, async () => {
    try {
      const data = await fetchEastmoneyQuote(code)
      data.source = 'eastmoney'
      return data
    } catch (e1) {
      try {
        const data = await fetchSinaQuote(code)
        data.source = 'sina'
        data.stale = false
        return data
      } catch (e2) {
        throw new Error(`Both sources failed: ${e1.message} / ${e2.message}`)
      }
    }
  })
}

// A股K线：主东财，备新浪
async function fetchAStockKline(code, period, count) {
  const cacheKey = `kline_a_${code}_${period}_${count}`
  
  return getCached(cacheKey, async () => {
    try {
      const data = await fetchEastmoneyKline(code, period, count)
      data.source = 'eastmoney'
      return data
    } catch (e1) {
      try {
        const data = await fetchSinaKline(code, period, count)
        data.source = 'sina'
        return data
      } catch (e2) {
        throw new Error(`Both sources failed: ${e1.message} / ${e2.message}`)
      }
    }
  })
}

// 美股查询：Yahoo Finance
async function fetchUSQuote(symbol) {
  const cacheKey = `quote_us_${symbol}`
  
  return getCached(cacheKey, async () => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`
    
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
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
    
    const last = quote.close[quote.close.length - 1]
    const prevClose = meta.chartPreviousClose
    
    return {
      code: symbol,
      name: symbol, // Yahoo不提供中文名
      price: last,
      change: last - prevClose,
      changePercent: ((last - prevClose) / prevClose) * 100,
      high: Math.max(...quote.high),
      low: Math.min(...quote.low),
      open: quote.open[0],
      prevClose: prevClose,
      volume: quote.volume[quote.volume.length - 1],
      marketCap: null,
      pe: meta.trailingPE,
      pb: null,
      source: 'yahoo'
    }
  })
}

// 美股K线
async function fetchUSKline(symbol, period, count) {
  const cacheKey = `kline_us_${symbol}_${period}_${count}`
  
  return getCached(cacheKey, async () => {
    const range = period === 'day' ? '6mo' : period === 'week' ? '2y' : '5d'
    const interval = period === 'day' ? '1d' : period === 'week' ? '1wk' : '5m'
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`
    
    const response = await fetch(url)
    const data = await response.json()

    if (!data.chart || !data.chart.result || !data.chart.result[0]) {
      throw new Error(`Yahoo Kline API: no data`)
    }

    const chart = data.chart.result[0]
    const timestamps = chart.timestamp
    const quote = chart.indicators.quote[0]
    
    return timestamps.slice(-count).map((ts, i) => {
      const idx = timestamps.indexOf(ts)
      return {
        time: new Date(ts * 1000).toISOString().split('T')[0],
        open: quote.open[idx],
        close: quote.close[idx],
        high: quote.high[idx],
        low: quote.low[idx],
        volume: quote.volume[idx]
      }
    })
  })
}

export default {
  async fetch(request) {
    const url = new URL(request.url)
    const path = url.pathname
    
    // CORS 头
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400'
    }

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

        return new Response(JSON.stringify({
          success: true,
          data: result.data,
          source: result.data.source,
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