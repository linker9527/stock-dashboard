# 📈 Stock Dashboard

个人股票看板，支持 A股 + 美股，Cloudflare Workers + Pages 部署。

## 功能

- ✅ A股 + 美股实时行情
- ✅ 主备数据源自动切换
  - A股主：东方财富
  - A股备：新浪财经
  - 美股：Yahoo Finance
- ✅ K线图表（最近30天）
- ✅ 5秒自动刷新
- ✅ 自选股本地存储
- ✅ 缓存层防止限流（3秒TTL）
- ✅ 降级策略：全部失败时返回旧数据

## 项目结构

```
stock-dashboard/
├── workers/                 # Cloudflare Workers (后端 API)
│   ├── src/
│   │   ├── index.js         # 主路由
│   │   └── data-sources/
│   │       ├── eastmoney.js # 东财（A股主）
│   │       ├── sina.js      # 新浪（A股备）
│   │       └── yahoo.js     # Yahoo（美股，内联在 index.js）
│   ├── wrangler.toml
│   └── package.json
├── frontend/                # 前端页面 (Cloudflare Pages)
│   ├── index.html
│   └── app.js
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

部署后会得到一个 URL，形如：
```
https://stock-dashboard-api.YOUR-ACCOUNT.workers.dev
```

**测试 API：**
```bash
curl "https://stock-dashboard-api.YOUR-ACCOUNT.workers.dev/api/quote?code=sh600519"
curl "https://stock-dashboard-api.YOUR-ACCOUNT.workers.dev/api/kline?code=sh600519&period=day&count=30"
```

### 2. 部署 Pages（前端页面）

**方法A：Cloudflare Dashboard 直接部署**
1. 打开 https://dash.cloudflare.com/ → Workers & Pages
2. Create → Pages → Upload assets
3. 选择 `frontend` 文件夹
4. 点 Deploy

**方法B：Git 集成自动部署**
1. Pages → Connect to Git → 选这个仓库
2. Root directory 填 `frontend`
3. Build command 留空（纯静态）

### 3. 绑定 Workers 到 Pages（关键步骤！）

前端页面默认用 `location.origin` 作为 API 地址，所以需要把 Workers 绑定到 Pages：

1. 打开 Pages 项目设置
2. 找到 **Functions** 或 **Workers routes** 部分
3. 添加路由：
   - Pattern: `/api/*`
   - Worker: `stock-dashboard-api`

或者在 Pages 的 `wrangler.toml` 里配置：
```toml
[workers]
routes = [{ pattern = "/api/*", worker = "stock-dashboard-api" }]
```

### 4. 使用

打开 Pages 分配的域名（如 `stock-dashboard.pages.dev`），输入股票代码开始追踪。

## API 文档

### GET /api/quote
获取实时行情

**参数：**
- `code` (必填)：股票代码
  - A股：`sh600519`（沪）/ `sz000001`（深）
  - 美股：`AAPL` / `TSLA`

**响应：**
```json
{
  "success": true,
  "data": {
    "code": "sh600519",
    "name": "贵州茅台",
    "price": 1680.00,
    "change": 5.00,
    "changePercent": 0.30,
    "high": 1690.00,
    "low": 1670.00,
    "open": 1675.00,
    "prevClose": 1675.00,
    "volume": 12345678,
    "turnover": 1234567890000,
    "marketCap": 211870000000000,
    "pe": 28.5,
    "pb": 8.2,
    "source": "eastmoney"
  },
  "fromCache": false,
  "stale": false
}
```

### GET /api/kline
获取K线数据

**参数：**
- `code`：股票代码
- `period`：`day` (日) / `week` (周) / `min5` (5分钟)
- `count`：返回K线数量，默认100

### GET /api/health
健康检查

## 数据源说明

| 市场 | 主源 | 备用 | 延迟 | 备注 |
|------|------|------|------|------|
| A股 | 东方财富 | 新浪 | 1-3秒 | 东财数据更全 |
| 美股 | Yahoo | - | 5-15秒 | Yahoo偶尔限流 |

## 限制说明

- 免费接口，不保证完全实时
- 交易时间外数据不更新
- Yahoo Finance 有请求频率限制
- 缓存3秒，频繁刷新不会重复请求

## 常见错误排查

**报错 "Both sources failed"：**
- 数据源接口临时挂了，等几分钟重试
- 检查 API URL 是否正确

**数据 stale: true：**
- 主备源都失败，返回了缓存的旧数据
- 等数据源恢复

**CORS 错误：**
- 确认 Workers 已正确部署
- 检查 Pages 是否绑定了 Workers

## 费用

- Cloudflare Workers: 免费（10万请求/天）
- Cloudflare Pages: 免费
- 域名：可选，免费用 `.pages.dev`

## 更新日志

- v1.0.0 初始版本
