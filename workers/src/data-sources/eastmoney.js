import { fetchTimeout } from '../http.js'

// 东方财富数据源（A股 / 港股主数据源）
// 官方接口参考：
// 实时行情 https://push2.eastmoney.com/api/qt/stock/get
// 历史K线 https://push2his.eastmoney.com/api/qt/stock/kline/get
// 价格类字段以「分」为单位，需要除以100还原为「元」

// 市场号映射：东财 secid 的前缀是市场号
//   1=沪市  0=深市  116=港股
// 注意 mkt 105/106 是纳斯达克/纽交所，本项目美股走腾讯+Yahoo，不用东财
const MARKET_SECID = { sh: '1', sz: '0', hk: '116' }

function parseCode(code) {
  const m = String(code).toLowerCase().match(/^(sh|sz|hk)(\d{4,6})$/)
  if (!m) return null
  return { market: m[1], rawCode: m[2], secid: MARKET_SECID[m[1]] + '.' + m[2] }
}

// 东财不同市场的成交量单位不同（实测验证）：
//   A股 f47 / f56 单位是「手」(1手=100股) -> 换算为股需 ×100
//   港股 f47 / f56 单位直接是「股」        -> 不换算
// 实测依据 hk00700：quote f47=22309793 与 K线 f56=22309793 数值相同。
// 若按「手」解读则单日 22 亿股，远超腾讯控股流通盘，显然不成立。
function volumeFactor(market) {
  return market === 'hk' ? 1 : 100
}

export async function fetchQuote(code) {
  const parsed = parseCode(code)
  if (!parsed) throw new Error(`Eastmoney: invalid code "${code}" (expect sh600519 / sz000001 / hk00700)`)
  const secid = parsed.secid

  // 注意：实时接口参数是 secid（单数），加 fltt=2 后返回的已经是「元」为单位，无需再除100
  // 单只股票查询用 secid；批量场景才用 secids 逗号分隔
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fltt=2&fields=f43,f44,f45,f46,f47,f48,f50,f51,f52,f57,f58,f60,f116,f117,f162,f167,f168,f169,f170,f171`

  const response = await fetchTimeout(url, {
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
    throw new Error(`Eastmoney API: no data for ${code} (rc=${data.rc})`)
  }

  const d = data.data

  // 停牌时会返回 "-"，做空值保护
  const num = v => (typeof v === 'number' ? v : null)

  return {
    code: code,
    name: d.f58,
    price: num(d.f43),
    change: num(d.f169),
    changePercent: num(d.f170),
    high: num(d.f44),
    low: num(d.f45),
    open: num(d.f46),
    prevClose: num(d.f60),
    // 成交量统一换算为「股」，系数按市场区分（见 volumeFactor）
    volume: (num(d.f47) != null ? num(d.f47) * volumeFactor(parsed.market) : null),
    turnover: num(d.f48),
    bid1: num(d.f51),
    ask1: num(d.f52),
    marketCap: num(d.f116),
    floatMarketCap: num(d.f117),
    pe: num(d.f162),
    pb: num(d.f167)
  }
}

export async function fetchKline(code, period = 'day', count = 100) {
  const parsed = parseCode(code)
  if (!parsed) throw new Error(`Eastmoney Kline: invalid code "${code}"`)
  const secid = parsed.secid

  // K线接口参数是 secid（单数），klt: 101=日K 102=周K 5=5分钟
  const klt = period === 'day' ? 101 : period === 'week' ? 102 : 5
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=${klt}&fqt=1&lmt=${count}&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58`

  const response = await fetchTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://quote.eastmoney.com/'
    }
  })
  const data = await response.json()

  if (!data.data || !data.data.klines) {
    throw new Error(`Eastmoney Kline API: no data`)
  }

  // 注意量单位：东财K线的 f56（parts[5]）与 quote 接口 f47 单位一致。
  // A股是「手」(×100)，港股是「股」(×1)。系数必须与 fetchQuote 保持一致，
  // 否则同一只股票的 quote 和 kline 会显示差 100 倍的成交量。
  // （tencent.js 注释里曾写"东财K线 f56 是股"，那是错的，以本文件为准）
  const factor = volumeFactor(parsed.market)
  return data.data.klines.map(line => {
    const parts = line.split(',')
    return {
      time: parts[0],
      open: parseFloat(parts[1]),
      close: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      volume: parseInt(parts[5]) * factor
    }
  })
}