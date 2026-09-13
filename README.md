# Hilton Resort Credit 合格酒店地图

把 Hilton 官方 [Resort Credit Eligible Hotels](https://www.hilton.com/en/p/hilton-honors/resort-credit-eligible-hotels/) 页面列出的酒店,按品牌呈现在一张 Leaflet 地图上。术语见 `CONTEXT.md`。

## 结构

- `index.html` + `assets/` —— 纯静态页面(Leaflet 与 markercluster 走 CDN,底图 CARTO Voyager),运行时 `fetch` 预生成的 `data/hotels.json`,零构建。
- `scripts/build-data.mjs` —— 数据管线:解析保存的页面 HTML → hotel code 去重 → 抓取详情页 JSON-LD 坐标(Nominatim 回落 → 人工 overrides 兜底)→ 产出 `data/hotels.json`。
- `data/hotels.json` —— 生成产物,随脚本一并入库。字段:`code / name / brand / region / lat / lng / url / coordinateSource`(取值 `json-ld | nominatim | override | failed | null`;`failed` = 两轮编码均失败,`null` = 未尝试)。
- `data/overrides.json` —— 人工坐标 overrides:两轮编码都失败的极少数酒店,按 hotel code 补 `{ "lat": …, "lng": … }`(可附 `note`)。
- `tests/` —— 两条测试接缝,全程不碰网络:
  - 接缝 1(管线整体):fixture HTML + 注入假地理编码器 → hotels.json 契约。
  - 接缝 2(页面整体):headless 浏览器 + fixture JSON → DOM 行为(CDN 与底图在路由层本地应答)。

## 常用命令

```bash
npm test            # 全量测试(node --test)
npm start           # 本地预览 http://localhost:8000/
npm run build:data  # 用 data/raw/ 下的页面快照重建 data/hotels.json
```

## 更新数据

1. 保存页面快照(名单会变动,以当次页面为准):
   ```bash
   curl -A "Mozilla/5.0" -o data/raw/resort-credit-eligible-hotels.html \
     https://www.hilton.com/en/p/hilton-honors/resort-credit-eligible-hotels/
   ```
2. 重跑管线并提交产物:`npm run build:data && git add data/hotels.json`。
   默认对名单全量取坐标(约 5-10 分钟);`--max-geocode N` 可只取前 N 家样本。
   `--cache data/raw/geocode-cache.json` 缓存已成功的坐标,补充 overrides 后重跑不重复请求外部服务。
   管线对 Hilton 与 Nominatim 均约 1 请求/秒礼貌限速;详情页连续 403 会自动熔断,本轮跳过 JSON-LD。
   运行结束会把仍失败的酒店清单打印到 stderr,按 code 补进 `data/overrides.json` 后重跑即可。

> 注意:Hilton 详情页对部分网络环境返回 403(反爬),此时坐标自动落到 Nominatim 回落,`coordinateSource` 会如实标注来源。
