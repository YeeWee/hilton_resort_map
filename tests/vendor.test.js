import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// 接缝 3(vendor 脚本 CLI 边界):`--check` 校验 vendor/ 与 node_modules 的 npm 产物
// 逐字节一致、版本记录一致;手工改动 vendor 或漏跑同步会在这里变红。
// vendor 文件的忠实性由它唯一覆盖,不另写逐文件 diff。

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('vendor --check:vendor/ 产物与 node_modules 一致、版本记录一致', async () => {
  await assert.doesNotReject(
    execFileAsync(process.execPath, ['scripts/vendor.mjs', '--check'], { cwd: repoRoot }),
  );
});
