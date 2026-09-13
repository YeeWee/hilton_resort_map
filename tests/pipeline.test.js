import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildHotels } from '../src/pipeline.mjs';

const fixtureHtml = readFileSync(new URL('./fixtures/resort-page.html', import.meta.url), 'utf8');

test('解析 by-brand tab:每家酒店带 hotel code、名称、Brand、官网链接', async () => {
  const { hotels } = await buildHotels({ html: fixtureHtml, geocode: async () => null, maxGeocode: 0 });

  // brand tab 页面顺序前 4 家(仅 region tab 有的 jhmgwwa 补在最后,由去重测试覆盖)
  assert.deepEqual(
    hotels.slice(0, 4).map((h) => h.code),
    ['cuncici', 'rslvhvh', 'frahghi', 'heribqq'],
  );

  const conradTulum = hotels.find((h) => h.code === 'cuncici');
  assert.equal(conradTulum.name, 'Conrad Tulum Riviera Maya');
  assert.equal(conradTulum.brand, 'Conrad Hotels & Resorts');
  assert.equal(conradTulum.url, 'https://www.hilton.com/en/hotels/cuncici-conrad-tulum-riviera-maya/');
});

test('合并 by-region tab 的 Region;仅出现在 brand tab 的酒店 Region 为 null', async () => {
  const { hotels } = await buildHotels({ html: fixtureHtml, geocode: async () => null, maxGeocode: 0 });

  assert.equal(hotels.find((h) => h.code === 'rslvhvh').region, 'Americas');
  assert.equal(hotels.find((h) => h.code === 'frahghi').region, 'Europe');
  assert.equal(hotels.find((h) => h.code === 'heribqq').region, null);
});

test('hotel code 去重:跨品牌重复归首个品牌组;仅 region tab 有的酒店补入且 brand 为 null;总数守恒', async () => {
  const { hotels } = await buildHotels({ html: fixtureHtml, geocode: async () => null, maxGeocode: 0 });

  // brand tab 5 条链接 + region tab 4 条链接,按 code 并集后应为 5 家、各出现一次
  assert.equal(hotels.length, 5);
  const codes = hotels.map((h) => h.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.deepEqual([...codes].sort(), ['cuncici', 'frahghi', 'heribqq', 'jhmgwwa', 'rslvhvh']);

  const rsl = hotels.find((h) => h.code === 'rslvhvh');
  assert.equal(rsl.brand, 'Conrad Hotels & Resorts');
  assert.equal(rsl.name, 'Conrad Las Vegas at Resorts World');

  assert.deepEqual(
    hotels.find((h) => h.code === 'jhmgwwa'),
    {
      code: 'jhmgwwa',
      name: 'Grand Wailea, A Waldorf Astoria Resort',
      brand: null,
      region: 'Americas',
      lat: null,
      lng: null,
      url: 'https://www.hilton.com/en/hotels/jhmgwwa-grand-wailea/',
      coordinateSource: null,
    },
  );
});

test('注入假地理编码器:按页面顺序只对前 maxGeocode 家取坐标,成功记来源,失败显式留空', async () => {
  const geocodeCalls = [];
  const geocode = async (hotel) => {
    geocodeCalls.push(hotel.code);
    if (hotel.code === 'cuncici') return { lat: 20.1308, lng: -87.4663, source: 'json-ld' };
    return null; // 模拟详情页 JSON-LD 缺坐标
  };

  const { hotels } = await buildHotels({ html: fixtureHtml, geocode, maxGeocode: 2 });

  assert.deepEqual(geocodeCalls, ['cuncici', 'rslvhvh']);

  const tulum = hotels.find((h) => h.code === 'cuncici');
  assert.equal(tulum.lat, 20.1308);
  assert.equal(tulum.lng, -87.4663);
  assert.equal(tulum.coordinateSource, 'json-ld');

  const rsl = hotels.find((h) => h.code === 'rslvhvh');
  assert.equal(rsl.lat, null);
  assert.equal(rsl.lng, null);
  assert.equal(rsl.coordinateSource, null);

  assert.equal(hotels.find((h) => h.code === 'frahghi').coordinateSource, null);
});
