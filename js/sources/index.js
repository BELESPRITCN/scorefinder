/** 数据源注册表 */
import * as imported from './imported.js';
import * as fsa from './fsafolder.js';
import * as drive from './drive.js';
import * as lanserver from './lanserver.js';
import * as store from '../store.js';

export const TYPES = { imported, fsa, drive, server: lanserver };

export function typeOf(source) {
  return TYPES[source.type];
}

export async function listSources() {
  const list = await store.idbGetAll('sources');
  // 「本机导入」是常驻来源，即使还没有导入任何文件也显示
  if (!list.some((s) => s.id === 'imported')) list.push({ ...imported.SOURCE });
  return list.sort((a, b) => (a.type === 'imported' ? -1 : b.type === 'imported' ? 1 : a.name.localeCompare(b.name)));
}

export async function saveSource(source) {
  await store.idbPut('sources', source);
}

/** 抓取某个来源的索引，入库后返回记录数 */
export async function refreshSource(source, onProgress) {
  const mod = typeOf(source);
  if (!mod) throw new Error('未知来源类型: ' + source.type);
  const records = await mod.index(source, onProgress);
  await store.idbDeleteByIndex('files', 'sourceId', source.id);
  await store.idbPutMany('files', records);
  const updated = { ...source, lastIndexed: Date.now(), fileCount: records.length };
  if (source.id !== 'imported') await store.idbPut('sources', updated);
  return { records, source: updated };
}

export async function removeSource(source) {
  const mod = typeOf(source);
  if (mod?.removeSource) await mod.removeSource(source);
  await store.idbDeleteByIndex('files', 'sourceId', source.id);
  if (source.id !== 'imported') await store.idbDelete('sources', source.id);
}

export async function loadAllRecords() {
  return await store.idbGetAll('files');
}
