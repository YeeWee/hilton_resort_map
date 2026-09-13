import { readFile } from 'node:fs/promises';

// 人工坐标 overrides:两轮编码(JSON-LD、Nominatim)都失败的极少数酒店,
// 由维护者按 hotel code 在 data/overrides.json 里补坐标,管线合并时兜底。
// 文件不存在视为空(首轮全量运行通常还没有 overrides)。
export async function loadOverrides(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }

  const data = JSON.parse(raw);
  for (const [code, entry] of Object.entries(data)) {
    if (typeof entry?.lat !== 'number' || typeof entry?.lng !== 'number') {
      throw new Error(`overrides 条目非法(${code}):需要数字 lat/lng`);
    }
  }
  return data;
}
