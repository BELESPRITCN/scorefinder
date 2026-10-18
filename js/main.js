/**
 * 主程序：界面、交互、数据流。
 * 三个数据源（Google Drive / 本机文件夹 / 本机导入）统一走 search.js 的索引和搜索。
 */
import { initDictFromUrls } from './dict.js';
import { search, groupHits } from './search.js';
import * as store from './store.js';
import { listSources, saveSource, refreshSource, removeSource, loadAllRecords } from './sources/index.js';
import * as importedSrc from './sources/imported.js';
import * as fsaSrc from './sources/fsafolder.js';
import * as driveSrc from './sources/drive.js';
import * as lanSrc from './sources/lanserver.js';
import { PUBLIC_APP_URL, buildDriveConfigLink, parseDriveConfigLink, appBaseUrl, defaultShareBase } from './configlink.js';
import { openViewer, closeViewer, installViewerGestures } from './viewer.js';
import { $, el, debounce, toast, fmtSize, fmtTime, downloadBlob } from './util.js';

const VERSION = '0.1.0';
const KIND_LABEL = { pdf: 'PDF', image: '图片', doc: 'DOC' };

const state = {
  sources: [],
  records: [],
  results: [],
  activeSources: null, // null = 全部
  cachedDriveIds: new Set(),
  tab: 'search',
  installingPrompt: null,
  dictReady: false,
  openedFromLink: false,
  lanInfo: null,
};

/* ============ 打开文件 / 缓存 ============ */

async function cachedDriveIds() {
  const names = await store.opfsListNames(['cache', 'drive']);
  state.cachedDriveIds = new Set(names);
}

function isCached(rec) {
  return rec.sourceType === 'drive' && state.cachedDriveIds.has(rec.driveId);
}

async function cacheDriveBlob(rec, blob) {
  await store.opfsWrite(['cache', 'drive', rec.driveId], blob);
  state.cachedDriveIds.add(rec.driveId);
}

async function getBlob(rec) {
  const st = store.loadSettings();
  if (rec.sourceType === 'imported') {
    const f = await store.opfsRead(['imported', rec.opfsPath || rec.relPath]);
    if (!f) throw new Error('本机文件不存在（可能被浏览器清理，请重新导入）');
    return f;
  }
  if (rec.sourceType === 'fsa') {
    return await fsaSrc.open(rec);
  }
  if (rec.sourceType === 'server') {
    return await lanSrc.open(rec);
  }
  if (rec.sourceType === 'drive') {
    const cached = await store.opfsRead(['cache', 'drive', rec.driveId]);
    if (cached) return cached;
    if (!navigator.onLine) throw new Error('当前离线，且这个谱还没有缓存到本机');
    const src = state.sources.find((s) => s.id === rec.sourceId);
    const cfg = src?.config || {};
    const auth =
      cfg.mode === 'apiKey'
        ? driveSrc.authOf({ mode: 'apiKey', apiKey: cfg.apiKey || st.driveApiKey })
        : driveSrc.authOf({ clientId: cfg.clientId || st.driveClientId });
    const blob = await driveSrc.open(rec, auth);
    if (st.autoCacheViewed) {
      cacheDriveBlob(rec, blob).then(() => renderResults()).catch(() => {});
    }
    return blob;
  }
  throw new Error('未知来源类型: ' + rec.sourceType);
}

function openHref(rec) {
  return '?open=' + encodeURIComponent(rec.id);
}

function drivePreviewUrl(rec) {
  return `https://drive.google.com/file/d/${encodeURIComponent(rec.driveId)}/view`;
}

/** Word 类文档：Drive 直接打开 Google 预览；本机/导入的下载后用系统工具打开 */
async function openDoc(rec) {
  if (rec.sourceType === 'drive' && rec.driveId) {
    const url = drivePreviewUrl(rec);
    if (state.openedFromLink) {
      location.replace(url);
      return;
    }
    const a = el('a', { href: url, target: '_blank', rel: 'noopener' });
    document.body.append(a);
    a.click();
    a.remove();
    return;
  }

  toast('正在准备下载…', 2000);
  try {
    const blob = await getBlob(rec);
    downloadBlob(blob, rec.raw || rec.display || 'document');
    toast('已开始下载，请用 Word/Pages 打开', 4200);
    if (state.openedFromLink) setTimeout(() => window.close(), 800);
  } catch (e) {
    if (rec.sourceType === 'fsa' && state.openedFromLink) {
      promptAuthorize(rec, e.message);
    } else {
      toast('下载失败: ' + e.message, 4200);
    }
  }
}

async function openItem(item) {
  const rec = item.rec;
  if (rec.kind === 'doc') {
    await openDoc(rec);
    return;
  }
  toast('正在打开…', 1200);
  try {
    const blob = await getBlob(rec);
    const canCache = rec.sourceType === 'drive' && !isCached(rec);
    await openViewer({
      blob,
      rec,
      canCache,
      cached: isCached(rec),
      onClose: () => {
        // 从搜索结果新标签页打开时：直接关掉这个标签（浏览器只允许关单条历史的标签），
        // 关不掉就退回该标签内的搜索页。
        if (state.openedFromLink) {
          window.close();
          setTimeout(() => {
            closeViewer();
            renderResults();
          }, 120);
          return;
        }
        closeViewer();
        renderResults();
      },
      onCache: async () => {
        await cacheDriveBlob(rec, blob);
      },
    });
  } catch (e) {
    if (rec.sourceType === 'fsa' && state.openedFromLink) {
      promptAuthorize(rec, e.message);
    } else {
      toast('打开失败: ' + e.message, 4200);
    }
  }
}

/** 新标签页里打开「本机文件夹」的谱时，浏览器可能要求一次新的点击授权 */
function promptAuthorize(rec, msg) {
  const sheet = $('#sheet');
  sheet.textContent = '';
  sheet.hidden = false;
  sheet.append(
    el(
      'div',
      { class: 'sheet-list' },
      el('div', { class: 'sheet-title' }, '需要一次授权'),
      el('div', { class: 'muted', style: 'padding:0 2px 10px' }, `${msg}。点下面按钮允许读取该文件夹即可打开。`),
      el(
        'button',
        {
          class: 'primary',
          onclick: async () => {
            sheet.hidden = true;
            await openItem({ rec });
          },
        },
        '授权并打开'
      ),
      el('button', { class: 'sheet-cancel', onclick: () => (sheet.hidden = true) }, '取消')
    )
  );
}

function chooseItem(group) {
  if (group.items.length === 1) {
    openItem(group.items[0]);
    return;
  }
  const sheet = $('#sheet');
  sheet.textContent = '';
  sheet.hidden = false;
  const list = el(
    'div',
    { class: 'sheet-list' },
    el('div', { class: 'sheet-title' }, `「${group.items[0].rec.display}」有 ${group.items.length} 个来源`),
    ...group.items.map((it) =>
      el(
        'a',
        {
          class: 'sheet-item',
          href: openHref(it.rec),
          target: '_blank',
          rel: 'noopener',
          onclick: (e) => {
            if (it.rec.kind === 'doc') {
              e.preventDefault();
              sheet.hidden = true;
              openDoc(it.rec);
              return;
            }
            sheet.hidden = true;
          },
        },
        el('span', { class: 'sheet-src' }, it.rec.sourceName || it.rec.sourceType),
        el('span', { class: 'sheet-path' }, it.rec.relPath || it.rec.raw),
        isCached(it.rec) ? el('span', { class: 'badge ok' }, '已缓存') : null
      )
    ),
    el('button', { class: 'sheet-cancel', onclick: () => (sheet.hidden = true) }, '取消')
  );
  sheet.append(list);
}

/* ============ 搜索页 ============ */

function sourceChips() {
  const counts = new Map();
  for (const r of state.records) counts.set(r.sourceId, (counts.get(r.sourceId) || 0) + 1);
  const bar = el('div', { class: 'chips' });
  bar.append(
    el(
      'button',
      {
        class: 'chip' + (state.activeSources === null ? ' on' : ''),
        onclick: () => {
          state.activeSources = null;
          runSearch();
          renderSearchPage();
        },
      },
      `全部 ${state.records.length}`
    )
  );
  for (const s of state.sources) {
    const n = counts.get(s.id) || 0;
    if (!n) continue;
    const on = state.activeSources?.has(s.id);
    bar.append(
      el(
        'button',
        {
          class: 'chip' + (on ? ' on' : ''),
          onclick: () => {
            const set = new Set(state.activeSources || []);
            if (on) set.delete(s.id);
            else set.add(s.id);
            state.activeSources = set.size ? set : null;
            runSearch();
            renderSearchPage();
          },
        },
        `${s.name} ${n}`
      )
    );
  }
  return bar;
}

function renderSearchPage() {
  const page = $('#page-search');
  const q = $('#q')?.value || '';
  const list = $('#results');
  const hint = $('#search-hint');

  $('#search-filters').textContent = '';
  if (state.records.length) $('#search-filters').append(sourceChips());

  list.textContent = '';
  if (!q.trim()) {
    hint.hidden = false;
    hint.textContent = state.records.length
      ? `输入关键词开始搜索（简繁、拼音、英文、编号都可以）。当前共 ${state.records.length} 个谱、${state.sources.filter((s) => (state.records.some((r) => r.sourceId === s.id))).length} 个来源。`
      : '还没有添加任何来源。去「资料库」连接 Google Drive，或添加本机文件夹 / 导入文件。';
    return;
  }
  if (!state.results.length) {
    hint.hidden = false;
    hint.textContent = '';
    hint.append(el('div', {}, state.dictReady ? '没有找到匹配的谱。' : '词典还在加载…'));
    const sugs = state.dictReady ? suggestionsFor(q) : [];
    if (sugs.length) {
      hint.append(
        el('div', { class: 'muted', style: 'margin-top:8px' }, '换个短一点的关键词试试：'),
        el(
          'div',
          { class: 'chips' },
          ...sugs.map((s) =>
            el(
              'button',
              {
                class: 'chip',
                onclick: () => {
                  $('#q').value = s.q;
                  runSearch();
                },
              },
              `${s.q}（${s.n}）`
            )
          )
        )
      );
    }
    return;
  }
  hint.hidden = true;

  for (const g of state.results) {
    const primary = g.items[0];
    const rec = primary.rec;
    const isDoc = rec.kind === 'doc';
    const sources = [...new Set(g.items.map((it) => it.rec.sourceName || it.rec.sourceType))];
    const cached = g.items.some((it) => isCached(it.rec));
    const row = el(
      'a',
      {
        class: 'result',
        href: openHref(rec),
        target: '_blank',
        rel: 'noopener',
        // 有多个来源时先让用户挑一个；Word 文档直接预览或下载，不进查看器
        onclick: (e) => {
          if (g.items.length > 1) {
            e.preventDefault();
            chooseItem(g);
            return;
          }
          if (isDoc) {
            e.preventDefault();
            openDoc(rec);
          }
        },
      },
      el('div', { class: `ficon ${rec.kind}` }, KIND_LABEL[rec.kind] || '文件'),
      el(
        'div',
        { class: 'rmain' },
        el('div', { class: 'rname' }, rec.display || rec.raw),
        el('div', { class: 'rmeta' }, rec.raw),
        el(
          'div',
          { class: 'rmeta2' },
          sources.join(' / '),
          rec.size ? ` · ${fmtSize(rec.size)}` : '',
          cached ? el('span', { class: 'badge ok' }, '可离线') : null,
          isDoc ? el('span', { class: 'badge' }, rec.sourceType === 'drive' ? 'Drive 预览' : '下载打开') : null,
          g.items.length > 1 ? el('span', { class: 'badge' }, `${g.items.length} 个来源`) : null
        )
      ),
      el('div', { class: 'rgo', title: isDoc ? (rec.sourceType === 'drive' ? '在 Google Drive 中预览' : '下载后用系统工具打开') : '' }, isDoc ? (rec.sourceType === 'drive' ? '↗' : '↓') : '›')
    );
    list.append(el('li', {}, row));
  }
}

function runSearch() {
  const q = $('#q')?.value || '';
  if (!q.trim()) {
    state.results = [];
  } else if (!state.dictReady) {
    state.results = [];
  } else {
    state.results = groupHits(search(state.records, q, { limit: 400, sourceIds: state.activeSources }));
  }
  renderSearchPage();
}

/** 搜不到时，用更短的关键词给建议（比如「月亮代表我的心」→「月亮」） */
function suggestionsFor(q) {
  const tokens = q.trim().split(/\s+/).filter(Boolean);
  const cands = new Set();
  if (tokens.length === 1) {
    const t = tokens[0];
    if (t.length >= 4) {
      cands.add(t.slice(0, 2));
      cands.add(t.slice(0, 3));
      cands.add(t.slice(-3));
    }
  } else {
    for (const t of tokens) if (t.length >= 2) cands.add(t);
  }
  const out = [];
  for (const c of cands) {
    if (c === q.trim()) continue;
    const n = search(state.records, c, { limit: 1000, sourceIds: state.activeSources }).length;
    if (n) out.push({ q: c, n });
    if (out.length >= 4) break;
  }
  return out.sort((a, b) => b.n - a.n).slice(0, 3);
}

/* ============ 资料库（来源管理） ============ */

function card(title, ...children) {
  return el('section', { class: 'card' }, el('h3', {}, title), ...children);
}

function statusLine(src) {
  if (!src.lastIndexed) return el('div', { class: 'muted' }, '尚未建立索引');
  return el(
    'div',
    { class: 'muted' },
    `${src.fileCount || 0} 个谱 · 上次索引 ${fmtTime(src.lastIndexed)} ${new Date(src.lastIndexed).toTimeString().slice(0, 5)}`
  );
}

function renderSourcesPage() {
  const page = $('#page-sources');
  page.textContent = '';
  const st = store.loadSettings();

  /* ---- 本机服务 ---- */
  const lanCard = card('本机服务（这台 Mac 上的曲库）');
  lanCard.append(
    el(
      'div',
      { class: 'muted' },
      'Mac 上运行着「歌谱搜索」时，手机/平板用同一个 WiFi 打开这个地址，就会自动连上 Mac 上 config.json 配置的文件夹——谱不用上传，也不占手机空间。'
    )
  );
  for (const s of state.sources.filter((x) => x.type === 'server')) {
    lanCard.append(
      el(
        'div',
        { class: 'src-row' },
        el('div', { class: 'src-main' }, el('div', { class: 'src-name' }, s.name), statusLine(s)),
        el('button', { class: 'ghost', onclick: (e) => doRefresh(s, e.target) }, '刷新索引'),
        el('button', { class: 'ghost danger', onclick: () => doRemove(s) }, '移除')
      )
    );
  }
  const lanInput = el('input', { class: 'inp', placeholder: '服务地址，例如 http://192.168.0.9:8765', value: location.origin });
  lanCard.append(
    el('div', { class: 'form' }, lanInput,
      el('button', {
        class: 'primary',
        onclick: async (e) => {
          const baseUrl = lanInput.value.trim().replace(/\/+$/, '');
          if (!baseUrl) return toast('请填服务地址');
          e.target.disabled = true;
          try {
            const info = await lanSrc.fetchInfo(baseUrl);
            const name = '本机服务 (' + info.roots.map((r) => r.name).join(', ') + ')';
            const src = { id: 'server_' + Math.random().toString(36).slice(2, 10), type: 'server', name, enabled: true, config: { baseUrl } };
            await saveSource(src);
            store.saveSettings({ lanDismissed: '' });
            state.sources = await listSources();
            await doRefresh(state.sources.find((s) => s.id === src.id));
          } catch (err) {
            toast('连接失败: ' + err.message, 5000);
          } finally {
            e.target.disabled = false;
          }
        },
      }, '连接并建立索引')
    )
  );
  page.append(lanCard);

  /* ---- Google Drive ---- */
  const driveSources = state.sources.filter((s) => s.type === 'drive');
  const driveCard = card('Google Drive');
  if (!driveSources.length) {
    driveCard.append(el('div', { class: 'muted' }, '把整库歌谱放在 Drive，任何设备打开网页都能搜（Mac 关机也能用）。'));
  }
  for (const s of driveSources) {
    driveCard.append(
      el(
        'div',
        { class: 'src-row' },
        el('div', { class: 'src-main' }, el('div', { class: 'src-name' }, s.name), statusLine(s)),
        s.config?.mode === 'apiKey' && s.config?.folderId && s.config?.apiKey
          ? el('button', { class: 'ghost', onclick: () => openDriveConfigModal(s) }, '二维码')
          : null,
        el('button', { class: 'ghost', onclick: (e) => doRefresh(s, e.target) }, '刷新索引'),
        el('button', { class: 'ghost danger', onclick: () => doRemove(s) }, '移除')
      )
    );
  }

  // 首次配置步骤（随时可展开，不依赖 README 文件）
  const help = el('details', { class: 'help' });
  const a = (href, text) => el('a', { href, target: '_blank', rel: 'noopener' }, text);
  help.append(
    el('summary', {}, '第一次用？点开看配置步骤（约 5 分钟，只需一次）'),
    el(
      'div',
      {},
      el('p', {}, el('b', {}, '方式 A（推荐，最简单）：公开链接 + API Key')),
      el(
        'ol',
        {},
        el('li', {}, '先把曲库文件夹传到 Drive（用 Drive 桌面客户端同步最省事）。'),
        el('li', {}, '在 Drive 里右键这个文件夹 →「共享」→ 常规访问权限选「知道链接的任何人」，权限保持「查看者」→「复制链接」。'),
        el('li', {}, a('https://console.cloud.google.com/projectcreate', '新建一个 Google Cloud 项目'), '（名字随意，如 scorefinder）。'),
        el('li', {}, a('https://console.cloud.google.com/apis/library/drive.googleapis.com', '启用 Google Drive API'), '——点「启用」。'),
        el('li', {}, a('https://console.cloud.google.com/apis/credentials', '创建 API 密钥'), '——「创建凭据 → API 密钥」→ 复制，弹窗可直接关掉。'),
        el('li', {}, '把文件夹链接和 Key 填到下面 →「添加并建立索引」。')
      ),
      el(
        'p',
        { class: 'muted' },
        '注意：第 4、5 步打开后，先看页面顶部项目选择器是不是刚建的项目；不对就切换一下。'
      ),
      el('p', { class: 'muted' }, '方式 A 意味着拿到链接的人都能看这些谱；介意的话用方式 B。'),
      el('p', {}, el('b', {}, '方式 B：Google 登录（OAuth Client ID，文件夹无需公开）')),
      el(
        'p',
        { class: 'muted' },
        '在 Google Cloud Console 创建 OAuth 客户端 ID（类型选「Web 应用」，「已获授权的 JavaScript 来源」填本页地址），详见 README 第三节「配置 Google Drive」。'
      ),
      el('p', { class: 'muted' }, 'Key 只保存在这台设备的浏览器里；也可以在 Google 控制台给 Key 加「HTTP 来源」限制（填本页地址）更安全。')
    )
  );
  driveCard.append(help);

  // 认证方式切换
  const chipApi = el('button', { class: 'chip', onclick: () => setDriveMode('apiKey') }, '公开链接 + API Key');
  const chipOauth = el('button', { class: 'chip', onclick: () => setDriveMode('oauth') }, 'Google 登录（OAuth）');
  driveCard.append(el('div', { class: 'chips' }, chipApi, chipOauth));

  const folderInput = el('input', { class: 'inp', placeholder: 'Drive 文件夹链接（https://drive.google.com/drive/folders/…）或文件夹 ID' });
  const apiKeyInput = el('input', {
    class: 'inp',
    placeholder: 'Google API Key（AIza…）',
    value: driveSources.find((s) => s.config?.mode === 'apiKey')?.config?.apiKey || st.driveApiKey || '',
  });
  const clientIdInput = el('input', {
    class: 'inp',
    placeholder: 'Google OAuth Client ID（…apps.googleusercontent.com）',
    value: driveSources.find((s) => s.config?.mode !== 'apiKey')?.config?.clientId || st.driveClientId || '',
  });

  function currentDriveMode() {
    return chipApi.classList.contains('on') ? 'apiKey' : 'oauth';
  }
  function setDriveMode(m) {
    chipApi.classList.toggle('on', m === 'apiKey');
    chipOauth.classList.toggle('on', m === 'oauth');
    apiKeyInput.hidden = m !== 'apiKey';
    clientIdInput.hidden = m !== 'oauth';
  }
  setDriveMode(driveSources[0]?.config?.mode || st.driveMode || 'apiKey');

  const addDrive = el('button', {
    class: 'primary',
    onclick: async (e) => {
      const folderId = driveSrc.parseFolderId(folderInput.value);
      if (!folderId) return toast('请粘贴 Drive 文件夹链接');
      const mode = currentDriveMode();
      e.target.disabled = true;
      try {
        let config;
        let name;
        if (mode === 'apiKey') {
          const apiKey = apiKeyInput.value.trim();
          if (!apiKey) throw new Error('请填入 Google API Key');
          const auth = driveSrc.authOf({ mode: 'apiKey', apiKey });
          name = await driveSrc.fetchFolderName(auth, folderId);
          config = { mode: 'apiKey', apiKey, folderId };
          store.saveSettings({ driveApiKey: apiKey, driveMode: 'apiKey' });
        } else {
          const clientId = clientIdInput.value.trim();
          if (!clientId) throw new Error('请填入 OAuth Client ID');
          const auth = driveSrc.authOf({ clientId });
          await driveSrc.requestToken(clientId, { interactive: true });
          name = await driveSrc.fetchFolderName(auth, folderId);
          config = { mode: 'oauth', clientId, folderId };
          store.saveSettings({ driveClientId: clientId, driveMode: 'oauth' });
        }
        const src = {
          id: 'drive_' + Math.random().toString(36).slice(2, 10),
          type: 'drive',
          name,
          enabled: true,
          config,
        };
        await saveSource(src);
        state.sources = await listSources();
        await doRefresh(state.sources.find((s) => s.id === src.id));
      } catch (err) {
        toast('添加失败: ' + err.message, 7000);
      } finally {
        e.target.disabled = false;
      }
    },
  }, '添加并建立索引');
  driveCard.append(el('div', { class: 'form' }, folderInput, apiKeyInput, clientIdInput, addDrive));
  driveCard.append(
    el(
      'div',
      { class: 'form' },
      el(
        'button',
        {
          class: 'ghost',
          onclick: async () => {
            const text = prompt('粘贴配置链接（在已配置的设备上点「二维码」→「复制链接」）：');
            if (!text) return;
            const cfg = parseDriveConfigLink(text);
            if (!cfg) return toast('配置链接格式不对', 6000);
            await importDriveConfig(cfg.folderId, cfg.apiKey);
          },
        },
        '从配置链接导入…'
      )
    ),
    el(
      'div',
      { class: 'muted small' },
      '换设备不想重新填？在已配置的设备上点来源行的「二维码」，扫码或复制链接。iPhone/iPad 已装成主屏幕 App 的用上面的导入。'
    )
  );
  page.append(driveCard);

  /* ---- 本机文件夹 ---- */
  const fsaCard = card('本机文件夹（这台电脑上的目录）');
  if (!fsaSrc.supported()) {
    fsaCard.append(el('div', { class: 'muted' }, '当前浏览器不支持直接读文件夹（Chrome/Edge 桌面版支持）。手机请用下面的「本机导入」，或在 Mac 上用 Chrome 打开。'));
  }
  for (const s of state.sources.filter((x) => x.type === 'fsa')) {
    fsaCard.append(
      el(
        'div',
        { class: 'src-row' },
        el('div', { class: 'src-main' }, el('div', { class: 'src-name' }, s.name), statusLine(s)),
        el('button', { class: 'ghost', onclick: (e) => doRefresh(s, e.target) }, '扫描/刷新'),
        el('button', { class: 'ghost danger', onclick: () => doRemove(s) }, '移除')
      )
    );
  }
  if (fsaSrc.supported()) {
    fsaCard.append(
      el('button', {
        class: 'primary',
        onclick: async () => {
          try {
            const s = await fsaSrc.addFolder();
            state.sources = await listSources();
            await doRefresh(s);
          } catch (e) {
            if (e.name !== 'AbortError') toast('添加失败: ' + e.message);
          }
        },
      }, '添加文件夹…')
    );
  }
  page.append(fsaCard);

  /* ---- 本机导入 ---- */
  const impCount = state.records.filter((r) => r.sourceType === 'imported').length;
  const impCard = card('本机导入（离线可用，手机上最常用）');
  impCard.append(
    el('div', { class: 'muted' }, `已导入 ${impCount} 个谱。适合把常看的谱复制到手机：选文件导入，或把整个文件夹打包成 ZIP 导入。支持 PDF、图片和 Word 文档；Word 下载后用系统工具打开。导入后完全离线可用。`)
  );
  const fileInput = el('input', { type: 'file', multiple: true, accept: '.pdf,image/*,.doc,.docx,.rtf,.odt', style: 'display:none' });
  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    if (!files.length) return;
    const t = toast(`导入中 0/${files.length}`, 600000);
    try {
      const recs = await importedSrc.addFiles(files, (i, n, name) => {
        const elx = document.getElementById('toast');
        if (elx) elx.textContent = `导入中 ${i}/${n}：${name}`;
      });
      await reloadRecords();
      runSearch();
      toast(`已导入 ${recs.length} 个谱`, 3000);
    } catch (e) {
      toast('导入失败: ' + e.message, 5000);
    }
  });
  const zipInput = el('input', { type: 'file', accept: '.zip', style: 'display:none' });
  zipInput.addEventListener('change', async () => {
    const f = zipInput.files?.[0];
    zipInput.value = '';
    if (!f) return;
    toast(`正在解压 ${f.name}…`, 600000);
    try {
      const { records, failed } = await importedSrc.importZip(f, (i, n, name) => {
        const elx = document.getElementById('toast');
        if (elx) elx.textContent = `解压导入 ${i}/${n}：${name}`;
      });
      await reloadRecords();
      runSearch();
      toast(`ZIP 导入完成：${records.length} 个谱${failed.length ? `，${failed.length} 个失败` : ''}`, 4000);
    } catch (e) {
      toast('ZIP 导入失败: ' + e.message, 5000);
    }
  });
  impCard.append(
    el('div', { class: 'btn-row' },
      el('button', { class: 'primary', onclick: () => fileInput.click() }, '选择文件导入…'),
      el('button', { class: 'ghost', onclick: () => zipInput.click() }, '导入 ZIP…')
    ),
    fileInput,
    zipInput
  );
  const importedRecords = state.records.filter((r) => r.sourceType === 'imported').sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  if (importedRecords.length) {
    const listBox = el('div', { class: 'imp-list' });
    for (const rec of importedRecords.slice(0, 200)) {
      listBox.append(
        el(
          'div',
          { class: 'imp-row' },
          el('span', { class: 'imp-name', title: rec.raw }, rec.display || rec.raw),
          el('span', { class: 'muted' }, fmtSize(rec.size)),
          el('button', {
            class: 'icon danger',
            title: '删除',
            onclick: async () => {
              await importedSrc.removeRecord(rec);
              await reloadRecords();
              runSearch();
              renderSourcesPage();
            },
          }, '×')
        )
      );
    }
    if (importedRecords.length > 200) listBox.append(el('div', { class: 'muted' }, `（只显示最近 200 个，共 ${importedRecords.length} 个）`));
    impCard.append(listBox);
  }
  page.append(impCard);

  /* ---- 缓存 ---- */
  const cacheCard = card('缓存与存储');
  const usageBox = el('div', { class: 'muted' }, '正在计算…');
  cacheCard.append(usageBox);
  store.storageUsage().then(({ usage, quota }) => {
    usageBox.textContent = `浏览器已用存储 ${fmtSize(usage)}${quota ? `（上限约 ${fmtSize(quota)}）` : ''}。Drive 上没缓存过的谱每次打开需要联网；打开过/缓存过的可离线。`;
  });
  cacheCard.append(
    el('div', { class: 'btn-row' },
      el('button', { class: 'ghost', onclick: async () => { await store.requestPersistentStorage(); toast('已申请持久存储：浏览器不会自动清理你的离线歌谱'); } }, '申请持久存储'),
      el('button', {
        class: 'ghost danger',
        onclick: async () => {
          if (!confirm('清空所有 Drive 缓存文件？（本机导入的文件不受影响）')) return;
          const db = await store.openDB();
          const names = await store.opfsListNames(['cache', 'drive']);
          for (const n of names) await store.opfsDelete(['cache', 'drive', n]);
          await cachedDriveIds();
          runSearch();
          toast('缓存已清空');
        },
      }, '清空 Drive 缓存')
    )
  );
  page.append(cacheCard);
}

/* 索引刷新串行化：自动刷新和手动刷新不要同时改数据库 */
let refreshLock = Promise.resolve();
let refreshBusy = false;
function withRefreshLock(task) {
  const runTask = async () => {
    refreshBusy = true;
    try {
      return await task();
    } finally {
      refreshBusy = false;
    }
  };
  const run = refreshLock.then(runTask, runTask);
  refreshLock = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function doRefresh(src, btn, { silent = false } = {}) {
  if (btn) btn.disabled = true;
  if (!silent) toast('正在建立索引…', 600000);
  return withRefreshLock(async () => {
    const before = src.fileCount || 0;
    try {
      if (src.type === 'fsa') {
        const perm = await fsaSrc.checkPermission(src.id, true);
        if (perm !== 'granted') throw new Error('没有获得文件夹读取权限');
      }
      const { source } = await refreshSource(src, (n, _t, path) => {
        if (silent) return;
        const elx = document.getElementById('toast');
        if (elx) elx.textContent = `正在建立索引… ${n} 个文件 ${path ? '· ' + path.slice(0, 40) : ''}`;
      });
      state.sources = await listSources();
      await reloadRecords();
      runSearch();
      if (silent) {
        // 后台刷新不重绘资料库，避免打断正在填写的表单
        if (source.fileCount !== before) {
          toast(`「${source.name}」已更新：${source.fileCount} 个谱`, 3500);
        } else {
          console.log(`[auto-refresh] 「${source.name}」无变化`);
        }
      } else {
        renderSourcesPage();
        toast(`「${source.name}」索引完成：${source.fileCount} 个谱`, 3500);
      }
      return true;
    } catch (e) {
      if (silent) console.warn(`[auto-refresh] 「${src.name}」失败`, e);
      else toast('索引失败: ' + e.message, 6000);
      return false;
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

let autoRefreshing = false;

/** 打开 App / 切回前台时，在后台检查 Drive 有没有新谱 */
async function autoRefreshDriveSources() {
  if (autoRefreshing || refreshBusy || !navigator.onLine) return;
  if (state.openedFromLink) return;
  if (new URLSearchParams(location.search).has('selftest')) return;
  const candidates = state.sources.filter((s) => {
    if (s.type !== 'drive' || s.enabled === false || !s.lastIndexed) return false;
    // OAuth 过期时不能静默续期，避免后台突然弹登录框；OAuth 来源仍用手动刷新
    if (s.config?.mode !== 'apiKey' || !s.config?.apiKey) return false;
    return Date.now() - s.lastIndexed > 30_000;
  });
  if (!candidates.length) return;
  autoRefreshing = true;
  try {
    for (const s of candidates) {
      if (!state.sources.some((x) => x.id === s.id)) continue;
      await doRefresh(s, null, { silent: true });
    }
  } finally {
    autoRefreshing = false;
  }
}

async function doRemove(src) {
  if (!confirm(`移除来源「${src.name}」？（不会动云端/磁盘上的原文件）`)) return;
  // 等后台刷新结束，避免刷新又把来源写回去
  if (refreshBusy) toast('正在后台更新索引，完成后移除…', 2500);
  await refreshLock;
  // 手动移除本机服务后，不要每次打开又自动加回来
  if (src.type === 'server' && String(src.config?.baseUrl || '').replace(/\/+$/, '') === location.origin) {
    store.saveSettings({ lanDismissed: location.origin });
  }
  await removeSource(src);
  state.sources = await listSources();
  await reloadRecords();
  runSearch();
  renderSourcesPage();
  toast('已移除来源');
}

/**
 * 打开页面时自动探测当前地址是否就是本机服务。
 * 手机打开 Mac 的局域网地址，第一次就能直接搜，不用去资料库手动连接。
 */
async function autoConnectLan() {
  try {
    const info = await lanSrc.probeOrigin();
    if (!info) return;
    state.lanInfo = info;
    const base = location.origin;
    const existing = state.sources.find(
      (s) => s.type === 'server' && String(s.config?.baseUrl || '').replace(/\/+$/, '') === base
    );
    if (existing) {
      // 上次可能只加了来源、索引没建完，这里补一次
      if (!state.records.some((r) => r.sourceId === existing.id)) await doRefresh(existing);
      return;
    }
    if (store.loadSettings().lanDismissed === base) return;
    const src = {
      id: 'server_' + Math.random().toString(36).slice(2, 10),
      type: 'server',
      name: '本机服务 (' + (info.roots || []).map((r) => r.name).join(', ') + ')',
      enabled: true,
      config: { baseUrl: base },
    };
    await saveSource(src);
    state.sources = await listSources();
    await doRefresh(state.sources.find((s) => s.id === src.id));
    console.log(`[boot] 已自动连接本机服务：${info.fileCount} 个谱`);
  } catch (e) {
    console.warn('[boot] 自动连接本机服务失败', e);
  }
}

/* ============ Drive 配置二维码 / 换设备导入 ============ */

/** 从地址栏读取配置链接：#drive=<folderId>&k=<apiKey>（也兼容 ?drive=…） */
function readDriveConfigFromUrl() {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const query = new URLSearchParams(location.search);
  const folderId = hash.get('drive') || query.get('drive') || '';
  const apiKey = hash.get('k') || query.get('k') || '';
  return folderId && apiKey ? { folderId, apiKey } : null;
}

/** 导入后把 Key 从地址栏/历史里去掉 */
function clearDriveConfigFromUrl() {
  const u = new URL(location.href);
  u.hash = '';
  u.searchParams.delete('drive');
  u.searchParams.delete('k');
  history.replaceState(null, '', u.pathname + (u.search || ''));
}

/** 把 Drive 曲库配置加进本机（二维码扫码 / 粘贴链接共用） */
async function importDriveConfig(folderId, apiKey, { ask = false } = {}) {
  if (!folderId || !apiKey) {
    toast('配置链接不完整');
    return 'error';
  }
  const existing = state.sources.find((s) => s.type === 'drive' && s.config?.folderId === folderId);
  if (existing) {
    toast(`这个曲库已经添加过了：${existing.name}`, 5000);
    return 'exists';
  }
  let name;
  try {
    name = await driveSrc.fetchFolderName(driveSrc.authOf({ mode: 'apiKey', apiKey }), folderId);
  } catch (e) {
    toast('配置无效：' + e.message, 7000);
    return 'error';
  }
  if (ask && !(await askImportDrive(name))) return 'cancelled';
  const src = {
    id: 'drive_' + Math.random().toString(36).slice(2, 10),
    type: 'drive',
    name,
    enabled: true,
    config: { mode: 'apiKey', apiKey, folderId },
  };
  await saveSource(src);
  store.saveSettings({ driveApiKey: apiKey, driveMode: 'apiKey' });
  state.sources = await listSources();
  await doRefresh(state.sources.find((s) => s.id === src.id));
  return 'added';
}

/** 生成二维码（SVG，缩放到 .qrbox 大小仍然清晰） */
function renderQr(box, text) {
  box.textContent = '';
  if (typeof window.qrcode !== 'function') {
    box.textContent = '二维码组件未加载，请刷新页面再试';
    return;
  }
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const m = 4; // 静区
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
      }
    }
    box.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + m * 2} ${n + m * 2}" shape-rendering="crispEdges" role="img" aria-label="配置二维码"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  } catch (e) {
    box.textContent = '生成二维码失败：' + e.message;
  }
}

/** 扫码打开后，先确认再添加（不用原生 confirm，手机浏览器在加载阶段可能拦截） */
function askImportDrive(name) {
  return new Promise((resolve) => {
    const modal = $('#modal');
    modal.textContent = '';
    modal.hidden = false;
    const finish = (ok) => {
      modal.hidden = true;
      modal.textContent = '';
      modal.onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(ok);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') finish(false);
    };
    document.addEventListener('keydown', onKey);
    modal.onclick = (e) => {
      if (e.target === modal) finish(false);
    };
    modal.append(
      el(
        'div',
        { class: 'modal-card' },
        el('div', { class: 'modal-title' }, `添加 Google Drive 曲库「${name}」？`),
        el('div', { class: 'muted' }, '配置来自二维码/链接。会在这台设备上建立索引，API Key 只保存在本机浏览器里。'),
        el(
          'div',
          { class: 'modal-actions' },
          el('button', { class: 'primary', onclick: () => finish(true) }, '添加'),
          el('button', { class: 'ghost', onclick: () => finish(false) }, '取消')
        )
      )
    );
  });
}

/** 「配置二维码」弹窗：把当前 Drive 来源的 folderId + API Key 带到另一台设备 */
function openDriveConfigModal(src) {
  const modal = $('#modal');
  modal.textContent = '';
  modal.hidden = false;
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  function close() {
    modal.hidden = true;
    modal.textContent = '';
    modal.onclick = null;
    document.removeEventListener('keydown', onKey);
  }
  modal.onclick = (e) => {
    if (e.target === modal) close();
  };
  document.addEventListener('keydown', onKey);

  const baseInput = el('input', { class: 'inp', value: defaultShareBase(), spellcheck: 'false', autocapitalize: 'off' });
  const linkInput = el('input', { class: 'inp mono', readonly: true });
  const qrBox = el('div', { class: 'qrbox' });
  const error = el('div', { class: 'muted small' });

  function refreshLink() {
    error.textContent = '';
    try {
      const link = buildDriveConfigLink(baseInput.value, src.config.folderId, src.config.apiKey);
      linkInput.value = link;
      renderQr(qrBox, link);
    } catch (e) {
      linkInput.value = '';
      qrBox.textContent = '';
      error.textContent = e.message;
    }
  }

  const curBase = appBaseUrl();
  const presets = el(
    'div',
    { class: 'chips' },
    el('button', { class: 'chip', onclick: () => { baseInput.value = PUBLIC_APP_URL; refreshLink(); } }, '公网版'),
    /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || curBase === PUBLIC_APP_URL
      ? null
      : el('button', { class: 'chip', onclick: () => { baseInput.value = curBase; refreshLink(); } }, '当前地址')
  );
  baseInput.addEventListener('input', debounce(refreshLink, 150));

  async function copyLink() {
    const text = linkInput.value;
    if (!text) return toast(error.textContent || '链接无效');
    try {
      await navigator.clipboard.writeText(text);
      toast('配置链接已复制');
    } catch {
      linkInput.focus();
      linkInput.select();
      try {
        document.execCommand('copy');
        toast('配置链接已复制');
      } catch {
        toast('复制失败：请长按链接手动复制', 5000);
      }
    }
  }

  modal.append(
    el(
      'div',
      { class: 'modal-card' },
      el('div', { class: 'modal-title' }, `在其它设备上添加「${src.name}」`),
      el('div', { class: 'muted' }, '用手机/平板的相机扫二维码，或在浏览器里打开链接；按提示确认即可，不用再填 Key。'),
      el('div', { class: 'field-label' }, '二维码里的地址'),
      baseInput,
      presets,
      qrBox,
      el('div', { class: 'field-label' }, '配置链接'),
      linkInput,
      error,
      el('div', { class: 'modal-actions' }, el('button', { class: 'primary', onclick: copyLink }, '复制链接'), el('button', { class: 'ghost', onclick: close }, '关闭')),
      el(
        'div',
        { class: 'muted small' },
        '链接里含 API Key，请只发给自己。iPhone/iPad 的主屏幕 App 与 Safari 存储分开：已装成 App 的，先在已配置的设备上「复制链接」，再到 App 里用「从配置链接导入」；扫码只会加到 Safari。'
      )
    )
  );
  refreshLink();
}

/* ============ 设置页 ============ */

function renderSettingsPage() {
  const page = $('#page-settings');
  page.textContent = '';
  const st = store.loadSettings();

  const cacheToggle = el('input', {
    type: 'checkbox',
    ...(st.autoCacheViewed ? { checked: true } : {}),
    onchange: () => {
      store.saveSettings({ autoCacheViewed: cacheToggle.checked });
      toast(cacheToggle.checked ? '打开过的 Drive 谱会自动缓存' : '不再自动缓存');
    },
  });
  page.append(
    card('设置',
      el('label', { class: 'row' }, cacheToggle, el('span', {}, '打开过的 Google Drive 谱自动缓存到本机（方便离线重看）')),
      el('label', { class: 'row' },
        el('input', {
          type: 'checkbox',
          ...(('standalone' in window.navigator) ? { checked: true } : {}),
          onchange: () => {},
        }),
        el('span', {}, `当前是${window.matchMedia('(display-mode: standalone)').matches ? '' : '非'}独立 App 模式（从主屏幕打开即为独立模式）`)
      )
    )
  );

  const online = navigator.onLine;
  page.append(
    card('状态',
      el('div', { class: 'muted' }, `网络：${online ? '在线' : '离线'} · 版本 ${VERSION} · ${navigator.userAgent.includes('Android') ? 'Android' : '桌面'}`),
      state.installingPrompt
        ? el('button', { class: 'primary', onclick: async () => { state.installingPrompt.prompt(); state.installingPrompt = null; renderSettingsPage(); } }, '安装到主屏幕 / 桌面')
        : el('div', { class: 'muted' }, '想装成 App：Chrome 菜单 →「添加到主屏幕」或地址栏右侧「安装」。装好后可全屏打开、离线可用。')
    )
  );

  page.append(
    card('关于',
      el('div', { class: 'muted' }, '歌谱搜索 · 纯本地处理，歌谱文件和搜索都不经过任何中间服务器。'),
      el('div', { class: 'muted' }, '搜索支持：简繁互转、拼音全拼/首字母、英文（忽略大小写和撇号）、编号、多关键词（空格分隔，全部满足）。')
    )
  );
}

/* ============ 页面切换 ============ */

function showTab(tab) {
  state.tab = tab;
  for (const t of ['search', 'sources', 'settings']) {
    $(`#page-${t}`).hidden = t !== tab;
  }
  for (const b of document.querySelectorAll('#tabs button')) {
    b.classList.toggle('on', b.dataset.tab === tab);
  }
  if (tab === 'sources') renderSourcesPage();
  if (tab === 'settings') renderSettingsPage();
  if (tab === 'search') {
    renderSearchPage();
    if (window.matchMedia('(min-width: 720px)').matches) $('#q').focus();
  }
}

/* ============ 启动 ============ */

async function reloadRecords() {
  state.records = await loadAllRecords();
}

async function boot() {
  // 界面骨架事件
  $('#q').addEventListener('input', debounce(() => runSearch(), 80));
  $('#q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch();
  });
  $('#q-clear').addEventListener('click', () => {
    $('#q').value = '';
    runSearch();
    $('#q').focus();
  });
  for (const b of document.querySelectorAll('#tabs button')) {
    b.addEventListener('click', () => showTab(b.dataset.tab));
  }
  installViewerGestures();
  window.addEventListener('online', () => {
    renderSettingsPage();
    autoRefreshDriveSources().catch((e) => console.warn('[auto-refresh]', e));
  });
  window.addEventListener('offline', () => renderSettingsPage());
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installingPrompt = e;
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch((e) => console.warn('SW 注册失败', e));
  }

  // 数据
  console.log('[boot] 打开数据库');
  await store.openDB();
  console.log('[boot] 缓存列表');
  await cachedDriveIds();
  console.log('[boot] 来源列表');
  state.sources = await listSources();
  console.log('[boot] 记录');
  await reloadRecords();
  showTab('search');
  console.log('[boot] 已显示搜索页');

  // 配置链接（二维码）：#drive=<folderId>&k=<apiKey>
  const cfgFromLink = readDriveConfigFromUrl();
  if (cfgFromLink) clearDriveConfigFromUrl();

  // 搜索结果在新标签页打开：?open=<记录 id>，直接进查看器
  const openId = new URLSearchParams(location.search).get('open');
  if (openId) {
    state.openedFromLink = true;
    const rec = state.records.find((r) => r.id === openId);
    if (rec) {
      openItem({ rec });
    } else {
      toast('这个谱不在索引里了（来源可能被重置），请回搜索页刷新索引', 7000);
    }
  }

  // 从后台切回前台超过 30 秒，就检查一次 Drive 更新
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    if (away >= 30_000) autoRefreshDriveSources().catch((e) => console.warn('[auto-refresh]', e));
  });

  // 词典（74 万字节，一次加载）
  try {
    await initDictFromUrls(new URL('../data/t2s.json', import.meta.url).href, new URL('../data/pinyin.json', import.meta.url).href);
    state.dictReady = true;
    runSearch();
  } catch (e) {
    toast('词典加载失败: ' + e.message, 6000);
  }

  // 从二维码/配置链接导入的 Drive 来源
  if (cfgFromLink && !openId && !new URLSearchParams(location.search).has('selftest')) {
    await importDriveConfig(cfgFromLink.folderId, cfgFromLink.apiKey, { ask: true });
  }

  // 手机/平板打开 http://192.168.x.x:8765 或 Tailscale 地址时：自动连接本机服务
  // （必须在词典加载后，建立索引要用词典生成显示名）
  if (!new URLSearchParams(location.search).has('selftest')) {
    const lanTask = autoConnectLan();
    if (!openId) await lanTask;
  }

  // 打开时后台检查 Drive 更新（不阻塞界面；刚索引过 30 秒内不重复）
  if (!openId && !new URLSearchParams(location.search).has('selftest')) {
    autoRefreshDriveSources().catch((e) => console.warn('[auto-refresh]', e));
  }

  store.requestPersistentStorage().then((ok) => {
    if (ok) store.saveSettings({ persistRequested: true });
  });

  if (!store.mem.enabled && !(await store.opfsAvailable())) {
    toast('提示：浏览器文件存储不可用，导入/缓存的谱只保留在本次会话', 8000);
  }
  if (store.mem.enabled) {
    toast('提示：浏览器数据库不可用（可能是无痕浏览），索引不会保存到下次打开', 8000);
  }

  if (new URLSearchParams(location.search).has('selftest')) {
    runSelfTest().catch((e) => console.error('selftest crash', e));
  }
  console.log('[boot] done');
}

/** 自检模式：?selftest=1&server=<地址>&q=<关键词>，结果写入 #selftest 和页面标题 */
async function runSelfTest() {
  const params = new URLSearchParams(location.search);
  const out = el('pre', { id: 'selftest' });
  document.body.append(out);
  const lines = [];
  const log = (s) => {
    lines.push(s);
    out.textContent = lines.join('\n');
    console.log('[selftest] ' + s);
  };
  try {
    const baseUrl = (params.get('server') || location.origin).replace(/\/+$/, '');
    const q = params.get('q') || '愛你';
    log(`server=${baseUrl} q=${q}`);
    const info = await lanSrc.fetchInfo(baseUrl);
    log(`服务信息: roots=${info.roots.map((r) => r.name).join(',')} fileCount=${info.fileCount}`);
    log(`存储: IndexedDB=${store.mem.enabled ? '不可用(内存模式)' : '正常'} OPFS=${(await store.opfsAvailable()) ? '正常' : '不可用(内存模式)'}`);
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      log(`Service Worker: ${reg ? '已注册' : '未注册'}`);
    } catch (e) {
      log('Service Worker: 检查失败 ' + e.message);
    }
    let src = state.sources.find((s) => s.type === 'server' && s.config.baseUrl === baseUrl);
    if (!src) {
      src = { id: 'server_selftest', type: 'server', name: '本机服务(自检)', enabled: true, config: { baseUrl } };
      await saveSource(src);
      state.sources = await listSources();
    }
    const t0 = Date.now();
    const { source } = await refreshSource(src, (n) => {
      if (n % 2000 === 0) log(`索引中… ${n}`);
    });
    log(`索引完成: ${source.fileCount} 个谱, 耗时 ${Date.now() - t0}ms`);
    await reloadRecords();
    log(`记录数=${state.records.length}`);
    $('#q').value = q;
    runSearch();
    log(`命中=${state.results.length}`);
    for (const g of state.results.slice(0, 6)) log(`  · ${g.items[0].rec.display}  <${g.items[0].rec.raw}>`);
    const first = state.results[0];
    if (first) {
      await openItem(first.items[0]);
      await new Promise((r) => setTimeout(r, 3000));
      const canvas = document.querySelector('#v-canvas');
      const img = document.querySelector('#v-img');
      log(
        '查看器: ' +
          (canvas ? `PDF canvas ${canvas.width}x${canvas.height}` : img ? `图片 ${img.naturalWidth}x${img.naturalHeight}` : '未渲染!')
      );
    }
    log('SELFTEST OK');
    document.title = 'SELFTEST OK';
  } catch (e) {
    log('SELFTEST FAIL: ' + (e && e.message));
    document.title = 'SELFTEST FAIL';
  }
}

boot().catch((e) => {
  console.error(e);
  document.body.append(el('div', { class: 'fatal' }, '启动失败: ' + e.message));
});
