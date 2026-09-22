// 东方财富数据源（A股主数据源）

function codeToSecid(code) {
  // 转换代码格式：sh600519 -> 1.600519, sz000001 -> 0.000001
  if (code.startsWith('sh')) return '1.' + code.substring(2)
  if (code.startsWith('sz')) return '0.' + code.substring(2)
  return code
}

export async function fetchQuote(code) {
  const secid = codeToSecid(code)

  // 用逗号分隔的 secids 支持批量
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secids=${secid}&fields=f43,f44,f45,f46,f47,f48,f50,f51,f52,f57,f58,f60,f116,f117,f162,f167,f168,f169,f170,f171`

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://quote.eastmoney.com/'
    }
  })

  if (!response.ok) {
    throw new Error(`Eastmoney API error: ${response.status}`)
  }

  const data = await response.json()

  if (!data.data) {
    throw new Error(`Eastmoney API: no data for ${code}`)
  }

  const d = data.data

  return {
    code: code,
    name: d.f58,
    price: d.f43 / 100, // 价格需要除以100
    change: d.f169 / 100,
    changePercent: d.f170 / 100,
    high: d.f44 / 100,
    low: d.f45 / 100,
    open: d.f46 / 100,
    prevClose: d.f60 / 100,
    volume: d.f47,
    turnover: d.f48,
    bid1: d.f51 / 100,
    ask1: d.f52 / 100,
    marketCap: d.f116,
    floatMarketCap: d.f117,
    pe: d.f162 / 100,
    pb: d.f167 / 100
  }
}

export async function fetchKline(code, period = 'day', count = 100) {
  const secid = codeToSecid(code)

  const klt = period === 'day' ? 101 : period === 'week' ? 102 : 5
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=${klt}&fqt=1&lmt=${count}&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58`

  const response = await fetch(url)
  const data = await response.json()

  if (!data.data || !data.data.klines) {
    throw new Error(`Eastmoney Kline API: no data`)
  }

  return data.data.klines.map(line => {
    const parts = line.split(',')
    return {
      time: parts[0],
      open: parseFloat(parts[1]),
      close: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      volume: parseInt(parts[5])
    }
  })
}