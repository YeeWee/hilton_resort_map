import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createJsonLdGeocoder, createNominatimGeocoder, withFallback } from '../src/geocoders.mjs';

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
      json: async () => [{ lat: '20.3582784', lon: '-87.3375665', name: 'Conrad Tulum Riviera Maya' }],
    };
  };

  const geocode = createNominatimGeocoder({ fetchImpl: jsonFetch, delayMs: 0 });
  const result = await geocode({ code: 'cuncici', name: 'Conrad Tulum Riviera Maya', url: 'https://www.hilton.com/en/hotels/cuncici-conrad-tulum-riviera-maya/' });

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
