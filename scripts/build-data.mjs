#!/usr/bin/env node
// 数据管线 CLI:保存的页面 HTML → hotels.json
//   node scripts/build-data.mjs [--html data/raw/resort-credit-eligible-hotels.html]
//                               [--out data/hotels.json] [--overrides data/overrides.json]
//                               [--max-geocode all|N] [--cache data/raw/geocode-cache.json]
// 坐标兜底次序:详情页 JSON-LD → Nominatim 按酒店名回落 → 人工 overrides;
// 全部失败且已尝试的酒店在产物里显式标记 coordinateSource=failed。
// 对外部服务(Hilton 详情页 / Nominatim)礼貌限速(约 1 请求/秒)。
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { buildHotels } from '../src/pipeline.mjs';
import { createJsonLdGeocoder, createNominatimGeocoder, withFallback } from '../src/geocoders.mjs';
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

// 成功结果缓存(可选):补充 overrides 后重跑时,已编码酒店不再重复请求外部服务
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
    console.error(`坐标缓存已有 ${cache.size} 条,命中者不再请求外部服务`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

console.error(`解析页面 ${values.html} …`);
const geocode = withFallback(createJsonLdGeocoder({ logger: console }), createNominatimGeocoder({ logger: console }));

async function cachedGeocode(hotel) {
  if (cache.has(hotel.code)) return cache.get(hotel.code);
  const result = await geocode(hotel);
  if (result) {
    cache.set(hotel.code, result);
    await saveCache(); // 每次成功即落盘,中断后不重打已成功的外部服务
  }
  return result;
}

const output = await buildHotels({ html, geocode: cachedGeocode, overrides, maxGeocode });

const brandCount = new Set(output.hotels.map((h) => h.brand).filter(Boolean)).size;
const bySource = {};
for (const hotel of output.hotels) bySource[hotel.coordinateSource] = (bySource[hotel.coordinateSource] ?? 0) + 1;
console.error(`共 ${output.hotels.length} 家 / ${brandCount} 个品牌;坐标来源 ${JSON.stringify(bySource)}`);

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
