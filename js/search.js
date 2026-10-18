/**
 * 搜索核心（纯逻辑，浏览器和 Node 测试共用）。
 *
 * 归一化策略：所有文件名和查询词都先转成简体、小写，再匹配，
 * 因此「爱你 / 愛你 / 爱你」三类写法能互相命中。
 * 另外建立拼音索引（全拼 + 首字母，多音字取最多 3 个读音的 8 种组合），
 * 所以输入 "aini"、"am" 也能搜到「愛你」「阿妹」。
 */
import { toSimplified, readingsOf } from './dict.js';

export const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const EXT_RE = /\.(pdf|jpe?g|png|webp|gif|bmp|tiff?|heic|heif|avif|jfif|docx?|rtf|odt)$/i;
const MAX_VARIANTS = 8;

export function compact(s) {
  // 去掉所有分隔符和标点（含全角），但保留中文/字母/数字：
  // "月亮 代表我的心_蔡琴" -> "月亮代表我的心蔡琴"; "Can't Fight" -> "cantfight"
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 只保留 ASCII 字母数字（用于拼音判断） */
export function stripToAlnum(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 把原始文件名清理成展示用名字：去扩展名、去编号前缀、去尾部页码乱码 */
export function cleanDisplayName(raw) {
  let name = String(raw);
  while (EXT_RE.test(name)) name = name.replace(EXT_RE, '');
  // 开头的编号前缀: 015_011_ / 108-084 / 051 175 173
  let prev;
  do {
    prev = name;
    name = name.replace(/^\d{1,4}(?:[\s._-]+\d{1,4})*[\s._-]+/, '');
  } while (name !== prev);
  // 去掉（譜）（谱）这类标记
  name = name.replace(/[（(]\s*[譜谱]\s*[)）]/g, '');
  // 尾部楼层/页码: -126_059 / -128 056 / -p1 / -F / _U
  while (name.length > 1) {
    const m = name.match(/[\s._-]\d{1,4}$/) || name.match(/[\s._-](?:p\d{1,2}|[A-Za-z])$/i);
    if (!m) break;
    const cut = name.slice(0, m.index);
    if (!/[0-9A-Za-z\u3400-\u9fff]/.test(cut)) break;
    if (!CJK_RE.test(cut) && !/[A-Za-z]/.test(cut)) break;
    name = cut;
  }
  const disp = name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return disp || raw;
}

/** 拼音组合：每个汉字取最多 3 个读音，组合数上限 MAX_VARIANTS（优先用第一读音） */
function buildPinyinVariants(canon) {
  let variants = [[]];
  for (const ch of canon) {
    if (!CJK_RE.test(ch)) continue;
    const rs = readingsOf(ch);
    if (!rs || !rs.length) continue;
    const next = [];
    for (const v of variants) {
      for (const r of rs) {
        next.push([...v, r]);
        if (next.length >= MAX_VARIANTS) break;
      }
      if (next.length >= MAX_VARIANTS) break;
    }
    if (next.length) variants = next;
  }
  return variants;
}

/**
 * 建索引记录。meta 里需要:
 *   id (全局唯一), sourceId, sourceName, raw (文件名), relPath, size, mtime, kind ('pdf'|'image'|'doc')
 * 以及取文件所需的引用字段（driveId / fsPath / opfsPath 等，由各 source 自定）
 */
export function makeRecord(meta) {
  const raw = String(meta.raw ?? '');
  const canon = toSimplified(raw).toLowerCase();
  const display = meta.display || cleanDisplayName(raw);
  const canonDisp = toSimplified(display).toLowerCase();
  const variants = buildPinyinVariants(canon);
  return {
    ...meta,
    display,
    canon,
    canonDisp,
    stripped: compact(canon),
    strippedDisp: compact(canonDisp),
    pyFull: variants.map((v) => v.join('')),
    pyInit: variants.map((v) => v.map((r) => r[0]).join('')),
  };
}

export function parseQuery(query) {
  return String(query)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      const canon = toSimplified(tok).toLowerCase();
      return {
        raw: tok,
        canon,
        stripped: compact(canon),
        isAscii: /^[a-z0-9]+$/.test(canon),
      };
    });
}

function scoreToken(t, rec) {
  const { canon, canonDisp, stripped, strippedDisp, pyFull, pyInit } = rec;
  const tc = t.canon;
  let s = 0;

  if (canonDisp === tc) s = 600;
  else if (canonDisp.startsWith(tc)) {
    const nxt = canonDisp[tc.length] ?? '';
    s = nxt === '' || /[\s_\-·、，。,.()（）]/.test(nxt) ? 520 : 400;
  } else if (canonDisp.includes(tc)) s = 260;

  if (canon === tc) s = Math.max(s, 550);
  else if (canon.startsWith(tc)) s = Math.max(s, 330);
  else if (canon.includes(tc)) s = Math.max(s, 240);

  const ts = t.stripped;
  if (ts.length >= 2) {
    if (strippedDisp === ts) s = Math.max(s, 500);
    else if (strippedDisp.startsWith(ts)) s = Math.max(s, 330);
    else if (strippedDisp.includes(ts)) s = Math.max(s, 220);
    if (stripped !== strippedDisp) {
      if (stripped.startsWith(ts)) s = Math.max(s, 240);
      else if (stripped.includes(ts)) s = Math.max(s, 190);
    }
  }

  if (t.isAscii && tc.length >= 1) {
    const exactFull = pyFull[0] === tc;
    const exactInit = tc.length >= 2 && pyInit[0] === tc;
    if (exactFull) s = Math.max(s, 480);
    if (exactInit) s = Math.max(s, 460);
    if (tc.length >= 2) {
      if (pyFull[0].startsWith(tc)) s = Math.max(s, 320);
      if (pyInit[0].startsWith(tc)) s = Math.max(s, 300);
      if (pyFull.some((v) => v.startsWith(tc))) s = Math.max(s, 280);
      if (pyInit.some((v) => v.startsWith(tc))) s = Math.max(s, 270);
      if (pyFull.some((v) => v.includes(tc))) s = Math.max(s, 150);
      if (pyInit.some((v) => v.includes(tc))) s = Math.max(s, 130);
    }
  }
  return s;
}

/**
 * @param {Array} records  由 makeRecord 生成的记录
 * @param {string} query
 * @param {{limit?:number, sourceIds?:Set<string>|string[]|null}} opts
 */
export function search(records, query, opts = {}) {
  const tokens = parseQuery(query);
  if (!tokens.length) return [];
  const limit = opts.limit ?? 300;
  const srcSet = opts.sourceIds
    ? opts.sourceIds instanceof Set
      ? opts.sourceIds
      : new Set(opts.sourceIds)
    : null;

  const hits = [];
  for (const rec of records) {
    if (srcSet && srcSet.size && !srcSet.has(rec.sourceId)) continue;
    let total = 0;
    let ok = true;
    for (const t of tokens) {
      const s = scoreToken(t, rec);
      if (s <= 0) {
        ok = false;
        break;
      }
      total += s;
    }
    if (!ok) continue;
    hits.push({ rec, score: total });
  }
  hits.sort((a, b) => b.score - a.score || a.rec.canon.length - b.rec.canon.length);
  return hits.slice(0, limit);
}

/** 把不同来源里"看起来是同一个谱"的记录合并成一个展示组 */
export function groupHits(hits) {
  const groups = new Map();
  for (const h of hits) {
    const key = h.rec.strippedDisp || h.rec.stripped || h.rec.id;
    const g = groups.get(key);
    if (g) {
      g.items.push(h);
      g.score = Math.max(g.score, h.score);
    } else {
      groups.set(key, { key, score: h.score, items: [h] });
    }
  }
  const arr = [...groups.values()];
  arr.sort((a, b) => b.score - a.score);
  return arr;
}
