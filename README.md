# Hilton Resort Credit 合格酒店地图

把 Hilton 官方 [Resort Credit Eligible Hotels](https://www.hilton.com/en/p/hilton-honors/resort-credit-eligible-hotels/) 页面列出的酒店,按品牌呈现在一张 Leaflet 地图上。术语见 `CONTEXT.md`。

## 结构

- `index.html` + `assets/` —— 纯静态页面(Leaflet 与 markercluster 走 CDN,底图 CARTO Voyager),运行时 `fetch` 预生成的 `data/hotels.json`,零构建。
- `scripts/build-data.mjs` —— 数据管线:解析保存的页面 HTML → hotel code 去重 → 抓取详情页 JSON-LD 坐标(Nominatim 回落)→ 产出 `data/hotels.json`。
- `data/hotels.json` —— 生成产物,随脚本一并入库。字段:`code / name / brand / region / lat / lng / url / coordinateSource`。
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
   `--max-geocode N` 控制本次抓取坐标的样本数(默认 10;管线对 Hilton 与 Nominatim 均约 1 请求/秒礼貌限速)。

> 注意:Hilton 详情页对部分网络环境返回 403(反爬),此时坐标自动落到 Nominatim 回落,`coordinateSource` 会如实标注来源。
