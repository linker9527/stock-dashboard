import { fetchTimeout } from '../http.js'

// 腾讯财经数据源（美股主源 / A股兜底备源 / 港股备源）
//
// 实测验证（2026-09-22）：
// 1. 实时行情  美股【不带后缀】 https://qt.gtimg.cn/q=usAAPL      （带 .OQ 返回空！）
// 2. 实时行情  A股             https://qt.gtimg.cn/q=sh600519
// 3. K线      美股【必须带后缀】 https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=usAAPL.OQ,day,<起>,<止>,N
// 4. K线      A股【必须带日期范围或用 fqkline】
//    https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,20,qfq
// 5. 美股K线接口和A股不同，且必须传起止日期，否则报 param error
// 6. 返回是 GBK 编码，中文名称需按 GBK 解码。但 Cloudflare Workers 的 TextDecoder
//    仅支持 UTF-8（官方文档确认），无法用 new TextDecoder('gbk') 救，本地 Node 支持
//    GBK 能跑通属于"本地过线上崩"。
//    因此 A股降级时不取 p[1] 中文名，改由 index.js 用东财搜索接口（UTF-8）补全。
//    美股用 p[46] 英文全名，港股用 p[46] 英文简称（实测 hk00700 -> TENCENT）。
// 7. 港股 K线复用 A股 fqkline 接口：https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=hk00700,day,,,20,qfq
//    key 为 hk00700，返回 [日期,开,收,高,低,量,...]，量单位与实时接口一致（股）
//
// 字段映射（A股/美股通用）：
//   p[1]=中文简称 p[2]=代码 p[3]=现价 p[4]=昨收 p[5]=今开 p[6]=成交量
//   p[30]=时间戳 p[31]=涨跌额 p[32]=涨跌幅% p[33]=最高 p[34]=最低
//   p[36]=成交量 p[37]=成交额 p[38]=换手率
//   p[43]=量比 p[44]=总市值(亿) p[45]=流通市值(亿) p[46]=美股英文全名 p[47]=EPS p[48]=52周高
//   p[49]=52周低 p[51]=振幅 p[52]=PE(A股TTM)
//   美股 PE 在 p[39]（实测 AAPL: 39.03 = 340.32/8.72 ✓）
//
// 港股实测（hk00700，78 字段）：
//   价格类字段与 A股/美股完全一致（p3/p4/p5/p31/p32/p33/p34/p36/p37/p39/p44/p45）
//   差异：p[46]=英文名(TENCENT) 美股也是英文名；p[41]/p[42](内外盘)恒为 0
//   K线复用 fqkline 接口，key 为 hk00700，返回 [日期,开,收,高,低,量,...]

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }

function pad(code) {
  // 补齐 6 位代码，sh600519 -> 600519
  return code.replace(/^(sh|sz|bj)/i, '')
}

async function raw(url, timeoutMs) {
  const r = await fetchTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, timeoutMs)
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
  const clean = symbol.toUpperCase().replace(/\.(OQ|N|AM|P)$/, '')
  const text = await raw(`https://qt.gtimg.cn/q=us${clean}`)
  const m = text.match(/"(.+)"/)
  if (!m) throw new Error('Tencent US: empty response')
  return parseLine(m[1], 'us' + clean, true)
}

// 港股实时行情（2026-09-23 新增）
// 与 A股同一个接口，直接带 hk 前缀即可：https://qt.gtimg.cn/q=hk00700
// 实测 hk00700 返回 78 字段，p[3]=441.000（腾讯控股股价）
export async function fetchHKQuote(code) {
  const clean = code.toLowerCase().replace(/^hk/, '')
  const fullCode = 'hk' + clean
  const text = await raw(`https://qt.gtimg.cn/q=${fullCode}`)
  const m = text.match(/"(.+)"/)
  if (!m) throw new Error('Tencent HK: empty response')
  return parseLine(m[1], fullCode, true)
}

function parseLine(str, code, isUS = false) {
  const p = str.split('~')
  if (p.length < 53) throw new Error(`Tencent: incomplete fields (${p.length})`)

  const price = num(p[3])
  const prevClose = num(p[4])
  const change = num(p[31])
  const changePercent = num(p[32])
  // 取字段：超出范围时返回 undefined，num() 会转成 null，避免短字段抛错
  const f = i => (i < p.length ? p[i] : undefined)

  // name 处理：
  // - 美股/港股用 p[46] 英文名（UTF-8 安全，实测 AAPL->Apple Inc. / hk00700->TENCENT）
  // - A股本应取 p[1] 中文名，但腾讯返回 GBK 编码，而 Cloudflare Workers 的
  //   TextDecoder 仅支持 UTF-8（官方文档确认），无法用 new TextDecoder('gbk') 解码。
  //   所以 A股这里直接置空，由 index.js 路由层调用东财搜索接口（UTF-8）补全中文名。
  //   否则降级到腾讯时会显示 "??????" 乱码（BUG-2）。
  let name = isUS ? (f(46) || null) : null

  return {
    code,
    name,
    price,
    change: change ?? (price != null && prevClose != null ? price - prevClose : null),
    changePercent: changePercent ?? (price != null && prevClose ? ((price - prevClose) / prevClose) * 100 : null),
    high: num(f(33)),
    low: num(f(34)),
    open: num(f(5)),
    prevClose,
    // A股成交量单位=手(1手=100股)，美股=股；这里统一换算为「股」便于前端一致显示
    volume: num(f(36)) != null ? (isUS ? num(f(36)) : num(f(36)) * 100) : null,
    // 成交额：A股单位=万元，美股=美元，统一换算为「元/美元」
    turnover: num(f(37)) != null ? (isUS ? num(f(37)) : num(f(37)) * 1e4) : null,
    pe: isUS ? num(f(39)) : num(f(52)),
    pb: isUS ? null : num(f(46)),   // A股 p[46]=市净率；美股/港股该位置是英文名，无PB
    marketCap: (num(f(44)) != null ? num(f(44)) * 1e8 : null),   // 亿 -> 元
    floatMarketCap: (num(f(45)) != null ? num(f(45)) * 1e8 : null),
    high52: isUS ? num(f(48)) : null,
    low52: isUS ? num(f(49)) : null,
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
    `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},${type},,,${count},qfq`,
    4000 // K线超时 4 秒，快速降级
  )
  const data = JSON.parse(text)
  const node = data.data && data.data[code]
  if (!node) throw new Error(`Tencent A kline: no data for ${code}`)

  const rows = node[`qfq${type}`] || node[type] || []
  if (!rows.length) throw new Error('Tencent A kline: empty')
  return toRows(rows, 100)  // 第2参数：腾讯A股K线量单位是「手」，换算为股
}

// 美股K线（kline 接口，必须带后缀 + 起止日期）
// 后缀 = 交易所标识，带错后缀接口仍返回 code:0 但只有 1 根 K线（静默残缺，比报错更糟）：
//   105 纳斯达克 → .OQ   106 纽交所 → .N   107 NYSE Arca/Amex → .AM
//   实测：JPM/BAC 用 .OQ 只回当天 1 根，换 .N 回完整多日；SPY/VOO/DIA 用 .AM 才完整。
// 后缀基本不变（换交易所是极小概率事件），按代码缓存一次即可。
// 查不到后缀说明代码本身有问题，直接抛错让路由层降级 Yahoo，绝不静默拿残缺数据。
const usSuffixCache = new Map()   // 'JPM' -> '.N'

async function resolveUSSuffix(clean) {
  const hit = usSuffixCache.get(clean)
  if (hit) return hit
  // 腾讯实时行情的 p[2] 带交易所后缀（实测 usSPY → "SPY.AM"，usJPM → "JPM.N"）
  const text = await raw(`https://qt.gtimg.cn/q=us${clean}`)
  const m = text.match(/"(.+)"/)
  if (!m) throw new Error(`Tencent US: empty response for ${clean}`)
  const listed = String(m[1].split('~')[2] || '').toUpperCase()
  const suffix = listed.match(/\.(OQ|N|AM|P)$/)
  if (!suffix) {
    throw new Error(`Tencent US: unknown exchange for ${clean} (p[2]="${listed}")`)
  }
  usSuffixCache.set(clean, suffix[0])
  return suffix[0]
}

// 实测结论：美股支持 day / week / 60 / 5，但分钟周期的日期窗口被服务端忽略，
//   无论传多宽的区间都只返回当天 1 根 K 线，无法用于画图。
//   所以分钟周期同样直接抛错，由调用方降级到 Yahoo。
// 返回: [日期, 开, 收, 高, 低, 量(股)]
export async function fetchUSKline(symbol, period = 'day', count = 100) {
  const type = mapPeriod(period)
  const upper = symbol.toUpperCase()
  const given = upper.match(/\.(OQ|N|AM|P)$/)
  const clean = upper.replace(/\.(OQ|N|AM|P)$/, '')
  // 调用方显式带后缀（如直接传 JPM.N）就尊重它；否则查实时行情确定交易所
  const fullCode = `us${clean}${given ? given[0] : await resolveUSSuffix(clean)}`
  const end = new Date().toISOString().slice(0, 10)
  const start = new Date(Date.now() - (type === 'week' ? 1500 : 900) * 864e5)
    .toISOString().slice(0, 10)

  const text = await raw(
    `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${fullCode},${type},${start},${end},${count}`,
    4000 // K线超时 4 秒
  )
  const data = JSON.parse(text)
  if (data.code !== 0) throw new Error(`Tencent US kline: ${data.msg || 'param error'}`)

  const node = data.data && data.data[fullCode]
  if (!node) throw new Error(`Tencent US kline: no data for ${fullCode}`)

  const rows = (node[type] || []).slice(-count)
  if (!rows.length) throw new Error('Tencent US kline: empty')
  // 防御：后缀对了却只回 1 根 = 数据不可信（正是带错后缀时的症状），
  // 抛错降级 Yahoo；Yahoo 对新股照样回真实短历史，不会错杀。
  if (rows.length < 2 && count >= 5) {
    throw new Error(`Tencent US kline: suspicious partial data (${rows.length} row) for ${fullCode}`)
  }
  return toRows(rows)
}

// 港股K线（fqkline 接口，与 A股同一套）
// 实测 hk00700：https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=hk00700,day,,,20,qfq
//   返回 data.hk00700.day = [["2026-09-23","453.400","441.000","454.400","438.600","22309793",{"cqr":...}]]
//   量单位是「股」(factor=1)，与实时接口 p[36] 一致；A股是「手」(factor=100)
export async function fetchHKKline(code, period = 'day', count = 100) {
  const type = mapPeriod(period)
  const fullCode = 'hk' + String(code).toLowerCase().replace(/^hk/, '')
  const text = await raw(
    `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${fullCode},${type},,,${count},qfq`,
    4000 // K线超时 4 秒
  )
  const data = JSON.parse(text)
  const node = data.data && data.data[fullCode]
  if (!node) throw new Error(`Tencent HK kline: no data for ${fullCode}`)

  // 港股没有前复权标记，直接用 type 键
  const rows = node[type] || []
  if (!rows.length) throw new Error('Tencent HK kline: empty')
  return toRows(rows, 1)
}
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
  // 腾讯A股K线单位是「手」(factor=100)，腾讯美股K线是「股」(factor=1)
  return rows.map(r => ({
    time: String(r[0]),
    open: parseFloat(r[1]),
    close: parseFloat(r[2]),
    high: parseFloat(r[3]),
    low: parseFloat(r[4]),
    volume: parseFloat(r[5]) * volumeFactor
  }))
}
