/**
 * 查看器：PDF（pdf.js 本地渲染）+ 图片（可缩放/旋转）。
 * 支持：翻页、缩放、旋转、双指手势、键盘，以及"缓存/下载/系统打开"。
 */
import { el, $, toast, debounce } from './util.js';

let pdfjsLib = null;
let vendorBase = null;

async function ensurePdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import(new URL('../vendor/pdfjs/pdf.min.mjs', import.meta.url).href);
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
    vendorBase = new URL('../vendor/pdfjs/', import.meta.url).href;
  }
  return pdfjsLib;
}

const S = {
  rec: null,
  blobUrl: null,
  pdf: null,
  page: 1,
  pages: 0,
  zoom: 1,
  fitMode: true,
  rotate: 0,
  rendering: false,
  pendingRender: false,
  onClose: null,
  cached: false,
  canCache: false,
};

function root() {
  return document.getElementById('viewer');
}

function setStatus(text) {
  const s = $('#v-status');
  if (s) s.textContent = text || '';
}

function isOpen() {
  return root() && !root().hidden;
}

export function closeViewer() {
  const r = root();
  if (!r) return;
  r.hidden = true;
  r.classList.remove('open');
  if (S.blobUrl) URL.revokeObjectURL(S.blobUrl);
  if (S.pdf) {
    try {
      S.pdf.destroy();
    } catch {
      /* ignore */
    }
  }
  Object.assign(S, { rec: null, blobUrl: null, pdf: null, page: 1, pages: 0, zoom: 1, rotate: 0, fitMode: true, onClose: null });
  if (document.body.dataset.viewer === '1') delete document.body.dataset.viewer;
}

/** 打开查看器
 * @param {{blob:Blob, rec:object, group?:Array, index?:number, canCache?:boolean, cached?:boolean, onCache?:Function, onSwitch?:Function}} opts
 */
export async function openViewer(opts) {
  const r = root();
  Object.assign(S, {
    rec: opts.rec,
    blobUrl: URL.createObjectURL(opts.blob),
    page: 1,
    zoom: 1,
    fitMode: true,
    rotate: 0,
    pages: 0,
    onClose: opts.onClose || null,
    cached: !!opts.cached,
    canCache: !!opts.canCache,
    onCache: opts.onCache || null,
    onSwitch: opts.onSwitch || null,
    group: opts.group || null,
    index: opts.index || 0,
  });
  r.hidden = false;
  r.classList.add('open');
  document.body.dataset.viewer = '1';
  buildBar(opts);
  if (opts.rec.kind === 'pdf') {
    await openPdf(opts.blob);
  } else {
    openImage();
  }
}

function buildBar(opts) {
  const bar = $('#v-bar');
  bar.textContent = '';
  const prevBtn = el('button', { class: 'icon', title: '返回搜索', onclick: () => (S.onClose ? S.onClose() : closeViewer()) }, '←');
  const title = el(
    'div',
    { class: 'v-title' },
    el('div', { class: 'v-name', title: S.rec.raw }, S.rec.display || S.rec.raw),
    el('div', { class: 'v-sub' }, `${S.rec.sourceName || ''} · ${S.rec.relPath || S.rec.raw}`)
  );
  const actions = el('div', { class: 'v-actions' });
  if (S.canCache && !S.cached) {
    actions.append(el('button', { class: 'ghost', onclick: () => doCache() }, '缓存到本机'));
  } else if (S.cached) {
    actions.append(el('span', { class: 'badge ok', title: '已缓存在本机，可离线查看' }, '已缓存'));
  }
  actions.append(
    el('button', {
      class: 'ghost',
      title: '下载/保存',
      onclick: downloadCurrent,
    }, '下载')
  );
  actions.append(
    el('button', {
      class: 'ghost',
      title: '用系统方式打开（新标签页）',
      onclick: () => window.open(S.blobUrl, '_blank'),
    }, '系统打开')
  );
  bar.append(prevBtn, title, actions);
}

async function doCache() {
  if (!S.onCache) return;
  setStatus('正在缓存到本机…');
  try {
    await S.onCache();
    S.cached = true;
    buildBar({});
    setStatus('已缓存，可离线查看');
  } catch (e) {
    setStatus('');
    toast('缓存失败: ' + e.message);
  }
}

async function openPdf(blob) {
  setStatus('正在加载 PDF…');
  const stage = $('#v-stage');
  stage.textContent = '';
  const canvas = el('canvas', { id: 'v-canvas' });
  stage.append(canvas);
  try {
    const lib = await ensurePdfjs();
    const data = new Uint8Array(await blob.arrayBuffer());
    S.pdf = await lib.getDocument({
      data,
      cMapUrl: vendorBase + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: vendorBase + 'standard_fonts/',
      // v6 起 CCITT 传真（本曲库的扫描件格式）与 JPEG2000 解码走 wasm；
      // 不给 wasmUrl 会导致整页扫描图渲染为空白。
      wasmUrl: vendorBase + 'wasm/',
    }).promise;
    S.pages = S.pdf.numPages;
    S.page = 1;
    buildTools('pdf');
    await renderPage();
    setStatus('');
  } catch (e) {
    setStatus('');
    stage.textContent = '';
    stage.append(el('div', { class: 'v-error' }, 'PDF 渲染失败: ' + e.message));
  }
}

function downloadCurrent() {
  const a = el('a', { href: S.blobUrl, download: S.rec?.raw || 'download' });
  document.body.append(a);
  a.click();
  a.remove();
}

function openImage() {
  const stage = $('#v-stage');
  stage.textContent = '';
  const img = el('img', { src: S.blobUrl, alt: S.rec.raw, id: 'v-img' });
  img.addEventListener('error', () => {
    stage.textContent = '';
    stage.append(
      el(
        'div',
        { style: 'display:flex;flex-direction:column;align-items:center;gap:12px' },
        el('div', { class: 'v-error' }, '浏览器不能直接显示这个图片格式。下载后可以用系统工具打开。'),
        el('button', { class: 'primary', onclick: downloadCurrent }, '下载原图')
      )
    );
  });
  stage.append(img);
  buildTools('image');
  applyImageTransform();
}

function buildTools(kind) {
  const tools = $('#v-tools');
  tools.textContent = '';
  if (kind === 'pdf') {
    tools.append(
      el('button', { class: 'icon', title: '上一页 (←)', onclick: () => gotoPage(S.page - 1) }, '‹'),
      el('span', { class: 'v-page', id: 'v-page' }, `${S.page} / ${S.pages}`),
      el('button', { class: 'icon', title: '下一页 (→)', onclick: () => gotoPage(S.page + 1) }, '›')
    );
  }
  tools.append(
    el('button', { class: 'icon', title: '缩小 (-)', onclick: () => zoomBy(1 / 1.3) }, '−'),
    el('span', { class: 'v-zoom', id: 'v-zoom' }, '100%'),
    el('button', { class: 'icon', title: '放大 (+)', onclick: () => zoomBy(1.3) }, '＋'),
    el('button', {
      class: 'ico-text',
      title: '适应宽度',
      onclick: () => {
        S.fitMode = true;
        S.zoom = 1;
        applyZoom();
      },
    }, '适宽'),
    el('button', { class: 'ico-text', title: '旋转 (r)', onclick: () => rotateBy(90) }, '旋转')
  );
}

function updateZoomLabel() {
  const z = $('#v-zoom');
  if (z) z.textContent = Math.round(S.zoom * 100) + '%';
  const p = $('#v-page');
  if (p) p.textContent = `${S.page} / ${S.pages}`;
}

function zoomBy(f) {
  S.fitMode = false;
  S.zoom = Math.min(8, Math.max(0.3, S.zoom * f));
  applyZoom();
}

function applyZoom() {
  updateZoomLabel();
  if (S.rec.kind === 'pdf') scheduleRender();
  else applyImageTransform();
}

function rotateBy(deg) {
  S.rotate = (S.rotate + deg) % 360;
  if (S.rec.kind === 'pdf') scheduleRender();
  else applyImageTransform();
}

function applyImageTransform() {
  const img = $('#v-img');
  if (!img) return;
  img.style.transform = `rotate(${S.rotate}deg)`;
  if (S.fitMode) img.style.width = '100%';
  else img.style.width = Math.round(S.zoom * 100) + '%';
}

function gotoPage(p) {
  if (!S.pdf) return;
  const page = Math.min(Math.max(1, p), S.pages);
  if (page === S.page) return;
  S.page = page;
  updateZoomLabel();
  scheduleRender();
}

let renderTimer = null;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => renderPage(), 120);
}

async function renderPage() {
  if (!S.pdf || S.rendering) {
    S.pendingRender = true;
    return;
  }
  S.rendering = true;
  try {
    const canvas = $('#v-canvas');
    if (!canvas) return;
    const page = await S.pdf.getPage(S.page);
    const stage = $('#v-stage');
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const rotate = (page.rotate + S.rotate) % 360;
    const base = page.getViewport({ scale: 1, rotation: rotate });
    let scaleCss;
    if (S.fitMode) {
      scaleCss = Math.max(0.1, (stage.clientWidth - 8) / base.width);
    } else {
      const fit = Math.max(0.1, (stage.clientWidth - 8) / base.width);
      scaleCss = fit * S.zoom;
    }
    const scale = scaleCss * dpr;
    const viewport = page.getViewport({ scale, rotation: rotate });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = Math.floor(viewport.width / dpr) + 'px';
    canvas.style.height = Math.floor(viewport.height / dpr) + 'px';
    const task = page.render({ canvasContext: canvas.getContext('2d'), canvas, viewport });
    await task.promise;
  } catch (e) {
    console.warn('render error', e);
  } finally {
    S.rendering = false;
    if (S.pendingRender) {
      S.pendingRender = false;
      renderPage();
    }
  }
}

/* ---------------- 手势与键盘 ---------------- */

let touchStart = null;
export function installViewerGestures() {
  const stage = $('#v-stage');
  stage.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 1) touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
      else touchStart = null;
    },
    { passive: true }
  );
  stage.addEventListener(
    'touchend',
    (e) => {
      if (!touchStart || !S.rec) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touchStart.x;
      const dy = t.clientY - touchStart.y;
      const dt = Date.now() - touchStart.t;
      touchStart = null;
      if (dt > 600 || Math.abs(dx) < 60 || Math.abs(dy) > 60) return;
      if (S.rec.kind === 'pdf' && S.fitMode) {
        if (dx < 0) gotoPage(S.page + 1);
        else gotoPage(S.page - 1);
      }
    },
    { passive: true }
  );
  window.addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    if (e.key === 'Escape') closeViewer();
    else if (e.key === 'ArrowRight' || e.key === 'PageDown') gotoPage(S.page + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') gotoPage(S.page - 1);
    else if (e.key === '+' || e.key === '=') zoomBy(1.3);
    else if (e.key === '-') zoomBy(1 / 1.3);
    else if (e.key.toLowerCase() === 'r') rotateBy(90);
  });
  window.addEventListener(
    'resize',
    debounce(() => {
      if (isOpen() && S.rec?.kind === 'pdf' && S.fitMode) scheduleRender();
    }, 200)
  );
}
