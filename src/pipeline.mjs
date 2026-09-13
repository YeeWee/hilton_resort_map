import { parsePage } from './parse-page.mjs';

// 接缝 1(管线整体):输入 = 保存的页面 HTML + 注入的地理编码器;输出 = hotels.json。
// 数据全集 = 页面两个 tab 列出的全部酒店(并集),不多不少;唯一性以 hotel code 为准。

// 每家酒店的输出契约:code / name / brand / region / lat / lng / url / coordinateSource
function toHotel(entry, brand, region) {
  return {
    code: entry.code,
    name: entry.name,
    brand,
    region,
    lat: null,
    lng: null,
    url: entry.url,
    coordinateSource: null,
  };
}

export async function buildHotels({ html, geocode, maxGeocode = Infinity }) {
  const { brandGroups, regionGroups } = parsePage(html);

  const regionByCode = new Map();
  for (const group of regionGroups) {
    for (const entry of group.hotels) {
      if (!regionByCode.has(entry.code)) regionByCode.set(entry.code, group.label);
    }
  }

  const hotels = [];
  const seen = new Set();
  for (const group of brandGroups) {
    for (const entry of group.hotels) {
      if (seen.has(entry.code)) continue;
      seen.add(entry.code);
      hotels.push(toHotel(entry, group.label, regionByCode.get(entry.code) ?? null));
    }
  }

  // 仅出现在 by-region tab 的酒店(页面两 tab 更新不同步)也在数据全集内,Brand 置空
  for (const group of regionGroups) {
    for (const entry of group.hotels) {
      if (seen.has(entry.code)) continue;
      seen.add(entry.code);
      hotels.push(toHotel(entry, null, group.label));
    }
  }

  const toGeocode = hotels.slice(0, maxGeocode);
  for (let i = 0; i < toGeocode.length; i++) {
    const result = await geocode(toGeocode[i]);
    if (result) {
      toGeocode[i].lat = result.lat;
      toGeocode[i].lng = result.lng;
      toGeocode[i].coordinateSource = result.source;
    }
  }

  return { generatedAt: new Date().toISOString(), hotels };
}
