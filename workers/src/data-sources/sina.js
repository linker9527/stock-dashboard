// 新浪财经数据源（A股备用数据源）

export async function fetchQuote(code) {
  // 新浪接口格式：sh600519
  const url = `https://hq.sinajs.cn/list=${code}`

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://finance.sina.com.cn'
    }
  })

  if (!response.ok) {
    throw new Error(`Sina API error: ${response.status}`)
  }

  const text = await response.text()
  // 格式：var hq_str_sh600519="贵州茅台,1680.00,1675.00,1685.00,1690.00,1670.00,1680.00,1681.00,12345678,1234567890000,100,1680.00,200,1681.00,300,1682.00,400,1683.00,500,1684.00,100,1679.00,200,1678.00,300,1677.00,400,1676.00,500,1675.00,2024-01-01,15:00:00,00"
  
  const match = text.match(/"(.+)"/)
  if (!match || !match[1]) {
    throw new Error(`Sina API: invalid response`)
  }

  const parts = match[1].split(',')

  // 新浪接口直接返回「元」单位，不用换算
  const price = parseFloat(parts[3])
  const prevClose = parseFloat(parts[2])

  return {
    code: code,
    name: parts[0],
    price: price,
    change: price - prevClose,
    changePercent: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
    high: parseFloat(parts[4]),
    low: parseFloat(parts[5]),
    open: parseFloat(parts[1]),
    prevClose: prevClose,
    volume: parseInt(parts[8]),
    turnover: parseFloat(parts[9]),
    bid1: parseFloat(parts[11]),
    ask1: parseFloat(parts[21]),
    // 新浪接口没有市值、PE、PB数据
    marketCap: null,
    floatMarketCap: null,
    pe: null,
    pb: null
  }
}

export async function fetchKline(code, period = 'day', count = 100) {
  // 新浪K线接口
  const scale = period === 'day' ? 240 : period === 'week' ? 1200 : 5
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${code}&type=${scale}&datalen=${count}`

  const response = await fetch(url)
  const data = await response.json()

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Sina Kline API: no data`)
  }

  return data.map(item => ({
    time: item.day,
    open: parseFloat(item.open),
    close: parseFloat(item.close),
    high: parseFloat(item.high),
    low: parseFloat(item.low),
    volume: parseInt(item.volume)
  }))
}