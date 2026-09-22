# 📈 Stock Dashboard

个人股票看板：A股 + 美股实时行情，主备多源自动切换。
部署在 Cloudflare（Workers 后端 + Pages 前端），完全免费。

## 特性

- ✅ A股 + 美股实时行情，5 秒自动刷新
- ✅ 多数据源主备自动切换（见下表）
- ✅ 三级降级：主源 → 备源 → 兜底源 → 返回过期缓存
- ✅ 缓存层（TTL 3 秒）防限流，重复请求不重复打外部接口
- ✅ 自选股本地存储（localStorage），刷新不丢
- ✅ K线图表（Canvas 手绘，零依赖）
- ✅ 全部接口带超时，Yahoo 不可达时 6 秒快速失败不会卡死 Worker

## 数据源架构

| 市场 | 主源 | 备源 | 兜底源 |
|------|------|------|--------|
| A股行情 | 东方财富 | 新浪 | 腾讯 |
| A股K线 | 东方财富 | ~~新浪（已失效）~~ | 腾讯 |
| 美股行情 | 腾讯 | Yahoo | — |
| 美股K线 | 腾讯 | Yahoo | — |

> ⚠️ **新浪K线接口已废弃**：`CN_MarketData.getKLineData` 现在返回
> `{"__ERROR":1,"__ERRORMSG":"Input error"}`，试了 6 种参数变体全部失败，
> 不是参数问题。新浪**实时行情**（`hq.sinajs.cn`）仍然正常。
> 所以 A股K线的新浪备源实际无效，东财挂掉时直接降级到腾讯。
> 代码里保留了新浪分支以便接口将来恢复，但别指望它能兜底。

### 踩坑记录（重要，改动前必读）

**1. 东财实时接口参数**
- 参数是 `secid`（单数），不是 `secids`（复数）。复数形式返回 `rc:102, data:null`
- 必须加 `fltt=2`，否则返回值以「分」为单位。加了之后就是「元」，不用再除以 100

**2. Yahoo Finance 在国内基本不可用**
- 不是 4xx/5xx 报错，而是 TCP 直接挂起。`fetch` 默认无超时，会一直卡住
- 所以 Yahoo 只做兜底源，且所有 Yahoo 请求必须带 `AbortController` 6 秒超时

**3. 腾讯接口：实时行情和K线的代码格式正好相反**
- 实时行情：`https://qt.gtimg.cn/q=usAAPL` —— **不能带后缀**，带 `.OQ` 返回空
- K线：`param=usAAPL.OQ,day,<起>,<止>,N` —— **必须带后缀，且必须传起止日期**
- 只传数量不传日期会报 `param error`

**4. 腾讯 K线周期限制**
- 只支持 `day` / `week`
- 实测 `60` / `5` / `min_5` / `m60` 全部返回 `bad params` 或 `param error`
- 美股的 `60`/`5` 虽不报错，但无论日期区间多宽都只返回当天 1 根，无法画图
- 专用的 `minkline` 接口已下线（返回 `undefined method`）
- **因此分钟周期显式抛错，让主备切换降级到 Yahoo**——返回错周期数据比报错更糟

**5. A股和美股的腾讯字段位置不一致**
- A股：PE 在 `p[52]`，市净率在 `p[46]`
- 美股：`p[46]` 是英文全名，PE 在 `p[39]`，没有 PB，`p[48]`/`p[49]` 是 52 周高低

**6. 单位换算**
- 腾讯 A股成交额单位是「万元」，成交量是「手」（1手=100股）
- 美股成交额是美元，成交量是股
- 代码里已统一换算为「元」和「股」

**7. JSON 序列化会丢弃数组上的自定义属性**
- `rows.source = 'eastmoney'` 后，`JSON.stringify(rows)` 不会输出 source（数组只序列化数值索引）
- 所以 K线的 source 必须由路由层显式取出写进响应体，行情接口不受影响（source 挂在普通对象上）

## 项目结构

```
stock-dashboard/
├── workers/                      # Cloudflare Workers（后端 API）
│   ├── src/
│   │   ├── index.js              # 路由 + 缓存 + 主备切换 + 超时控制
│   │   └── data-sources/
│   │       ├── eastmoney.js      # 东方财富（A股主）
│   │       ├── sina.js           # 新浪（A股备）
│   │       └── tencent.js        # 腾讯（美股主 / A股兜底）
│   ├── wrangler.toml
│   └── package.json              # 含 "type": "module"，配合 wrangler 的 ESMODULES
├── frontend/                     # Cloudflare Pages（前端页面）
│   ├── index.html
│   └── app.js
├── test/                         # 本地端到端测试（Node 18+，会真实请求外部接口）
│   ├── e2e.test.mjs              # 缓存 / TTL / stale 降级 / 主备源 / 边界报错
│   └── degradation.test.mjs      # 模拟主源挂掉，验证降级链与跨源数据一致性
└── README.md
```

## 快速开始

### 1. 部署 Workers（后端 API）

```bash
cd workers
npm install
npx wrangler login        # 首次需要登录
npm run dev               # 本地测试
npm run deploy            # 部署到 Cloudflare
```

本地测试地址 `http://localhost:8787`：

```bash
curl "http://localhost:8787/api/quote?code=sh600519"
curl "http://localhost:8787/api/quote?code=AAPL"
curl "http://localhost:8787/api/kline?code=sh600519&period=day&count=30"
curl "http://localhost:8787/api/health"
```

部署后得到形如 `https://stock-dashboard-api.YOUR-ACCOUNT.workers.dev` 的地址。

### 2. 部署 Pages（前端页面）

**方法 A：Dashboard 直接上传**
1. https://dash.cloudflare.com/ → Workers & Pages
2. Create → Pages → Upload assets
3. 选 `frontend` 文件夹 → Deploy

**方法 B：Git 自动部署**
1. Pages → Connect to Git → 选本仓库
2. Root directory 填 `frontend`
3. Build command 留空（纯静态）

### 3. 绑定 Workers 到 Pages（必须做！）

前端用 `location.origin` 作为 API 地址，需要把 Workers 绑定到 Pages 域名：

1. 打开 Pages 项目设置
2. 找到 Functions / Worker routes
3. 添加路由：Pattern = `/api/*`，Worker = `stock-dashboard-api`

不做这步前端会 404。

### 4. 使用

打开 Pages 分配的域名（如 `xxx.pages.dev`），输入代码：
- A股：`sh600519`（沪）/ `sz000001`（深）/ `sz300750`（创业板）
- 美股：`AAPL` / `TSLA` / `NVDA`

## API 文档

### GET /api/quote

| 参数 | 必填 | 说明 |
|------|------|------|
| code | ✅ | `sh600519` / `sz000001`（A股）或 `AAPL`（美股，不带后缀） |

响应：

```json
{
  "success": true,
  "data": {
    "code": "sh600519",
    "name": "贵州茅台",
    "price": 1253.8,
    "change": 1.23,
    "changePercent": 0.1,
    "high": 1265.88,
    "low": 1248.1,
    "open": 1252.15,
    "prevClose": 1252.57,
    "volume": 2457300,
    "turnover": 3088526148,
    "marketCap": 1567352311333.8,
    "floatMarketCap": 1567352311333.8,
    "pe": 17.6,
    "pb": 6.24,
    "high52": null,
    "low52": null,
    "source": "eastmoney"
  },
  "fromCache": false,
  "stale": false
}
```

字段说明：
- `volume` / `turnover` / `marketCap` 已统一换算为「股」「元」
- `pb` 美股为 `null`（腾讯美股接口无市净率）
- `high52` / `low52` 仅美股有值
- `source` 标记实际命中的数据源：`eastmoney` / `sina` / `tencent` / `yahoo`
- `stale=true` 表示主备全挂，返回的是过期缓存（仍可用，但可能不是最新价）

### GET /api/kline

| 参数 | 必填 | 说明 |
|------|------|------|
| code | ✅ | 同 `/api/quote` |
| period | ❌ | `day`（默认）/ `week`。5 分钟目前依赖 Yahoo，国内可能不可用 |
| count | ❌ | 返回K线数量，默认 100 |

响应：

```json
{
  "success": true,
  "data": [
    { "time": "2026-09-22", "open": 1252.15, "close": 1253.8, "high": 1265.88, "low": 1248.1, "volume": 24573 }
  ],
  "source": "eastmoney",
  "fromCache": false
}
```

### GET /api/health

健康检查，返回缓存条目数和时间戳。

## 开发调试

本地端到端测试（需 Node 18+，代码用 ESM；会真实请求外部接口）：

```bash
# 核心机制：缓存、TTL、stale 降级、主备源、边界报错
node test/e2e.test.mjs

# 降级链专项：模拟主源挂掉，验证自动切换 + 跨源数据一致性
node test/degradation.test.mjs
```

覆盖内容：
- 缓存命中与 3 秒 TTL 过期
- stale 降级（模拟外部全部超时，返回过期缓存）
- 主备降级链（mock 主源挂掉，验证切到备源/兜底源）
- 三个源全挂时必须报错，不能返回脏数据
- 跨源成交量单位一致性（quote 与 kline 应量级一致）
- 分钟K线显式抛错、无效代码报错、错误处理分支

## 费用

| 服务 | 费用 | 说明 |
|------|------|------|
| Cloudflare Workers | 免费 | 10 万请求/天 |
| Cloudflare Pages | 免费 | 静态托管 |
| 域名 | 免费 | 用自带的 `.pages.dev` |
| **合计** | **0 元** | 换域名一年几十块 |

## 限制说明

- 免费公开接口，不保证完全实时，也不保证长期可用
- 交易时间外数据不更新
- 5 分钟K线依赖 Yahoo，国内网络下大概率不可用（6 秒超时快速失败）
- 缓存 3 秒，主备全挂时返回过期数据并标记 `stale`
- 不做投资建议，仅展示公开行情数据
