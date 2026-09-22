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
let refreshTimers = [];

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

function addStock() {
  const input = document.getElementById('searchInput');
  let code = input.value.trim();
  
  if (!code) return;
  
  // 简单校验：A股必须sh/sz开头，美股是英文
  if (!code.match(/^(sh|sz)\d{6}$/i) && !code.match(/^[A-Za-z\.\-]{1,10}$/)) {
    alert('代码格式不对哦\nA股: sh600519 / sz000001\n美股: AAPL / TSLA');
    return;
  }
  
  code = code.toLowerCase();
  
  if (watchlist.includes(code)) {
    alert('这个股票已经在列表里了');
    return;
  }
  
  watchlist.push(code);
  saveWatchlist();
  input.value = '';
  render();
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
  watchlist.forEach(code => {
    loadCard(code);
  });
}

async function loadCard(code) {
  try {
    const result = await fetchQuote(code);
    const d = result.data;
    
    // 更新标题
    const nameEl = document.getElementById(`name-${code}`);
    if (nameEl) nameEl.textContent = d.name || code.toUpperCase();
    
    // 更新价格
    const priceEl = document.getElementById(`price-${code}`);
    const changeEl = document.getElementById(`change-${code}`);
    
    if (priceEl) {
      priceEl.textContent = d.price.toFixed(2);
      const cls = d.change > 0 ? 'up' : d.change < 0 ? 'down' : 'flat';
      priceEl.className = `price ${cls}`;
    }
    
    if (changeEl) {
      const sign = d.change > 0 ? '+' : '';
      changeEl.textContent = `${sign}${d.change.toFixed(2)}  ${sign}${d.changePercent.toFixed(2)}%`;
      const cls = d.change > 0 ? 'up' : d.change < 0 ? 'down' : 'flat';
      changeEl.className = `change ${cls}`;
    }
    
    // 更新详情
    const detailsEl = document.getElementById(`details-${code}`);
    if (detailsEl) {
      detailsEl.innerHTML = `
        <div class="detail-item"><span class="detail-label">今开</span><span class="detail-value">${d.open?.toFixed(2) || '-'}</span></div>
        <div class="detail-item"><span class="detail-label">昨收</span><span class="detail-value">${d.prevClose?.toFixed(2) || '-'}</span></div>
        <div class="detail-item"><span class="detail-label">最高</span><span class="detail-value up">${d.high?.toFixed(2) || '-'}</span></div>
        <div class="detail-item"><span class="detail-label">最低</span><span class="detail-value down">${d.low?.toFixed(2) || '-'}</span></div>
        <div class="detail-item"><span class="detail-label">成交量</span><span class="detail-value">${formatVolume(d.volume)}</span></div>
        <div class="detail-item"><span class="detail-label">成交额</span><span class="detail-value">${formatAmount(d.turnover)}</span></div>
        ${d.pe ? `<div class="detail-item"><span class="detail-label">市盈率</span><span class="detail-value">${d.pe.toFixed(2)}</span></div>` : ''}
        ${d.pb ? `<div class="detail-item"><span class="detail-label">市净率</span><span class="detail-value">${d.pb.toFixed(2)}</span></div>` : ''}
        ${d.marketCap ? `<div class="detail-item"><span class="detail-label">总市值</span><span class="detail-value">${formatAmount(d.marketCap)}</span></div>` : ''}
      `;
    }
    
    // 更新数据源标签
    const sourceEl = document.getElementById(`source-${code}`);
    if (sourceEl) {
      let label = d.source || 'unknown';
      if (result.stale) label += ' (旧)';
      sourceEl.textContent = label;
    }
    
    // 加载K线
    loadChart(code);
    
  } catch (e) {
    const priceEl = document.getElementById(`price-${code}`);
    if (priceEl) {
      priceEl.textContent = '❌';
      priceEl.title = e.message;
    }
  }
}

// 简化的K线图（用 canvas 手绘，不用额外库）
async function loadChart(code) {
  const container = document.getElementById(`chart-${code}`);
  if (!container) return;
  
  try {
    const data = await fetchKline(code);
    if (!data || !data.length) return;
    
    drawChart(container, data);
  } catch (e) {
    container.innerHTML = '<div class="loading" style="text-align:center;padding-top:80px;">K线加载失败</div>';
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
  const priceRange = maxPrice - minPrice || 1;
  
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

document.getElementById('searchInput').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') addStock();
});

loadWatchlist();
render();

// 定时刷新
refreshTimers.push(setInterval(() => {
  watchlist.forEach(code => loadCard(code));
}, POLL_INTERVAL));

// 页面可见时才刷新
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    watchlist.forEach(code => loadCard(code));
  }
});
