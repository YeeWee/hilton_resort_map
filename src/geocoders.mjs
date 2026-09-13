import * as cheerio from 'cheerio';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createLimiter(delayMs) {
  let firstCall = true;
  return async function beforeRequest() {
    if (!firstCall) await sleep(delayMs);
    firstCall = false;
  };
}

// 管线对外部服务(Hilton 详情页 / Nominatim)共用的标识性 UA
const PIPELINE_UA =
  'hilton_resort_map/1.0 (static map data pipeline; https://github.com/YeeWee/hilton_resort_map)';

// 官网链接存在 /rooms/ 等子路径变体;详情页(含 JSON-LD)一律取规范属性页 URL
export function canonicalHotelUrl(url) {
  const match = /^https?:\/\/[^/]+\/en\/hotels\/([^/]+)/.exec(url);
  return match ? `https://www.hilton.com/en/hotels/${match[1]}/` : url;
}

// 与 Nominatim 政策对齐的礼貌限速,同样适用于 Hilton 详情页
export const DEFAULT_DELAY_MS = 1100;

// 抓取详情页并从 JSON-LD(顶层或 @graph 内)提取 GeoCoordinates;
// 找不到坐标时显式返回 null,由调用方决定回落策略。
// 连续 breakerThreshold 次 403 视为详情页整体被拒(反爬),本轮熔断、不再空打后续请求。
export function createJsonLdGeocoder({ fetchImpl = fetch, delayMs = DEFAULT_DELAY_MS, logger = console, breakerThreshold = 5 } = {}) {
  const beforeRequest = createLimiter(delayMs);
  let consecutive403 = 0;
  let tripped = false;
  return async function geocode(hotel) {
    const url = canonicalHotelUrl(hotel.url);
    if (tripped) return null;
    await beforeRequest();

    let html;
    try {
      const response = await fetchImpl(url, {
        headers: { 'user-agent': PIPELINE_UA },
      });
      if (response.status === 403) {
        consecutive403 += 1;
        if (consecutive403 >= breakerThreshold) {
          tripped = true;
          logger.warn?.(`[geocode] 连续 ${consecutive403} 次 403,详情页拒绝访问,本轮跳过 JSON-LD 抓取`);
        }
        return null;
      }
      if (!response.ok) {
        logger.warn?.(`[geocode] HTTP ${response.status} ${url}`);
        return null;
      }
      consecutive403 = 0;
      html = await response.text();
    } catch (error) {
      logger.warn?.(`[geocode] 抓取失败 ${url}: ${error.message}`);
      return null;
    }

    return extractGeo(html);
  };
}

// Nominatim 返回的结果里,哪些类型算得上"酒店类 POI";城市边界、行政区、营地等一律不收
// ('yes' 对应 OSM 里只标了 tourism=yes 的酒店)
const HOTEL_CATEGORIES = new Set(['tourism']);
const HOTEL_TYPES = new Set([
  'hotel', 'resort', 'apartment', 'motel', 'aparthotel', 'hostel', 'guest_house',
  'chalet', 'alpine_hut', 'bed_and_breakfast', 'yes',
]);

// 结果落点必须落在该 Hilton Region 的粗窗外才收(Region 是 Hilton 自己的分区口径)。
// 窗口刻意放宽(含亚速尔、佛得角、埃及、塞舌尔、法属波利尼西亚等边界案例),只用于挡同名误配。
const REGION_WINDOWS = {
  Americas: (c) => c.lng < -30 || c.lng > 150,
  Europe: (c) => c.lat >= 34 && c.lat <= 72 && c.lng >= -32 && c.lng <= 45,
  'Middle East': (c) => c.lat >= 12 && c.lat <= 43 && c.lng >= 25 && c.lng <= 64,
  Africa: (c) => c.lat >= -35 && c.lat <= 38 && c.lng >= -25 && c.lng <= 58,
  'Asia Pacific': (c) => c.lng >= 55 || c.lng <= -130,
};

function acceptNominatimResult(result, region, logger) {
  const category = result.category ?? result.class;
  if (!HOTEL_CATEGORIES.has(category) || !HOTEL_TYPES.has(result.type)) {
    logger.warn?.(`[geocode] Nominatim 结果非酒店类(${category}/${result.type}),拒绝: ${result.name ?? result.display_name}`);
    return null;
  }
  const coords = { lat: Number(result.lat), lng: Number(result.lon) };
  const regionAllows = region && REGION_WINDOWS[region];
  if (regionAllows && !regionAllows(coords)) {
    logger.warn?.(`[geocode] Nominatim 结果落在 ${region} 地区之外,拒绝: ${result.name ?? result.display_name}`);
    return null;
  }
  return { lat: coords.lat, lng: coords.lng, source: 'nominatim' };
}

// 查询变体:全名 → 去掉前导品牌词 → 去掉尾部品牌注记(及两者组合),供逐个回落查询。
// 按页面酒店名的实际前缀剥词(名称前缀与 Brand 标签并不一一对应,如 brand 叫
// "Hilton Grand Vacation Club" 的酒店,名却以 "Hilton Vacation Club" 开头)。
export function nameVariants(name) {
  const out = [];
  const push = (variant) => {
    const trimmed = variant?.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  };
  push(name);
  const leadingStripped = name.replace(
    /^(?:Hilton Grand Vacations Club|Hilton Vacation Club|Hilton Grand Vacations|Signia Hilton|Hilton|DoubleTree by Hilton|Hampton by Hilton|Homewood Suites by Hilton|Embassy Suites by Hilton|Curio Collection by Hilton|Tapestry Collection by Hilton|Waldorf Astoria Hotels & Resorts|Waldorf Astoria|LXR Hotels & Resorts)\s+/,
    '',
  );
  push(leadingStripped);
  const suffixStripped = (value) =>
    value
      .replace(/(?:^|,)\s*[Aa]\s+Hilton\b.*$/, '')
      .replace(/(?:^|,)\s*[Aa]\s+Waldorf\s+Astoria\b.*$/, '')
      .replace(/,\s*(?:LXR|Tapestry|Curio|Signia|DoubleTree|Embassy|Homewood|Hampton)\b[^,]*$/, '')
      .replace(/,?\s*by\s+Hilton\s*$/, '');
  push(suffixStripped(name));
  push(suffixStripped(leadingStripped));
  return out;
}

// 按酒店名回落到 Nominatim(政策要求标识性 UA、约 1 请求/秒):
// 依次尝试名称变体,只接受酒店类 POI 且落点与酒店 Region 一致的结果。
export function createNominatimGeocoder({ fetchImpl = fetch, delayMs = DEFAULT_DELAY_MS, logger = console } = {}) {
  const beforeRequest = createLimiter(delayMs);
  return async function geocode(hotel) {
    for (const name of nameVariants(hotel.name)) {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(name)}`;
      await beforeRequest();

      let results;
      try {
        const response = await fetchImpl(url, { headers: { 'user-agent': PIPELINE_UA } });
        if (!response.ok) {
          logger.warn?.(`[geocode] Nominatim HTTP ${response.status} ${hotel.name}`);
          return null;
        }
        results = await response.json();
      } catch (error) {
        logger.warn?.(`[geocode] Nominatim 请求失败 ${hotel.name}: ${error.message}`);
        return null;
      }

      const first = Array.isArray(results) ? results[0] : null;
      if (!first) continue;
      const accepted = acceptNominatimResult(first, hotel.region, logger);
      if (accepted) return accepted;
    }
    logger.warn?.(`[geocode] Nominatim 无可用结果: ${hotel.name}`);
    return null;
  };
}

// Nominatim reverse 逆地理编码:按酒店坐标取所在国家的 ISO 3166-1 代码
// (见 CONTEXT.md 的 Country 词条:国家按坐标所在的地理位置判定)。
// zoom 收窄到城市级以减小响应;失败(网络/HTTP/响应缺地址)显式返回 null,不抛错。
export function createNominatimReverseCountryGeocoder({ fetchImpl = fetch, delayMs = DEFAULT_DELAY_MS, logger = console } = {}) {
  const beforeRequest = createLimiter(delayMs);
  return async function resolveCountry(hotel) {
    if (hotel.lat == null || hotel.lng == null) return null;
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&addressdetails=1&lat=${hotel.lat}&lon=${hotel.lng}`;
    await beforeRequest();

    try {
      const response = await fetchImpl(url, { headers: { 'user-agent': PIPELINE_UA } });
      if (!response.ok) {
        logger.warn?.(`[geocode] Nominatim reverse HTTP ${response.status} ${hotel.name}`);
        return null;
      }
      const result = await response.json();
      return result?.address?.country_code?.toUpperCase() ?? null;
    } catch (error) {
      logger.warn?.(`[geocode] Nominatim reverse 请求失败 ${hotel.name}: ${error.message}`);
      return null;
    }
  };
}

// 组合回落链:首选服务返回 null 时依次尝试后续服务
export function withFallback(...geocoders) {
  return async function geocode(hotel) {
    for (const tryGeocode of geocoders) {
      const result = await tryGeocode(hotel);
      if (result) return result;
    }
    return null;
  };
}

export function extractGeo(html) {
  const $ = cheerio.load(html);
  for (const el of $('script[type="application/ld+json"]')) {
    let data;
    try {
      data = JSON.parse($(el).text());
    } catch {
      continue;
    }
    const nodes = [data, ...(Array.isArray(data) ? data : []), ...(Array.isArray(data?.['@graph']) ? data['@graph'] : [])];
    for (const node of nodes) {
      const geo = node?.geo;
      if (geo && geo.latitude != null && geo.longitude != null) {
        return { lat: Number(geo.latitude), lng: Number(geo.longitude), source: 'json-ld' };
      }
    }
  }
  return null;
}
