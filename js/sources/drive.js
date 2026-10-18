/**
 * 数据源：Google Drive（浏览器直连 Drive API v3，无任何自建服务器）。
 * 两种认证方式（二选一，一次配置）：
 *   1) apiKey：文件夹设为「知道链接的任何人可查看」，只需 Google API Key。最简单，无需登录。
 *   2) oauth ：填自己的 OAuth Client ID，文件夹可以不公开。
 * 配置步骤见应用内「资料库 → Google Drive」或 README 第三节。
 */
import { makeRecord } from '../search.js';
import { kindOf } from '../util.js';

export const type = 'drive';
export const label = 'Google Drive';

const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const API = 'https://www.googleapis.com/drive/v3/files';
const TOKEN_KEY = 'scorefinder.driveToken';

/** Drive 里可索引的 Word 类文档 MIME */
const WORD_MIMES = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/rtf',
  'text/rtf',
  'application/vnd.oasis.opendocument.text',
]);

/** 把来源配置归一成认证对象 */
export function authOf(config = {}) {
  if (config.mode === 'apiKey') return { mode: 'apiKey', apiKey: config.apiKey || '' };
  return { mode: 'oauth', clientId: config.clientId || '' };
}

let gisLoading = null;
let token = loadToken();

function loadToken() {
  try {
    // 用 localStorage 而不是 sessionStorage：新标签页打开谱时也能复用登录
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    if (t && t.access && Date.now() < t.expiresAt - 60000) return t;
  } catch {
    /* ignore */
  }
  return null;
}

function saveToken(t) {
  token = t;
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
  } catch {
    /* ignore */
  }
}

export function hasToken() {
  return !!token;
}
export function forgetToken() {
  token = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisLoading) {
    gisLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => {
        gisLoading = null;
        reject(new Error('无法加载 Google 登录组件（检查网络）'));
      };
      document.head.append(s);
    });
  }
  return gisLoading;
}

/** 获取 access token。interactive=false 时静默尝试，不会弹窗。 */
export async function requestToken(clientId, { interactive = true } = {}) {
  if (!clientId) throw new Error('请先在「设置」里填入 Google OAuth Client ID');
  if (token && Date.now() < token.expiresAt - 60000) return token.access;
  await loadGis();
  return new Promise((resolve, reject) => {
    let done = false;
    const tc = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        done = true;
        if (resp.error) {
          reject(new Error(resp.error_description || resp.error));
          return;
        }
        saveToken({
          access: resp.access_token,
          expiresAt: Date.now() + Number(resp.expires_in || 3600) * 1000,
        });
        resolve(token.access);
      },
      error_callback: (err) => {
        done = true;
        reject(new Error(err?.message || 'Google 登录被取消'));
      },
    });
    tc.requestAccessToken({ prompt: interactive ? '' : 'none' });
    if (!interactive) {
      setTimeout(() => {
        if (!done) reject(new Error('需要重新登录 Google（点一下「连接 Google Drive」）'));
      }, 2500);
    }
  });
}

async function apiFetch(url, auth, { blob = false } = {}) {
  if (auth.mode === 'apiKey') {
    if (!auth.apiKey) throw new Error('请先填入 Google API Key');
    const u = new URL(url);
    u.searchParams.set('key', auth.apiKey);
    const r = await fetch(u.toString());
    if (!r.ok) {
      let detail = '';
      try {
        detail = (await r.json())?.error?.message || '';
      } catch {
        /* ignore */
      }
      if (r.status === 400 || r.status === 403 || r.status === 404) {
        throw new Error(
          `Google 拒绝访问（${r.status}）：请确认文件夹已设为「知道链接的任何人可查看」、API Key 正确且已启用 Drive API。` +
            (detail ? `（${detail}）` : '')
        );
      }
      throw new Error(`Drive API ${r.status}${detail ? ': ' + detail : ''}`);
    }
    return blob ? await r.blob() : await r.json();
  }

  const clientId = auth.clientId;
  for (let attempt = 0; attempt < 2; attempt++) {
    let access = null;
    try {
      access = await requestToken(clientId, { interactive: false });
    } catch {
      access = await requestToken(clientId, { interactive: true });
    }
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + access } });
    if (r.status === 401) {
      forgetToken();
      continue;
    }
    if (!r.ok) {
      let detail = '';
      try {
        detail = (await r.json())?.error?.message || '';
      } catch {
        /* ignore */
      }
      throw new Error(`Drive API ${r.status}${detail ? ': ' + detail : ''}`);
    }
    return blob ? await r.blob() : await r.json();
  }
  throw new Error('Google 登录已过期，请重新连接 Drive');
}

export function parseFolderId(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const m =
    s.match(/folders\/([A-Za-z0-9_-]{10,})/) ||
    s.match(/[?&]id=([A-Za-z0-9_-]{10,})/) ||
    s.match(/^([A-Za-z0-9_-]{10,})$/);
  return m ? m[1] : '';
}

export async function fetchFolderName(auth, folderId) {
  const j = await apiFetch(`${API}/${folderId}?fields=name&supportsAllDrives=true`, auth);
  return j.name;
}

function toRecord(source, folderName, file, relPrefix) {
  const mime = file.mimeType || '';
  let kind = null;
  if (mime === 'application/pdf') kind = 'pdf';
  else if (mime.startsWith('image/')) kind = 'image';
  else if (WORD_MIMES.has(mime)) kind = 'doc';
  // 有些文件 MIME 是 octet-stream，按扩展名兜底
  if (!kind) kind = kindOf(file.name);
  if (!kind) return null;
  return makeRecord({
    id: 'drive:' + file.id,
    sourceId: source.id,
    sourceName: source.name || folderName,
    sourceType: 'drive',
    raw: file.name,
    relPath: `${folderName}/${relPrefix}${file.name}`,
    kind,
    driveId: file.id,
    size: Number(file.size || 0),
    mtime: file.modifiedTime ? Date.parse(file.modifiedTime) : 0,
    mimeType: mime,
  });
}

async function listChildren(auth, parentId) {
  const out = [];
  let pageToken = '';
  do {
    const url = new URL(API);
    url.searchParams.set('q', `'${parentId}' in parents and trashed=false`);
    url.searchParams.set('fields', 'nextPageToken,files(id,name,size,modifiedTime,mimeType)');
    url.searchParams.set('pageSize', '1000');
    url.searchParams.set('includeItemsFromAllDrives', 'true');
    url.searchParams.set('supportsAllDrives', 'true');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const j = await apiFetch(url.toString(), auth);
    out.push(...(j.files || []));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}

export async function index(source, onProgress) {
  const auth = authOf(source.config);
  const folderId = source.config.folderId;
  if (auth.mode === 'apiKey' ? !auth.apiKey : !auth.clientId) {
    throw new Error('Drive 来源缺少配置（API Key 或 OAuth Client ID）');
  }
  if (!folderId) throw new Error('Drive 来源缺少文件夹链接');
  const folderName = source.name || (await fetchFolderName(auth, folderId));

  const records = [];
  const queue = [{ id: folderId, rel: '' }];
  let seenFolders = 0;
  while (queue.length) {
    const { id, rel } = queue.shift();
    seenFolders++;
    const children = await listChildren(auth, id);
    for (const f of children) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        queue.push({ id: f.id, rel: rel + f.name + '/' });
        continue;
      }
      const rec = toRecord(source, folderName, f, rel);
      if (rec) records.push(rec);
    }
    onProgress?.(records.length, 0, `${folderName}/${rel}`);
  }
  return records;
}

export async function open(rec, auth = authOf({ clientId: rec.clientId })) {
  const url = `${API}/${rec.driveId}?alt=media&supportsAllDrives=true`;
  return await apiFetch(url, auth, { blob: true });
}

/** 相对路径定位文件（用于分享/打开单个文件后重建记录，暂用不到） */
export function fileUrl(rec) {
  return `https://drive.google.com/file/d/${rec.driveId}/view`;
}
