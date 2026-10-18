/**
 * Google Drive「配置链接」：把一个已配置好的 Drive 来源（文件夹 ID + API Key）
 * 编码进链接，方便在另一台设备上一次性导入。
 *
 * 配置放在 hash 里（不会随请求发送到服务器）：
 *   https://example.com/app/#drive=<folderId>&k=<apiKey>
 */

/** 已发布的公网版地址；换部署地址时改这里 */
export const PUBLIC_APP_URL = 'https://belespritcn.github.io/scorefinder/';

export function buildDriveConfigLink(baseUrl, folderId, apiKey) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+/i.test(base)) throw new Error('地址要以 http:// 或 https:// 开头');
  if (!folderId) throw new Error('缺少文件夹 ID');
  if (!apiKey) throw new Error('缺少 API Key');
  return `${base}/#drive=${encodeURIComponent(folderId)}&k=${encodeURIComponent(apiKey)}`;
}

export function parseDriveConfigLink(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(s, 'https://example.invalid/');
  } catch {
    return null;
  }
  const hash = new URLSearchParams(u.hash.replace(/^#/, ''));
  const folderId = hash.get('drive') || u.searchParams.get('drive') || '';
  const apiKey = hash.get('k') || u.searchParams.get('k') || '';
  if (!/^[A-Za-z0-9_-]{10,}$/.test(folderId) || !apiKey) return null;
  return { folderId, apiKey };
}

/** 当前页面所在目录的地址（带结尾斜杠） */
export function appBaseUrl(loc = location) {
  const path = loc.pathname.endsWith('/') ? loc.pathname : loc.pathname.replace(/[^/]*$/, '');
  return loc.origin + path;
}

/** 生成二维码时默认填哪个地址：已在公网版上就用当前地址，否则用公网版 */
export function defaultShareBase(loc = location, publicUrl = PUBLIC_APP_URL) {
  const pub = new URL(publicUrl, 'https://example.invalid/');
  if (loc.origin === pub.origin && loc.pathname.startsWith(pub.pathname)) return appBaseUrl(loc);
  return publicUrl;
}
