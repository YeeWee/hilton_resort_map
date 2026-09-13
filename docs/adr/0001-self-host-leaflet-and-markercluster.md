# ADR-0001:Leaflet/markercluster 自托管进仓库,底图瓦片维持 CARTO 不换国内源

- 状态:已接受(Accepted)
- 日期:2026-09-14
- 关联:issue #8(自托管实施)、后续跟踪 CARTO 瓦片国内可达性的独立 issue

## 背景

地图页是零构建纯静态页面,定位是境外静态托管 + 国内直连访问。第三方 JS/CSS(Leaflet、leaflet.markercluster,共 5 个文件)此前从 unpkg 公共 CDN 加载,国内访客直连境外公共 CDN 偶尔不稳:CDN 抖动时首屏长时间白屏或脚本报错,marker、图例、侧边栏全部不可用——首屏可用性不应取决于第三方 CDN 的当刻可用性。

底图瓦片另走 CARTO Voyager(带 api key),其国内可达性是独立风险,见"瓦片源"一节。

## 决策

### 一、第三方 JS/CSS 一律自托管,不依赖任何公共 CDN

- Leaflet 与 leaflet.markercluster 的 dist 产物(5 个文件)复制进顶层 `vendor/`,镜像 npm 包内部结构,随代码入库。
- index.html 引用同源相对路径,**路径不带版本号**——升级库时页面零改动,不存在"路径版本与实际内容不符"。
- 版本的**唯一事实来源是 `package.json` 与 lockfile**;`vendor/VERSIONS.json` 由脚本生成,仅供 git diff 阅读。
- 同步由零依赖脚本 `scripts/vendor.mjs` 完成(`npm run vendor`),并提供 `--check` 模式只校验不写盘;测试执行 `--check` 守住 vendor 与 npm 产物的一致性,页面测试的"全程不碰网络"断言 + 静态断言(index.html 的 `<link href>` / `<script src>` 不得引用 http(s) 外链)共同守住自托管不被回潮。
- 升级动线:`npm update leaflet leaflet.markercluster` → `npm run vendor` → `npm test`。

### 二、底图瓦片维持 CARTO Voyager 与现有 api key,不换国内瓦片源

国内主流底图(高德、腾讯、百度等)使用 **GCJ-02 坐标系**(百度为 BD-09),对真实地理位置做了整体偏移;本项目的酒店坐标是 **WGS-84**(Hilton 详情页 JSON-LD / Nominatim / overrides 均为 WGS-84)。换国内瓦片源意味着:

- 要么全部 326 家酒店坐标做 WGS-84 → GCJ-02 换算(换算算法本身有百米级误差,且 overrides 与缓存都要跟着换口径);
- 要么接受地图上酒店点位整体偏移,落在错误的街区。

收益(瓦片加载更快)与代价(坐标体系整体重构、数据管线与 overrides 全部牵连)严重不对称。因此保留 CARTO 现状,CARTO 瓦片国内可达性作为已知风险以独立 issue 跟踪,观察到实际劣化时再议决;若届时换源,须重新立项处理坐标换算。

## 被否决的备选方案

- **换国内公共 CDN(如 bootcdn/staticfile)**:同样是把首屏可用性押在第三方 CDN 上,且第三方公共 CDN 有过投毒/停服先例;引入新的供应链信任,不解决根因。
- **多源回退(CDN 失败后落 vendor 或反之)**:双路径让"页面实际加载了哪份代码"不可预期,也给页面与测试增加两处同步负担;自托管后同源加载没有失败场景可言。
- **引入打包器(bundler)**:违背页面零构建定位,收益仅是 tree-shaking,对两个各约 150KB 的库意义有限。

## 后果

- 仓库多出 `vendor/`(约 5 个文件,数百 KB)入库;换来静态托管零构建即可伺服、页面 JS/CSS 零外链,核心浏览与筛选在底图瓦片全部失败时仍可用。
- `devDependencies` 里的 leaflet / leaflet.markercluster 保留:它们是升级动线的来源,页面测试也不再从 node_modules 替答 CDN。
- 后续所有第三方前端库引入一律走"加入 devDependencies → `npm run vendor` → index.html 引 vendor 路径"动线,不再出现新的外链引用。
