import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import { chromium } from 'playwright';
import { createStaticServer } from '../scripts/serve.mjs';

// 接缝 2(页面整体):headless 浏览器加载页面 + fixture 版 hotels.json,
// 断言用户可见的 DOM 行为。所有外部请求(Leaflet CDN、CARTO 底图)在路由层
// 由本地副本应答,fixture JSON 注入数据;全程不碰网络。

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const CDN_FILES = {
  // 与 index.html 引用的 CDN 版本一一对应,升级时两处同步
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css': 'node_modules/leaflet/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js': 'node_modules/leaflet/dist/leaflet.js',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css': 'node_modules/leaflet.markercluster/dist/MarkerCluster.css',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css': 'node_modules/leaflet.markercluster/dist/MarkerCluster.Default.css',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js': 'node_modules/leaflet.markercluster/dist/leaflet.markercluster.js',
};

const TILE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('页面整体:fixture JSON → marker/聚合/popup/侧边栏定位/统计', async (t) => {
  const fixtureJson = await readFile(new URL('./fixtures/hotels.fixture.json', import.meta.url), 'utf8');
  const server = createStaticServer(repoRoot);
  const baseUrl = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(() => server.close());

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());

  const context = await browser.newContext();
  t.after(() => context.close());

  const externalRequests = [];
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url in CDN_FILES) {
      return route.fulfill({ path: `${repoRoot}/${CDN_FILES[url]}` });
    }
    if (url.includes('/data/hotels.json')) {
      return route.fulfill({ body: fixtureJson, contentType: 'application/json; charset=utf-8' });
    }
    if (url.includes('basemaps.cartocdn.com')) {
      return route.fulfill({ body: Buffer.from(TILE_PNG, 'base64'), contentType: 'image/png' });
    }
    if (url.startsWith(baseUrl)) {
      return route.continue();
    }
    externalRequests.push(url);
    return route.abort();
  });

  const page = await context.newPage();
  t.after(() => page.close());
  await page.goto(`${baseUrl}/index.html`, { waitUntil: 'load' });

  // 统计行:共 N 家 / M 个品牌(与 fixture 名单一致:5 家 / 3 个品牌)
  await page.waitForSelector('#stats:has-text("共 5 家 / 3 个品牌")');

  // 初始低缩放:上海两家聚合成 1 个簇(计数 2),柏林/纽约各自独立 marker
  await page.waitForFunction(() => document.querySelectorAll('.hotel-marker').length === 2);
  assert.equal(await page.locator('.marker-cluster').count(), 1);
  assert.equal((await page.locator('.marker-cluster').innerText()).trim(), '2');

  // 缩放驱动的聚合/展开:放大到上海,簇消散为独立 marker;缩回世界级,簇重现
  await page.evaluate(() => window.__map__.setView([31.234, 121.482], 14));
  await page.waitForFunction(
    () => document.querySelectorAll('.marker-cluster').length === 0
      && document.querySelectorAll('.hotel-marker').length === 2,
  );
  await page.evaluate(() => window.__map__.setZoom(2));
  await page.waitForFunction(() => document.querySelectorAll('.marker-cluster').length === 1);

  // 点击簇展开聚合(用户视角的"缩放展开"):簇消失,被聚合的两家分开显示
  // (markercluster 只把视口内的子 marker 渲染进 DOM,故此处计数为视口内的 2 家)
  await page.locator('.marker-cluster').click();
  await page.waitForFunction(
    () => document.querySelectorAll('.marker-cluster').length === 0
      && document.querySelectorAll('.hotel-marker').length === 2,
  );

  // 直接点击 marker 弹出 popup:含酒店名/Brand/Region/官网链接
  await page.locator('.hotel-marker').first().click();
  const popup = page.locator('.leaflet-popup-content');
  await popup.waitFor();
  const popupText = await popup.innerText();
  assert.match(popupText, /品牌/);
  assert.match(popupText, /地区/);
  assert.ok(await popup.locator('a[href^="https://www.hilton.com/"]').first().getAttribute('href'));

  // 侧边栏按 Brand 分组,组头含品牌名与数量
  const conradGroup = page.locator('#brand-groups details', { hasText: 'Conrad Hotels & Resorts' });
  assert.equal(await conradGroup.count(), 1);
  assert.match(await conradGroup.locator('summary').innerText(), /2/);
  assert.equal(await page.locator('#brand-groups details').count(), 3);

  // 侧边栏分组默认折叠;展开 Hilton 组后点击列表项 → 地图定位并打开该酒店的 popup
  const hiltonGroup = page.locator('#brand-groups details', { hasText: 'Hilton Hotels & Resorts' });
  await hiltonGroup.locator('summary').click();
  await page.locator('#brand-groups button', { hasText: 'Hotel D New York' }).click();
  await page.waitForFunction(() => document.querySelector('.leaflet-popup-content')?.textContent.includes('Hotel D New York'));

  // 无坐标酒店:侧边栏列出但不可定位
  const noCoords = page.locator('#brand-groups button', { hasText: 'Hotel E No Coords' });
  assert.equal(await noCoords.count(), 1);
  assert.equal(await noCoords.isDisabled(), true);
  assert.match(await noCoords.innerText(), /暂无坐标/);

  // 测试全程不碰网络:所有请求都被本地应答
  assert.deepEqual(externalRequests, []);
});
