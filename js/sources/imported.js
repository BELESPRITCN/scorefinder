/**
 * 数据源：本机导入。
 * 用户在手机上从文件管理器多选（或导入 ZIP），文件被存进浏览器的 OPFS，
 * 之后搜索/查看完全离线，不依赖网络。
 */
import { makeRecord } from '../search.js';
import * as store from '../store.js';
import { kindOf } from '../util.js';

export const type = 'imported';
export const label = '本机导入';
export const supportsZip = true;

export const SOURCE = {
  id: 'imported',
  type,
  name: '本机导入',
  enabled: true,
};

async function uniqueName(name) {
  const base = name;
  let candidate = base;
  let i = 2;
  while (await store.idbGet('files', 'imported:' + candidate)) {
    const m = base.match(/^(.*?)(\.[^.]*)?$/);
    candidate = `${m[1]} (${i})${m[2] || ''}`;
    i++;
    if (i > 200) break;
  }
  return candidate;
}

/** 导入一批 File（来自 <input type=file multiple>） */
export async function addFiles(files, onProgress) {
  const list = [...files].filter((f) => kindOf(f.name));
  const records = [];
  let i = 0;
  for (const f of list) {
    const name = await uniqueName(f.name);
    await store.opfsWrite(['imported', name], f);
    records.push(
      makeRecord({
        id: 'imported:' + name,
        sourceId: SOURCE.id,
        sourceName: SOURCE.name,
        sourceType: 'imported',
        raw: name,
        relPath: name,
        size: f.size,
        mtime: f.lastModified || Date.now(),
        kind: kindOf(name),
        opfsPath: name,
      })
    );
    onProgress?.(++i, list.length, name);
  }
  await store.idbPutMany('files', records);
  return records;
}

/* ---------------- 极简 ZIP 读取（支持 store / deflate，兼容 GBK 文件名） ---------------- */

function decodeName(bytes, flags) {
  const utf8 = (flags & 0x800) !== 0;
  const buf = new Uint8Array(bytes);
  try {
    return new TextDecoder(utf8 ? 'utf-8' : 'gbk').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

function readZipEntries(dv) {
  const u8 = new Uint8Array(dv.buffer);
  // 找 EOCD
  let eocd = -1;
  const min = Math.max(0, u8.length - 65557);
  for (let i = u8.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = decodeName(u8.slice(p + 46, p + 46 + nameLen), flags);
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      entries.push({ name, zip64: true });
    } else {
      entries.push({ name, method, compSize, size, localOffset });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function extractEntry(u8, dv, entry) {
  const p = entry.localOffset;
  if (dv.getUint32(p, true) !== 0x04034b50) throw new Error('ZIP 局部头损坏');
  const nameLen = dv.getUint16(p + 26, true);
  const extraLen = dv.getUint16(p + 28, true);
  const start = p + 30 + nameLen + extraLen;
  const data = u8.slice(start, start + entry.compSize);
  if (entry.method === 0) return new Blob([data]);
  if (entry.method === 8) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([data]).stream().pipeThrough(ds);
    return await new Response(stream).blob();
  }
  throw new Error('不支持的 ZIP 压缩方式: ' + entry.method);
}

/** 导入 ZIP 里的所有 PDF / 图片 / Word 文档 */
export async function importZip(file, onProgress) {
  const buf = await file.arrayBuffer();
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const entries = readZipEntries(dv);
  const targets = entries.filter(
    (e) => !e.zip64 && !e.name.endsWith('/') && !e.name.includes('__MACOSX/') && kindOf(e.name.split('/').pop())
  );
  if (!targets.length) throw new Error('ZIP 里没有找到 PDF、图片或 Word 文档');
  const records = [];
  const failed = [];
  let i = 0;
  for (const e of targets) {
    const base = e.name.split('/').pop();
    try {
      const blob = await extractEntry(u8, dv, e);
      const name = await uniqueName(base);
      await store.opfsWrite(['imported', name], blob);
      records.push(
        makeRecord({
          id: 'imported:' + name,
          sourceId: SOURCE.id,
          sourceName: SOURCE.name,
          sourceType: 'imported',
          raw: name,
          relPath: name,
          size: blob.size,
          mtime: Date.now(),
          kind: kindOf(name),
          opfsPath: name,
        })
      );
    } catch (err) {
      failed.push(base);
    }
    onProgress?.(++i, targets.length, base);
  }
  await store.idbPutMany('files', records);
  return { records, failed };
}

export async function removeRecord(rec) {
  if (rec.opfsPath) await store.opfsDelete(['imported', rec.opfsPath]);
  await store.idbDelete('files', rec.id);
}
