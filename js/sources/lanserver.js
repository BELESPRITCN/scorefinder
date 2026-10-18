/**
 * 数据源：本机服务（scripts/serve.mjs 提供的 HTTP 接口）。
 * 适合 Safari / iPad / 手机等在浏览器里不能直接读文件夹的场景：
 * 只要和服务在同一网络（或走 Tailscale），就能搜索 Mac 上 config.json 配置的文件夹。
 */
import { makeRecord } from '../search.js';
import { kindOf } from '../util.js';

export const type = 'server';
export const label = '本机服务';

function joinUrl(base, path) {
  return String(base).replace(/\/+$/, '') + path;
}

/** 探测地址是否是歌谱搜索服务 */
export async function fetchInfo(baseUrl) {
  let r;
  try {
    r = await fetch(joinUrl(baseUrl, '/api/server/info'));
  } catch (e) {
    throw new Error('连不上服务（检查地址/网络/服务是否在运行）');
  }
  if (!r.ok) throw new Error(`服务返回 ${r.status}`);
  const j = await r.json();
  if (j.app !== 'scorefinder') throw new Error('这个地址不是歌谱搜索服务');
  return j;
}

/**
 * 探测「当前页面所在的地址」是不是本机服务。
 * 用于手机打开 http://192.168.x.x:8765 时自动连接，省掉手动添加。
 * 不是本服务（例如静态托管在 GitHub Pages）时静默返回 null。
 */
export async function probeOrigin(timeout = 2000) {
  if (!/^https?:$/.test(location.protocol)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(joinUrl(location.origin, '/api/server/info'), { signal: ctrl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    return j.app === 'scorefinder' ? j : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function index(source, onProgress) {
  const base = source.config.baseUrl;
  const r = await fetch(joinUrl(base, '/api/server/manifest'));
  if (!r.ok) throw new Error(`读取清单失败 (${r.status})`);
  const j = await r.json();
  const roots = j.roots || [];
  const records = [];
  let i = 0;
  for (const f of j.files || []) {
    const kind = kindOf(f.name);
    if (!kind) continue;
    const root = roots[f.r] || { name: 'root', id: 'r' + f.r };
    records.push(
      makeRecord({
        id: `server:${source.id}:${f.r}:${f.rel}`,
        sourceId: source.id,
        sourceName: source.name,
        sourceType: 'server',
        raw: f.name,
        relPath: `${root.name}/${f.rel}`,
        kind,
        size: f.size,
        mtime: f.mtime,
        serverBase: base,
        serverRoot: f.r,
        serverRel: f.rel,
      })
    );
    if (++i % 500 === 0) onProgress?.(i, 0, f.rel);
  }
  return records;
}

export async function open(rec) {
  const url = joinUrl(
    rec.serverBase,
    `/api/server/file?r=${rec.serverRoot}&rel=${encodeURIComponent(rec.serverRel)}`
  );
  const r = await fetch(url);
  if (!r.ok) throw new Error(`读取文件失败 (${r.status})`);
  return await r.blob();
}
