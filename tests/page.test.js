import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createStaticServer } from '../scripts/serve.mjs';

// 接缝 2(页面整体):headless 浏览器加载页面 + fixture 版 hotels.json,
// 断言用户可见的 DOM 行为。第三方库与页面同源加载(vendor/),底图瓦片(CARTO)
// 在路由层由本地副本应答,fixture JSON 注入数据;全程不碰网络——
// 任何回潮的外链资源(unpkg 等)都会落入 externalRequests 让测试变红。

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const TILE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function openPage(t, { viewport } = {}) {
  const fixtureJson = await readFile(new URL('./fixtures/hotels.fixture.json', import.meta.url), 'utf8');
  const server = createStaticServer(repoRoot);
  const baseUrl = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(() => server.close());

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());

  const context = await browser.newContext(viewport ? { viewport } : {});
  t.after(() => context.close());

  const externalRequests = [];
  const tileRequests = [];
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.includes('/data/hotels.json')) {
      return route.fulfill({ body: fixtureJson, contentType: 'application/json; charset=utf-8' });
    }
    if (url.includes('basemaps.cartocdn.com')) {
      tileRequests.push(url);
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
  return { page, externalRequests, tileRequests };
}

// fixture 名单(7 家):Conrad×2 与 Hilton×1 同在上海(共 3 家聚成一簇,国家均为中国),
// DoubleTree 柏林、Hilton 纽约、无品牌悉尼各自独立,Hilton×1 无坐标不上图、国家亦未标注。

test('页面整体:fixture JSON → marker/聚合/popup/侧边栏三级树/统计', async (t) => {
  const { page, externalRequests } = await openPage(t);

  // 统计行:共 N 家 / M 个品牌 / K 个国家(7 家 / 3 个品牌 / 4 个国家,无坐标酒店不计国家)
  await page.waitForSelector('#stats:has-text("共 7 家 / 3 个品牌 / 4 个国家")');

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
  await page.locator('.marker-cluster').click();
  await page.waitForFunction(
    () => document.querySelectorAll('.marker-cluster').length === 0
      && document.querySelectorAll('.hotel-marker').length === 3,
  );

  // 直接点击 marker 弹出 popup:含酒店名/Brand/地区(Region · 国家)/官网链接
  await page.locator('.hotel-marker').first().click();
  const popup = page.locator('.leaflet-popup-content');
  await popup.waitFor();
  const popupText = await popup.innerText();
  assert.match(popupText, /品牌/);
  assert.match(popupText, /地区:Asia Pacific · 中国/);
  assert.ok(await popup.locator('a[href^="https://www.hilton.com/"]').first().getAttribute('href'));

  // 侧边栏大洲→国家→酒店三级树:大洲数量降序、未标注置底,组头带计数
  const continentNames = await page.locator('#geo-tree .continent-group > summary .geo-name').allInnerTexts();
  assert.deepEqual(continentNames, ['亚洲', '北美洲', '大洋洲', '欧洲', '未标注大洲']);
  const asia = page.locator('#geo-tree .continent-group', { hasText: '亚洲' });
  assert.match(await asia.locator('> summary').innerText(), /3 家/);

  // 展开亚洲 → 中国;展开中国 → 3 家酒店
  await asia.locator('> summary').click();
  const china = asia.locator('.country-group', { hasText: '中国' });
  assert.equal(await china.count(), 1);
  assert.match(await china.locator('> summary').innerText(), /3 家/);
  await china.locator('> summary').click();
  assert.equal(await china.locator('.hotel-item').count(), 3);

  // 展开北美洲 → 美国,点击纽约酒店 → 地图定位并打开该酒店的 popup
  const northAmerica = page.locator('#geo-tree .continent-group', { hasText: '北美洲' });
  await northAmerica.locator('> summary').click();
  await northAmerica.locator('.country-group', { hasText: '美国' }).locator('> summary').click();
  await northAmerica.locator('.hotel-item', { hasText: 'Hotel D New York' }).click();
  await page.waitForFunction(() => document.querySelector('.leaflet-popup-content')?.textContent.includes('Hotel D New York'));

  // 无坐标酒店:列在"未标注大洲 → 未标注国家"下但不可定位
  const unknown = page.locator('#geo-tree .continent-group', { hasText: '未标注大洲' });
  await unknown.locator('> summary').click();
  const unknownCountry = unknown.locator('.country-group', { hasText: '未标注国家' });
  await unknownCountry.locator('> summary').click();
  const noCoords = unknownCountry.locator('.hotel-item', { hasText: 'Hotel E No Coords' });
  assert.equal(await noCoords.count(), 1);
  assert.equal(await noCoords.isDisabled(), true);
  assert.match(await noCoords.innerText(), /暂无坐标/);

  // 测试全程不碰网络:同源请求之外的一切(包括回潮的 unpkg 外链)都被记录且为空
  assert.deepEqual(externalRequests, []);
});

test('页面整体:国家勾选与品牌图例 AND 叠加,树计数联动,重置一键勾回', async (t) => {
  const { page, externalRequests } = await openPage(t);

  await page.waitForSelector('#stats:has-text("共 7 家 / 3 个品牌 / 4 个国家")');
  await page.waitForFunction(() => document.querySelectorAll('.hotel-marker').length === 3);
  assert.equal((await page.locator('.marker-cluster').innerText()).trim(), '3');

  // 展开亚洲 → 中国,准备勾选
  const asia = page.locator('#geo-tree .continent-group', { hasText: '亚洲' });
  await asia.locator('> summary').click();
  const china = asia.locator('.country-group', { hasText: '中国' });
  await china.locator('> summary').click();
  assert.equal(await china.locator('.hotel-item').count(), 3);

  // 取消勾选中国:上海 marker(含簇)从地图消失,酒店行隐藏;
  // 国家节点常驻(计数不变、仍展开),可随时勾回
  await china.locator('.geo-toggle').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.hotel-marker').length === 3);
  await page.waitForFunction(() => document.querySelectorAll('.marker-cluster').length === 0);
  assert.match(await china.locator('> summary').innerText(), /3 家/);
  assert.equal(await china.locator('.hotel-item').count(), 0);
  assert.equal(await china.getAttribute('class'), 'country-group geo-off');
  assert.equal(await china.locator('> summary .geo-toggle').first().isChecked(), false);

  // 勾回中国:marker 与酒店行恢复
  await china.locator('> summary .geo-toggle').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.marker-cluster').length === 1);
  assert.equal(await china.locator('.hotel-item').count(), 3);

  // 与品牌图例 AND 叠加:隐藏 Conrad 后,中国的计数 3 → 1(剩 Hilton 一家),节点保留
  const conradItem = page.locator('#legend .legend-item', { hasText: 'Conrad Hotels & Resorts' });
  await conradItem.click();
  await page.waitForFunction(
    () => document.querySelectorAll('.marker-cluster').length === 0
      && document.querySelectorAll('.hotel-marker').length === 4,
  );
  assert.equal(await asia.count(), 1);
  assert.match(await china.locator('> summary').innerText(), /1 家/);
  assert.equal(await china.locator('.hotel-item').count(), 1);

  // 再隐藏 Hilton:中国计数归 0(纽约酒店同属 Hilton 也被藏),国家节点连同亚洲整级隐藏
  const hiltonItem = page.locator('#legend .legend-item', { hasText: 'Hilton Hotels & Resorts' });
  await hiltonItem.click();
  await page.waitForFunction(() => document.querySelectorAll('.hotel-marker').length === 2);
  assert.equal(await asia.count(), 0);
  // 只剩大洋洲(无品牌悉尼)与欧洲(柏林)两洲有可见酒店
  assert.equal(await page.locator('#geo-tree .continent-group').count(), 2);

  // 被隐藏品牌的酒店行不再出现在树里(点击恢复品牌的旧路径不复存在)
  assert.equal(await page.locator('#geo-tree .hotel-item', { hasText: 'Hotel A Shanghai' }).count(), 0);

  // 隐藏品牌不改变图例自身计数(图例计数保持全量)
  assert.match(await conradItem.innerText(), /(^|\D)2(\D|$)/);

  // 重新显示 Conrad 与 Hilton:亚洲/中国按品牌重建
  await conradItem.click();
  await hiltonItem.click();
  await page.waitForFunction(
    () => document.querySelectorAll('.marker-cluster').length === 1
      && document.querySelector('.marker-cluster').textContent.trim() === '3',
  );
  assert.equal(await page.locator('#geo-tree .continent-group', { hasText: '亚洲' }).count(), 1);

  // 取消勾选两个国家 → 地图只剩纽约/悉尼;重置一键勾回(图例筛选不受影响)
  const europe = page.locator('#geo-tree .continent-group', { hasText: '欧洲' });
  await europe.locator('> summary').click();
  const germany = europe.locator('.country-group', { hasText: '德国' });
  await germany.locator('.geo-toggle').first().click();
  await china.locator('> summary .geo-toggle').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.hotel-marker').length === 2);
  await page.locator('#geo-reset').click();
  await page.waitForFunction(
    () => document.querySelectorAll('.marker-cluster').length === 1
      && document.querySelectorAll('.hotel-marker').length === 3,
  );
  assert.equal(await page.locator('#geo-tree .hotel-item').count(), 7); // 全部酒店行,含禁用的无坐标酒店
  assert.equal(await germany.locator('> summary .geo-toggle').first().isChecked(), true);

  // 大洲复选框 = 其下全部国家:取消勾选亚洲即上海整体消失,勾回恢复
  await asia.locator('> summary .geo-toggle').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.hotel-marker').length === 3);
  await asia.locator('> summary .geo-toggle').first().click();
  await page.waitForFunction(
    () => document.querySelectorAll('.marker-cluster').length === 1
      && document.querySelector('.marker-cluster').textContent.trim() === '3',
  );

  // 配色贯穿 marker/图例/popup:同一品牌三处颜色一致
  const legendColor = await hiltonItem.locator('.chip').evaluate((el) => getComputedStyle(el).backgroundColor);
  const northAmerica = page.locator('#geo-tree .continent-group', { hasText: '北美洲' });
  await northAmerica.locator('> summary').click();
  await northAmerica.locator('.country-group', { hasText: '美国' }).locator('> summary').click();
  await northAmerica.locator('.hotel-item', { hasText: 'Hotel D New York' }).click();
  await page.waitForFunction(() => document.querySelector('.leaflet-popup-content')?.textContent.includes('Hotel D New York'));
  const markerColor = await page.locator('.hotel-marker span').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  const popupChipColor = await page.locator('.leaflet-popup-content .chip').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(legendColor, markerColor);
  assert.equal(legendColor, popupChipColor);

  // 测试全程不碰网络:同源请求之外的一切(包括回潮的 unpkg 外链)都被记录且为空
  assert.deepEqual(externalRequests, []);
});

test('页面整体(移动视口 390×844):抽屉式边栏默认收起、汉堡开合、筛选联动、遮罩关闭', async (t) => {
  const { page, externalRequests } = await openPage(t, { viewport: { width: 390, height: 844 } });

  await page.waitForSelector('#stats:has-text("共 7 家 / 3 个品牌 / 4 个国家")');
  await page.waitForFunction(() => document.querySelectorAll('.hotel-marker').length === 3);

  // 首屏默认收起:抽屉离屏不可见,地图占满视口宽,按钮语义=收起态(aria-expanded 应为 false)
  assert.equal(await page.locator('#sidebar').evaluate((el) => el.classList.contains('drawer-open')), false);
  const sideClosed = await page.locator('#sidebar').boundingBox();
  assert.ok(sideClosed !== null && sideClosed.x < 0, `抽屉应默认离屏:left=${sideClosed?.x}`);
  const mapClosed = await page.locator('#map').boundingBox();
  assert.equal(Math.round(mapClosed.width), 390); // 地图占满视口宽
  assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'), 'false');

  // 点顶栏汉堡 → 抽屉滑入视野,内含可折叠品牌筛选条 + 地理树;地图宽度不变(不触发 invalidateSize 路径)
  await page.locator('#sidebar-toggle').click();
  await page.waitForFunction(() => document.querySelector('#sidebar').classList.contains('drawer-open'));
  // 等 0.25s 滑入过渡结束后再量几何
  await page.waitForFunction(() => document.querySelector('#sidebar').getBoundingClientRect().left >= 0);
  const sideOpen = await page.locator('#sidebar').boundingBox();
  assert.ok(sideOpen.x >= 0, `抽屉应滑入视野、左缘>=0:left=${sideOpen.x}`);
  assert.ok(sideOpen.width <= 360); // min(88vw,360px) → 88vw=343 < 360
  assert.equal(await page.locator('#brand-items .legend-item').count(), 4); // fixture 3 品牌 + 未标注品牌
  assert.equal(await page.locator('#geo-tree').count(), 1);
  const mapOpen = await page.locator('#map').boundingBox();
  assert.equal(Math.round(mapOpen.width), 390); // 抽屉开合不改变地图尺寸

  // 抽屉内地理树联动:展开亚洲→中国,取消勾选中国则上海 cluster 消失
  const asia = page.locator('#geo-tree .continent-group', { hasText: '亚洲' });
  await asia.locator('> summary').click();
  const china = asia.locator('.country-group', { hasText: '中国' });
  await china.locator('> summary').click();
  assert.equal(await china.locator('.hotel-item').count(), 3);
  await china.locator('.geo-toggle').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.marker-cluster').length === 0);
  assert.equal(await china.locator('.hotel-item').count(), 0);
  await china.locator('> summary .geo-toggle').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.marker-cluster').length === 1);

  // 抽屉内品牌筛选条联动:隐藏 Conrad → 上海簇拆散为 1 家 Hilton;桌面 #legend 副本 aria-pressed 同步
  const conrad = page.locator('#brand-items .legend-item', { hasText: 'Conrad Hotels & Resorts' });
  await conrad.click();
  await page.waitForFunction(
    () => document.querySelectorAll('.marker-cluster').length === 0
      && document.querySelectorAll('.hotel-marker').length === 4,
  );
  assert.equal(await conrad.getAttribute('aria-pressed'), 'false');
  assert.equal(
    await page.locator('#legend .legend-item', { hasText: 'Conrad Hotels & Resorts' }).getAttribute('aria-pressed'),
    'false',
  );
  await conrad.click();
  await page.waitForFunction(() => document.querySelectorAll('.marker-cluster').length === 1);

  // 三种关闭方式其一:点击半透明遮罩(抽屉右侧可见区域)→ 抽屉收起、地图回全屏
  await page.locator('#drawer-backdrop').click({ position: { x: 370, y: 400 } });
  await page.waitForFunction(() => !document.querySelector('#sidebar').classList.contains('drawer-open'));
  // 等收起过渡结束:抽屉重新离屏
  await page.waitForFunction(() => document.querySelector('#sidebar').getBoundingClientRect().left < -100);
  assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'), 'false');
  const sideClosedAgain = await page.locator('#sidebar').boundingBox();
  assert.ok(sideClosedAgain.x < 0);

  // 顶栏按钮再开,抽屉内 ✕ 再关(三种关闭路径覆全)
  await page.locator('#sidebar-toggle').click();
  await page.waitForFunction(() => document.querySelector('#sidebar').classList.contains('drawer-open'));
  await page.locator('#drawer-close').click();
  await page.waitForFunction(() => !document.querySelector('#sidebar').classList.contains('drawer-open'));

  // 测试全程不碰网络
  assert.deepEqual(externalRequests, []);
});

test('页面整体(最窄手机视口 320×568):抽屉收窄适配、三级树不横向溢出', async (t) => {
  const { page } = await openPage(t, { viewport: { width: 320, height: 568 } });

  await page.waitForSelector('#stats:has-text("共 7 家 / 3 个品牌 / 4 个国家")');
  await page.waitForFunction(() => document.querySelectorAll('.hotel-marker').length === 3);

  // 最窄手机:抽屉宽度跟随 88vw(320×0.88=281<360),收起时地图占满视口
  assert.equal(Math.round((await page.locator('#map').boundingBox()).width), 320);
  await page.locator('#sidebar-toggle').click();
  await page.waitForFunction(() => document.querySelector('#sidebar').classList.contains('drawer-open'));
  await page.waitForFunction(() => document.querySelector('#sidebar').getBoundingClientRect().left >= 0);
  const side = await page.locator('#sidebar').boundingBox();
  assert.equal(Math.round(side.width), 282); // 88vw → 281.6 向上取整为宽
  assert.ok(side.width <= 320);

  // 三级树在收窄抽屉内不横向溢出:整棵 geo-tree 与每洲 summary 都落在抽屉内
  const overflow = await page.evaluate(() => {
    const sidebar = document.querySelector('#sidebar').getBoundingClientRect();
    const tree = document.querySelector('#geo-tree').getBoundingClientRect();
    const summaries = [...document.querySelectorAll('#geo-tree summary')]
      .map((el) => el.getBoundingClientRect());
    const within = (r) => r.left >= sidebar.left - 1 && r.right <= sidebar.right + 1;
    return { treeOk: within(tree), summariesOk: summaries.every(within) };
  });
  assert.ok(overflow.treeOk, 'geo-tree 不应横向溢出抽屉');
  assert.ok(overflow.summariesOk, '三级树 summary 不应横向溢出抽屉');
});

test('页面整体:底图瓦片请求携带 CARTO api key', async (t) => {
  const { page, tileRequests } = await openPage(t);

  // 等首块瓦片真正加载完成,再核对实际发出的请求 URL
  await page.waitForFunction(() => document.querySelector('.leaflet-tile-loaded') !== null);
  assert.ok(tileRequests.length > 0, '应发出底图瓦片请求');
  assert.ok(
    tileRequests.every((url) => url.includes('/rastertiles/voyager/')),
    `底图应仍走 voyager rastertiles:首条 ${tileRequests[0]}`,
  );
  assert.ok(
    tileRequests.every((url) => url.includes('key=cb1_3j9m_1_9b078866ec04f2fd9b6a45d4')),
    `瓦片请求应携带 api key:首条 ${tileRequests[0]}`,
  );
});

// 静态断言:只看 index.html 的事实——<link href> / <script src> 不得引用 http(s)
// 或协议相对(//host)外链资源(<a> 链接不限),守住"JS/CSS 全部自托管"不被无声破坏。
test('页面静态:index.html 的 <link>/<script> 不得引用外链资源', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const tags = html.match(/<(?:link|script)\b[^>]*>/gi) ?? [];
  const externals = tags.filter((tag) => /\s(?:href|src)\s*=\s*["'](?:https?:)?\/\//i.test(tag));
  assert.deepEqual(externals, [], `index.html 不得引用外链资源(自托管见 scripts/vendor.mjs):${externals.join(' ; ')}`);
});
