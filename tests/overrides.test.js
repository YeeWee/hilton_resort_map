import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadOverrides } from '../src/overrides.mjs';

async function withTempOverrides(content) {
  const dir = await mkdtemp(join(tmpdir(), 'overrides-'));
  const file = join(dir, 'overrides.json');
  if (content !== undefined) await writeFile(file, content);
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('加载 overrides:按 hotel code 读取人工坐标', async () => {
  const { file, cleanup } = await withTempOverrides(
    JSON.stringify({ jhmgwwa: { lat: 20.8286, lng: -156.6433, note: '人工核对' } }),
  );
  try {
    const overrides = await loadOverrides(file);
    assert.deepEqual(overrides, { jhmgwwa: { lat: 20.8286, lng: -156.6433, note: '人工核对' } });
  } finally {
    await cleanup();
  }
});

test('overrides 文件不存在时返回空对象(首轮全量还没有 overrides)', async () => {
  assert.deepEqual(await loadOverrides('/nonexistent/path/overrides.json'), {});
});

test('非法条目(缺坐标、非数字)显式报错并指出 hotel code', async () => {
  const { file, cleanup } = await withTempOverrides(
    JSON.stringify({
      good00aa: { lat: 1.5, lng: 2.5 },
      bad00bb: { lat: 'oops', lng: 2.5 },
    }),
  );
  try {
    await assert.rejects(loadOverrides(file), /bad00bb/);
  } finally {
    await cleanup();
  }
});
