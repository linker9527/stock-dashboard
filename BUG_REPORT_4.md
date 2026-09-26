# 第四轮检测报告（终检）

> 日期：2026-09-26
> 范围：frontend/app.js、frontend/index.html、frontend/sw.js、workers/src/**、server.js、test/**
> 方法：逐行审读 + `node --check` 全量语法校验 + 三套测试全跑 + 本地起服真实浏览器冒烟（渲染/搜索/添加/删除/弹窗/非法输入）

---

## 一、本轮发现并已修复的问题

### 🟠 P1：`ASSETS` 兜底分支在非 Cloudflare 环境直接崩（测试/本地/线上 404 路径）

**位置**：`workers/src/index.js` 末尾兜底分支 + `workers/wrangler.toml` `[assets]`

**现象**：
- e2e 测试第 9 节打到 `/api/unknown` 时 `FATAL ReferenceError: ASSETS is not defined`，测试套件中断；
- `server.js` 本地服务下，任何未匹配 API 路径返回 500（ReferenceError）而不是 404；
- 生产侧 `wrangler.toml` 的 `[assets]` **没有声明 `binding`**：静态资源本身能被自动服务（`/`、`/app.js` 正常），
  但 Worker 里的 `ASSETS` 是 undefined，访问 `/favicon.ico` 等未匹配路径会变成 Cloudflare 1101 错误页。

**修复（已应用并验证）**：
1. `wrangler.toml` 补 `binding = "ASSETS"`（官方配置项，Worker 侧才能 fetch 资产、404 走资产层）；
2. `index.js` 兜底分支加 `typeof ASSETS` 守卫，无绑定时返回干净的 404 JSON。

验证：e2e 第 9 节现在输出 `/api/unknown -> 404 "Not found"`，全套件 exit 0。

### 🟡 P2：搜索添加路径绕过了代码白名单（XSS 防线缺口，NEW-14）

**位置**：`frontend/app.js` `addStock()` / `renderSuggest()` + `workers/src/index.js` `/api/search`

**问题**：NEW-10 修复了「导入/localStorage」路径的注入，但**搜索添加**路径漏了：
- 搜索结果 `code` 来自东财 suggest 接口原样透传，`addStock` 直接 `watchlist.push(code)`；
- `render()` 的卡片模板 `id="card-${code}"`、`data-code="${code}"` 不转义——恶意/异常的
  上游 Code 会形成 HTML 注入并随 `saveWatchlist` 持久化；
- `renderSuggest` 模板里 `rawCode`、`market` 也是裸奔（`name` 有 `esc()`，其余没有）。

**修复（三道防线，已应用）**：
1. 后端 `/api/search` 增加与前端 `isSafeCode` 对齐的白名单正则，不合格 code 直接丢弃该候选；
2. 前端 `addStock` 在 push 前过 `isSafeCode`，不合格 flash 提示；
3. `renderSuggest` 模板对 `rawCode`/`market` 补 `esc()`。

### 🟡 P2：e2e 测试 6d 断言写死 1000，与上游上限不符

**现象**：`count=99999999 -> rows=640` 标 ❌。限幅逻辑本身正确（lmt 已收敛到 1000），
但腾讯日K上游自身最多回约 640 根，断言不应写死 1000。

**修复**：改为「`0 < rows <= 1000`」区间断言，注释说明上游上限。

### 🟢 P3：降级测试第 4 节 mock 陈旧，新浪兜底从未被真正测到

**问题**：A股主源已从东财换成腾讯，但测试 mock 只掐 `push2`（东财），腾讯主源直接命中，
`✅ 正确降级到新浪` 的断言实际一直落空为 ⚠️。

**修复**：mock 同时掐 `qt.gtimg.cn` + `push2`，现在真实走到新浪兜底并 ✅。

### 🟢 P3：`saveWatchlist` 无异常保护

**问题**：隐身模式/存储配额满时 `localStorage.setItem` 抛异常，`addStock`/`removeStock`
在 push 之后中断、render 不执行，表现为"点了没反应"且无任何提示。

**修复**：try/catch 包裹（内存态仍可用，仅刷新后不保留）。

### 🔧 部署收尾：SW 缓存 v3 → v4

前端 app.js/sw.js 有改动，按项目部署纪律递增 `CACHE_NAME`，部署后 activate 自动清旧缓存。

---

## 二、未提交改动复核（本轮前已存在的 1 处）

| 改动 | 结论 |
|---|---|
| `fetchYahooQuote` URL 补 `?range=1d&interval=1d` | ✅ 正确。与已在用的 `fetchYahooKline` 参数模式一致；Yahoo chart 接口不带 range/interval 时部分场景直接报错。本机网络到 Yahoo 不通（与 DEPLOYMENT_NOTES 记录一致）无法实测，`wrangler deploy` 后可用 `wrangler tail` 观察一次美股降级路径确认。 |

## 三、终验结果（全部重新跑过）

```
语法校验:   8/8 通过（node --check 全部 JS 文件）
e2e:        全绿（无 ❌、无 FATAL，exit 0；含 /api/unknown -> 404）
回归测试:   28/28 通过
降级链:     全部 ✅（含修正后的"腾讯/东财挂 → 新浪兜底"真实降级）
```

## 四、真实浏览器冒烟（localhost:8787，逐项人工核验）

| 测试点 | 结果 | 证据 |
|---|---|---|
| 首页渲染：默认两卡真实行情 + canvas K线 + 降级角标 | ✅ | t1_home_viewport.png |
| 搜索"腾讯"→ 下拉候选带港股标签 | ✅ | t2_search_dropdown.png |
| 点选候选 → hk00700 卡片（PB 正确显示"-"） | ✅ | t3_hk_card.png |
| 非法输入 "AAPL;rm" → 红色 flash，未添加 | ✅ | t4_invalid_input_flash.png |
| 删除卡片 + 导出密钥弹窗（SDKB.1 格式+自动全选） | ✅ | t5_removed_and_export_modal.png |

截图存于 `gui-test-screenshots/`。控制台日志 IAB 环境不支持只读采集；全程无可见错误表现
（无空白区、无失败占位、无布局破损）。

## 五、遗留的已知无害项（未改动）

1. **300ms 防抖窗口内回车**：搜索候选还在路上时回车，会用到上一轮的候选列表。
   影响仅限极快手速下添加错候选，且候选本身是合法代码，不值得为此引入复杂度。
2. **`/api/search` 无缓存**：每键一次上游请求（已有 300ms 防抖），量级可接受。

## 结论

**第四轮共修复 5 处问题（P1×1、P2×2、P3×2）+ SW 版本收尾；三轮遗留问题全部复核确认已修；
三套测试 + 真实浏览器冒烟全绿。代码库处于可部署状态——`wrangler deploy` 后记得跑一次
`wrangler tail` 验证美股 Yahoo 降级路径。**
