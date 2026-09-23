// 前端逻辑
// 支持本地运行 (localhost) 和生产环境 (Cloudflare Pages)

// 自动检测 API 地址
const API_BASE = (() => {
  // 本地开发模式
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    return 'http://localhost:8787';
  }
  // 生产环境：和前端同域名
  return location.origin;
})();

const STORAGE_KEY = 'stock_watchlist';
const POLL_INTERVAL = 5000; // 5秒刷新一次

let watchlist = [];
let refreshTimers = [];   // 只放「卡片级」定时器，全局轮询不在此列
let globalTimer = null;   // 全局 5 秒轮询，初始化时注册一次，不随 render 重建

// ========== 本地存储 ==========

function loadWatchlist() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    watchlist = saved ? JSON.parse(saved) : ['sh600519', 'sz000001'];
  } catch (e) {
    watchlist = ['sh600519', 'sz000001'];
  }
}

function saveWatchlist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(watchlist));
}

// ========== 股票卡片操作 ==========

let searchResults = [];   // 当前搜索建议
let activeIndex = -1;     // 下拉高亮项（键盘上下键）
let searchTimer = null;   // 输入防抖

// 无歧义代码形式：带市场前缀，或纯 6 位数字（A股）
//
// 注意：纯字母【不在此列】。英文 ticker（AAPL/GOOGL）和拼音（gzmt/maotai）
// 字形完全相同，无法用正则可靠区分。若把纯字母当代码直接添加，
// 输入 "gzmt" 会被当成美股代码发到后端然后 400（BUG-11）。
// 解法：纯字母一律走搜索接口，用下拉候选确认到底是 ticker 还是股票拼音。
// 数字/带前缀形式仍然直连，保留快速路径。
function isDefiniteCode(s) {
  const t = s.trim();
  if (!t) return false;
  return /^(sh|sz|hk)\d{4,6}$/i.test(t) || /^\d{6}$/.test(t);
}

// 输入是否像代码（是则直接加，不搜索）
// 仅作为 addStock 的兜底：当搜索无结果时才用。
// 常规路径下纯字母会先经过搜索，因此这里保持宽松无副作用。
function looksLikeCode(s) {
  return isDefiniteCode(s) || /^[A-Za-z][A-Za-z.\-]{0,4}$/.test(s.trim());
}

// 归一化代码：纯6位数字按首位推断市场（5/6/9 开头是上证，其余是深证）
function normalizeCode(input) {
  let code = input.trim().toLowerCase();
  if (/^(sh|sz|hk)\d{4,6}$/.test(code)) return code;
  if (/^\d{6}$/.test(code)) {
    return (/^(5|6|9)/.test(code) ? 'sh' : 'sz') + code;
  }
  return code;
}

// 市场标签（用于下拉显示）
const MARKET_LABEL = { '1': '沪市', '0': '深市', '105': '纳斯达克', '106': '纽交所', '116': '港股' };

async function addStock() {
  const input = document.getElementById('searchInput');
  const raw = input.value.trim();
  if (!raw) return;

  let code;
  if (searchResults.length > 0) {
    // 下拉有结果：
    //  - 键盘上下键选中过（activeIndex >= 0）-> 用选中的那一项
    //  - 只打了 ticker 直接回车（activeIndex === -1）-> 优先用精确匹配项，
    //    否则退回第一条（"苹果" 这种唯一结果就是正确目标）
    const top = searchResults[Math.max(activeIndex, 0)];
    const typed = raw.toUpperCase();
    const exact = searchResults.find(r => r.code.toUpperCase() === typed);
    code = (exact && activeIndex < 0) ? exact.code : top.code;
  } else if (looksLikeCode(raw)) {
    // 搜索无结果 / 输入被清空过：代码形式直连，名字形式走下面的搜索分支
    code = normalizeCode(raw);
  } else {
    // 中文/拼音 -> 搜索
    try {
      const results = await searchStock(raw);
      if (!results.length) {
        flash('没找到相关股票，试试输代码或拼音');
        return;
      }
      if (results.length > 1) {
        // 多条结果，停在下面让用户选
        renderSuggest(results);
        input.focus();
        return;
      }
      code = results[0].code;
    } catch (e) {
      flash('搜索失败：' + e.message);
      return;
    }
  }

  if (!code) return;

  if (watchlist.includes(code)) {
    flash('已在自选里了');
  } else {
    watchlist.push(code);
    saveWatchlist();
    render();
  }

  input.value = '';
  hideSuggest();
  input.focus();
}

// 轻提示（不弹窗）
function flash(msg) {
  const hint = document.querySelector('.hint');
  const orig = hint.dataset.orig || hint.textContent;
  hint.dataset.orig = orig;
  hint.textContent = '⚠️ ' + msg;
  hint.style.color = '#d94a4a';
  clearTimeout(flash._t);
  flash._t = setTimeout(() => {
    hint.textContent = hint.dataset.orig;
    hint.style.color = '';
  }, 2500);
}

function removeStock(code) {
  watchlist = watchlist.filter(c => c !== code);
  saveWatchlist();
  render();
}

// ========== 数据获取 ==========

async function fetchQuote(code) {
  const url = `${API_BASE}/api/quote?code=${encodeURIComponent(code)}`;
  const res = await fetch(url);
  const json = await res.json();
  
  if (!json.success) {
    throw new Error(json.error || '请求失败');
  }
  
  return json;
}

async function fetchKline(code) {
  const url = `${API_BASE}/api/kline?code=${encodeURIComponent(code)}&period=day&count=60`;
  const res = await fetch(url);
  const json = await res.json();
  
  if (!json.success) {
    throw new Error(json.error || 'K线请求失败');
  }
  
  return json.data;
}

// ========== 搜索 ==========

async function searchStock(keyword) {
  const url = `${API_BASE}/api/search?q=${encodeURIComponent(keyword)}`;
  const res = await fetch(url);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || '搜索失败');
  return json.data || [];
}

function renderSuggest(results) {
  const box = document.getElementById('searchSuggest');
  if (!results.length) {
    hideSuggest();
    return;
  }
  searchResults = results;
  activeIndex = -1;
  box.innerHTML = results.map((r, i) => {
    const mkt = MARKET_LABEL[r.market] || r.market;
    return `<div class="suggest-item" data-i="${i}" onclick="pickSuggest(${i})">
      <span><span class="suggest-name">${esc(r.name)}</span><span class="suggest-code"> ${r.rawCode}</span></span>
      <span class="suggest-market">${mkt}</span>
    </div>`;
  }).join('');
  box.classList.add('show');
}

function hideSuggest() {
  const box = document.getElementById('searchSuggest');
  box.classList.remove('show');
  box.innerHTML = '';
  searchResults = [];
  activeIndex = -1;
}

function pickSuggest(i) {
  const input = document.getElementById('searchInput');
  const item = searchResults[i];
  if (!item) return;
  // 必须同步 activeIndex，否则 addStock 会用 Math.max(activeIndex,0)
  // 取到第 0 项，导致点第 3 项却添加第 1 项
  activeIndex = i;
  input.value = item.name;
  addStock();
}

function moveSuggest(delta) {
  if (!searchResults.length) return;
  activeIndex = (activeIndex + delta + searchResults.length) % searchResults.length;
  const items = document.querySelectorAll('.suggest-item');
  items.forEach((el, i) => el.classList.toggle('active', i === activeIndex));
  if (items[activeIndex]) items[activeIndex].scrollIntoView({ block: 'nearest' });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function bindSearch() {
  const input = document.getElementById('searchInput');

  // 输入防抖搜索
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const v = input.value.trim();
    if (!v) { hideSuggest(); return; }
    // 只有「带前缀」和「纯6位数字」是确定代码，直连不搜索。
    // 纯字母不能在这里直接判定为代码——见 isDefiniteCode 注释（BUG-11）。
    if (isDefiniteCode(v)) { hideSuggest(); return; }
    searchTimer = setTimeout(async () => {
      try {
        const results = await searchStock(v);
        renderSuggest(results);
      } catch (e) {
        hideSuggest();
      }
    }, 300);
  });

  // 键盘导航
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addStock();
    } else if (e.key === 'ArrowDown' && searchResults.length) {
      e.preventDefault();
      moveSuggest(1);
    } else if (e.key === 'ArrowUp' && searchResults.length) {
      e.preventDefault();
      moveSuggest(-1);
    } else if (e.key === 'Escape') {
      hideSuggest();
    }
  });

  // 点击外部关闭下拉
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) hideSuggest();
  });
}

// ========== 渲染 ==========

function render() {
  const grid = document.getElementById('grid');
  
  // 清理旧定时器
  refreshTimers.forEach(t => clearInterval(t));
  refreshTimers = [];
  
  if (watchlist.length === 0) {
    grid.innerHTML = '<div class="empty">暂无自选股，输入代码开始追踪</div>';
    return;
  }
  
  grid.innerHTML = watchlist.map(code => `
    <div class="card" id="card-${code}">
      <div class="source-tag" id="source-${code}">加载中</div>
      <div class="card-header">
        <div>
          <span class="card-title" id="name-${code}">--</span>
          <span class="card-code">${code}</span>
        </div>
        <button class="close-btn" onclick="removeStock('${code}')">×</button>
      </div>
      <div class="price-area">
        <div class="price flat" id="price-${code}">--</div>
        <div class="change flat" id="change-${code}">--</div>
      </div>
      <div class="details" id="details-${code}">
        <div class="loading" style="grid-column: span 2; text-align:center;">加载中...</div>
      </div>
      <div class="chart-container" id="chart-${code}"></div>
    </div>
  `).join('');
  
  // 异步加载数据
  // 卡片是刚重建的（innerHTML 已清空），所以这次 loadChart 必须强刷，
  // 否则节流判断会拦住首屏绘图
  watchlist.forEach(code => {
    CHART_CACHE[code] = 0;
    loadCard(code);
  });
}

async function loadCard(code) {
  try {
    const result = await fetchQuote(code);
    const d = result.data;
    
    // 更新标题
    const nameEl = document.getElementById(`name-${code}`);
    if (nameEl) {
      // 兜底顺序：后端补全的中文名 -> 原始代码。
      // 后端已过滤乱码（见 index.js 的 isGarbledName），到这里要么是真名要么是 null
      nameEl.textContent = d.name || code.toUpperCase();
    }
    
    // 更新价格
    const priceEl = document.getElementById(`price-${code}`);
    const changeEl = document.getElementById(`change-${code}`);

    // BUG-8：停牌/新上市/异常数据下后端返回 null，直接 toFixed 会抛错
    // 让整个卡片渲染中断（后续详情、K线都不画）。必须先判空。
    if (priceEl) {
      if (d.price == null) {
        priceEl.textContent = '--';
        priceEl.className = 'price flat';
        priceEl.title = '暂无价格数据（可能停牌）';
      } else {
        priceEl.textContent = d.price.toFixed(2);
        priceEl.className = `price ${d.change > 0 ? 'up' : d.change < 0 ? 'down' : 'flat'}`;
      }
    }

    if (changeEl) {
      const dir = d.change > 0 ? 'up' : d.change < 0 ? 'down' : 'flat';
      changeEl.className = `change ${dir}`;
      changeEl.textContent = (d.change == null || d.changePercent == null)
        ? '--'
        : `${d.change > 0 ? '+' : ''}${d.change.toFixed(2)}  ${d.change > 0 ? '+' : ''}${d.changePercent.toFixed(2)}%`;
    }
    
    // 更新详情
    const detailsEl = document.getElementById(`details-${code}`);
    if (detailsEl) {
      // v() 把 null 转 '-'，但保留 0（0 是合法数据，|| 会误伤）
      const v = (x, digits = 2) => (x == null ? '-' : x.toFixed(digits));
      detailsEl.innerHTML = `
        <div class="detail-item"><span class="detail-label">今开</span><span class="detail-value">${v(d.open)}</span></div>
        <div class="detail-item"><span class="detail-label">昨收</span><span class="detail-value">${v(d.prevClose)}</span></div>
        <div class="detail-item"><span class="detail-label">最高</span><span class="detail-value up">${v(d.high)}</span></div>
        <div class="detail-item"><span class="detail-label">最低</span><span class="detail-value down">${v(d.low)}</span></div>
        <div class="detail-item"><span class="detail-label">成交量</span><span class="detail-value">${formatVolume(d.volume)}</span></div>
        <div class="detail-item"><span class="detail-label">成交额</span><span class="detail-value">${formatAmount(d.turnover)}</span></div>
        ${d.pe != null ? `<div class="detail-item"><span class="detail-label">市盈率</span><span class="detail-value">${d.pe.toFixed(2)}</span></div>` : ''}
        ${d.pb != null ? `<div class="detail-item"><span class="detail-label">市净率</span><span class="detail-value">${d.pb.toFixed(2)}</span></div>` : ''}
        ${d.marketCap != null ? `<div class="detail-item"><span class="detail-label">总市值</span><span class="detail-value">${formatAmount(d.marketCap)}</span></div>` : ''}
      `;
    }
    
    // 更新数据源标签
    const sourceEl = document.getElementById(`source-${code}`);
    if (sourceEl) {
      let label = d.source || 'unknown';
      if (result.stale) label += ' (旧)';
      sourceEl.textContent = label;
    }
    
    // 加载K线（60 秒节流，避免每 5 秒重拉 —— BUG-9）
    loadChart(code);

  } catch (e) {
    const priceEl = document.getElementById(`price-${code}`);
    if (priceEl) {
      priceEl.textContent = '❌';
      priceEl.title = e.message;
    }
  }
}

const CHART_CACHE = {};          // code -> 最近一次成功拉取的时间戳
const KLINE_INTERVAL = 60000;    // K线 60 秒才重拉一次（行情 5 秒）

// 简化的K线图（用 canvas 手绘，不用额外库）
// BUG-9：quote 每 5 秒刷新一次，但 K 线不需要这么频繁。
// 原实现每次 loadCard 都重拉 /api/kline 并重建 canvas，一天能打几千个请求，
// 白白吃免费额度。改成 60 秒节流；canvas 已存在时只重绘数据，不重建节点。
async function loadChart(code, force = false) {
  const container = document.getElementById(`chart-${code}`);
  if (!container) return;

  const now = Date.now();
  if (!force && CHART_CACHE[code] && now - CHART_CACHE[code] < KLINE_INTERVAL) return;

  try {
    const data = await fetchKline(code);
    if (!data || !data.length) return;

    drawChart(container, data);
    CHART_CACHE[code] = Date.now();
  } catch (e) {
    // 失败不重建容器，避免每 5 秒闪一次"加载失败"
    if (!container.querySelector('canvas') && !container.querySelector('.loading')) {
      container.innerHTML = '<div class="loading" style="text-align:center;padding-top:80px;">K线加载失败</div>';
    }
  }
}

function drawChart(container, klineData) {
  // 取最近30根K线
  const data = klineData.slice(-30);
  const width = container.clientWidth || 300;
  const height = 200;
  
  const canvas = document.createElement('canvas');
  canvas.width = width * 2;
  canvas.height = height * 2;
  canvas.style.width = '100%';
  canvas.style.height = height + 'px';
  canvas.style.display = 'block';
  container.innerHTML = '';
  container.appendChild(canvas);
  
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);
  
  // 计算价格范围
  const prices = data.flatMap(k => [k.high, k.low]);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  // 停牌股/横盘时 max==min，价差为 0。不能 fallback 到绝对值 1：
  // 那会让 340 元的股票渲染成一条贴底的线。改用价格的 0.5% 作为最小价差。
  const priceRange = maxPrice - minPrice || Math.abs(minPrice) * 0.005 || 1;
  
  const padding = 10;
  const chartHeight = height - padding * 2;
  const barWidth = (width - padding * 2) / data.length - 2;
  
  // 绘制每根K线
  data.forEach((k, i) => {
    const x = padding + i * (barWidth + 2) + 1;
    const openY = padding + (1 - (k.open - minPrice) / priceRange) * chartHeight;
    const closeY = padding + (1 - (k.close - minPrice) / priceRange) * chartHeight;
    const highY = padding + (1 - (k.high - minPrice) / priceRange) * chartHeight;
    const lowY = padding + (1 - (k.low - minPrice) / priceRange) * chartHeight;
    
    const isUp = k.close >= k.open;
    const color = isUp ? '#ff4d4d' : '#4dff4d';
    
    // 上下影线
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + barWidth/2, highY);
    ctx.lineTo(x + barWidth/2, lowY);
    ctx.stroke();
    
    // 实体
    ctx.fillStyle = color;
    const bodyTop = Math.min(openY, closeY);
    const bodyHeight = Math.max(Math.abs(closeY - openY), 1);
    ctx.fillRect(x, bodyTop, barWidth, bodyHeight);
  });
  
  // 最新价格线
  const lastClose = data[data.length - 1].close;
  const lastY = padding + (1 - (lastClose - minPrice) / priceRange) * chartHeight;
  ctx.strokeStyle = '#666';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, lastY);
  ctx.lineTo(width, lastY);
  ctx.stroke();
  ctx.setLineDash([]);
  
  // 最新价格标签
  ctx.fillStyle = '#888';
  ctx.font = '11px sans-serif';
  ctx.fillText(lastClose.toFixed(2), 4, lastY - 4);
}

// ========== 工具函数 ==========

function formatVolume(v) {
  if (!v) return '-';
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(2) + '万';
  return v.toString();
}

function formatAmount(v) {
  if (!v) return '-';
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(2) + '万';
  return v.toString();
}

// ========== 初始化 ==========

// 绑定搜索框（输入防抖搜索 + 键盘上下选择 + 回车添加）
bindSearch();

// 全局轮询：初始化时注册一次，绝不随 render() 清空
// render() 会重建卡片并清理 refreshTimers（卡片级定时器），
// 若把全局轮询也放进去，用户增删股票后轮询会静默停摆（BUG-1）
function startGlobalPolling() {
  if (globalTimer) clearInterval(globalTimer);
  globalTimer = setInterval(() => {
    watchlist.forEach(code => loadCard(code));
  }, POLL_INTERVAL);
}

loadWatchlist();
render();
startGlobalPolling();

// 页面可见时才刷新
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    watchlist.forEach(code => loadCard(code));
  }
});
