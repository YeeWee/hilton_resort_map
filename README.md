# Hilton Resort Credit 合格酒店地图

把 Hilton 官方 [Resort Credit Eligible Hotels](https://www.hilton.com/en/p/hilton-honors/resort-credit-eligible-hotels/) 页面列出的酒店呈现在一张 Leaflet 地图上:品牌决定配色与图例筛选,侧边栏按大洲 → 国家 → 酒店三级树组织(勾选筛选)。数据全集就是该页面列出的全部酒店,不多不少;页面顶部显示"共 N 家 / M 个品牌 / K 个国家"供与官方页面核对。术语见 `CONTEXT.md`。

## 目录结构

```
index.html + assets/     纯静态页面(Leaflet / markercluster 走 CDN,底图 CARTO Voyager),零构建
scripts/build-data.mjs   数据管线 CLI
scripts/serve.mjs        零依赖静态服务器(本地预览与页面测试共用)
src/                     管线核心:页面解析、地理编码(回落链)、国家逆编码、overrides 合并
data/hotels.json         生成产物,随代码一并入库;页面运行时 fetch 它
data/overrides.json      人工坐标 overrides(维护指南见下)
tests/                   两条测试接缝(test seam),全程不碰网络
```

## 前置要求

- Node ≥ 20、npm(开发验证环境为 Node 24)。
- `npm test` 的页面测试用本机系统 Chrome(headless),需装有 Google Chrome;无需 `npx playwright install`。

## 快速开始

```bash
npm install        # 安装依赖(cheerio;devDependencies 里有 playwright 供测试用)
npm start          # 启动本地预览,默认 http://localhost:8000/
```

浏览器打开 <http://localhost:8000/>,即可看到地图。核对总数:页面顶栏显示"共 N 家 / M 个品牌",与管线输出、Hilton 官方页面三方一致即数据完整。

## 测试

```bash
npm test
```

两条接缝,全程不碰网络:

1. **管线整体**:保存的页面 HTML fixture + 注入的假地理编码器/国家逆编码器 → 断言 `data/hotels.json` 契约(品牌齐全、hotel code 去重、Region 合并、国家与大洲派生、总数守恒、失败显式标记)。
2. **页面整体**:headless Chrome 加载页面 + fixture 版 hotels.json → 断言用户可见的 DOM 行为(marker 总数、图例筛选、大洲/国家勾选与 AND 叠加、树计数联动、重置、聚合展开、popup 字段、侧边栏定位、统计行)。CDN 与底图在路由层由本地副本应答。

## 重跑管线(名单更新后)

Hilton 名单会变动。重跑以**当次页面**为准,hotel code 不变即视为同一酒店:

```bash
# 1. 保存页面快照(页面为服务端渲染,静态 HTML 里就有全部名单)
curl --create-dirs -A "Mozilla/5.0" -o data/raw/resort-credit-eligible-hotels.html \
  https://www.hilton.com/en/p/hilton-honors/resort-credit-eligible-hotels/

# 2. 重跑管线(建议始终带 --cache,详见下文)
npm run build:data -- --cache data/raw/geocode-cache.json

# 3. 核对总数:结束时会打印"共 N 家 / M 个品牌"与坐标来源分布;再 git add 提交产物
npm start   # 打开页面,确认顶栏数字与之一致
git add data/hotels.json data/overrides.json   # overrides 有变更才需要加第二个
git commit -m "刷新名单"
```

说明:

- **首次全量运行**约 10-20 分钟:管线先逐家抓取 Hilton 详情页 JSON-LD 坐标,缺失时按酒店名回落 Nominatim。对 Hilton 详情页与 Nominatim 均按约 1 请求/秒礼貌限速。Hilton 详情页对部分网络环境一律 403(见 [issue #6](https://github.com/YeeWee/hilton_resort_map/issues/6)),此时 JSON-LD 自动短路(连续 5 次 403 熔断),坐标全部来自 Nominatim 与 overrides。
- **`--cache` 缓存成功结果**:每家编码成功即落盘,中断不重打;补充 overrides 后重跑时,已成功的酒店不再请求外部服务。缓存文件在 `data/raw/`(gitignore),换机器不随仓库走。
- `--max-geocode N` 只对前 N 家取坐标(快速试跑);`--html` / `--out` / `--overrides` 可换输入输出路径。
- 仍失败的酒店会在结束时列到 stderr(见下一节)。

## overrides 维护指南

编码失败或未尝试(`--max-geocode` 截断)的酒店,由人工补坐标兜底,保证全量上图;编码成功的酒店坐标优先,overrides 不会覆盖它们。

> 当前部分网络环境下 Hilton 详情页一律 403(见 [issue #6](https://github.com/YeeWee/hilton_resort_map/issues/6)),JSON-LD 一轮整体缺席,overrides 占比会明显偏高(当前 114/326)——网络环境正常时两轮编码都失败的通常只是极少数。

1. **找出失败者**:重跑管线,结束时 stderr 列出全部 `coordinateSource=failed` 的 `code` 与 `name`;或直接在 `data/hotels.json` 里搜 `"coordinateSource": "failed"`。
2. **查坐标**:任选可靠来源——Hilton 官网酒店页的地图、Nominatim 网页版(<https://nominatim.openstreetmap.org/>)、Google Maps 右键坐标等。小岛型、位于独立园区的酒店注意落到酒店本体而非城镇中心。
3. **补进 `data/overrides.json`**,按 hotel code 为键:
   ```json
   {
     "hghyfci": {
       "name": "Conrad Hangzhou Tonglu",
       "lat": 29.7874,
       "lng": 119.6806,
       "note": "浙江杭州桐庐"
     }
   }
   ```
   `name` / `note` 仅便于人工核对,管线只读 `lat` / `lng`(必须为数字,否则管线报错拒绝启动)。
4. **重跑管线** `npm run build:data -- --cache data/raw/geocode-cache.json`(已成功的酒店走缓存,不再请求外部服务)。
5. 核对 stderr 不再有失败清单、坐标来源分布里 `override` 数量与文件一致,提交 `data/hotels.json` 与 `data/overrides.json`。

> 名单变动后,已下架酒店的 overrides 条目会收到"不在页面名单中"的警告,可留存或清理,不影响运行。

## hotels.json 数据契约

顶层 `{ "generatedAt": "<ISO 时间>", "hotels": [ … ] }`,按页面 by-brand tab 的顺序排列。每家酒店:

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `code` | string | hotel code,取自官网链接 `/en/hotels/<code>-<slug>`,全集内唯一,页面重复变体靠它去重 |
| `name` | string | 酒店名,保留页面原文(不翻译) |
| `brand` | string \| null | Brand,以页面 by-brand tab 分组为准;null = 仅出现在 by-region tab(页面两 tab 更新不同步),页面归入"未标注品牌" |
| `region` | string \| null | Region,取自 by-region tab(Hilton 官网口径,见 `CONTEXT.md`;只作 popup 展示,不参与分组筛选) |
| `countryCode` / `country` / `continent` | string \| null | 国家 ISO 代码与中文名、标准大洲。按坐标做 Nominatim reverse 逆地理编码判定(非官网字段);无坐标、逆编码失败或代码不在 `src/countries.mjs` 映射表时为 null,页面归入"未标注大洲 / 未标注国家"置底 |
| `lat` / `lng` | number \| null | 坐标;null = 无坐标(不上图,侧边栏标"暂无坐标") |
| `url` | string | 官网酒店页链接(popup 与侧边栏共用) |
| `coordinateSource` | string \| null | 坐标来源:`json-ld`(详情页结构化数据,最准)/ `nominatim`(按名编码回落)/ `override`(人工补录)/ `failed`(两轮编码均失败)/ `null`(未尝试,如 `--max-geocode` 截断) |

示例条目:

```json
{
  "code": "auhetci",
  "name": "Conrad Abu Dhabi Etihad Towers",
  "brand": "Conrad Hotels & Resorts",
  "region": "Middle East",
  "countryCode": "AE",
  "country": "阿联酋",
  "continent": "亚洲",
  "lat": 24.4583909,
  "lng": 54.322254,
  "url": "https://www.hilton.com/en/hotels/auhetci-conrad-abu-dhabi-etihad-towers/",
  "coordinateSource": "nominatim"
}
```

页面侧约定:页面只消费本文件,对 `brand` 为 null 的酒店灰点展示、图例置底;`lat` / `lng` 为 null 的酒店不生成 marker;侧边栏按 `continent` → `country` 组织三级树,缺失值归入"未标注大洲 / 未标注国家"置底。

### 国家与大洲的判定口径

- 国家按**坐标所在的地理位置**判定(Nominatim reverse 取 ISO 代码),不是 Hilton 官网字段;大洲由 ISO 代码经 `src/countries.mjs` 映射出中文名与标准 6 洲(跨洲国家的归类惯例见该文件注释)。
- 重跑管线时逆编码结果与坐标同缓存(`data/raw/geocode-cache.json` 条目里的 `countryCode` 字段),只存成功结果,失败的下次重跑自动重试。
- 构建结束会打印三类核对信息:无国家信息的酒店清单、映射表外的国家代码(补表后重跑即可,不重新请求)、坐标判定大洲与 Hilton Region 严格矛盾(Europe/Africa)的清单。
