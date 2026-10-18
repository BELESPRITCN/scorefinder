/**
 * 数据源：本机文件夹（File System Access API，Chrome/Edge 桌面版可用）。
 * 适合在 Mac 上直接扫 /Users/mli/tools/scores 这类目录，不经过任何云。
 */
import { makeRecord } from '../search.js';
import * as store from '../store.js';
import { kindOf } from '../util.js';

export const type = 'fsa';
export const label = '本机文件夹';

export function supported() {
  return typeof window.showDirectoryPicker === 'function';
}

export async function addFolder() {
  const handle = await window.showDirectoryPicker({ id: 'scorefinder', mode: 'read' });
  const id = 'fsa_' + Math.random().toString(36).slice(2, 10);
  const source = {
    id,
    type,
    name: handle.name,
    enabled: true,
    lastIndexed: 0,
    fileCount: 0,
  };
  await store.idbPut('sources', source);
  await store.idbPut('handles', { id, handle });
  return source;
}

export async function getHandle(sourceId) {
  const row = await store.idbGet('handles', sourceId);
  return row?.handle || null;
}

/** 返回 'granted' | 'prompt' | 'denied' | 'missing' */
export async function checkPermission(sourceId, request = false) {
  const handle = await getHandle(sourceId);
  if (!handle) return 'missing';
  const opts = { mode: 'read' };
  try {
    let p = await handle.queryPermission(opts);
    if (p !== 'granted' && request) p = await handle.requestPermission(opts);
    return p;
  } catch {
    return 'missing';
  }
}

const dirCache = new Map(); // key: sourceId + '/' + dirPath -> handle

async function resolveFile(sourceId, relPath) {
  const root = await getHandle(sourceId);
  if (!root) throw new Error('文件夹未授权或已被移动');
  // 由用户点击触发时（打开文件/刷新），顺手申请一次权限
  try {
    if ((await root.queryPermission({ mode: 'read' })) === 'prompt') {
      await root.requestPermission({ mode: 'read' });
    }
  } catch {
    /* 忽略 */
  }
  const parts = relPath.split('/');
  const fileName = parts.pop();
  let dir = root;
  let key = sourceId + '/';
  for (const part of parts) {
    key += part + '/';
    let h = dirCache.get(key);
    if (!h) {
      h = await dir.getDirectoryHandle(part);
      dirCache.set(key, h);
    }
    dir = h;
  }
  const fh = await dir.getFileHandle(fileName);
  return await fh.getFile();
}

export async function index(source, onProgress) {
  const handle = await getHandle(source.id);
  if (!handle) throw new Error(`「${source.name}」的文件夹授权已失效，请移除后重新添加`);

  const records = [];
  let count = 0;
  async function walk(dir, relParts, depth) {
    if (depth > 8) return;
    for await (const [name, entry] of dir.entries()) {
      if (name.startsWith('.')) continue;
      if (entry.kind === 'directory') {
        await walk(entry, [...relParts, name], depth + 1);
        continue;
      }
      const kind = kindOf(name);
      if (!kind) continue;
      const relPath = [...relParts, name].join('/');
      records.push(
        makeRecord({
          id: `${source.id}:` + relPath,
          sourceId: source.id,
          sourceName: source.name,
          sourceType: 'fsa',
          raw: name,
          relPath,
          kind,
          fsPath: relPath,
        })
      );
      if (++count % 100 === 0) onProgress?.(count, 0, relPath);
    }
  }
  await walk(handle, [], 0);
  onProgress?.(count, count, '');
  return records;
}

export async function open(rec) {
  return await resolveFile(rec.sourceId, rec.fsPath || rec.relPath);
}

export async function removeSource(source) {
  dirCache.clear();
  await store.idbDelete('handles', source.id);
}
