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
const UNKNOWN_CONTINENT_LABEL = '未标注大洲';
const UNKNOWN_COUNTRY_LABEL = '未标注国家';

const colorOf = (brand) => BRAND_COLORS[brand] ?? UNKNOWN_BRAND_COLOR;
const labelOf = (brand) => brand ?? UNKNOWN_BRAND_LABEL;
const chipHtml = (brand) => `<span class="chip" style="background:${colorOf(brand)}"></span>`;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function popupHtml(hotel) {
  // Region 是官网口径、Country 是坐标判定口径,两者并存展示(见 CONTEXT.md)
  const place = [hotel.region, hotel.country].filter(Boolean).join(' · ') || '—';
  return `
    <strong class="popup-name">${escapeHtml(hotel.name)}</strong>
    <div class="popup-brand">${chipHtml(hotel.brand)}品牌:${escapeHtml(labelOf(hotel.brand))}</div>
    <div class="popup-region">地区:${escapeHtml(place)}</div>
    <a class="popup-link" href="${escapeHtml(hotel.url)}" target="_blank" rel="noopener">官网页面 ↗</a>`;
}

function renderStats(hotels) {
  const brandCount = new Set(hotels.map((h) => h.brand).filter(Boolean)).size;
  const countryCount = new Set(hotels.map((h) => h.country).filter(Boolean)).size;
  document.getElementById('stats').textContent =
    `共 ${hotels.length} 家 / ${brandCount} 个品牌 / ${countryCount} 个国家`;
}

function pushToGrouped(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

// 图例共用的品牌分组与排序:数量降序,未标注品牌(brand 为 null)置底
function groupByBrandOrdered(hotels) {
  const byBrand = new Map();
  for (const hotel of hotels) {
    pushToGrouped(byBrand, hotel.brand, hotel);
  }
  return [...byBrand.entries()].sort((a, b) => (a[0] === null) - (b[0] === null) || b[1].length - a[1].length);
}

function renderLegend(hotels) {
  const legend = document.createElement('div');
  legend.id = 'legend';

  const title = document.createElement('div');
  title.className = 'legend-title';
  title.textContent = '品牌图例(点击筛选)';
  legend.appendChild(title);

  for (const [brand, groupHotels] of groupByBrandOrdered(hotels)) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'legend-item';
    item.setAttribute('aria-pressed', 'true');
    item.innerHTML = `
      ${chipHtml(brand)}
      <span class="legend-name">${escapeHtml(labelOf(brand))}</span>
      <span class="legend-count">${groupHotels.length}</span>`;
    item.addEventListener('click', () => {
      setBrandVisible(brand, item.getAttribute('aria-pressed') !== 'true');
    });
    legendItemsByBrand.set(brand, item);
    legend.appendChild(item);
  }

  const mapContainer = document.getElementById('map');
  mapContainer.appendChild(legend);
  // 图例浮在地图上,按下/滚轮不应拖动或缩放底图
  L.DomEvent.disableClickPropagation(legend);
  L.DomEvent.disableScrollPropagation(legend);
}

// ---- 侧边栏:大洲 → 国家 → 酒店三级树(勾选筛选 + 导航定位) ----

// marker 与酒店行的可见性 = 品牌(图例)× 国家(勾选),两者 AND
const hiddenBrands = new Set();       // 图例里被点掉的品牌(brand 原值)
const uncheckedCountries = new Set(); // 取消勾选的国家(country 原值,null = 未标注国家)
const openGroups = new Set();         // 保持展开的分组,键 "c:大洲名" / "k:国家名"

let hotelsAll = [];
let markersByCode = new Map();
let geoTree = []; // buildTree 的结果:分组结构与排序只取决于全量数据,筛选只影响计数与显隐

// 分组排序:数量降序,同数按名称;未标注(value 为 null)一律置底
function orderGroups(groups) {
  return groups.sort((a, b) =>
    (a.value === null) - (b.value === null)
    || b.hotels.length - a.hotels.length
    || a.label.localeCompare(b.label, 'zh'));
}

function buildTree(hotels) {
  const byContinent = new Map();
  for (const hotel of hotels) {
    pushToGrouped(byContinent, hotel.continent, hotel);
  }
  return orderGroups([...byContinent.entries()].map(([continent, continentHotels]) => {
    const byCountry = new Map();
    for (const hotel of continentHotels) {
      pushToGrouped(byCountry, hotel.country, hotel);
    }
    return {
      value: continent,
      label: continent ?? UNKNOWN_CONTINENT_LABEL,
      hotels: continentHotels,
      countries: orderGroups([...byCountry.entries()].map(([country, countryHotels]) => ({
        value: country,
        label: country ?? UNKNOWN_COUNTRY_LABEL,
        hotels: countryHotels,
      }))),
    };
  }));
}

const isBrandVisible = (hotel) => !hiddenBrands.has(hotel.brand);
const isCountryChecked = (hotel) => !uncheckedCountries.has(hotel.country);
// 树上各级计数只看品牌筛选:国家勾选不隐藏节点(否则没法勾回来),只隐藏 marker 与酒店行
const brandFilteredCount = (hotels) => hotels.filter(isBrandVisible).length;

// 把当前筛选落到 marker 层:只移动可见性发生变化的 marker,簇计数随之重算
function refreshMarkers() {
  const toAdd = [];
  const toRemove = [];
  for (const hotel of hotelsAll) {
    const marker = markersByCode.get(hotel.code);
    if (!marker) continue;
    const visible = isBrandVisible(hotel) && isCountryChecked(hotel);
    if (visible === cluster.hasLayer(marker)) continue;
    (visible ? toAdd : toRemove).push(marker);
  }
  if (toRemove.length > 0) cluster.removeLayers(toRemove);
  if (toAdd.length > 0) cluster.addLayers(toAdd);
}

function setOpen(key, open) {
  if (open) openGroups.add(key);
  else openGroups.delete(key);
}

const groupKey = (prefix, label) => `${prefix}:${label}`;

function geoCheckbox(label, checked) {
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'geo-toggle';
  checkbox.checked = checked;
  checkbox.setAttribute('aria-label', `在地图上显示${label}的酒店`);
  // 勾选动作不应冒泡到 summary 触发展开/收起
  checkbox.addEventListener('click', (event) => event.stopPropagation());
  return checkbox;
}

function summaryLine(checkbox, label, count) {
  const summary = document.createElement('summary');
  summary.append(
    checkbox,
    Object.assign(document.createElement('span'), { className: 'geo-name', textContent: label }),
    Object.assign(document.createElement('span'), { className: 'geo-count', textContent: `${count} 家` }),
  );
  return summary;
}

function hotelItem(hotel) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'hotel-item';
  item.textContent = hotel.name;
  const marker = markersByCode.get(hotel.code);
  if (marker) {
    // 酒店行只在通过完整筛选(品牌 × 国家)时渲染,点击时 marker 必然可见
    item.addEventListener('click', () => {
      map.flyTo(marker.getLatLng(), 14);
      map.once('moveend', () => marker.openPopup());
    });
  } else {
    item.disabled = true;
    item.appendChild(Object.assign(document.createElement('small'), { textContent: '暂无坐标' }));
  }
  return item;
}

function countryGroup(country) {
  const details = document.createElement('details');
  details.className = 'country-group';
  const key = groupKey('k', country.label);
  details.open = openGroups.has(key);
  details.addEventListener('toggle', () => setOpen(key, details.open));

  const checked = !uncheckedCountries.has(country.value);
  const checkbox = geoCheckbox(country.label, checked);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) uncheckedCountries.delete(country.value);
    else uncheckedCountries.add(country.value);
    refreshMarkers();
    renderTree();
  });
  if (!checked) details.classList.add('geo-off');

  details.appendChild(summaryLine(checkbox, country.label, brandFilteredCount(country.hotels)));

  // 酒店行跟随完整筛选;国家节点本身常驻,勾掉只藏行与 marker
  for (const hotel of country.hotels) {
    if (!isBrandVisible(hotel) || !isCountryChecked(hotel)) continue;
    details.appendChild(hotelItem(hotel));
  }
  return details;
}

function continentGroup(continent, visibleCountries) {
  const details = document.createElement('details');
  details.className = 'continent-group';
  const key = groupKey('c', continent.label);
  details.open = openGroups.has(key);
  details.addEventListener('toggle', () => setOpen(key, details.open));

  const checkedCount = visibleCountries.filter((country) => !uncheckedCountries.has(country.value)).length;
  const checkbox = geoCheckbox(continent.label, checkedCount === visibleCountries.length);
  checkbox.indeterminate = checkedCount > 0 && checkedCount < visibleCountries.length;
  // 勾大洲 = 勾其下全部国家(含被品牌筛选暂时藏掉的,勾选状态先保留)
  checkbox.addEventListener('change', () => {
    for (const country of continent.countries) {
      if (checkbox.checked) uncheckedCountries.delete(country.value);
      else uncheckedCountries.add(country.value);
    }
    refreshMarkers();
    renderTree();
  });

  const count = visibleCountries.reduce((sum, country) => sum + brandFilteredCount(country.hotels), 0);
  details.appendChild(summaryLine(checkbox, continent.label, count));

  const list = document.createElement('div');
  list.className = 'country-list';
  for (const country of visibleCountries) list.appendChild(countryGroup(country));
  details.appendChild(list);
  return details;
}

function renderTree() {
  const nav = document.getElementById('geo-tree');
  nav.textContent = '';
  for (const continent of geoTree) {
    // 品牌筛完整洲为空时整洲隐藏(勾选状态保留,放宽品牌筛选后自动回来)
    const visibleCountries = continent.countries.filter((country) => brandFilteredCount(country.hotels) > 0);
    if (visibleCountries.length === 0) continue;
    nav.appendChild(continentGroup(continent, visibleCountries));
  }
}

const map = L.map('map', { center: [30, 20], zoom: 2, worldCopyJump: true });

L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=cb1_3j9m_1_9b078866ec04f2fd9b6a45d4', {
  subdomains: 'abcd',
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
}).addTo(map);

const cluster = L.markerClusterGroup({ showCoverageOnHover: false });
map.addLayer(cluster);

const legendItemsByBrand = new Map();

// 切换一个品牌的显隐并同步图例项;marker 与侧边栏酒店行都跟随 品牌 × 国家 筛选
function setBrandVisible(brand, visible) {
  if (visible) hiddenBrands.delete(brand);
  else hiddenBrands.add(brand);
  legendItemsByBrand.get(brand)?.setAttribute('aria-pressed', String(visible));
  refreshMarkers();
  renderTree();
}

// 调试/测试钩子:暴露 Leaflet 公开的 map 对象(页面测试用它驱动缩放)
window.__map__ = map;

async function init() {
  try {
    const response = await fetch('data/hotels.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    hotelsAll = data.hotels;

    for (const hotel of hotelsAll) {
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
      markersByCode.set(hotel.code, marker);
    }

    geoTree = buildTree(hotelsAll);
    renderStats(hotelsAll);
    renderLegend(hotelsAll);
    renderTree();
  } catch (error) {
    document.getElementById('stats').textContent = `数据加载失败:${error.message}`;
  }
}

init();

// 重置:一键勾回全部国家;图例的品牌筛选不在此列(两处职责分离)
document.getElementById('geo-reset').addEventListener('click', () => {
  if (uncheckedCountries.size === 0) return;
  uncheckedCountries.clear();
  refreshMarkers();
  renderTree();
});

document.getElementById('sidebar-toggle').addEventListener('click', (event) => {
  const collapsed = document.getElementById('layout').classList.toggle('sidebar-collapsed');
  event.target.textContent = collapsed ? '展开侧边栏' : '收起侧边栏';
  event.target.setAttribute('aria-expanded', String(!collapsed));
  map.invalidateSize();
});
