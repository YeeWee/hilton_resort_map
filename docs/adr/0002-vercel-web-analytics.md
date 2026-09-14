# ADR-0002:Vercel Web Analytics 经自托管 @vercel/analytics + Import Map 接入

- 状态:已接受(Accepted)
- 日期:2026-09-14

## 背景

站点(纯静态、零构建)需要访问量统计。站已部署在 Vercel,Vercel Web Analytics 对源站是免维护的托管服务,站点侧只需注入它提供的 loader 脚本即可采集。

Vercel 官方提供两条接入路径:一是在 index.html 直接加 `<script defer src="/_vercel/insights/script.js">`;二是通过 npm 包 `@vercel/analytics` 的 `inject()`(生产模式下它做的也正是插入同一 loader 脚本)。本项目前端是**纯静态、无打包器**的,`<script src>` 均是普通脚本、无 `type="module"`、无浏览器侧 resolve 机制——直接写 `import { inject } from "@vercel/analytics"` 浏览器无法解析包名。

## 决策

- 采用 `@vercel/analytics` 的 `inject()`,保持与官方 npm 接入一致,而非手写 `<script>` 标签。
- 编译器侧无法 resolve,故用浏览器 **Import Map** 把包名 `@vercel/analytics` 映射到自托管副本;该副本即包内的浏览器入口 `dist/index.mjs`(240 行、无内部 import,自包含),随 vendor 动线同步进 `vendor/@vercel/analytics/dist/index.mjs`。
- index.html 中 `<head>` 先放 import map,再放 `<script type="module">import { inject } from "@vercel/analytics"; inject();</script>`。
- 升级动线沿用 ADR-0001 的自托管约定:`pnpm update @vercel/analytics` → `pnpm run vendor` → `pnpm test`;`scripts/vendor.mjs` 为 scoped 包(`@scope/pkg`)按前两段解析包名。

## 被否决的备选方案

- **直接手写 `<script defer src="/_vercel/insights/script.js">`**:行为与 `inject()` 相同且更简单,但用户明确选择走 npm 包接入;统一走 `@vercel/analytics` 也便于日后启用自定义事件上报(页面标记请求、聚合等)而不必再换接入方式。
- **引入打包器(bundler)只为了 `inject()`**:违背页面零构建定位,对一个约 6KB 的自包含模块毫无必要(同 ADR-0001 的否决理由)。

## 后果

- 仓库 `vendor/` 新增 `@vercel/analytics` 的浏览器入口(约 6KB)入库;页面零外链约束不受影响(该模块走同源 `vendor/` 相对路径)。
- `inject()` 指向 `/analytics/insights/script.js`,由 Vercel 平台在**开始 Web Analytics 的部署**上自动提供。这意味着:未部署到 Vercel(本地 `pnpm start`)时该脚本 404 静默失败,无本地样本上报,属正常预期;必须先在 Vercel 项目上启用 Web Analytics 才有数据。
- 依赖清单里 `@vercel/analytics` 在 `dependencies`(而非 devDependencies):它与页面运行相关(虽经自托管,仍属运行时概念),与纯构建期使用的 leaflet 等区分。