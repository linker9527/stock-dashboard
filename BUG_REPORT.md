# 📈 股票看板 Bug 检查报告

- **检查范围**：`股票/` 项目（Cloudflare Workers 后端 + Pages 前端 + 本地 server.js + 测试）
- **检查方式**：通读全部源码 + 运行现有测试（`e2e.test.mjs`，真实联网）+ 编写临时探针实测（全程 mock / 真实抓包，不污染项目）
- **结论**：共发现 **13 个问题**，其中 **3 个严重**、**3 个中等**、**7 个轻微**。现有测试全部通过，但测试覆盖未触及这些缺陷。

---

## 严重（建议优先修复）

### 🔴 BUG-1　前端「5 秒自动刷新」在增删股票后永久失效
- **位置**：`frontend/app.js`
  - `render()` 第 260–261 行清空 `refreshTimers` 并重置为空数组
  - 全局轮询定时器只在第 470 行注册**一次**，之后从不重建
  - `addStock()`（102 行）、`removeStock()`（127 行）都会再次调用 `render()`
- **实证**：探针执行后，初始化时有 1 个 5 秒定时器；调用 `removeStock()` 后存活数变成 **0**。
- **影响**：用户只要添加或删除任意一只股票，自动刷新就**静默停摆**，页面不再更新行情。这是核心卖点功能。
- **修复**：把「全局轮询定时器」与「每卡片定时器」分开管理；`render()` 只清理卡片级定时器，全局轮询在初始化时注册一次、不要纳入 `refreshTimers` 一起清空。

### 🔴 BUG-2　A股备用源（新浪/腾讯）返回的股票名称是乱码
- **位置**：`workers/src/data-sources/sina.js:18`、`tencent.js:31`（`raw()` 里的 `r.text()`）
- **根因**：新浪返回 `charset=GB18030`、腾讯返回 `charset=GBK`，而 `Response.text()` 按规范**强制 UTF-8 解码**，中文名变成 `U+FFFD` 乱码。主源东方财富是 UTF-8 JSON，正常。
- **实证**（真实抓包解码）：
  - 贵州茅台：新浪 `����ę́`、腾讯 `����ę́`（正确应为 `贵州茅台`）
  - 现有 `e2e.test.mjs` 第 4 步输出也是 `����ę́`，同样印证
- **影响**：东方财富主源挂掉、降级到新浪/腾讯时，页面股票名显示乱码。
- **备注**：`README.md` 踩坑记录 #6 提到了 GBK，但结论是错的——它写「A股用中文名称」，实际中文名就是乱码，等于没解决。
- **修复注意**：不能直接 `new TextDecoder('gbk')` 救——本地 Node 支持 GBK（能过），但 **Cloudflare Workers 的 TextDecoder 仅支持 UTF-8**（[官方文档](https://developers.cloudflare.com/workers/runtime-apis/encoding/)），部署后会失效。可行方案：
  1. 内置一个轻量 GBK→Unicode 映射表做纯 JS 解码；或
  2. A股兜底时名称字段降级显示代码（`name = code`），放弃中文名；或
  3. 名称统一改走 UTF-8 的接口（如东方财富搜索接口）补齐。

### 🔴 BUG-3　点击搜索下拉第 N 项，实际添加的是第 1 项
- **位置**：`frontend/app.js`
  - `pickSuggest(i)`（192–198 行）只改 `input.value`，**没有同步 `activeIndex = i`**
  - `addStock()`（69–71 行）用 `searchResults[Math.max(activeIndex, 0)]`，而 `activeIndex` 初始为 `-1`，`Math.max(-1,0)=0`
- **实证**：探针模拟下拉有 `[茅台, 五粮液, 中国平安]`，点击第 3 项「中国平安」，实际加入的是 `sh600519`（茅台）。
- **影响**：鼠标点击下拉选股功能基本不可用（只有先用键盘上下键选中过，才会正确）。
- **修复**：`pickSuggest(i)` 内先 `activeIndex = i`，或 `addStock` 改为接收明确的 code 参数。

---

## 中等

### 🟠 BUG-4　除 Yahoo/search 外，所有外部请求都没有超时
- **位置**：`eastmoney.js:21`、`sina.js:7`、`tencent.js:29` 全是裸 `fetch`，无 `AbortController`。只有 `fetchWithTimeout`（Yahoo、/api/search）带了超时。
- **矛盾**：`README.md` 明确写「全部接口带超时」——与实际不符。
- **实证**：探针记录请求信号，东财/新浪/腾讯 `signal=NO`，仅 Yahoo `signal=YES`。
- **影响**：Yahoo 那种「TCP 直接挂起」的故障如果发生在主源（东财/腾讯），降级链**根本不会触发**，请求一直卡住，拖垮 Worker。
- **修复**：把 `fetchWithTimeout` 统一应用到所有数据源 fetch。

### 🟠 BUG-5　港股功能整体失效（界面承诺但后端不支持）
- **位置**：`workers/src/index.js:346`（只认 `/^(sh|sz)/`，其余全当美股）
- **表现**：
  - `frontend/index.html:222` 提示词明确写「港股：腾讯 / 00700」
  - `/api/search` 会正常返回 `hk00700`（`index.js:307` prefixMap `'116':'hk'`）
  - 但 `/api/quote?code=hk00700` 被当成美股 → 拼成 `usHK00700` → 必然失败
- **实证**：探针 #1/#6 均复现 `usHK00700`、最终 500。
- **影响**：搜索到的港股、手输的港股代码都无法显示行情，与文档/提示矛盾。
- **修复**：要么补港股数据源与路由分支，要么在搜索/提示中**移除港股宣称**，避免误导。

### 🟠 BUG-6　server.js 静态文件分支无异常保护，访问目录路径可致崩溃
- **位置**：`server.js:44-55`，`readFileSync(filePath)` 对目录会抛 `EISDIR`，处于 async handler 内未捕获 → `unhandledRejection`。
- **影响**：Node 15+ 默认对 unhandledRejection 视为致命错误，`node server.js` 本地服务可被一个恶意/异常路径请求搞挂。
- **修复**：静态文件分支加 `try/catch`；或先 `statSync` 判目录、对目录返回 404/403。

---

## 轻微

### 🟡 BUG-7　`code`/`count` 参数无校验（注入与滥用）
- `/api/quote`、`/api/kline` 的 `code` 直接拼进上游 URL。
- **实证**：`code=sh600519&fltt=9&fields=f1` 成功注入上游 query（探针 #5）。
- `count` 可为负数/超大值：`count=-5 → lmt=-5`、`count=99999999` 直接透传（探针 #3）。
- **修复**：`code` 用白名单正则校验（`^(sh|sz)\d{6}$`、`^[A-Z]{1,5}$`）；`count` 限制 `1–1000` 且取整。

### 🟡 BUG-8　Yahoo 兜底 high/low 空数组保护缺失
- `index.js:195-196`：`Math.max(...[])` → `-Infinity`，被 `JSON.stringify` 序列化为 `null`。
- **实证**：构造 high/low 全为 null 的 Yahoo 响应，返回 `high=null low=null`。
- **影响**：异常/停牌数据下字段为 null，前端显示 `-`，无崩溃，但属于未处理边界。

### 🟡 BUG-9　前端每 5 秒重拉 K 线并重绘 canvas
- `loadCard()`（346 行）每次都调 `loadChart()`，后者每次都请求 `/api/kline`（与 quote 的缓存 key 分开）并重建 canvas。
- **影响**：浪费免费额度（10 万请求/天），高频重绘。
- **修复**：K 线单独用更长间隔（如 60s）刷新，或仅在卡片首次渲染/价格变动时更新。

### 🟡 BUG-10　测试用例自身的两个问题
- `test/e2e.test.mjs:65` 把**有效代码** `sh600000`（浦发银行）当成「无效代码」期望抛错——断言前提错误。
- 测试输出依赖控制台编码，中文名乱码影响断言可读性（与 BUG-2 同源）。

### 🟡 BUG-11　拼音搜索被 `looksLikeCode` 拦截
- `frontend/app.js:47`：`/^[A-Za-z][A-Za-z.\-]{0,5}$/` 把 ≤6 位纯字母（如 `gzmt`、`maotai`）当作美股代码，不触发搜索。
- **影响**：与「支持拼音搜索」的说明冲突，短拼音搜不到。
- **修复**：区分「纯英文 ticker」与「拼音」需要额外启发（例如命中本地代码表再当 ticker）。

### 🟡 BUG-12　wrangler.toml 配置项存疑（建议确认）
- `module_format = "ESMODULES"` 不是 wrangler v3 的合法顶层键（ESM 由 `export default` 自动探测），会被警告或忽略。
- `compatibility_date = "2024-01-01"` 早于 `nodejs_compat` v2 要求的 `2024-09-23`，可能拿不到完整 Node 兼容行为。
- **建议**：删除 `module_format`；如依赖 nodejs_compat，把 compatibility_date 提到 `2024-09-23` 之后并实测。

### 🟡 BUG-13　注释互相矛盾（文档问题）
- `eastmoney.js:80` 注释：东财 K线 f56 单位是「手」（×100，正确）
- `tencent.js:146` 注释：东财K线 f56 单位是「股」(factor=1)（**错误**）
- 两处对同一字段说法相反，易误导后人改动。实际以东财「手」为准。

---

## 修复优先级建议

| 优先级 | Bug | 原因 |
|---|---|---|
| P0 | BUG-1、BUG-2、BUG-3 | 用户直接可见，功能失效/乱码/点选错误 |
| P1 | BUG-4、BUG-5 | 韧性设计失效 / 文档承诺功能不可用 |
| P2 | BUG-6 | 本地服务稳定性 |
| P3 | 其余 | 健壮性、性能、文档与测试质量 |

> 需要的话，我可以按这个优先级直接动手修（BUG-1/2/3 都是小改动），或者先出针对某一项的修复补丁。
