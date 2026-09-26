# 股票看板 — 部署与网络问题记录

## 当前部署状态（已完成）

- **Worker**: `stock-dashboard-api` — 前端静态文件 + API 一体化
- **Workers.dev**: `https://stock-dashboard-api.qfqfg-w.workers.dev`
- **自定义域名**: `gu-piao.ccwu.cc`
- **版本**: `73831550-9391-4b52-8521-4fd9b0e25bb3`（腾讯主源版）
- **账号**: `qfqfg_w@qq.com`（account `576e9ee91a145407f8a12594397aecc5`）
- **GitHub**: `https://github.com/linker9527/stock-dashboard`，最新 commit `1d7dc7b`

## 数据源降级链（最终版）

| 市场 | 类型 | 主源 | 备源1 | 备源2 |
|------|------|------|-------|-------|
| A股 | 行情 + 日/周K | 腾讯 | 新浪 | 东财 |
| A股 | 分钟K（5/60分） | 东财 | Yahoo（.SS/.SZ 后缀） | — |
| 港股 | 行情 + 日/周K | 腾讯 | 东财 | — |
| 港股 | 分钟K（5/60分） | 东财 | Yahoo（.HK 后缀） | — |
| 美股 | 行情 + 日/周K | 腾讯 | Yahoo | — |
| 美股 | 分钟K（5/60分） | Yahoo | — | — |

> 2026-09-26 起K线链路按周期区分（见 index.js 的 klineSourceChain）：腾讯分钟K实测只回
> 当天 1 根等价不支持、新浪K线接口已失效，所以分钟周期不再经过它们空耗超时；
> 分钟K缓存 TTL 单独为 60 秒（日/周K仍是 5 分钟）。前端对分钟线从东财/Yahoo 取数
> 不再标记「·备源」——那是该周期唯一稳定来源，不是降级。

原因：Cloudflare 出口 IP 被 `push2.eastmoney.com` 拦截（RST），东财降级为备源。

## 已修复的 Bug（13 个，commit cf8a18f / 5ee9b44 / 4c54dbd）

BUG-1 增删后停刷新、BUG-2 GBK乱码、BUG-3 点选错项、BUG-4 无超时、
BUG-5 港股失效、BUG-6 server.js崩溃、BUG-7~13 code/count校验/空数组/K线间隔/测试/拼音/wrangler配置/注释矛盾

## 网络访问问题（待解决）

### 现象
- PC Edge → `https://gu-piao.ccwu.cc` ✅ 正常
- PC curl / Invoke-WebRequest → ❌ (35) Connection reset
- iPad / 手机 → ❌ 连接被重置

### 诊断结论
**TLS 指纹过滤**，不是 SNI 阻断。

证据链：
1. 同 PC 同 WiFi，Edge（BoringSSL）正常，curl/.NET（Schannel）被 RST
2. TCP 443 到 CF 边缘 IP（172.67.217.32）通
3. 强制 TLS1.2 / 1.3 / http1.1 全部被重置
4. 同 IP 换 SNI=www.cloudflare.com → 200 OK

中间盒在按 TLS ClientHello 指纹区别对待：放行 Chrome/BoringSSL，重置 Schannel。

### 待验证方案
1. **iPad 开 Cloudflare WARP** → 定性是路径问题还是 TLS 指纹问题
2. **手机换 4G/5G 流量** → 区分 WiFi vs 运营商
3. **手机 Edge 关闭 DoH** → 排除 DNS over HTTPS 干扰
4. **换子域名**（如 `g.ccwu.cc`）→ 排除精确域名匹配阻断
5. **开 ECH** → 加密 SNI（需 Chrome 130+ / Safari 18+）

### 不需要动的
- localhost:8787 — 旧的本地开发路径，与公网无关
- cloudflared 隧道 — 当前用 CF Worker 自定义域名，不走隧道
- 13 个代码 bug — 已全部修复
