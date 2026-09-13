import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildHotels } from '../src/pipeline.mjs';
import { createJsonLdGeocoder, createNominatimGeocoder, withFallback } from '../src/geocoders.mjs';

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
      countryCode: null,
      country: null,
      continent: null,
      lat: null,
      lng: null,
      url: 'https://www.hilton.com/en/hotels/jhmgwwa-grand-wailea/',
      coordinateSource: null,
    },
  );
});

test('国家派生:坐标就绪的酒店经逆编码得 ISO 代码,映射表给出中文名与大洲', async () => {
  const geocode = async (hotel) =>
    hotel.code === 'cuncici'
      ? { lat: 20.1308, lng: -87.4663, source: 'json-ld' }
      : hotel.code === 'rslvhvh'
        ? { lat: 36.1147, lng: -115.1728, source: 'nominatim' }
        : null;
  const resolveCountryCalls = [];
  const resolveCountry = async (hotel) => {
    resolveCountryCalls.push(hotel.code);
    if (hotel.code === 'cuncici') return 'mx'; // 小写也应归一为大写
    if (hotel.code === 'rslvhvh') return 'XX'; // 映射表外的代码
    if (hotel.code === 'heribqq') return 'GR'; // override 坐标同样参与判定
    return null; // 逆编码失败
  };

  // heribqq 走人工 override 坐标,同样应参与国家判定
  const overrides = { heribqq: { lat: 35.5168, lng: 24.0999 } };
  const { hotels, unmappedCountryCodes } = await buildHotels({
    html: fixtureHtml, geocode, resolveCountry, overrides, maxGeocode: 2,
  });

  const tulum = hotels.find((h) => h.code === 'cuncici');
  assert.deepEqual([tulum.countryCode, tulum.country, tulum.continent], ['MX', '墨西哥', '北美洲']);

  const lasVegas = hotels.find((h) => h.code === 'rslvhvh');
  assert.deepEqual([lasVegas.countryCode, lasVegas.country, lasVegas.continent], ['XX', null, null]);

  // override 坐标同样判定国家
  const chania = hotels.find((h) => h.code === 'heribqq');
  assert.deepEqual([chania.countryCode, chania.country, chania.continent], ['GR', '希腊', '欧洲']);

  // 无坐标酒店不做国家判定;逆编码失败保持 null
  assert.deepEqual(resolveCountryCalls.sort(), ['cuncici', 'heribqq', 'rslvhvh']);
  const frankfurt = hotels.find((h) => h.code === 'frahghi');
  assert.deepEqual([frankfurt.countryCode, frankfurt.country, frankfurt.continent], [null, null, null]);

  // 映射表外的代码在返回值里报告,供补表
  assert.deepEqual(unmappedCountryCodes, [{ code: 'XX', count: 1 }]);
});

test('国家派生:未注入逆编码器时字段保持 null(向后兼容)', async () => {
  const { hotels } = await buildHotels({ html: fixtureHtml, geocode: async () => null, maxGeocode: 0 });

  assert.ok(hotels.every((h) => h.countryCode === null && h.country === null && h.continent === null));
});

test('注入假地理编码器:按页面顺序只对前 maxGeocode 家取坐标,成功记来源', async () => {
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

  assert.equal(hotels.find((h) => h.code === 'frahghi').coordinateSource, null);
});

test('显式失败标记:已尝试编码但无坐标记 coordinateSource=failed;未尝试保持 null', async () => {
  const { hotels } = await buildHotels({ html: fixtureHtml, geocode: async () => null, maxGeocode: 2 });

  const failed = hotels.filter((h) => h.coordinateSource === 'failed').map((h) => h.code);
  assert.deepEqual(failed, ['cuncici', 'rslvhvh']); // 已尝试、回落也失败的按页面顺序记 failed
  assert.equal(hotels.find((h) => h.code === 'cuncici').lat, null);
  assert.equal(hotels.find((h) => h.code === 'rslvhvh').lat, null);

  // 未尝试的(超出 maxGeocode)不是失败,保持 null
  assert.equal(hotels.find((h) => h.code === 'frahghi').coordinateSource, null);
  assert.equal(hotels.find((h) => h.code === 'jhmgwwa').coordinateSource, null);
});

test('overrides 合并:编码失败时采用人工坐标记 override;编码成功时不覆盖', async () => {
  const overrides = {
    rslvhvh: { lat: 36.1147, lng: -115.1728 }, // 编码失败的酒店 → 人工坐标生效
    cuncici: { lat: 0, lng: 0 }, // 编码成功的酒店 → 不被 override 覆盖
    heribqq: { lat: 35.5168, lng: 24.0999 }, // 未尝试编码的酒店 → 人工坐标同样生效
  };
  const geocode = async (hotel) =>
    hotel.code === 'cuncici' ? { lat: 20.1308, lng: -87.4663, source: 'json-ld' } : null;

  const { hotels } = await buildHotels({ html: fixtureHtml, geocode, overrides, maxGeocode: 2 });

  const rsl = hotels.find((h) => h.code === 'rslvhvh');
  assert.deepEqual([rsl.lat, rsl.lng, rsl.coordinateSource], [36.1147, -115.1728, 'override']);

  const tulum = hotels.find((h) => h.code === 'cuncici');
  assert.deepEqual([tulum.lat, tulum.lng, tulum.coordinateSource], [20.1308, -87.4663, 'json-ld']);

  const aulus = hotels.find((h) => h.code === 'heribqq');
  assert.deepEqual([aulus.lat, aulus.lng, aulus.coordinateSource], [35.5168, 24.0999, 'override']);
});

test('全链路回落(注入假服务):详情页无 JSON-LD 坐标时按名回落 Nominatim,来源记 nominatim', async () => {
  const detailHtml = readFileSync(new URL('./fixtures/hotel-detail-no-geo.html', import.meta.url), 'utf8');
  const detailUrl = 'https://www.hilton.com/en/hotels/rslvhvh-resorts-world-las-vegas/';
  const fakeHilton = async (url) => (url === detailUrl ? { ok: true, status: 200, text: async () => detailHtml } : { ok: false, status: 404, text: async () => '' });
  const fakeNominatim = async (url) => {
    assert.match(url, /nominatim\.openstreetmap\.org\/search\?format=jsonv2&limit=1&q=/);
    if (!url.includes('q=Conrad%20Las%20Vegas%20at%20Resorts%20World')) {
      return { ok: true, status: 200, json: async () => [] }; // 其余酒店名回落无结果
    }
    return {
      ok: true,
      status: 200,
      json: async () => [{ lat: '36.1147', lon: '-115.1728', category: 'tourism', type: 'hotel', name: 'Conrad Las Vegas at Resorts World' }],
    };
  };

  const geocode = withFallback(
    createJsonLdGeocoder({ fetchImpl: fakeHilton, delayMs: 0, logger: { warn() {} } }),
    createNominatimGeocoder({ fetchImpl: fakeNominatim, delayMs: 0 }),
  );

  const { hotels } = await buildHotels({ html: fixtureHtml, geocode, maxGeocode: 2 });

  const lasVegas = hotels.find((h) => h.code === 'rslvhvh');
  assert.deepEqual([lasVegas.lat, lasVegas.lng, lasVegas.coordinateSource], [36.1147, -115.1728, 'nominatim']);
});
