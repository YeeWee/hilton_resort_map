#!/usr/bin/env node
// 数据管线 CLI:保存的页面 HTML → hotels.json
//   node scripts/build-data.mjs [--html data/raw/resort-credit-eligible-hotels.html]
//                               [--out data/hotels.json] [--max-geocode 10]
// 抓取详情页 JSON-LD 坐标时对外部服务礼貌限速(约 1 请求/秒)。
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { buildHotels } from '../src/pipeline.mjs';
import { createJsonLdGeocoder, createNominatimGeocoder, withFallback } from '../src/geocoders.mjs';

const { values } = parseArgs({
  options: {
    html: { type: 'string', default: 'data/raw/resort-credit-eligible-hotels.html' },
    out: { type: 'string', default: 'data/hotels.json' },
    'max-geocode': { type: 'string', default: '10' },
  },
});

const html = await readFile(values.html, 'utf8');
const maxGeocode = Number(values['max-geocode']);

console.error(`解析页面 ${values.html} …`);
// 坐标来源:详情页 JSON-LD 优先,Nominatim 按酒店名回落
const geocode = withFallback(createJsonLdGeocoder({ logger: console }), createNominatimGeocoder({ logger: console }));
const output = await buildHotels({ html, geocode, maxGeocode });

const brandCount = new Set(output.hotels.map((h) => h.brand).filter(Boolean)).size;
const withCoords = output.hotels.filter((h) => h.lat != null).length;
console.error(`共 ${output.hotels.length} 家 / ${brandCount} 个品牌;已取坐标 ${withCoords} 家`);

await writeFile(values.out, `${JSON.stringify(output, null, 2)}\n`);
console.error(`已写入 ${values.out}`);
