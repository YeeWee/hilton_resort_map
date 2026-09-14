// 零依赖 vendor 同步脚本:node_modules → vendor/ 复制第三方 dist 产物并记录版本
//   node scripts/vendor.mjs           复制产物 + 写 vendor/VERSIONS.json
//   node scripts/vendor.mjs --check   只校验、不写盘,不一致时以非零码退出
//
// 升级动线:npm update leaflet leaflet.markercluster → npm run vendor → npm test。
// 版本的唯一事实来源是 package.json 与 lockfile;vendor/VERSIONS.json 仅供 git diff 阅读。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// index.html 引用的全部第三方产物,路径相对各自 npm 包根,镜像包内结构。
// 页面只用 divIcon,leaflet dist 的 images/ 无引用,不复制。
const FILES = [
  'leaflet/dist/leaflet.css',
  'leaflet/dist/leaflet.js',
  'leaflet.markercluster/dist/MarkerCluster.css',
  'leaflet.markercluster/dist/MarkerCluster.Default.css',
  'leaflet.markercluster/dist/leaflet.markercluster.js',
  '@vercel/analytics/dist/index.mjs',
];
// 包名即产物路径的首段;scoped 包(@scope/pkg)取前两段,版本从各包的 package.json 读取
const pkgNameOf = (rel) => (rel.startsWith('@') ? rel.split('/').slice(0, 2).join('/') : rel.split('/')[0]);
const PACKAGES = [...new Set(FILES.map(pkgNameOf))];

async function readFileMap(baseDir) {
  const files = new Map();
  for (const rel of FILES) {
    files.set(rel, await readFile(join(baseDir, rel)));
  }
  return files;
}

async function readVersions(baseDir) {
  const versions = {};
  for (const name of PACKAGES) {
    const pkg = JSON.parse(await readFile(join(baseDir, name, 'package.json'), 'utf8'));
    versions[name] = pkg.version;
  }
  return versions;
}

async function readVendorState() {
  try {
    return {
      versions: JSON.parse(await readFile(join(repoRoot, 'vendor', 'VERSIONS.json'), 'utf8')),
      files: await readFileMap(join(repoRoot, 'vendor')),
    };
  } catch {
    return null; // VERSIONS.json 或任一产物缺失/非法,视为不一致
  }
}

async function sync() {
  const versions = await readVersions(join(repoRoot, 'node_modules'));
  const files = await readFileMap(join(repoRoot, 'node_modules'));
  for (const [rel, content] of files) {
    const target = join(repoRoot, 'vendor', rel);
    await mkdir(dirname(target), { recursive: true });
    if (!(await readFileIfExists(target))?.equals(content)) {
      await writeFile(target, content);
      console.error(`已复制 ${rel}`);
    }
  }
  const versionsJson = `${JSON.stringify(versions, null, 2)}\n`;
  if ((await readFileIfExists(join(repoRoot, 'vendor', 'VERSIONS.json'), 'utf8')) !== versionsJson) {
    await writeFile(join(repoRoot, 'vendor', 'VERSIONS.json'), versionsJson);
    console.error(`已写入 vendor/VERSIONS.json: ${JSON.stringify(versions)}`);
  }
  console.error('vendor 同步完成');
}

async function check() {
  let expected;
  try {
    expected = { versions: await readVersions(join(repoRoot, 'node_modules')), files: await readFileMap(join(repoRoot, 'node_modules')) };
  } catch {
    console.error('vendor --check 失败:node_modules 缺失或不完整,请先 npm install');
    process.exitCode = 1;
    return;
  }
  const actual = await readVendorState();
  if (actual === null) {
    console.error('vendor --check 失败:vendor/ 缺失产物或 VERSIONS.json,请运行 npm run vendor');
    process.exitCode = 1;
    return;
  }
  const problems = [];
  for (const [name, version] of Object.entries(expected.versions)) {
    if (actual.versions[name] !== version) {
      problems.push(`VERSIONS.json 中 ${name} 版本应为 ${version},实际为 ${actual.versions[name] ?? '缺失'}`);
    }
  }
  for (const [rel, content] of expected.files) {
    if (!actual.files.get(rel)?.equals(content)) {
      problems.push(`vendor/${rel} 与 node_modules 不一致,请运行 npm run vendor`);
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`vendor --check 失败:${problem}`);
    process.exitCode = 1;
    return;
  }
  console.error(`vendor --check 通过:${FILES.length} 个产物与 node_modules 一致(${JSON.stringify(expected.versions)})`);
}

async function readFileIfExists(file, encoding) {
  try {
    return await readFile(file, encoding);
  } catch {
    return null;
  }
}

const checkOnly = process.argv.includes('--check');
await (checkOnly ? check() : sync());
