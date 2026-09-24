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
let globalTimer = null;   // 全局 5 秒轮询，初始化时注册一次，不随 render 重建

// ========== 数据源元信息 ==========
// 主源不可用会降级到备源，降级必须可见（角标高亮 + 说明哪些字段没了）
const SOURCE_LABEL = { eastmoney: '东财', sina: '新浪', tencent: '腾讯', yahoo: 'Yahoo' };
const PRIMARY_SOURCE = { a: 'eastmoney', hk: 'eastmoney', us: 'tencent' };

function marketOf(code) {
  const c = String(code).toLowerCase();
  if (/^(sh|sz)/.test(c)) return 'a';
  if (/^hk/.test(c)) return 'hk';
  return 'us';
}
function primarySourceOf(code) {
  return PRIMARY_SOURCE[marketOf(code)] || 'eastmoney';
}
// 主源直接显示名；备源加「·备源」后缀，一眼看出是降级
function sourceLabel(source, code) {
  const name = SOURCE_LABEL[source] || source || 'unknown';
  if (!source) return name;
  return source === primarySourceOf(code) ? name : name + '·备源';
}

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
  // 裸 6 位 = A股；裸 4-5 位 = 港股（00700 是常见写法，NEW-11）
  return /^(sh|sz|hk)\d{4,6}$/i.test(t) || /^\d{4,6}$/.test(t);
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
    // 北交所号段（4/8/920 开头）不支持：原样透传让后端显式报错，
    // 而不是归到深市静默查不到（NEW-12）
    if (/^(4|8|920)/.test(code)) return code;
    return (/^(5|6|9)/.test(code) ? 'sh' : 'sz') + code;
  }
  // 裸 4-5 位数字 = 港股，补 hk 前缀并补足 5 位（700 -> hk00700）
  if (/^\d{4,5}$/.test(code)) return 'hk' + code.padStart(5, '0');
  return code;
}

// 市场标签（用于下拉显示）
const MARKET_LABEL = { '1': '沪市', '0': '深市', '105': '纳斯达克', '106': '纽交所', '107': 'Arca/ETF', '116': '港股' };

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
  
  // 后端把 K线数据源放在顶层 source（数组属性经 JSON 序列化会丢失），
  // 所以返回整个 json，供 loadChart 把来源同步到卡片角标
  return json;
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
        <button class="close-btn" data-code="${code}">×</button>
      </div>
      <div class="price-area">
        <div class="price flat" id="price-${code}">--</div>
        <div class="change flat" id="change-${code}">--</div>
      </div>
      <div class="details" id="details-${code}">
        <div class="loading" style="grid-column: span 2; text-align:center;">加载中...</div>
      </div>
      <div class="chart-bar">
        <span>日K</span>
        <span class="kline-tag" id="ksrc-${code}">K线加载中</span>
      </div>
      <div class="chart-container" id="chart-${code}"></div>
    </div>
  `).join('');

  // 删除按钮用 data-code + addEventListener，不用内联 onclick：
  // 内联拼接可注入（分享密钥可携带恶意 code，NEW-10）
  grid.querySelectorAll('.close-btn').forEach(btn => {
    btn.addEventListener('click', () => removeStock(btn.dataset.code));
  });
  
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
    
    // 更新数据源标签：非主源时琥珀色高亮，让降级可见（不再静默）
    const sourceEl = document.getElementById(`source-${code}`);
    if (sourceEl) {
      const primary = primarySourceOf(code);
      const degraded = !!d.source && d.source !== primary;
      let label = sourceLabel(d.source, code);
      if (result.stale) label += '·旧';
      sourceEl.textContent = label;
      sourceEl.className = 'source-tag' + (degraded ? ' degraded' : '');
      sourceEl.title = degraded
        ? `主源 ${SOURCE_LABEL[primary] || primary} 不可用，已降级到 ${SOURCE_LABEL[d.source] || d.source}。估值字段（市盈率/市净率/总市值）当前不可用。`
        : `数据源：${SOURCE_LABEL[d.source] || d.source}`;
    }
    
    // 加载K线（60 秒节流，避免每 5 秒重拉 —— BUG-9）
    loadChart(code);

    // 本次成功，清除离线标记
    markOnline(code);

  } catch (e) {
    // 后端连不上 ≠ 降级。降级还有价，离线什么都没有；
    // 之前只把价格换成 ❌，而详情/K线/来源角标全是上一次的旧值，
    // 看起来像"某个字段没加载出来"，其实是整台后端没了。
    markOffline(code, e.message);
  }
}

// 离线态（后端不可达）与降级态（有价但缺字段）必须在视觉上分开
const CARD_STATUS = {};   // code -> 'ok' | 'offline'

function markOffline(code, msg) {
  CARD_STATUS[code] = 'offline';
  const card = document.getElementById(`card-${code}`);
  if (card) card.classList.add('offline');

  const priceEl = document.getElementById(`price-${code}`);
  if (priceEl) {
    priceEl.textContent = '离线';
    priceEl.className = 'price flat';
    priceEl.title = '后端离线：' + msg;
  }

  const changeEl = document.getElementById(`change-${code}`);
  if (changeEl) { changeEl.textContent = '--'; changeEl.className = 'change flat'; }

  const detailsEl = document.getElementById(`details-${code}`);
  if (detailsEl) {
    detailsEl.innerHTML =
      '<div class="detail-item"><span class="detail-label" style="grid-column:span 2;text-align:center;color:#ff9b9b;">行情获取失败，5 秒后自动重试</span></div>';
  }

  const sourceEl = document.getElementById(`source-${code}`);
  if (sourceEl) {
    sourceEl.textContent = '离线';
    sourceEl.className = 'source-tag offline';
    sourceEl.title = msg;
  }

  updateOfflineBanner();
}

function markOnline(code) {
  CARD_STATUS[code] = 'ok';
  const card = document.getElementById(`card-${code}`);
  if (card) card.classList.remove('offline');
  updateOfflineBanner();
}

// 只有「全部卡片都离线」才弹横幅 —— 个别失败可能是单股异常，全部失败才是后端没了
function updateOfflineBanner() {
  const banner = document.getElementById('offlineBanner');
  if (!banner) return;
  const total = watchlist.length;
  const off = watchlist.filter(c => CARD_STATUS[c] === 'offline').length;
  banner.classList.toggle('show', total > 0 && off === total);
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
  // 失败也记录尝试时间：之前只在成功时写，持续失败的股票会每 5 秒白打一次
  // 上游（一天约 1.7 万请求），还会加剧东财的 IP 限流（NEW-8）
  CHART_CACHE[code] = now;

  try {
    const json = await fetchKline(code);
    const data = json.data;
    if (!data || !data.length) return;

    drawChart(container, data);
    updateKlineTag(code, json.source, json.stale);
  } catch (e) {
    // 失败不重建容器，避免每 5 秒闪一次"加载失败"
    if (!container.querySelector('canvas') && !container.querySelector('.loading')) {
      container.innerHTML = '<div class="loading" style="text-align:center;padding-top:80px;">K线加载失败</div>';
    }
  }
}

function drawChart(container, klineData) {
  // 过滤无效 K线：Yahoo 兜底常见 null OHLC，Number(null)=0 会把 minPrice 拉到 0
  // 压扁整图；parseFloat 失败的 NaN 则让 Math.min 得 NaN、整图空白（NEW-9）
  const data = klineData
    .filter(k => k && ['open', 'close', 'high', 'low'].every(f => Number.isFinite(k[f])))
    .slice(-30);
  if (!data.length) return;
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

// 把 K 线实际数据源同步到卡片角标。
// K 线和行情可能来自不同源（K线节流 60 秒、行情 5 秒，重试节奏不同），
// 不同源时角标高亮，免得"图上价格 ≠ 卡片价格"却没有任何解释。
function updateKlineTag(code, source, stale) {
  const el = document.getElementById(`ksrc-${code}`);
  if (!el) return;
  const degraded = !!source && source !== primarySourceOf(code);
  let label = sourceLabel(source, code);
  if (stale) label += '·旧';
  el.textContent = label;
  el.className = 'kline-tag' + (degraded ? ' degraded' : '');
  el.title = degraded
    ? `K线主源不可用，已降级到 ${SOURCE_LABEL[source] || source}`
    : `K线数据源：${SOURCE_LABEL[source] || source}`;
}

// 右上角「重试 K线」：绕过 60 秒节流，强制所有自选股重拉 K 线。
// 后端每次都会从头按 主源→备源→兜底 试一遍，所以主源一恢复，下一次请求就回来，
// 这个按钮只是不用干等那 60 秒。
async function retryAllKlines() {
  const btn = document.getElementById('retryKlineBtn');
  if (!watchlist.length) { flash('自选股为空'); return; }
  if (btn.disabled) return;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '重试中...';
  try {
    await Promise.all(watchlist.map(code => loadChart(code, true)));
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
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

// ========== 导出 / 导入密钥 ==========
// 只打包 watchlist —— localStorage 里唯一持久化的状态。
// 不含密码、凭证、个人信息，明文分享没有问题。
//
// 格式：SDKB.<版本>.<base64url(JSON)>.<fnv1a 校验码>
//   base64url  —— 用 -_ 替 +/ 并去掉 =，避免复制粘贴时被改写或截断
//   校验码     —— 抓「没复制全 / 中间缺字」这种最常见的失败，而不是让它静默导入错内容
const EXPORT_MAGIC = 'SDKB';
const EXPORT_VER = 1;

function b64urlEncode(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s), c => c.charCodeAt(0))));
}

// FNV-1a 32bit，取后 5 位 base36
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36).padStart(5, '0').slice(-5);
}

function buildKey() {
  const body = b64urlEncode({ v: EXPORT_VER, t: Date.now(), watchlist: watchlist.slice() });
  return `${EXPORT_MAGIC}.${EXPORT_VER}.${body}.${fnv1a(body)}`;
}

function parseKey(str) {
  const s = String(str).trim();
  if (!s) return { error: '密钥为空' };
  const p = s.split('.');
  if (p.length !== 4) return { error: '格式不对，应为 标识.版本.内容.校验码' };
  if (p[0] !== EXPORT_MAGIC) return { error: '这不是本看板的导出密钥' };
  if (Number(p[1]) !== EXPORT_VER) return { error: `不支持的版本 ${p[1]}（当前 ${EXPORT_VER}）` };
  if (fnv1a(p[2]) !== p[3].toLowerCase()) return { error: '校验失败：密钥可能没复制完整' };
  try {
    const data = b64urlDecode(p[2]);
    if (!Array.isArray(data.watchlist)) return { error: '密钥内容损坏：缺少自选股列表' };
    return { data };
  } catch (e) {
    return { error: '内容解析失败：' + e.message };
  }
}

// ---- 弹窗 ----
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function openModal(title, bodyHtml) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHtml;
  document.getElementById('modalMask').classList.add('show');
}

function closeModal() {
  document.getElementById('modalMask').classList.remove('show');
}

// ---- 导出 ----
function exportKey() {
  if (!watchlist.length) { flash('自选股为空，没有内容可导出'); return; }
  const key = buildKey();
  openModal('导出密钥', `
    <div class="hint-line">这段是自选股列表的编码，<strong>不含任何密码或隐私</strong>，可以放心分享。</div>
    <div class="hint-line">在别的浏览器/设备上打开本页 → 点「⤒ 导入」→ 粘贴 → 恢复。</div>
    <textarea id="exportText" readonly>${escapeHtml(key)}</textarea>
    <div class="modal-foot">
      <button class="btn" onclick="closeModal()">关闭</button>
      <button class="btn btn-primary" id="copyBtn" onclick="copyExport()">复制密钥</button>
    </div>
  `);
  const ta = document.getElementById('exportText');
  ta.focus();
  ta.select();
}

async function copyExport() {
  const ta = document.getElementById('exportText');
  const btn = document.getElementById('copyBtn');
  ta.focus();
  ta.select();
  let ok = false;
  try {
    await navigator.clipboard.writeText(ta.value);
    ok = true;
  } catch (e) {
    try { document.execCommand('copy'); ok = true; } catch (_) { ok = false; }
  }
  btn.textContent = ok ? '✓ 已复制' : '请手动全选复制';
  setTimeout(() => { btn.textContent = '复制密钥'; }, 1800);
}

// ---- 导入 ----
function importKey() {
  openModal('导入密钥', `
    <div class="hint-line">粘贴在别处导出的密钥。导入会<strong>合并</strong>到当前自选股，不会删除你已有的。</div>
    <textarea id="importText" placeholder="SDKB.1.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"></textarea>
    <div class="modal-foot">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="doImport()">导入</button>
    </div>
  `);
  document.getElementById('importText').focus();
}

// 代码白名单：watchlist 里的 code 会被拼进 DOM id，必须是安全字符集。
// 与后端 normalize*Code 的接受域对齐：sh/sz+6位、hk+4-5位、裸数字、美股 ticker。
// 只允许 字母/数字/点/连字符 —— 引号、尖括号、空格等一律拒绝（NEW-10 防 XSS）
function isSafeCode(code) {
  return /^(sh|sz)\d{6}$/i.test(code)
      || /^hk\d{4,5}$/i.test(code)
      || /^\d{4,6}$/.test(code)
      || /^[A-Za-z][A-Za-z.\-]{0,4}$/.test(code);
}

function doImport() {
  const text = document.getElementById('importText').value;
  if (!text.trim()) { flash('请先粘贴密钥'); return; }

  const r = parseKey(text);
  if (r.error) { flash(r.error); return; }

  const list = r.data.watchlist.filter(c => typeof c === 'string' && c.trim());
  if (!list.length) { flash('密钥里没有自选股'); return; }

  // 逐个校验格式：密钥设计为可明文分享，恶意密钥可以塞入带引号的 code，
  // 不校验就会经卡片模板形成注入（NEW-10）
  const valid = list.filter(isSafeCode);
  const dropped = list.length - valid.length;
  if (!valid.length) { flash('密钥里的代码全部不合法，未导入'); return; }

  let added = 0;
  for (const code of valid) {
    if (!watchlist.includes(code)) { watchlist.push(code); added++; }
  }
  saveWatchlist();
  render();
  closeModal();
  flash(`导入完成：${valid.length} 只，新增 ${added} 只` + (dropped ? `，丢弃 ${dropped} 个非法代码` : ''));
}

// ========== 初始化 ==========

// 绑定搜索框（输入防抖搜索 + 键盘上下选择 + 回车添加）
bindSearch();

// 全局轮询：初始化时注册一次，绝不随 render() 重建，
// 否则用户增删股票后轮询会静默停摆（BUG-1）
function startGlobalPolling() {
  if (globalTimer) clearInterval(globalTimer);
  globalTimer = setInterval(() => {
    watchlist.forEach(code => loadCard(code));
  }, POLL_INTERVAL);
}

loadWatchlist();
render();
startGlobalPolling();

// ESC 关闭弹窗
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// 页面可见时才刷新
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    watchlist.forEach(code => loadCard(code));
  }
});
