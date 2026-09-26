// 验证降级链：东财挂 + 新浪K线已失效 时，A股K线应能降到腾讯
import handler from '../workers/src/index.js'

async function call(path) {
  const res = await handler.fetch(new Request('https://api.test' + path))
  return { status: res.status, json: await res.json() }
}

const origFetch = globalThis.fetch

async function main() {
  console.log('=== 1. 正常路径：东财可用 ===')
  let r = await call('/api/kline?code=sh600519&period=day&count=5')
  console.log(`  source=${r.json.source}  末根量=${r.json.data[r.json.data.length - 1].volume}`)

  console.log('\n=== 2. 东财挂掉 → 新浪K线(已失效) → 腾讯兜底 ===')
  try {
    // 只让东财域名失败，新浪和腾讯正常
    globalThis.fetch = async (url, opts) => {
      if (typeof url === 'string' && url.includes('push2')) {
        throw new Error('eastmoney down')
      }
      return origFetch(url, opts)
    }
    // 用全新的 count 生成独立缓存键，避免命中上一次请求的缓存
    r = await call('/api/kline?code=sh600519&period=day&count=7')
    console.log(`  status=${r.status} source=${r.json.source}`)
    if (r.json.data && r.json.data.length) {
      const last = r.json.data[r.json.data.length - 1]
      console.log(`  末根=${last.time} O=${last.open} C=${last.close} 量=${last.volume}`)
      console.log(`  ${r.json.source === 'tencent' ? '✅ 东财挂后正确降级到腾讯（新浪K线已失效）' : `⚠️ source=${r.json.source}`}`)
    }
  } catch (e) {
    console.log(`  ❌ ${e.message}`)
  } finally {
    globalThis.fetch = origFetch
  }

  console.log('\n=== 3. 三个源全挂 → 应报错（不能返回脏数据）===')
  try {
    globalThis.fetch = async () => { throw new Error('all down') }
    r = await call('/api/kline?code=sh600000&period=day&count=5')
    console.log(`  status=${r.status} ${r.json.error}`)
  } finally {
    globalThis.fetch = origFetch
  }

  console.log('\n=== 4. A股行情降级链（腾讯/东财挂 → 新浪兜底）===')
  try {
    globalThis.fetch = async (url, opts) => {
      const u = typeof url === 'string' ? url : String(url)
      // 主源腾讯和备源东财都掐掉，才能真正测到新浪兜底
      //（主源已换成腾讯后，只掐东财会命中腾讯主源，断言永远落空）
      if (u.includes('push2') || u.includes('qt.gtimg.cn')) throw new Error('down')
      return origFetch(url, opts)
    }
    r = await call('/api/quote?code=sh600519')
    console.log(`  status=${r.status} source=${r.json.data && r.json.data.source}`)
    console.log(`  ${r.json.data && r.json.data.name} 价格=${r.json.data && r.json.data.price}`)
    console.log(`  ${r.json.data && r.json.data.source === 'sina' ? '✅ 正确降级到新浪' : '⚠️'}`)
  } finally {
    globalThis.fetch = origFetch
  }

  console.log('\n=== 5. 跨源成交量一致性（茅台，应都在 245万 量级）===')
  const rows = await call('/api/kline?code=sh600519&period=day&count=3')
  const lastRow = rows.json.data[rows.json.data.length - 1]
  const q = await call('/api/quote?code=sh600519')
  console.log(`  quote.volume = ${q.json.data.volume}`)
  console.log(`  kline.volume = ${lastRow.volume}`)
  const diff = Math.abs(q.json.data.volume - lastRow.volume) / lastRow.volume
  console.log(`  差异 = ${(diff * 100).toFixed(2)}%  ${diff < 0.05 ? '✅ 单位一致' : '❌ 单位不一致'}`)
}

main()
