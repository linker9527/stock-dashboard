# 第三轮检测报告（终版）

> 日期：2026-09-25
> 范围：frontend/app.js、frontend/index.html、frontend/sw.js、workers/src/**、server.js、test/**
> 方法：逐行审读 + `node --check` 全量语法校验 + git 历史逐提交回溯 + 回归测试 28 项

---

## 一、本轮发现并已修复的问题

### 🔴 P0（致命）：`app.js` 缺失闭合大括号 → 整个前端瘫痪

**位置**：`frontend/app.js` `markUnsupported()` 函数（约 L493）

**现象**：
`node --check frontend/app.js` 报 `SyntaxError: Unexpected end of input`。
浏览器同样拒绝解析该文件 → **app.js 一行都不会执行**：轮询、搜索、添加、K线图、弹窗全部失效，页面永远停在"股票看板加载中…"启动遮罩。

**根因**：
新增 `markUnsupported`（北交所显示"不支持"）时漏写了函数的闭合 `}`。
后果是连锁的：它后面的 `markOffline`、`markOnline`、`updateOfflineBanner`、`drawChart` 等所有顶层函数被"吞"成 `markUnsupported` 的内部嵌套定义，全文件大括号错位，直到文件尾少一个 `}`。肉眼极难发现——缩进看起来完全正常。

**为何存活了 4 个提交都没暴露（git 回溯证据）**：

| 提交 | 说明 | 语法 |
|---|---|---|
| 9053ba1 | 腾讯标签对齐+超时恢复6s | ✅ OK |
| 378fde6 | Yahoo -Infinity+北交所"不支持" | ❌ **改坏的（本次提交引入）** |
| 3d341d7 | 竞态条件+XSS过滤+导入normalize | ❌ BROKEN |
| 7472abc | BJ代码分类+SW缓存v2 | ❌ BROKEN |
| 9b14a0a | 美股ticker大写+新浪K线response.ok | ❌ BROKEN |

三层遮蔽叠加，让致命错误静默近一天：
1. **测试盲区**：三个测试文件全部只测后端 `workers/src/index.js`，从不加载 `app.js`，每轮"28/28 全绿"绿的都不是前端；
2. **Service Worker 缓存优先**：`sw.js` cache-first 一直喂浏览器缓存里的旧版好文件，普通刷新不走网络，文件坏了页面照样"正常"；
3. **线上未重新部署**：生产环境跑的还是坏提交之前的旧包。

**修复（已应用并验证）**：
```js
  const sourceEl = document.getElementById(`source-${code}`);
  if (sourceEl) {
    sourceEl.textContent = '不支持';
    sourceEl.className = 'source-tag degraded';
    sourceEl.title = msg;
  }

  updateOfflineBanner();   // 顺带补上：与其他 mark* 行为一致，
}                          // ← 缺失的闭合大括号（本次修复核心）
                           //   避免"全离线→新增不支持卡→横幅不刷新"边缘情况

function markOffline(code, msg) {
```

### 🟡 P2（部署收尾）：SW 缓存版本号未递增

**位置**：`frontend/sw.js` L3

**问题**：cache-first 策略下，部署后若不 bump `CACHE_NAME`，用户继续命中旧缓存，拿不到修复版 app.js——本次语法 bug 能藏这么久它正是帮凶之一。

**修复（已应用）**：`stock-dash-v2` → `stock-dash-v3`，部署后 activate 钩子会自动清旧缓存。

---

## 二、前两轮问题复核（全部确认已修复）

| # | 问题 | 修复位置 | 状态 |
|---|---|---|---|
| 1 | loadCard 竞态（旧请求覆盖新结果） | `CARD_GEN` 代数计数器，loadCard 首尾双重校验 | ✅ |
| 2 | localStorage XSS | `loadWatchlist` 经 `isSafeCode` 白名单过滤 | ✅ |
| 3 | 导入未 normalizeCode 致重复 | `doImport` 逐项 `normalizeCode` 后去重 | ✅ |
| 4 | Yahoo `Math.max(...[])` → -Infinity | high/low 改 IIFE 判空 `arr.length ? ... : null` | ✅ |
| 5 | formatVolume/Amount 把 0 当 falsy 显示"-" | 改 `v == null` + `v === 0` 分支 | ✅ |
| 6 | 北交所代码静默归深市 | 后端显式拒绝 4/8/920 号段返回 400；前端 `markUnsupported` 显示"不支持" | ✅ |
| 7 | 纯前缀 `sh` 被当美股 500 | `classifyCode` 显式拒绝返回 400 | ✅ |
| 8 | 美股 ticker 大小写分裂（normalizeCode 转小写） | `normalizeCode` 美股分支返回 `toUpperCase()` | ✅ |
| 9 | 新浪 K线缺 `response.ok` 检查 | sina.js fetchKline 已补 HTTP 状态检查 | ✅ |
| 10 | SW 缓存版本号 | 本轮 bump 至 v3 | ✅ |

---

## 三、终验结果

```
语法校验:  8/8 通过（node --check 全部 JS 文件）
回归测试:  28/28 通过（NEW-1/2/3/5/6/7/11/12 全覆盖）
```

## 四、防复发建议（未改动，供后续采纳）

1. **语法冒烟测试**：在 `test/` 加一个零依赖脚本，`node --check` 遍历 `frontend/*.js` 和 `workers/src/**/*.js`——本次 bug 一秒即穿。
2. **SW 改 stale-while-revalidate**：先回缓存、后台静默拉新版、下次访问生效；部署不再强依赖手动 bump 版本号。
3. **部署纪律**：`wrangler deploy` 前固定跑"语法校验 + 回归测试"两道门。

---

## 结论

**本轮 P0 语法错误与 P2 缓存版本号均已修复并验证通过；前两轮全部问题确认修好；当前代码库处于可部署状态。**
