import { parsePage } from './parse-page.mjs';
import { COUNTRY_META } from './countries.mjs';

// 接缝 1(管线整体):输入 = 保存的页面 HTML + 注入的地理编码器 + 注入的国家逆编码器 + 人工 overrides;输出 = hotels.json。
// 数据全集 = 页面两个 tab 列出的全部酒店(并集),不多不少;唯一性以 hotel code 为准。

// 每家酒店的输出契约:code / name / brand / region / countryCode / country / continent / lat / lng / url / coordinateSource
// coordinateSource:json-ld | nominatim | override | failed(已尝试但两轮都失败)| null(未尝试)
// countryCode / country / continent:按坐标逆地理编码判定的国家与大洲(见 CONTEXT.md),无坐标或判定失败时为 null
function toHotel(entry, brand, region) {
  return {
    code: entry.code,
    name: entry.name,
    brand,
    region,
    countryCode: null,
    country: null,
    continent: null,
    lat: null,
    lng: null,
    url: entry.url,
    coordinateSource: null,
  };
}

export async function buildHotels({ html, geocode, resolveCountry, overrides = {}, maxGeocode = Infinity }) {
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

  const overrideByCode = new Map(Object.entries(overrides));

  const toGeocode = hotels.slice(0, maxGeocode);
  const attempted = new Set(toGeocode.map((hotel) => hotel.code));
  for (let i = 0; i < toGeocode.length; i++) {
    const result = await geocode(toGeocode[i]);
    if (result) {
      toGeocode[i].lat = result.lat;
      toGeocode[i].lng = result.lng;
      toGeocode[i].coordinateSource = result.source;
    }
  }

  // 坐标兜底次序:编码结果优先;失败(或未尝试)时人工 overrides;两者皆无且已尝试则显式标记失败
  for (const hotel of hotels) {
    if (hotel.lat != null) continue;
    const override = overrideByCode.get(hotel.code);
    if (override) {
      hotel.lat = override.lat;
      hotel.lng = override.lng;
      hotel.coordinateSource = 'override';
    } else if (attempted.has(hotel.code)) {
      hotel.coordinateSource = 'failed';
    }
  }

  // 国家与大洲:坐标就绪后逐家逆地理编码(含 override 坐标),映射表给出中文名与大洲;
  // 无坐标、编码失败或代码不在映射表时保持 null(页面归入"未标注国家"/"未标注大洲")
  const unmappedCountryCodes = new Map();
  if (resolveCountry) {
    for (const hotel of hotels) {
      if (hotel.lat == null || hotel.lng == null) continue;
      const countryCode = await resolveCountry(hotel);
      if (!countryCode) continue;
      const normalized = countryCode.toUpperCase();
      hotel.countryCode = normalized;
      const meta = COUNTRY_META[normalized];
      if (meta) {
        hotel.country = meta.name;
        hotel.continent = meta.continent;
      } else {
        unmappedCountryCodes.set(countryCode, (unmappedCountryCodes.get(countryCode) ?? 0) + 1);
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    hotels,
    unmappedCountryCodes: [...unmappedCountryCodes.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => a.code.localeCompare(b.code)),
  };
}
