/* Hilton Resort Credit 合格酒店地图(纯静态,零构建) */

const BRAND_COLORS = {
  'Hilton Hotels & Resorts': '#0072ce',
  'Conrad Hotels & Resorts': '#5b2d86',
  'Curio Collection by Hilton': '#c2185b',
  'DoubleTree by Hilton': '#e65100',
  'Embassy Suites by Hilton': '#00838f',
  'Hampton by Hilton': '#43a047',
  'Hilton Grand Vacation Club': '#7b1fa2',
  'Homewood Suites by Hilton': '#8d6e63',
  'LXR Hotels & Resorts': '#37474f',
  'Signia Hilton': '#b8860b',
  'Tapestry Collection by Hilton': '#f9a825',
  'Waldorf Astoria Hotels & Resorts': '#6d4c41',
};
const UNKNOWN_BRAND_COLOR = '#9e9e9e';
const UNKNOWN_BRAND_LABEL = '未标注品牌';

const colorOf = (brand) => BRAND_COLORS[brand] ?? UNKNOWN_BRAND_COLOR;
const labelOf = (brand) => brand ?? UNKNOWN_BRAND_LABEL;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function popupHtml(hotel) {
  return `
    <strong class="popup-name">${escapeHtml(hotel.name)}</strong>
    <div class="popup-brand"><span class="chip" style="background:${colorOf(hotel.brand)}"></span>品牌:${escapeHtml(labelOf(hotel.brand))}</div>
    <div class="popup-region">地区:${escapeHtml(hotel.region ?? '—')}</div>
    <a class="popup-link" href="${escapeHtml(hotel.url)}" target="_blank" rel="noopener">官网页面 ↗</a>`;
}

function renderStats(hotels) {
  const brandCount = new Set(hotels.map((h) => h.brand).filter(Boolean)).size;
  document.getElementById('stats').textContent = `共 ${hotels.length} 家 / ${brandCount} 个品牌`;
}

function renderSidebar(hotels, markers) {
  const groups = document.getElementById('brand-groups');

  // 按酒店数从多到少分组;未标注品牌(brand 为 null)单独一组置底
  const byBrand = new Map();
  for (const hotel of hotels) {
    if (!byBrand.has(hotel.brand)) byBrand.set(hotel.brand, []);
    byBrand.get(hotel.brand).push(hotel);
  }
  const ordered = [...byBrand.entries()].sort((a, b) => (a[0] === null) - (b[0] === null) || b[1].length - a[1].length);

  for (const [brand, groupHotels] of ordered) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.innerHTML = `
      <span class="chip" style="background:${colorOf(brand)}"></span>
      <span class="brand-name">${escapeHtml(labelOf(brand))}</span>
      <span class="brand-count">${groupHotels.length} 家</span>`;
    details.appendChild(summary);

    for (const hotel of groupHotels) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'hotel-item';
      item.textContent = hotel.name;
      const marker = markers.get(hotel.code);
      if (marker) {
        item.addEventListener('click', () => {
          map.flyTo(marker.getLatLng(), 14);
          map.once('moveend', () => marker.openPopup());
        });
      } else {
        item.disabled = true;
        item.appendChild(Object.assign(document.createElement('small'), { textContent: '暂无坐标' }));
      }
      details.appendChild(item);
    }
    groups.appendChild(details);
  }
}

const map = L.map('map', { center: [30, 20], zoom: 2, worldCopyJump: true });

L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
  subdomains: 'abcd',
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
}).addTo(map);

const cluster = L.markerClusterGroup({ showCoverageOnHover: false });
map.addLayer(cluster);

// 调试/测试钩子:暴露 Leaflet 公开的 map 对象(页面测试用它驱动缩放)
window.__map__ = map;

async function init() {
  try {
    const response = await fetch('data/hotels.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const hotels = data.hotels;

    const markers = new Map();
    for (const hotel of hotels) {
      if (hotel.lat == null || hotel.lng == null) continue;
      const marker = L.marker([hotel.lat, hotel.lng], {
        icon: L.divIcon({
          className: 'hotel-marker',
          html: `<span style="background:${colorOf(hotel.brand)}"></span>`,
          iconSize: [14, 14],
          iconAnchor: [7, 7],
        }),
      });
      marker.bindPopup(popupHtml(hotel));
      cluster.addLayer(marker);
      markers.set(hotel.code, marker);
    }

    renderStats(hotels);
    renderSidebar(hotels, markers);
  } catch (error) {
    document.getElementById('stats').textContent = `数据加载失败:${error.message}`;
  }
}

init();

document.getElementById('sidebar-toggle').addEventListener('click', (event) => {
  const collapsed = document.getElementById('layout').classList.toggle('sidebar-collapsed');
  event.target.textContent = collapsed ? '展开侧边栏' : '收起侧边栏';
  event.target.setAttribute('aria-expanded', String(!collapsed));
  map.invalidateSize();
});
