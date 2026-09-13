import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

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

async function openPage(t) {
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
  return { page, externalRequests };
}

// fixture 名单(7 家):Conrad×2 与 Hilton×1 同在上海(共 3 家聚成一簇),
// DoubleTree 柏林、无品牌悉尼各自独立,Hilton×1 无坐标不上图。

test('页面整体:fixture JSON → marker/聚合/popup/侧边栏定位/统计', async (t) => {
  const { page, externalRequests } = await openPage(t);

  // 统计行:共 N 家 / M 个品牌(与 fixture 名单一致:7 家 / 3 个品牌)
  await page.waitForSelector('#stats:has-text("共 7 家 / 3 个品牌")');

  // 初始低缩放:上海三家聚合成 1 个簇(计数 3),柏林/纽约/悉尼各自独立 marker
  await page.waitForFunction(() => document.querySelectorAll('.hotel-marker').length === 3);
  assert.equal(await page.locator('.marker-cluster').count(), 1);
  assert.equal((await page.locator('.marker-cluster').innerText()).trim(), '3');

  // 缩放驱动的聚合/展开:放大到上海,簇消散为独立 marker;缩回世界级,簇重现
  await page.evaluate(() => window.__map__.setView([31.234, 121.482], 14));
  await page.waitForFunction(
    () => document.querySelectorAll('.marker-cluster').length === 0
      && document.querySelectorAll('.hotel-marker').length === 3,
  );
  await page.evaluate(() => window.__map__.setZoom(2));
  await page.waitForFunction(() => document.querySelectorAll('.marker-cluster').length === 1);

  // 点击簇展开聚合(用户视角的"缩放展开"):簇消失,被聚合的三家分开显示
  // (markercluster 只把视口内的子 marker 渲染进 DOM,故此处计数为视口内的 3 家)
  await page.locator('.marker-cluster').click();
  await page.waitForFunction(
    () => document.querySelectorAll('.marker-cluster').length === 0
      && document.querySelectorAll('.hotel-marker').length === 3,
  );

  // 直接点击 marker 弹出 popup:含酒店名/Brand/Region/官网链接
  await page.locator('.hotel-marker').first().click();
  const popup = page.locator('.leaflet-popup-content');
  await popup.waitFor();
  const popupText = await popup.innerText();
  assert.match(popupText, /品牌/);
  assert.match(popupText, /地区/);
  assert.ok(await popup.locator('a[href^="https://www.hilton.com/"]').first().getAttribute('href'));

  // 侧边栏按 Brand 分组,组头含品牌名与数量;无品牌酒店归入"未标注品牌"置底
  const conradGroup = page.locator('#brand-groups details', { hasText: 'Conrad Hotels & Resorts' });
  assert.equal(await conradGroup.count(), 1);
  assert.match(await conradGroup.locator('summary').innerText(), /2/);
  assert.equal(await page.locator('#brand-groups details').count(), 4);

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

test('页面整体:图例筛选 → 品牌显隐与簇计数联动、配色一致', async (t) => {
  const { page, externalRequests } = await openPage(t);

  await page.waitForSelector('#stats:has-text("共 7 家 / 3 个品牌")');
  await page.waitForFunction(() => document.querySelectorAll('.hotel-marker').length === 3);
  assert.equal((await page.locator('.marker-cluster').innerText()).trim(), '3');

  // 图例显示全部品牌及各自酒店数量(与侧边栏同口径,含无坐标酒店),
  // 排序一致:数量降序,未标注品牌置底
  const legendItems = page.locator('#legend .legend-item');
  assert.equal(await legendItems.count(), 4);
  const legendTexts = await legendItems.allInnerTexts();
  assert.match(legendTexts[0], /Hilton Hotels & Resorts/);
  assert.match(legendTexts[0], /(^|\D)3(\D|$)/);
  assert.match(legendTexts[1], /Conrad Hotels & Resorts/);
  assert.match(legendTexts[1], /(^|\D)2(\D|$)/);
  assert.match(legendTexts[2], /DoubleTree by Hilton/);
  assert.match(legendTexts[2], /(^|\D)1(\D|$)/);
  assert.match(legendTexts[3], /未标注品牌/);
  assert.match(legendTexts[3], /(^|\D)1(\D|$)/);

  // 初始全部品牌可见
  for (const item of await legendItems.all()) {
    assert.equal(await item.getAttribute('aria-pressed'), 'true');
  }

  // 隐藏 Hilton:纽约/悉尼仍独立,上海簇只剩 Conrad 两家 → 簇计数 3 → 2(重算)
  const hiltonItem = page.locator('#legend .legend-item', { hasText: 'Hilton Hotels & Resorts' });
  await hiltonItem.click();
  await page.waitForFunction(() => document.querySelectorAll('.hotel-marker').length === 2);
  await page.waitForFunction(
    () => document.querySelectorAll('.marker-cluster').length === 1
      && document.querySelector('.marker-cluster').textContent.trim() === '2',
  );
  assert.equal(await hiltonItem.getAttribute('aria-pressed'), 'false');

  // 再隐藏 Conrad:上海簇整体消失,地图只剩柏林一家
  const conradItem = page.locator('#legend .legend-item', { hasText: 'Conrad Hotels & Resorts' });
  await conradItem.click();
  await page.waitForFunction(
    () => document.querySelectorAll('.marker-cluster').length === 0
      && document.querySelectorAll('.hotel-marker').length === 2,
  );

  // 重新显示 Conrad:簇按当前可见品牌重建(计数 2)
  await conradItem.click();
  await page.waitForFunction(
    () => document.querySelectorAll('.marker-cluster').length === 1
      && document.querySelector('.marker-cluster').textContent.trim() === '2',
  );

  // 重新显示 Hilton:簇计数回到 3
  await hiltonItem.click();
  await page.waitForFunction(
    () => document.querySelectorAll('.marker-cluster').length === 1
      && document.querySelector('.marker-cluster').textContent.trim() === '3',
  );
  assert.equal(await hiltonItem.getAttribute('aria-pressed'), 'true');

  // 隐藏/显示无品牌酒店(灰点):悉尼独立 marker 随之消失/重现
  const unknownItem = page.locator('#legend .legend-item', { hasText: '未标注品牌' });
  await unknownItem.click();
  await page.waitForFunction(() => document.querySelectorAll('.hotel-marker').length === 2);
  await unknownItem.click();
  await page.waitForFunction(() => document.querySelectorAll('.hotel-marker').length === 3);

  // 隐藏品牌后点击其侧边栏酒店:自动恢复该品牌显示并打开 popup(不飞向不可见 marker)
  await conradItem.click();
  await page.waitForFunction(
    () => document.querySelectorAll('.marker-cluster').length === 0
      && document.querySelectorAll('.hotel-marker').length === 4,
  );
  const conradGroup = page.locator('#brand-groups details', { hasText: 'Conrad Hotels & Resorts' });
  await conradGroup.locator('summary').click();
  await page.locator('#brand-groups button', { hasText: 'Hotel A Shanghai' }).click();
  await page.waitForFunction(() => document.querySelector('.leaflet-popup-content')?.textContent.includes('Hotel A Shanghai'));
  await page.waitForFunction(
    () => document.querySelectorAll('.marker-cluster').length === 1
      && document.querySelector('.marker-cluster').textContent.trim() === '3',
  );
  assert.equal(await conradItem.getAttribute('aria-pressed'), 'true');

  // 配色贯穿 marker/图例/侧边栏:同一品牌三处颜色一致
  const legendColor = await hiltonItem.locator('.chip').evaluate((el) => getComputedStyle(el).backgroundColor);
  const hiltonGroup = page.locator('#brand-groups details', { hasText: 'Hilton Hotels & Resorts' });
  const sidebarColor = await hiltonGroup.locator('summary .chip').evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(legendColor, sidebarColor);
  await hiltonGroup.locator('summary').click();
  await page.locator('#brand-groups button', { hasText: 'Hotel D New York' }).click();
  await page.waitForFunction(() => document.querySelector('.leaflet-popup-content')?.textContent.includes('Hotel D New York'));
  const markerColor = await page.locator('.hotel-marker span').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(legendColor, markerColor);

  // 测试全程不碰网络:所有请求都被本地应答
  assert.deepEqual(externalRequests, []);
});
