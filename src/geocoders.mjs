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
export function createJsonLdGeocoder({ fetchImpl = fetch, delayMs = DEFAULT_DELAY_MS, logger = console } = {}) {
  const beforeRequest = createLimiter(delayMs);
  return async function geocode(hotel) {
    const url = canonicalHotelUrl(hotel.url);
    await beforeRequest();

    let html;
    try {
      const response = await fetchImpl(url, {
        headers: { 'user-agent': PIPELINE_UA },
      });
      if (!response.ok) {
        logger.warn?.(`[geocode] HTTP ${response.status} ${url}`);
        return null;
      }
      html = await response.text();
    } catch (error) {
      logger.warn?.(`[geocode] 抓取失败 ${url}: ${error.message}`);
      return null;
    }

    return extractGeo(html);
  };
}

// 按酒店名回落到 Nominatim(政策要求标识性 UA、约 1 请求/秒)
export function createNominatimGeocoder({ fetchImpl = fetch, delayMs = DEFAULT_DELAY_MS, logger = console } = {}) {
  const beforeRequest = createLimiter(delayMs);
  return async function geocode(hotel) {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(hotel.name)}`;
    await beforeRequest();

    try {
      const response = await fetchImpl(url, { headers: { 'user-agent': PIPELINE_UA } });
      if (!response.ok) {
        logger.warn?.(`[geocode] Nominatim HTTP ${response.status} ${hotel.name}`);
        return null;
      }
      const results = await response.json();
      const first = Array.isArray(results) ? results[0] : null;
      if (!first) {
        logger.warn?.(`[geocode] Nominatim 无结果: ${hotel.name}`);
        return null;
      }
      return { lat: Number(first.lat), lng: Number(first.lon), source: 'nominatim' };
    } catch (error) {
      logger.warn?.(`[geocode] Nominatim 请求失败 ${hotel.name}: ${error.message}`);
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
