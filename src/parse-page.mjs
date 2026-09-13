import * as cheerio from 'cheerio';

// 页面结构(服务端渲染):
//   <div id="HotelsByBrand">  内含 role="tablist" 的品牌按钮 + role="tabpanel" 的品牌组
//   <div id="HotelsByRegion"> 同构,按钮文字为 Region
// tabpanel 通过 aria-labelledby 指回按钮 id;组内酒店为 <a href="…/en/hotels/<code>-<slug>[/...]">。
// 同一家酒店会以桌面/移动、尾斜杠等变体重复出现,去重一律以链接中的 hotel code 为准。

// 链接形态:/en/hotels/<code>-<slug>[/…] —— 允许尾斜杠与 /rooms/ 等子路径,slug 取第一段
const HOTEL_LINK_RE = /^\/en\/hotels\/([^/]+)/;

export function extractGroups($, containerId) {
  const container = $(`#${containerId}`);
  const groups = [];
  container.find('[role="tabpanel"]').each((_, panelEl) => {
    const panel = $(panelEl);
    const buttonId = panel.attr('aria-labelledby');
    const label = container.find(`[id="${buttonId}"]`).text().trim();
    const hotels = [];
    panel.find('a[href]').each((__, a) => {
      const href = $(a).attr('href');
      const path = href?.replace(/^https?:\/\/[^/]+/, '');
      const match = HOTEL_LINK_RE.exec(path ?? '');
      if (!match) return;
      hotels.push({
        code: match[1].split('-')[0],
        name: $(a).text().trim(),
        url: href,
      });
    });
    if (label) groups.push({ label, hotels });
  });
  return groups;
}

export function parsePage(html) {
  const $ = cheerio.load(html);
  return {
    brandGroups: extractGroups($, 'HotelsByBrand'),
    regionGroups: extractGroups($, 'HotelsByRegion'),
  };
}
