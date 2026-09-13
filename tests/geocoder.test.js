import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createJsonLdGeocoder, createNominatimGeocoder, createNominatimReverseCountryGeocoder, withFallback } from '../src/geocoders.mjs';

const withGeo = readFileSync(new URL('./fixtures/hotel-detail-jsonld.html', import.meta.url), 'utf8');
const noGeo = readFileSync(new URL('./fixtures/hotel-detail-no-geo.html', import.meta.url), 'utf8');
// Hilton 详情页也用 @graph 包裹多个 JSON-LD 节点
const withGraph = `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'WebSite', name: 'Hilton' },
    { '@type': 'Resort', name: 'Aulus Chania Resort', geo: { '@type': 'GeoCoordinates', latitude: 35.5168, longitude: 24.0999 } },
  ],
})}</script></head><body></body></html>`;

function fakeFetch(pagesByUrl) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push({ url, at: Date.now() });
    const html = pagesByUrl[url];
    if (html === undefined) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => html };
  };
  return { fetchImpl, calls };
}

test('JSON-LD 地理编码:从详情页提取坐标,并把 /rooms/ 变体规范化为属性页 URL', async () => {
  const canonical = 'https://www.hilton.com/en/hotels/cuncici-conrad-tulum-riviera-maya/';
  const { fetchImpl, calls } = fakeFetch({ [canonical]: withGeo });
  const geocode = createJsonLdGeocoder({ fetchImpl, delayMs: 0 });

  const result = await geocode({ code: 'cuncici', url: `${canonical}rooms/deluxe-suite/` });

  assert.deepEqual(result, { lat: 20.1308, lng: -87.4663, source: 'json-ld' });
  assert.equal(calls[0].url, canonical);
});

test('JSON-LD 地理编码:@graph 包裹的坐标也能提取', async () => {
  const { fetchImpl } = fakeFetch({ 'https://www.hilton.com/en/hotels/heribqq-aulus-chania-resort/': withGraph });
  const geocode = createJsonLdGeocoder({ fetchImpl, delayMs: 0 });

  const result = await geocode({ code: 'heribqq', url: 'https://www.hilton.com/en/hotels/heribqq-aulus-chania-resort/' });

  assert.deepEqual(result, { lat: 35.5168, lng: 24.0999, source: 'json-ld' });
});

test('JSON-LD 地理编码:无 geo、页面不存在时显式返回 null,不抛错', async () => {
  const { fetchImpl } = fakeFetch({
    'https://www.hilton.com/en/hotels/rslvhvh-resorts-world-las-vegas/': noGeo,
  });
  const geocode = createJsonLdGeocoder({ fetchImpl, delayMs: 0 });

  assert.equal(await geocode({ code: 'rslvhvh', url: 'https://www.hilton.com/en/hotels/rslvhvh-resorts-world-las-vegas/' }), null);
  assert.equal(await geocode({ code: 'gone99x', url: 'https://www.hilton.com/en/hotels/gone99x-vanished-hotel/' }), null);
});

test('JSON-LD 地理编码:连续 403 触发熔断,后续调用不再发请求(避免全量运行时空打被拒页面)', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: false, status: 403, text: async () => '' };
  };
  const geocode = createJsonLdGeocoder({ fetchImpl, delayMs: 0, logger: { warn() {} } });

  for (let i = 0; i < 7; i++) {
    assert.equal(await geocode({ code: `hot${i}xx`, url: `https://www.hilton.com/en/hotels/hot${i}xx-some-hotel/` }), null);
  }

  assert.equal(calls.length, 5, `前 5 次发请求,之后熔断;实际发了 ${calls.length} 次`);
});

test('连续编码时礼貌限速:两次请求间隔不小于 delayMs', async () => {
  const { fetchImpl, calls } = fakeFetch({
    'https://www.hilton.com/en/hotels/cuncici-conrad-tulum-riviera-maya/': withGeo,
    'https://www.hilton.com/en/hotels/frahghi-hilton-frankfurt-gravenbruch/': withGeo,
  });
  const geocode = createJsonLdGeocoder({ fetchImpl, delayMs: 25 });

  await geocode({ code: 'cuncici', url: 'https://www.hilton.com/en/hotels/cuncici-conrad-tulum-riviera-maya/' });
  await geocode({ code: 'frahghi', url: 'https://www.hilton.com/en/hotels/frahghi-hilton-frankfurt-gravenbruch/' });

  assert.ok(calls.length === 2);
  assert.ok(calls[1].at - calls[0].at >= 15, `间隔 ${calls[1].at - calls[0].at}ms 应 >= 15ms`);
});

test('Nominatim 回落:按酒店名查询,取首个结果的坐标,来源为 nominatim', async () => {
  const calls = [];
  const jsonFetch = async (url) => {
    calls.push({ url, at: Date.now() });
    return {
      ok: true,
      status: 200,
      json: async () => [{ lat: '20.3582784', lon: '-87.3375665', category: 'tourism', type: 'hotel', name: 'Conrad Tulum Riviera Maya' }],
    };
  };

  const geocode = createNominatimGeocoder({ fetchImpl: jsonFetch, delayMs: 0 });
  const result = await geocode({ code: 'cuncici', name: 'Conrad Tulum Riviera Maya', region: 'Americas', url: 'https://www.hilton.com/en/hotels/cuncici-conrad-tulum-riviera-maya/' });

  assert.deepEqual(result, { lat: 20.3582784, lng: -87.3375665, source: 'nominatim' });
  assert.match(calls[0].url, /nominatim\.openstreetmap\.org\/search\?format=jsonv2&limit=1&q=/);
});

test('Nominatim 回落:无结果、HTTP 错误、请求异常都显式返回 null', async () => {
  const jsonFetch = async (url) => {
    if (url.includes('q=Unknown')) return { ok: true, status: 200, json: async () => [] };
    if (url.includes('q=Blocked')) return { ok: false, status: 429, json: async () => [] };
    throw new Error('network down');
  };
  const geocode = createNominatimGeocoder({ fetchImpl: jsonFetch, delayMs: 0, logger: { warn() {} } });

  assert.equal(await geocode({ code: 'aaaaaaa', name: 'Unknown Hotel', url: 'u' }), null);
  assert.equal(await geocode({ code: 'bbbbbbb', name: 'Blocked Hotel', url: 'u' }), null);
  assert.equal(await geocode({ code: 'ccccccc', name: 'Offline Hotel', url: 'u' }), null);
});

test('Nominatim 回落:只接受酒店类 POI,拒绝城市边界等非酒店结果', async () => {
  const jsonFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [{ lat: '42.0095', lon: '12.8384', category: 'boundary', type: 'administrative', name: 'San Polo dei Cavalieri' }],
  });
  const geocode = createNominatimGeocoder({ fetchImpl: jsonFetch, delayMs: 0, logger: { warn() {} } });

  assert.equal(await geocode({ code: 'romhiwa', name: 'Rome Cavalieri', region: 'Europe' }), null);
});

test('Nominatim 回落:结果落在酒店 Region 之外时拒绝(防同名误配)', async () => {
  // Americas 酒店查到意大利的同名 POI → 拒绝
  const jsonFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [{ lat: '43.5378', lon: '11.4134', category: 'tourism', type: 'camp_site', name: 'Camping Village Orlando' }],
  });
  const geocode = createNominatimGeocoder({ fetchImpl: jsonFetch, delayMs: 0, logger: { warn() {} } });

  assert.equal(await geocode({ code: 'orltuvh', name: 'Tuscany Village Orlando', region: 'Americas' }), null);
  // Region 缺失时不做地区判断,仅类型守卫生效
  assert.equal(
    await geocode({ code: 'orltuvh', name: 'Tuscany Village Orlando', region: null }),
    null,
  );
});

test('Nominatim 回落:按名回落时先查全名,再查去掉 Hilton 品牌词的变体', async () => {
  const queries = [];
  const jsonFetch = async (url) => {
    queries.push(decodeURIComponent(url.split('q=')[1]));
    if (queries.length < 2) return { ok: true, status: 200, json: async () => [] };
    return {
      ok: true,
      status: 200,
      json: async () => [{ lat: '39.4772', lon: '-106.0502', category: 'tourism', type: 'hotel', name: 'Valdoro Mountain Lodge' }],
    };
  };
  const geocode = createNominatimGeocoder({ fetchImpl: jsonFetch, delayMs: 0 });

  const result = await geocode({
    code: 'qkbvagv',
    name: 'Hilton Grand Vacations Club Valdoro Mountain Lodge Breckenridge',
    region: 'Americas',
  });

  assert.deepEqual(queries, [
    'Hilton Grand Vacations Club Valdoro Mountain Lodge Breckenridge',
    'Valdoro Mountain Lodge Breckenridge',
  ]);
  assert.deepEqual(result, { lat: 39.4772, lng: -106.0502, source: 'nominatim' });
});

test('Nominatim 回落:变体覆盖尾部品牌注记;全部变体失败才返回 null', async () => {
  const queries = [];
  const jsonFetch = async (url) => {
    queries.push(decodeURIComponent(url.split('q=')[1]));
    return { ok: true, status: 200, json: async () => [] };
  };
  const geocode = createNominatimGeocoder({ fetchImpl: jsonFetch, delayMs: 0, logger: { warn() {} } });

  assert.equal(
    await geocode({ code: 'flldhsa', name: 'Signia Hilton Diplomat Beach Resort', region: 'Americas' }),
    null,
  );
  assert.deepEqual(queries, ['Signia Hilton Diplomat Beach Resort', 'Diplomat Beach Resort']);
});

test('Nominatim 回落:变体覆盖尾注 ", a Hilton Resort" 一类写法', async () => {
  const queries = [];
  const jsonFetch = async (url) => {
    queries.push(decodeURIComponent(url.split('q=')[1]));
    if (queries.length < 2) return { ok: true, status: 200, json: async () => [] };
    return {
      ok: true,
      status: 200,
      json: async () => [{ lat: '20.6831', lon: '-156.4413', category: 'tourism', type: 'hotel', name: 'Grand Wailea' }],
    };
  };
  const geocode = createNominatimGeocoder({ fetchImpl: jsonFetch, delayMs: 0 });

  const result = await geocode({
    code: 'jhmgwwa',
    name: 'Grand Wailea, A Waldorf Astoria Resort',
    region: 'Americas',
  });

  assert.deepEqual(queries, ['Grand Wailea, A Waldorf Astoria Resort', 'Grand Wailea']);
  assert.deepEqual(result, { lat: 20.6831, lng: -156.4413, source: 'nominatim' });
});

test('回落组合:首选失败时采用回落结果,来源跟随实际提供者', async () => {
  const calls = [];
  const primary = async (hotel) => {
    calls.push(`primary:${hotel.code}`);
    return null;
  };
  const fallback = async (hotel) => {
    calls.push(`fallback:${hotel.code}`);
    return { lat: 1, lng: 2, source: 'nominatim' };
  };

  const geocode = withFallback(primary, fallback);
  assert.deepEqual(await geocode({ code: 'cuncici' }), { lat: 1, lng: 2, source: 'nominatim' });
  assert.deepEqual(calls, ['primary:cuncici', 'fallback:cuncici']);
});

test('Nominatim reverse:按坐标查国家代码,小写结果归一为大写', async () => {
  const calls = [];
  const jsonFetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ address: { country_code: 'ae', country: 'United Arab Emirates' } }) };
  };

  const resolveCountry = createNominatimReverseCountryGeocoder({ fetchImpl: jsonFetch, delayMs: 0 });
  const result = await resolveCountry({ code: 'auhetci', name: 'Conrad Abu Dhabi Etihad Towers', lat: 24.4583909, lng: 54.322254 });

  assert.equal(result, 'AE');
  assert.match(calls[0], /nominatim\.openstreetmap\.org\/reverse\?format=jsonv2&zoom=10&addressdetails=1&lat=24\.4583909&lon=54\.322254/);
});

test('Nominatim reverse:HTTP 错误、请求异常、响应缺地址都显式返回 null', async () => {
  const jsonFetch = async (url) => {
    if (url.includes('lat=1')) return { ok: false, status: 429, json: async () => ({}) };
    if (url.includes('lat=2')) return { ok: true, status: 200, json: async () => ({ error: 'Unable to geocode' }) };
    throw new Error('network down');
  };
  const resolveCountry = createNominatimReverseCountryGeocoder({ fetchImpl: jsonFetch, delayMs: 0, logger: { warn() {} } });

  assert.equal(await resolveCountry({ code: 'aaaaaaa', name: 'Throttled', lat: 1, lng: 2 }), null);
  assert.equal(await resolveCountry({ code: 'bbbbbbb', name: 'Ocean', lat: 2, lng: 3 }), null);
  assert.equal(await resolveCountry({ code: 'ccccccc', name: 'Offline', lat: 3, lng: 4 }), null);
});

test('Nominatim reverse:无坐标的酒店直接返回 null,不发请求', async () => {
  const calls = [];
  const jsonFetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ address: { country_code: 'us' } }) };
  };
  const resolveCountry = createNominatimReverseCountryGeocoder({ fetchImpl: jsonFetch, delayMs: 0 });

  assert.equal(await resolveCountry({ code: 'nocoord', name: 'No Coords', lat: null, lng: null }), null);
  assert.deepEqual(calls, []);
});

test('Nominatim reverse:连续调用时礼貌限速', async () => {
  const calls = [];
  const jsonFetch = async (url) => {
    calls.push({ url, at: Date.now() });
    return { ok: true, status: 200, json: async () => ({ address: { country_code: 'us' } }) };
  };
  const resolveCountry = createNominatimReverseCountryGeocoder({ fetchImpl: jsonFetch, delayMs: 25 });

  await resolveCountry({ code: 'aaaaaaa', name: 'A', lat: 1, lng: 2 });
  await resolveCountry({ code: 'bbbbbbb', name: 'B', lat: 3, lng: 4 });

  assert.equal(calls.length, 2);
  assert.ok(calls[1].at - calls[0].at >= 15, `间隔 ${calls[1].at - calls[0].at}ms 应 >= 15ms`);
});
