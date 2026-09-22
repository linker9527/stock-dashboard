// 腾讯财经数据源（美股主源 / A股兜底备源）
//
// 实测验证（2026-09-22）：
// 1. 实时行情  美股【不带后缀】 https://qt.gtimg.cn/q=usAAPL      （带 .OQ 返回空！）
// 2. 实时行情  A股             https://qt.gtimg.cn/q=sh600519
// 3. K线      美股【必须带后缀】 https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=usAAPL.OQ,day,<起>,<止>,N
// 4. K线      A股【必须带日期范围或用 fqkline】
//    https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,20,qfq
// 5. 美股K线接口和A股不同，且必须传起止日期，否则报 param error
// 6. 返回是 GBK 编码，中文名称需按 GBK 解码（Worker 中 response.text() 会按 UTF-8 处理，
//    因此 name 字段对美股用 p[46] 英文全名兜底，A股用中文名称）
//
// 字段映射（A股/美股通用）：
//   p[1]=中文简称 p[2]=代码 p[3]=现价 p[4]=昨收 p[5]=今开 p[6]=成交量
//   p[30]=时间戳 p[31]=涨跌额 p[32]=涨跌幅% p[33]=最高 p[34]=最低
//   p[36]=成交量 p[37]=成交额 p[38]=换手率
//   p[43]=量比 p[44]=总市值(亿) p[45]=流通市值(亿) p[46]=美股英文全名 p[47]=EPS p[48]=52周高
//   p[49]=52周低 p[51]=振幅 p[52]=PE(A股TTM)
//   美股 PE 在 p[39]（实测 AAPL: 39.03 = 340.32/8.72 ✓）

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }

function pad(code) {
  // 补齐 6 位代码，sh600519 -> 600519
  return code.replace(/^(sh|sz|bj)/i, '')
}

async function raw(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!r.ok) throw new Error(`Tencent HTTP ${r.status}`)
  return r.text()
}

// A股实时行情
export async function fetchAQuote(code) {
  const text = await raw(`https://qt.gtimg.cn/q=${code}`)
  const m = text.match(/"(.+)"/)
  if (!m) throw new Error('Tencent A: empty response')
  return parseLine(m[1], code)
}

// 美股实时行情（不带后缀！）
export async function fetchUSQuote(symbol) {
  const clean = symbol.toUpperCase().replace(/\.(OQ|N|P)$/, '')
  const text = await raw(`https://qt.gtimg.cn/q=us${clean}`)
  const m = text.match(/"(.+)"/)
  if (!m) throw new Error('Tencent US: empty response')
  return parseLine(m[1], clean, true)
}

function parseLine(str, code, isUS = false) {
  const p = str.split('~')
  if (p.length < 53) throw new Error(`Tencent: incomplete fields (${p.length})`)

  const price = num(p[3])
  const prevClose = num(p[4])
  const change = num(p[31])
  const changePercent = num(p[32])

  return {
    code,
    name: isUS ? (p[46] || p[1]) : p[1],
    price,
    change: change ?? (price != null && prevClose != null ? price - prevClose : null),
    changePercent: changePercent ?? (price != null && prevClose ? ((price - prevClose) / prevClose) * 100 : null),
    high: num(p[33]),
    low: num(p[34]),
    open: num(p[5]),
    prevClose,
    // A股成交量单位=手(1手=100股)，美股=股；这里统一换算为「股」便于前端一致显示
    volume: num(p[36]) != null ? (isUS ? num(p[36]) : num(p[36]) * 100) : null,
    // 成交额：A股单位=万元，美股=美元，统一换算为「元/美元」
    turnover: num(p[37]) != null ? (isUS ? num(p[37]) : num(p[37]) * 1e4) : null,
    pe: isUS ? num(p[39]) : num(p[52]),
    pb: isUS ? null : num(p[46]),   // A股 p[46]=市净率；美股该位置是英文全名，无PB
    marketCap: (num(p[44]) != null ? num(p[44]) * 1e8 : null),   // 亿 -> 元
    floatMarketCap: (num(p[45]) != null ? num(p[45]) * 1e8 : null),
    high52: isUS ? num(p[48]) : null,
    low52: isUS ? num(p[49]) : null,
    source: 'tencent'
  }
}

// A股K线（fqkline 接口，支持前复权）
// 实测结论：腾讯 A股只支持 day / week 两个周期
//   - 60 / 5 / min_5 / m60 等分钟参数均返回 bad params 或 param error
//   - 专用的 minkline 接口已下线（返回 undefined method）
// 因此不支持的周期直接抛错，让调用方降级到备源（Yahoo 支持 5m/1h）
// 返回原始: [日期, 开, 收, 高, 低, 量(手)]
export async function fetchAKline(code, period = 'day', count = 100) {
  const type = mapPeriod(period)
  const text = await raw(
    `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},${type},,,${count},qfq`
  )
  const data = JSON.parse(text)
  const node = data.data && data.data[code]
  if (!node) throw new Error(`Tencent A kline: no data for ${code}`)

  const rows = node[`qfq${type}`] || node[type] || []
  if (!rows.length) throw new Error('Tencent A kline: empty')
  return toRows(rows, 100)  // 第2参数：腾讯A股K线量单位是「手」，换算为股
}

// 美股K线（kline 接口，必须带后缀 + 起止日期）
// 实测结论：美股支持 day / week / 60 / 5，但分钟周期的日期窗口被服务端忽略，
//   无论传多宽的区间都只返回当天 1 根 K 线，无法用于画图。
//   所以分钟周期同样直接抛错，由调用方降级到 Yahoo。
// 返回: [日期, 开, 收, 高, 低, 量(股)]
export async function fetchUSKline(symbol, period = 'day', count = 100) {
  const type = mapPeriod(period)
  const clean = symbol.toUpperCase().replace(/\.(OQ|N|P)$/, '')
  const fullCode = `us${clean}.OQ`
  const end = new Date().toISOString().slice(0, 10)
  const start = new Date(Date.now() - (type === 'week' ? 1500 : 900) * 864e5)
    .toISOString().slice(0, 10)

  const text = await raw(
    `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${fullCode},${type},${start},${end},${count}`
  )
  const data = JSON.parse(text)
  if (data.code !== 0) throw new Error(`Tencent US kline: ${data.msg || 'param error'}`)

  const node = data.data && data.data[fullCode]
  if (!node) throw new Error(`Tencent US kline: no data for ${fullCode}`)

  const rows = (node[type] || []).slice(-count)
  if (!rows.length) throw new Error('Tencent US kline: empty')
  return toRows(rows)
}

// 周期映射：只保留腾讯真正可用的周期，其余显式抛错
function mapPeriod(period) {
  switch (period) {
    case 'day':  return 'day'
    case 'week': return 'week'
    case 'min5':
    case 'min60':
      throw new Error('Tencent kline does not support minute period (only day/week)')
    default:
      throw new Error(`Tencent kline: unsupported period "${period}"`)
  }
}

function toRows(rows, volumeFactor = 1) {
  // volumeFactor: 源数据量单位的换算系数。
  // 东财K线 f56 单位是「股」(factor=1)；腾讯A股K线单位是「手」(factor=100)
  return rows.map(r => ({
    time: String(r[0]),
    open: parseFloat(r[1]),
    close: parseFloat(r[2]),
    high: parseFloat(r[3]),
    low: parseFloat(r[4]),
    volume: parseFloat(r[5]) * volumeFactor
  }))
}
