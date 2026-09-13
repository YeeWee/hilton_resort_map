#!/usr/bin/env node
// 数据管线 CLI:保存的页面 HTML → hotels.json
//   node scripts/build-data.mjs [--html data/raw/resort-credit-eligible-hotels.html]
//                               [--out data/hotels.json] [--overrides data/overrides.json]
//                               [--max-geocode all|N] [--cache data/raw/geocode-cache.json]
// 坐标兜底次序:详情页 JSON-LD → Nominatim 按酒店名回落 → 人工 overrides;
// 全部失败且已尝试的酒店在产物里显式标记 coordinateSource=failed。
// 坐标就绪后再逐家做 Nominatim reverse 逆地理编码得国家代码(COUNTRY_META 映射中文名与大洲)。
// 对外部服务(Hilton 详情页 / Nominatim)礼貌限速(约 1 请求/秒)。
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { buildHotels } from '../src/pipeline.mjs';
import {
  createJsonLdGeocoder,
  createNominatimGeocoder,
  createNominatimReverseCountryGeocoder,
  withFallback,
} from '../src/geocoders.mjs';
import { loadOverrides } from '../src/overrides.mjs';

const { values } = parseArgs({
  options: {
    html: { type: 'string', default: 'data/raw/resort-credit-eligible-hotels.html' },
    out: { type: 'string', default: 'data/hotels.json' },
    overrides: { type: 'string', default: 'data/overrides.json' },
    'max-geocode': { type: 'string', default: 'all' },
    cache: { type: 'string' },
  },
});

const html = await readFile(values.html, 'utf8');
const maxGeocode = values['max-geocode'] === 'all' ? Infinity : Number(values['max-geocode']);
if (maxGeocode !== Infinity && (!Number.isInteger(maxGeocode) || maxGeocode < 0)) {
  console.error(`--max-geocode 需为 "all" 或非负整数,收到:${values['max-geocode']}`);
  process.exit(1);
}
const overrides = await loadOverrides(values.overrides);

// 成功结果缓存(可选):补充 overrides 后重跑时,已编码酒店不再重复请求外部服务。
// 缓存条目为 { lat, lng, source, countryCode? }:坐标与国家代码同键存放,均只存成功结果
// (失败的酒店下次重跑时自动重试)
const cache = new Map();
const saveCache = () => {
  if (values.cache && cache.size > 0) {
    return writeFile(values.cache, `${JSON.stringify(Object.fromEntries(cache), null, 2)}\n`);
  }
};
if (values.cache) {
  try {
    const saved = JSON.parse(await readFile(values.cache, 'utf8'));
    for (const [code, result] of Object.entries(saved)) cache.set(code, result);
    const withCountry = [...cache.values()].filter((entry) => 'countryCode' in entry).length;
    console.error(`缓存已有 ${cache.size} 条(含国家代码 ${withCountry} 条),命中者不再请求外部服务`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

console.error(`解析页面 ${values.html} …`);
const geocode = withFallback(createJsonLdGeocoder({ logger: console }), createNominatimGeocoder({ logger: console }));
const resolveCountryUncached = createNominatimReverseCountryGeocoder({ logger: console });

async function cachedGeocode(hotel) {
  if (cache.has(hotel.code)) return cache.get(hotel.code);
  const result = await geocode(hotel);
  if (result) {
    cache.set(hotel.code, result);
    await saveCache(); // 每次成功即落盘,中断后不重打已成功的外部服务
  }
  return result;
}

// 国家代码缓存:与坐标同键;仅存成功结果,失败的下次重跑自动重试
async function cachedResolveCountry(hotel) {
  const entry = cache.get(hotel.code);
  if (entry && 'countryCode' in entry) return entry.countryCode;
  const countryCode = await resolveCountryUncached(hotel);
  if (countryCode) {
    if (cache.has(hotel.code)) cache.get(hotel.code).countryCode = countryCode;
    else cache.set(hotel.code, { countryCode });
    await saveCache();
  }
  return countryCode;
}

const output = await buildHotels({ html, geocode: cachedGeocode, resolveCountry: cachedResolveCountry, overrides, maxGeocode });

const brandCount = new Set(output.hotels.map((h) => h.brand).filter(Boolean)).size;
const countryCount = new Set(output.hotels.map((h) => h.country).filter(Boolean)).size;
const bySource = {};
for (const hotel of output.hotels) bySource[hotel.coordinateSource] = (bySource[hotel.coordinateSource] ?? 0) + 1;
console.error(`共 ${output.hotels.length} 家 / ${brandCount} 个品牌 / ${countryCount} 个国家;坐标来源 ${JSON.stringify(bySource)}`);

// 无坐标或逆编码失败的酒店:国家缺失,页面上归入"未标注国家"
const noCountry = output.hotels.filter((h) => h.country == null);
if (noCountry.length > 0) {
  console.error(`以下 ${noCountry.length} 家无国家信息(无坐标或逆编码失败),将归入"未标注国家";重跑可重试失败的逆编码:`);
  for (const hotel of noCountry) console.error(`  ${hotel.code}  ${hotel.name}`);
}
if (output.unmappedCountryCodes.length > 0) {
  console.error(`以下国家代码不在 src/countries.mjs 映射表内,请补表后重跑(已缓存,不会重新请求):`);
  for (const { code, count } of output.unmappedCountryCodes) console.error(`  ${code} ×${count}`);
}

// 矛盾清单(人工核对用):坐标判定的大洲与 Hilton Region 严格矛盾的两条口径
// (Europe/Africa 与大洲一一对应;Americas / Asia Pacific / Middle East 跨多洲,不在此列)
const REGION_STRICT_CONTINENT = { Europe: '欧洲', Africa: '非洲' };
const mismatches = output.hotels.filter(
  (h) => REGION_STRICT_CONTINENT[h.region] && h.continent && h.continent !== REGION_STRICT_CONTINENT[h.region],
);
for (const hotel of mismatches) {
  console.error(`矛盾:Hilton Region=${hotel.region} 但坐标判定 ${hotel.continent}(${hotel.country})→ ${hotel.code}  ${hotel.name}`);
}

const failed = output.hotels.filter((h) => h.coordinateSource === 'failed');
if (failed.length > 0) {
  console.error(`以下 ${failed.length} 家两轮编码均失败,请在 ${values.overrides} 补坐标:`);
  for (const hotel of failed) console.error(`  ${hotel.code}  ${hotel.name}`);
}
const knownCodes = new Set(output.hotels.map((h) => h.code));
for (const code of Object.keys(overrides)) {
  if (!knownCodes.has(code)) console.error(`警告:overrides 里的 ${code} 不在页面名单中(名单已变?),未使用`);
}

await saveCache();
await writeFile(values.out, `${JSON.stringify(output, null, 2)}\n`);
console.error(`已写入 ${values.out}`);
