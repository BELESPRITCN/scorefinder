/**
 * 词典层：简繁归一化 + 拼音读音查询。
 * 浏览器里用 initDictFromUrls()，Node（测试）里用 initDictFromData()。
 */
let T2S_CHARS = null;
let T2S_PHRASES = null;
let T2S_MAXP = 1;
let PINYIN = null;

export function initDictFromData(t2s, pinyin) {
  T2S_CHARS = t2s.c;
  T2S_PHRASES = t2s.p;
  T2S_MAXP = t2s.m || 1;
  PINYIN = pinyin;
}

export async function initDictFromUrls(
  t2sUrl = './data/t2s.json',
  pinyinUrl = './data/pinyin.json'
) {
  const [a, b] = await Promise.all([
    fetch(t2sUrl).then((r) => r.json()),
    fetch(pinyinUrl).then((r) => r.json()),
  ]);
  initDictFromData(a, b);
}

export function dictReady() {
  return T2S_CHARS !== null && PINYIN !== null;
}

/** 繁体 -> 简体（短语优先，字符兜底）。已经是简体则原样保留。 */
export function toSimplified(s) {
  if (!T2S_CHARS) throw new Error('dict not loaded');
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    let matched = false;
    const maxLen = Math.min(T2S_MAXP, n - i);
    for (let len = maxLen; len >= 2; len--) {
      const v = T2S_PHRASES[s.substr(i, len)];
      if (v !== undefined) {
        out += v;
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) {
      const ch = s[i];
      out += T2S_CHARS[ch] ?? ch;
      i++;
    }
  }
  return out;
}

/** 单个汉字的读音列表（小写、无音调），没有则返回 null */
export function readingsOf(ch) {
  if (!PINYIN) throw new Error('dict not loaded');
  return PINYIN[ch] || null;
}
