// ================================================================
// PAGESMITH — app.js  (ES Module)
// ================================================================

// ── CONSTANTS ──────────────────────────────────────────────────
const THUMB_W = 240;
const DPR     = window.devicePixelRatio || 1;
const HANDLE_R = 6;

const PAGE_SIZES = {
  letter:  { w: 612,    h: 792,     label: 'Letter (8.5×11")' },
  a4:      { w: 595.28, h: 841.89,  label: 'A4 (210×297mm)' },
  legal:   { w: 612,    h: 1008,    label: 'Legal (8.5×14")' },
  tabloid: { w: 792,    h: 1224,    label: 'Tabloid (11×17")' },
  a3:      { w: 841.89, h: 1190.55, label: 'A3 (297×420mm)' },
  a5:      { w: 419.53, h: 595.28,  label: 'A5 (148×210mm)' },
};

// ── STATE ───────────────────────────────────────────────────────
// pipelineCache[i] = { valid, computing, bytes, pages }
//   pages = [{renderedImg, dim}]
//   i=0 → source pages (always valid, bytes=null)
//   i=transforms.length → final output after all transforms
//
// Default view: show pipelineCache[transforms.length] (final output)
// While editing transform i: show pipelineCache[i] (its input)
const S = {
  pages:          [],    // source pages (srcType, pdfSrcBytes, imgBytes, etc.)
  transforms:     [],    // [{id, type, settings}]
  editingId:      null,  // id of transform currently being edited
  pipelineCache:  [],    // see above
  drag:           null,
  zoom:           1.0,
  isDark:         true,
};

// ── HELPERS ─────────────────────────────────────────────────────
function uid()                { return Math.random().toString(36).substring(2,15) + Math.random().toString(36).substring(2,15); }
function clamp(v, lo, hi)     { return Math.max(lo, Math.min(hi, v)); }
function transformIndex(id)   { return S.transforms.findIndex(t => t.id === id); }

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' toast-' + type : '');
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => { el.classList.add('fade-out'); setTimeout(() => el.remove(), 350); }, 2800);
}

// ── THEME ───────────────────────────────────────────────────────
function applyTheme(dark) {
  S.isDark = dark;
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const suns = document.querySelectorAll('#theme-toggle .sun-icon');
  const moons = document.querySelectorAll('#theme-toggle .moon-icon');
  suns.forEach(s => s.style.display = dark ? 'none' : 'block');
  moons.forEach(m => m.style.display = dark ? 'block' : 'none');
  try { localStorage.setItem('ps-theme', dark ? 'dark' : 'light'); } catch {}
}

// ── LOCAL STORAGE DB ────────────────────────────────────────────
const DB_VERSION = 1, DB_NAME = 'PagesmithDB', STORE_NAME = 'files';
let db;
function openDB() {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => { if (!e.target.result.objectStoreNames.contains(STORE_NAME)) e.target.result.createObjectStore(STORE_NAME); };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}
function saveFileToIDB(id, bytes) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite'); tx.objectStore(STORE_NAME).put(bytes, id);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  }));
}
function getFileFromIDB(id) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly'); const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  }));
}
async function deleteFileFromIDB(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = e => reject(e.target.error);
  });
}
function clearFilesIDB() {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite'); tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  }));
}
function uuid() { return uid(); }

let currentLoadId = 0;

// ── STATE MANAGEMENT ────────────────────────────────────────────
function saveState() {
  if (S.preventSave) return;
  const pagesMeta = S.pages.map(p => ({
    srcType: p.srcType, fileId: p.fileId, thumbId: p.thumbId, pdfSrcPageIdx: p.pdfSrcPageIdx,
    imgMimeType: p.imgMimeType, dim: p.dim
  }));
  localStorage.setItem('ps-state', JSON.stringify({ transforms: S.transforms, zoom: S.zoom, pages: pagesMeta }));
}

// ── MODULAR FILE PROCESSING ─────────────────────────────────────
async function processPDF(file) {
  const bytes    = new Uint8Array(await file.arrayBuffer());
  const fileId   = uuid();
  await saveFileToIDB(fileId, bytes);
  const pdfJsDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const added    = [];
  for (let i = 1; i <= pdfJsDoc.numPages; i++) {
    const page = await pdfJsDoc.getPage(i);
    const vp1  = page.getViewport({ scale: 1 });
    const dim  = { w: vp1.width, h: vp1.height };
    const scale = (THUMB_W / vp1.width) * DPR;
    const vp   = page.getViewport({ scale });
    const off  = new OffscreenCanvas(vp.width, vp.height);
    await page.render({ canvasContext: off.getContext('2d'), viewport: vp }).promise;
    
    const thumbId = uuid();
    const blob = await off.convertToBlob({ type: 'image/png' });
    const buffer = await blob.arrayBuffer();
    await saveFileToIDB(thumbId, new Uint8Array(buffer));
    added.push({ renderedImg: await createImageBitmap(blob), dim, srcType: 'pdf', fileId, thumbId, pdfSrcPageIdx: i - 1 });
  }
  return added;
}

function deleteCropRect(settings, pageIdx, id, totalPages) {
  const rects = settings.crops[pageIdx] || [];
  const idx = rects.findIndex(r => r.id === id);
  if (idx < 0) return;
  if (settings.syncAll) {
    for (let i = 0; i < totalPages; i++) {
      if (settings.crops[i]) settings.crops[i].splice(idx, 1);
    }
  } else {
    rects.splice(idx, 1);
  }
  settings.selected = null;
  invalidateCacheFrom(transformIndex(S.editingId));
  refreshOverlays();
}

async function processImage(file) {
  const bytes  = new Uint8Array(await file.arrayBuffer());
  const fileId = uuid();
  await saveFileToIDB(fileId, bytes);
  const bitmap = await createImageBitmap(new Blob([bytes], { type: file.type }));
  const { width: nw, height: nh } = bitmap;
  const dim    = { w: nw * 0.75, h: nh * 0.75 };
  const scale  = THUMB_W / nw;
  const off    = new OffscreenCanvas(Math.round(nw * scale * DPR), Math.round(nh * scale * DPR));
  off.getContext('2d').drawImage(bitmap, 0, 0, off.width, off.height);
  
  const thumbId = uuid();
  const blob = await off.convertToBlob({ type: 'image/png' });
  const buffer = await blob.arrayBuffer();
  await saveFileToIDB(thumbId, new Uint8Array(buffer));
  return [{ renderedImg: await createImageBitmap(blob), dim, srcType: 'image', fileId, thumbId, imgMimeType: file.type || 'image/png' }];
}

async function handleFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  const loadId = ++currentLoadId;
  showLoadingOverlay('Loading files...');
  const prevCount = S.pages.length;
  let added = 0;
  for (const file of files) {
    if (loadId !== currentLoadId) { hideLoadingOverlay(); return; }
    try {
      const newPages = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
        ? await processPDF(file)
        : file.type.startsWith('image/')
          ? await processImage(file)
          : (toast(`Skipped unsupported file: ${file.name}`, 'error'), null);
      if (newPages) { S.pages.push(...newPages); added += newPages.length; }
    } catch (err) {
      console.error(err);
      toast(`Failed to load ${file.name}`, 'error');
    }
  }
  if (loadId !== currentLoadId) { hideLoadingOverlay(); return; }
  if (added > 0) {
    if (S.transforms.length === 0 && prevCount === 0) S.editingId = null;
    // Extend crop settings & invalidate cache
    for (const t of S.transforms) {
      if (t.type === 'crop') {
        for (let i = prevCount; i < S.pages.length; i++) t.settings.crops[i] = t.settings.crops[i] || [];
      }
      if (t.type === 'reorder') {
        if (!t.settings.moves) t.settings.moves = [];
        // No longer need to manually adjust an 'order' array here; 
        // moves are independently resilient to page count shifts.
      }
    }
    invalidateCacheFrom(0);
    updateFileInfo();
    renderTransformList();
    updateExportButton();
    document.getElementById('drop-zone').style.display   = 'none';
    document.getElementById('pages-grid').style.display  = 'flex';
    await refreshDisplay();
    saveState();
    toast(`Added ${added} page${added !== 1 ? 's' : ''} · ${S.pages.length} total`, 'success');
  } else {
    hideLoadingOverlay();
  }
}

function updateFileInfo() {
  const cache = S.pipelineCache[displayCacheIdx()];
  const total = cache && cache.valid ? cache.pages.length : S.pages.length;
  const badge = document.getElementById('page-count-badge');
  badge.textContent = `${total} page${total !== 1 ? 's' : ''}`;
  badge.style.display = total ? 'inline-flex' : 'none';
}

// ── PIPELINE CACHE ──────────────────────────────────────────────
function initCache() {
  // Resize cache array to transforms.length + 1
  while (S.pipelineCache.length < S.transforms.length + 1) {
    S.pipelineCache.push({ valid: false, computing: false, bytes: null, pages: [] });
  }
  S.pipelineCache.length = S.transforms.length + 1;
  // Stage 0 always reflects source pages
  S.pipelineCache[0] = { valid: true, computing: false, bytes: null,
                         pages: S.pages.map(p => ({ renderedImg: p.renderedImg, dim: p.dim })) };
}

function invalidateCacheFrom(fromIdx) {
  for (let i = Math.max(1, fromIdx + 1); i < S.pipelineCache.length; i++) {
    if (S.pipelineCache[i]) S.pipelineCache[i].valid = false;
  }
}

function showLoadingOverlay(msg = 'Rendering…') {
  let el = document.getElementById('pipeline-loading');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pipeline-loading';
    el.className = 'pipeline-loading';
    document.getElementById('pages-panel').appendChild(el);
  }
  el.innerHTML = `<span class="pipeline-loading-dot"></span><span>${msg}</span>`;
  el.style.display = 'flex';
}
function hideLoadingOverlay() {
  const el = document.getElementById('pipeline-loading');
  if (el) el.style.display = 'none';
}

async function ensureCacheAt(idx) {
  // Compute all stages up to idx (inclusive) that are invalid
  for (let i = 1; i <= idx; i++) {
    if (!S.pipelineCache[i] || !S.pipelineCache[i].valid) {
      showLoadingOverlay(`Rendering stage ${i} of ${S.transforms.length}…`);
      await computeStage(i);
    }
  }
  hideLoadingOverlay();
}

async function computeStage(idx) {
  const prevPages = S.pipelineCache[idx - 1].pages;
  const t = S.transforms[idx - 1];
  let newPages;
  
  if (t.type === 'crop')          newPages = await previewCrop(prevPages, t.settings);
  else if (t.type === 'pagesize') newPages = await previewPageSize(prevPages, t.settings);
  else if (t.type === '2up')      newPages = await preview2Up(prevPages, t.settings);
  else if (t.type === '4up')      newPages = await preview4Up(prevPages, t.settings);
  else if (t.type === 'reorder')  newPages = previewReorder(prevPages, t.settings);
  else if (t.type === 'remove')   newPages = previewRemove(prevPages, t.settings);
  else if (t.type === 'insertblank') newPages = await previewInsertBlank(prevPages, t.settings);
  else newPages = prevPages.map(p => ({ ...p }));

  S.pipelineCache[idx] = { valid: true, computing: false, pages: newPages };
}

async function previewCrop(pages, settings) {
  const result = [];
  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    const crops = settings.crops[pi] || [];
    if (!crops.length) { result.push(page); continue; }
    for (const cr of crops) {
      // In source pages, renderedImg matches original size (scaled to THUMB_W initially but we map to dim)
      // Actually renderedImg was rendered at THUMB_W * DPR width.
      // So its internal size is not dim.w.
      const rw = page.renderedImg.width;
      const rh = page.renderedImg.height;
      const cx = cr.x * rw, cy = cr.y * rh;
      const cw = cr.w * rw, ch = cr.h * rh;
      const off = new OffscreenCanvas(cw, ch);
      off.getContext('2d').drawImage(page.renderedImg, cx, cy, cw, ch, 0, 0, cw, ch);
      result.push({ renderedImg: await createImageBitmap(off), dim: { w: cr.w * page.dim.w, h: cr.h * page.dim.h } });
    }
  }
  return result;
}

async function previewPageSize(pages, settings) {
  const result = [];
  for (const page of pages) {
    const rw = page.renderedImg.width, rh = page.renderedImg.height;
    const cw = page.dim.w, ch = page.dim.h; // PDF points
    let tw, th;
    if (settings.size === 'raw') { tw = cw; th = ch; }
    else {
      const ps = PAGE_SIZES[settings.size];
      tw = ps.w; th = ps.h;
      if (settings.halfSheet) { tw /= 2; th /= 2; }
      if (settings.orientation === 'landscape') [tw, th] = [th, tw];
    }
    const { top: mt, right: mr, bottom: mb, left: ml } = settings.margins;
    const mtt = mt * 72, mrt = mr * 72, mbt = mb * 72, mlt = ml * 72;
    const avw = tw - mlt - mrt, avh = th - mtt - mbt;
    
    // Target display size relative to DPR (we match standard sizing factor)
    const factor = (THUMB_W / tw) * DPR; 
    const rx = mlt * factor, ry = mtt * factor;
    const ravw = avw * factor, ravh = avh * factor;
    
    const sc = Math.min(ravw / rw, ravh / rh);
    const fw = rw * sc, fh = rh * sc;
    const fx = rx + (ravw - fw) / 2, fy = ry + (ravh - fh) / 2;

    const off = new OffscreenCanvas(tw * factor, th * factor);
    const ctx = off.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, off.width, off.height);
    ctx.drawImage(page.renderedImg, fx, fy, fw, fh);
    result.push({ renderedImg: await createImageBitmap(off), dim: { w: tw, h: th } });
  }
  return result;
}

async function preview2Up(pages, settings) {
  const result = [];
  const n = pages.length;
  const pad = settings.bookMode ? Math.ceil(n / 4) * 4 : Math.ceil(n / 2) * 2;
  if (!n) return [];
  const { w: pw, h: ph } = pages[0].dim;
  const rw = pages[0].renderedImg.width, rh = pages[0].renderedImg.height;
  
  for (let i = 0; i < pad / 2; i++) {
    const factor = (THUMB_W / (pw * 2)) * DPR;
    const off = new OffscreenCanvas(pw * 2 * factor, ph * factor);
    const ctx = off.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,off.width,off.height);
    
    let li, ri;
    if (settings.bookMode) {
      li = i % 2 === 0 ? pad - 1 - i : i;
      ri = i % 2 === 0 ? i : pad - 1 - i;
    } else {
      li = i * 2;
      ri = i * 2 + 1;
    }
    
    if (li < n) ctx.drawImage(pages[li].renderedImg, 0, 0, off.width/2, off.height);
    if (ri < n) ctx.drawImage(pages[ri].renderedImg, off.width/2, 0, off.width/2, off.height);
    result.push({ renderedImg: await createImageBitmap(off), dim: { w: pw * 2, h: ph } });
  }
  return result;
}

async function preview4Up(pages, settings) {
  const result = [];
  const n = pages.length;
  const pad = settings.bookMode ? Math.ceil(n / 8) * 8 : Math.ceil(n / 4) * 4;
  if (!n) return [];
  const { w: pw, h: ph } = pages[0].dim;
  
  if (settings.bookMode) {
    const numSpreads = pad / 2;
    const numFinalSheets = pad / 4;
    const spreadPages = [];
    const spreadW = pw, spreadH = ph / 2;
    
    // Phase 1: Create horizontal spreads (pw x ph/2)
    for (let i = 1; i <= numSpreads; i++) {
        const frontIdx = i - 1;
        const backIdx = pad - i;
        const isOdd = (i % 2 !== 0);
        const lIdx = isOdd ? backIdx : frontIdx;
        const rIdx = isOdd ? frontIdx : backIdx;
        
        const factor = (THUMB_W / spreadW) * DPR; 
        const off = new OffscreenCanvas(spreadW * factor, spreadH * factor);
        const ctx = off.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0,0,off.width,off.height);
        
        if (lIdx < n) ctx.drawImage(pages[lIdx].renderedImg, 0, 0, off.width/2, off.height);
        if (rIdx < n) ctx.drawImage(pages[rIdx].renderedImg, off.width/2, 0, off.width/2, off.height);
        spreadPages.push(off);
    }
    
    // Phase 2: Stitch spreads vertically (pw x ph)
    for (let j = 0; j < numFinalSheets; j++) {
        const topSpreadIdx = j;
        const bottomSpreadIdx = numSpreads - j - 1;
        
        const factor = (THUMB_W / pw) * DPR;
        const off = new OffscreenCanvas(pw * factor, ph * factor);
        const ctx = off.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0,0,off.width,off.height);
        
        // Top spread
        ctx.drawImage(spreadPages[topSpreadIdx], 0, 0, off.width, off.height/2);
        
        // Bottom spread
        ctx.save();
        ctx.translate(off.width/2, off.height * 0.75); 
        ctx.rotate(Math.PI);
        ctx.drawImage(spreadPages[bottomSpreadIdx], -off.width/2, -off.height/4, off.width, off.height/2);
        ctx.restore();
        
        result.push({ renderedImg: await createImageBitmap(off), dim: { w: pw, h: ph } });
    }
  } else {
    // Normal 4-up mode
    for (let i = 0; i < pad / 4; i++) {
        const factor = (THUMB_W / pw) * DPR;
        const off = new OffscreenCanvas(pw * factor, ph * factor);
        const ctx = off.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0,0,off.width,off.height);
        for(let j=0; j<4; j++){
            const idx = i*4 + j;
            if(idx < n){
                const x = (j%2) * (off.width/2);
                const y = Math.floor(j/2) * (off.height/2);
                ctx.drawImage(pages[idx].renderedImg, x, y, off.width/2, off.height/2);
            }
        }
        result.push({ renderedImg: await createImageBitmap(off), dim: { w: pw, h: ph } });
    }
  }
  return result;
}

function getReorderMap(n, moves) {
  const map = Array.from({length:n}, (_,i)=>i);
  for (const m of moves) {
    if (m.from < n && m.to < n) {
      const p = map.splice(m.from, 1)[0];
      map.splice(m.to, 0, p);
    }
  }
  return map;
}

function previewReorder(pages, settings) {
  const n = pages.length;
  if (!n) return [];
  const moves = settings.moves || [];
  // For backwards compatibility, if only 'order' exists, keep it but we'll prefer moves.
  // Actually, let's just use moves.
  const map = getReorderMap(n, moves);
  return map.map(i => pages[i]);
}

function previewRemove(pages, settings) {
  return pages.filter((_, i) => !settings.removedIndices.includes(i));
}

async function previewInsertBlank(pages, settings) {
  const result = pages.slice();
  const c = Math.max(1, settings.count || 1);
  const ref = pages.length > 0 ? pages[pages.length - 1] : { dim: { w: 8.5 * 72, h: 11 * 72 } };
  const pw = ref.dim.w, ph = ref.dim.h;
  
  for (let i = 0; i < c; i++) {
    const factor = (THUMB_W / pw) * DPR; 
    const off = new OffscreenCanvas(pw * factor, ph * factor);
    const ctx = off.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, off.width, off.height);
    result.push({ renderedImg: await createImageBitmap(off), dim: { w: pw, h: ph } });
  }
  return result;
}

// Determine which cache index to display right now
function displayCacheIdx() {
  if (S.editingId !== null) {
    const idx = transformIndex(S.editingId);
    const t = S.transforms[idx];
    if (t && ['crop', 'reorder', 'remove'].includes(t.type)) return idx;
    return idx + 1;
  }
  return S.transforms.length;
}

async function refreshDisplay() {
  initCache();
  const cacheIdx = displayCacheIdx();
  await ensureCacheAt(cacheIdx);
  const cache = S.pipelineCache[cacheIdx];
  if (cache && cache.valid) {
    renderPagesGrid();
    updateFileInfo();
    updateExportButton();
    if (!cache.pages.length && S.pages.length === 0) {
      document.getElementById('drop-zone').style.display = 'flex';
      document.getElementById('pages-grid').style.display = 'none';
    } else {
      document.getElementById('drop-zone').style.display = 'none';
      document.getElementById('pages-grid').style.display = 'flex';
    }
  }
}

// ── PAGES GRID ──────────────────────────────────────────────────
function renderPagesGrid(pages) {
  if (!pages) {
    pages = S.pipelineCache[displayCacheIdx()]?.pages || [];
    if (S.editingId !== null) {
      const t = S.transforms.find(x => x.id === S.editingId);
      if (t && t.type === 'reorder') {
        pages = previewReorder(pages, t.settings);
      }
    }
  }
  const grid = document.getElementById('pages-grid');
  grid.innerHTML = '';

  const isEditingReorder = S.editingId !== null &&
    S.transforms.find(t => t.id === S.editingId)?.type === 'reorder';

  for (let i = 0; i < pages.length; i++) {
    const pg    = pages[i];
    const img   = pg.renderedImg;
    const cssW  = Math.round(THUMB_W * S.zoom);
    const cssH  = Math.round((pg.dim.h / pg.dim.w) * cssW);

    const cell = document.createElement('div');
    cell.className = 'page-cell';
    cell.dataset.idx = i;
    if (isEditingReorder) { cell.draggable = true; cell.classList.add('reorder-draggable'); }

    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper';
    wrapper.style.width  = cssW + 'px';
    wrapper.style.height = cssH + 'px';

    const canvas = document.createElement('canvas');
    canvas.className = 'page-canvas';
    canvas.width  = img.width; canvas.height = img.height;
    canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
    canvas.getContext('2d').drawImage(img, 0, 0);

    const overlay = document.createElement('canvas');
    overlay.className = 'page-overlay';
    overlay.width = img.width; overlay.height = img.height;
    overlay.style.width = cssW + 'px'; overlay.style.height = cssH + 'px';

    wrapper.appendChild(canvas);
    wrapper.appendChild(overlay);

    // Source-mode only: type badge + trash
    if (S.editingId === null || isEditingReorder) {
      // No source badges needed in reorder mode; show in normal source view only
    }
    if (S.editingId === null) {
      const typeBadge = document.createElement('span');
      typeBadge.style.cssText = 'position:absolute;bottom:4px;left:4px;background:rgba(0,0,0,.55);color:#fff;font-size:9px;font-weight:600;padding:2px 5px;border-radius:3px;letter-spacing:.04em;';
      const srcPg = S.pages[i];
      typeBadge.textContent = srcPg ? (srcPg.srcType === 'image' ? 'IMG' : 'PDF') : '';
      const delBtn = document.createElement('button');
      delBtn.className = 'page-delete-btn'; delBtn.title = 'Delete page';
      delBtn.innerHTML = `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 3.5h11M4.5 3.5V2h5v1.5M5.5 6v4M8.5 6v4M2.5 3.5l.75 9h7.5l.75-9"/></svg>`;
      delBtn.addEventListener('click', e => { e.stopPropagation(); deletePage(i); });
      wrapper.appendChild(typeBadge); wrapper.appendChild(delBtn);
    }

    // Reorder drag handles
    if (isEditingReorder) {
      const dh = document.createElement('div');
      dh.className = 'reorder-handle';
      dh.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="5" cy="4" r="1.2"/><circle cx="11" cy="4" r="1.2"/><circle cx="5" cy="8" r="1.2"/><circle cx="11" cy="8" r="1.2"/><circle cx="5" cy="12" r="1.2"/><circle cx="11" cy="12" r="1.2"/></svg>`;
      wrapper.appendChild(dh);
      setupReorderDrag(cell, i);
    }

    const label = document.createElement('div');
    label.className = 'page-label';
    label.textContent = `Page ${i + 1}`;

    cell.appendChild(wrapper);
    cell.appendChild(label);
    grid.appendChild(cell);
  }

  refreshOverlays();
}

function getOverlay(idx) {
  return document.querySelector(`.page-cell[data-idx="${idx}"] .page-overlay`);
}

// ── OVERLAY DRAWING ─────────────────────────────────────────────
function refreshOverlays() {
  refreshCropInteraction();
  const pages = S.pipelineCache[displayCacheIdx()]?.pages || [];
  for (let i = 0; i < pages.length; i++) drawOverlay(i);
}

function drawOverlay(pageIdx) {
  const overlay = getOverlay(pageIdx);
  if (!overlay) return;
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!S.editingId) return;
  const t = S.transforms.find(t => t.id === S.editingId);
  if (!t) return;
  if (t.type === 'crop') drawCropOverlay(ctx, overlay, pageIdx, t.settings);
  if (t.type === 'remove') drawRemoveOverlay(ctx, overlay, pageIdx, t.settings);
}

function drawRemoveOverlay(ctx, overlay, pageIdx, settings) {
  if (settings.removedIndices.includes(pageIdx)) {
    const W = overlay.width, H = overlay.height;
    ctx.fillStyle = 'rgba(239, 68, 68, 0.2)'; // semi-transparent red
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#ef4444'; // solid red cross
    ctx.lineWidth = 4 * DPR;
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(W, H);
    ctx.moveTo(W, 0); ctx.lineTo(0, H);
    ctx.stroke();
  }
}


// ── CROP OVERLAY ────────────────────────────────────────────────
function drawCropOverlay(ctx, overlay, pageIdx, settings) {
  const rects = settings.crops[pageIdx] || [];
  const W = overlay.width, H = overlay.height;

  if (rects.length > 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'destination-out';
    for (const r of rects) ctx.fillRect(r.x * W, r.y * H, r.w * W, r.h * H);
    ctx.globalCompositeOperation = 'source-over';
  }

  const sel = settings.selected;
  for (const r of rects) {
    const rx = r.x * W, ry = r.y * H, rw = r.w * W, rh = r.h * H;
    const isSel = sel && sel.pageIdx === pageIdx && sel.id === r.id;
    ctx.strokeStyle = isSel ? '#fff' : 'rgba(99,102,241,0.9)';
    ctx.lineWidth = 1.5 * DPR; ctx.setLineDash([]);
    ctx.strokeRect(rx, ry, rw, rh);
    const num = rects.indexOf(r) + 1;
    const bx = rx + 4*DPR, by = ry + 4*DPR;
    ctx.fillStyle = 'rgba(99,102,241,0.9)';
    ctx.beginPath(); ctx.roundRect(bx, by, 14*DPR, 14*DPR, 3*DPR); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = `bold ${9*DPR}px Inter,sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(num), bx+7*DPR, by+7*DPR); ctx.textAlign = 'left';

    // Delete button (X) in top-right
    const dx = rx + rw - 18*DPR, dy = ry + 4*DPR;
    ctx.fillStyle = 'rgba(239,68,68,0.9)';
    ctx.beginPath(); ctx.roundRect(dx, dy, 14*DPR, 14*DPR, 3*DPR); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = `bold ${11*DPR}px Inter,sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('×', dx+7*DPR, dy+7*DPR); ctx.textAlign = 'left';
    if (isSel) {
      for (const [cx, cy] of [[rx,ry],[rx+rw,ry],[rx,ry+rh],[rx+rw,ry+rh]]) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(cx-HANDLE_R*DPR, cy-HANDLE_R*DPR, HANDLE_R*2*DPR, HANDLE_R*2*DPR);
        ctx.strokeStyle = 'rgba(99,102,241,0.9)'; ctx.lineWidth = 1.5*DPR;
        ctx.strokeRect(cx-HANDLE_R*DPR, cy-HANDLE_R*DPR, HANDLE_R*2*DPR, HANDLE_R*2*DPR);
      }
    }
  }

  if (S.drag?.type === 'draw' && S.drag.pageIdx === pageIdx) {
    const d = S.drag;
    const x = Math.min(d.nx,d.cx)*W, y = Math.min(d.ny,d.cy)*H;
    const w = Math.abs(d.cx-d.nx)*W, h = Math.abs(d.cy-d.ny)*H;
    ctx.strokeStyle = '#818cf8'; ctx.lineWidth = 1.5*DPR;
    ctx.setLineDash([4*DPR,3*DPR]); ctx.strokeRect(x,y,w,h); ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(99,102,241,0.1)'; ctx.fillRect(x,y,w,h);
  }
}

// ── CROP HIT TESTING ────────────────────────────────────────────
function cropCanvasCoords(overlay, e) {
  const r = overlay.getBoundingClientRect();
  return [clamp((e.clientX-r.left)/r.width, 0, 1), clamp((e.clientY-r.top)/r.height, 0, 1)];
}

function hitTestCropRects(overlay, rects, cx, cy) {
  const hr = HANDLE_R / overlay.offsetWidth, hrH = HANDLE_R / overlay.offsetHeight;
  const W = overlay.offsetWidth, H = overlay.offsetHeight;
  
  for (const r of [...rects].reverse()) {
    // Red 'X' is at: (rx + rw - 18*DPR), (ry + 4*DPR) with size 14*DPR
    // We'll use CSS pixels for hit testing.
    const rb = 18, rt = 4, size = 14; 
    const rx = r.x * W, ry = r.y * H, rw = r.w * W, rh = r.h * H;
    const bx = rx + rw - rb, by = ry + rt;
    if (cx * W >= bx && cx * W <= bx + size && cy * H >= by && cy * H <= by + size) {
      return { hit: 'delete', id: r.id };
    }
  }
  for (const r of [...rects].reverse()) {
    for (const [h, hx, hy] of [['nw',r.x,r.y],['ne',r.x+r.w,r.y],['sw',r.x,r.y+r.h],['se',r.x+r.w,r.y+r.h]]) {
      if (Math.abs(cx-hx)<hr && Math.abs(cy-hy)<hrH) return { hit:'handle', id:r.id, handle:h };
    }
  }
  for (const r of [...rects].reverse()) {
    if (cx>=r.x && cx<=r.x+r.w && cy>=r.y && cy<=r.y+r.h) return { hit:'body', id:r.id };
  }
  return { hit:'none' };
}

// ── CROP INTERACTION ────────────────────────────────────────────
function refreshCropInteraction() {
  const t = S.editingId ? S.transforms.find(x => x.id === S.editingId) : null;
  document.querySelectorAll('.page-cell').forEach(cell => {
    const overlay = cell.querySelector('.page-overlay');
    const canvas  = cell.querySelector('.page-canvas');
    if (!overlay || !canvas) return;
    const fresh = overlay.cloneNode(false);
    fresh.width = canvas.width; fresh.height = canvas.height;
    fresh.style.width = canvas.style.width; fresh.style.height = canvas.style.height;
    overlay.parentNode.replaceChild(fresh, overlay);
    if (t?.type === 'crop') attachCropListeners(fresh, parseInt(cell.dataset.idx), t.settings);
    if (t?.type === 'remove') attachRemoveListeners(fresh, parseInt(cell.dataset.idx), t.settings);
  });
}

function attachRemoveListeners(overlay, pageIdx, settings) {
  overlay.classList.add('interactive');
  overlay.style.cursor = 'pointer';
  overlay.addEventListener('click', () => {
    const i = settings.removedIndices.indexOf(pageIdx);
    if (i >= 0) settings.removedIndices.splice(i, 1);
    else settings.removedIndices.push(pageIdx);
    invalidateCacheFrom(transformIndex(S.editingId));
    refreshOverlays();
  });
}

function attachCropListeners(overlay, pageIdx, settings) {
  overlay.classList.add('interactive', 'crop-mode');
  const pageCount = () => (S.pipelineCache[displayCacheIdx()]?.pages || []).length;

  overlay.addEventListener('mousemove', e => {
    const [cx, cy] = cropCanvasCoords(overlay, e);
    const rects = settings.crops[pageIdx] || [];
    if (!S.drag) {
      const hit = hitTestCropRects(overlay, rects, cx, cy);
      overlay.classList.remove('crop-move','crop-nwse','crop-nesw');
      if (hit.hit==='body') overlay.classList.add('crop-move');
      else if (hit.hit==='handle') overlay.classList.add(['nw','se'].includes(hit.handle)?'crop-nwse':'crop-nesw');
      return;
    }
    const d = S.drag; d.cx = cx; d.cy = cy;
    if (d.type==='draw') { drawOverlay(pageIdx); return; }
    if (d.type==='move') { const dx=cx-d.cx0,dy=cy-d.cy0; d.cx0=cx; d.cy0=cy; moveCropRect(settings,d.pageIdx,d.id,dx,dy,pageCount()); return; }
    if (d.type==='resize') resizeCropRect(settings, d, cx, cy, pageCount());
  });

  overlay.addEventListener('mousedown', e => {
    if (e.button!==0) return; e.preventDefault();
    const [cx, cy] = cropCanvasCoords(overlay, e);
    const rects = settings.crops[pageIdx] || [];
    const hit = hitTestCropRects(overlay, rects, cx, cy);
    if (hit.hit === 'delete') {
      deleteCropRect(settings, pageIdx, hit.id, pageCount());
      return;
    }
    if (hit.hit==='handle') {
      S.drag = { type:'resize', pageIdx, id:hit.id, handle:hit.handle, orig:{...rects.find(r=>r.id===hit.id)}, cx0:cx, cy0:cy };
      settings.selected = { pageIdx, id:hit.id };
    } else if (hit.hit==='body') {
      settings.selected = { pageIdx, id:hit.id };
      S.drag = { type:'move', pageIdx, id:hit.id, cx0:cx, cy0:cy };
      refreshOverlays();
    } else {
      settings.selected = null;
      S.drag = { type:'draw', pageIdx, id:uid(), nx:cx, ny:cy, cx, cy };
    }
  });

  overlay.addEventListener('mouseup', () => {
    if (!S.drag) return;
    const d = S.drag; S.drag = null;
    if (d.type==='draw') {
      const x=Math.min(d.nx,d.cx), y=Math.min(d.ny,d.cy);
      const w=Math.abs(d.cx-d.nx), h=Math.abs(d.cy-d.ny);
      if (w>0.01 && h>0.01) {
        const nr = { id:d.id, x, y, w, h };
        const n = pageCount();
        if (settings.syncAll) {
          for (let i=0;i<n;i++) { if (!settings.crops[i]) settings.crops[i]=[]; settings.crops[i].push({...nr,id:uid()}); }
          settings.crops[pageIdx][settings.crops[pageIdx].length-1].id = d.id;
        } else {
          if (!settings.crops[pageIdx]) settings.crops[pageIdx]=[];
          settings.crops[pageIdx].push(nr);
        }
        settings.selected = { pageIdx, id:d.id };
        invalidateCacheFrom(transformIndex(S.editingId));
      }
    }
    refreshOverlays();
  });

  overlay.addEventListener('contextmenu', e => {
    e.preventDefault();
    const [cx,cy] = cropCanvasCoords(overlay, e);
    const rects = settings.crops[pageIdx] || [];
    const hit = hitTestCropRects(overlay, rects, cx, cy);
    if (hit.hit!=='none') {
      deleteCropRect(settings, pageIdx, hit.id, pageCount());
    }
  });

  document.addEventListener('keydown', e => {
    if ((e.key==='Delete'||e.key==='Backspace') && settings.selected) {
      const {pageIdx:sp,id:sid} = settings.selected;
      const pidx = (settings.crops[sp]||[]).findIndex(r=>r.id===sid); if (pidx<0) return;
      const n = pageCount();
      if (settings.syncAll) { for (let i=0;i<n;i++) { if (settings.crops[i]?.[pidx]) settings.crops[i].splice(pidx,1); } }
      else settings.crops[sp].splice(pidx,1);
      settings.selected=null;
      invalidateCacheFrom(transformIndex(S.editingId));
      refreshOverlays();
    }
  });
}

function moveCropRect(settings, pageIdx, id, dx, dy, n) {
  const rects = settings.crops[pageIdx]||[]; const rect=rects.find(r=>r.id===id); if(!rect) return;
  rect.x=clamp(rect.x+dx,0,1-rect.w); rect.y=clamp(rect.y+dy,0,1-rect.h);
  if (settings.syncAll) {
    const pidx=rects.indexOf(rect);
    for (let i=0;i<n;i++) { if(i===pageIdx) continue; const r=settings.crops[i]?.[pidx]; if(r){r.x=clamp(r.x+dx,0,1-r.w);r.y=clamp(r.y+dy,0,1-r.h);} }
  }
  refreshOverlays();
}

function resizeCropRect(settings, d, cx, cy, n) {
  const rects=settings.crops[d.pageIdx]||[]; const rect=rects.find(r=>r.id===d.id); if(!rect) return;
  const o=d.orig; let nx=o.x,ny=o.y,nw=o.w,nh=o.h;
  if(d.handle==='se'){nw=clamp(cx-o.x,.02,1-o.x);nh=clamp(cy-o.y,.02,1-o.y);}
  if(d.handle==='nw'){const r=o.x+o.w,b=o.y+o.h;nx=clamp(cx,0,r-.02);ny=clamp(cy,0,b-.02);nw=r-nx;nh=b-ny;}
  if(d.handle==='ne'){const b=o.y+o.h;nw=clamp(cx-o.x,.02,1-o.x);ny=clamp(cy,0,b-.02);nh=b-ny;}
  if(d.handle==='sw'){const r=o.x+o.w;nx=clamp(cx,0,r-.02);nw=r-nx;nh=clamp(cy-o.y,.02,1-o.y);}
  Object.assign(rect,{x:nx,y:ny,w:nw,h:nh});
  if(settings.syncAll){const pidx=rects.indexOf(rect);for(let i=0;i<n;i++){if(i===d.pageIdx)continue;if(settings.crops[i]?.[pidx])Object.assign(settings.crops[i][pidx],{x:nx,y:ny,w:nw,h:nh});}}
  refreshOverlays();
}

// ── REORDER DRAG ────────────────────────────────────────────────
let reorderDragSrc = -1;

function setupReorderDrag(cell, idx) {
  cell.addEventListener('dragstart', e => {
    reorderDragSrc = idx;
    e.dataTransfer.effectAllowed = 'move';
    cell.classList.add('reorder-dragging');
  });
  cell.addEventListener('dragend', () => { cell.classList.remove('reorder-dragging'); document.querySelectorAll('.reorder-drag-over').forEach(el=>el.classList.remove('reorder-drag-over')); });
  cell.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; cell.classList.add('reorder-drag-over'); });
  cell.addEventListener('dragleave', () => cell.classList.remove('reorder-drag-over'));
  cell.addEventListener('drop', e => {
    e.preventDefault(); cell.classList.remove('reorder-drag-over');
    if (reorderDragSrc === idx || reorderDragSrc < 0) return;
    const t = S.transforms.find(x => x.id === S.editingId);
    if (!t || t.type !== 'reorder') return;
    
    // Instead of absolute indices, we push a "move" relative to the CURRENT visual state.
    // However, the visual state itself is derived from previous moves.
    // Simplifying: push a move from visual index A to visual index B.
    if (!t.settings.moves) t.settings.moves = [];
    t.settings.moves.push({ from: reorderDragSrc, to: idx });
    
    invalidateCacheFrom(transformIndex(S.editingId));
    // Re-render the grid based on updated moves
    const inputPages = S.pipelineCache[transformIndex(S.editingId)]?.pages || [];
    const reordered  = previewReorder(inputPages, t.settings);
    renderPagesGrid(reordered);
    renderTransformList(); // Update moves list in panel
    reorderDragSrc = -1;
  });
}

// ── TRANSFORM LIST ──────────────────────────────────────────────
function renderTransformList() {
  const list  = document.getElementById('transforms-list');
  const empty = document.getElementById('empty-transforms');
  list.innerHTML = ''; list.appendChild(empty);

  if (!S.transforms.length) {
    empty.style.display='flex';
    document.getElementById('export-btn').disabled=true; return;
  }
  empty.style.display='none';

  S.transforms.forEach(t => {
    const isEditing = t.id === S.editingId;
    const card = document.createElement('div');
    card.className = 'transform-card' + (isEditing ? ' editing' : '');
    card.dataset.id = t.id;
    card.innerHTML = `
      <div class="card-header">
        <span class="drag-handle">⠿</span>
        <span class="card-icon">${typeIcon(t.type)}</span>
        <span class="card-name">${typeLabel(t.type)}</span>
        <div class="card-order-btns">
          <button class="card-edit-btn" data-id="${t.id}" title="${isEditing?'Done editing':'Edit'}">${isEditing?
            '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l3 3 7-7"/></svg>' :
            '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2.5l2.5 2.5zM2 14l3-1 8-8a1.5 1.5 0 0 0-2-2l-8 8-1 3z"/></svg>'
          }</button>
          <button class="card-order-btn move-up" data-id="${t.id}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 14V2M4 6l4-4 4 4"/></svg></button>
          <button class="card-order-btn move-down" data-id="${t.id}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v12M4 10l4 4 4-4"/></svg></button>
          <button class="card-remove-btn" data-id="${t.id}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
        </div>
      </div>
      <div class="card-body"><div class="card-body-inner">${cardBody(t)}</div></div>`;
    list.appendChild(card);
    card.querySelector('.card-edit-btn').addEventListener('click', e => { e.stopPropagation(); isEditing ? exitEditMode() : enterEditMode(t.id); });
    card.querySelector('.move-up').addEventListener('click',   e => { e.stopPropagation(); moveTransform(t.id,-1); });
    card.querySelector('.move-down').addEventListener('click', e => { e.stopPropagation(); moveTransform(t.id, 1); });
    card.querySelector('.card-remove-btn').addEventListener('click', async e => { e.stopPropagation(); await removeTransform(t.id); });
    card.addEventListener('click', () => { if (!isEditing) enterEditMode(t.id); });
    attachCardListeners(card, t);
  });
  updateExportButton();
}

function typeLabel(type) { return {crop:'Crop',pagesize:'Page Size','2up':'2-Up','4up':'4-Up',reorder:'Reorder Pages',remove:'Remove Pages',insertblank:'Insert Blank Pages'}[type]||type; }
function typeIcon(type) {
  if (type==='crop')    return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="3.5" y="3.5" width="9" height="9" rx="0.5"/><path d="M1 3.5h2.5M12.5 3.5H15M3.5 1v2.5M3.5 12.5V15M12.5 1v2.5M12.5 12.5V15"/></svg>`;
  if (type==='pagesize')return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="2.5" y="1" width="9" height="13" rx="1"/><path d="M5 5h5M5 8h5M5 11h3"/></svg>`;
  if (type==='reorder') return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2 4h12M2 8h12M2 12h12"/><path d="M12 6l2-2-2-2M4 10l-2 2 2 2"/></svg>`;
  if (type==='remove')  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4 4l8 8M12 4L4 12"/></svg>`;
  if (type==='insertblank') return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="3" y="1" width="10" height="14" rx="1"/><path d="M8 5v6M5 8h6"/></svg>`;
  if (type==='4up') return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>`;
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1" y="2" width="6" height="12" rx="1"/><rect x="9" y="2" width="6" height="12" rx="1"/></svg>`;
}

function cardBody(t) {
  if (t.type==='crop') return `
    <label class="checkbox-row"><input type="checkbox" class="sync-all-chk" ${t.settings.syncAll?'checked':''}><span>Sync all pages</span></label>
    <p class="ctrl-hint">Draw boxes to crop. Click <b>X</b> or right-click to delete. Each box becomes a new page.</p>
    <button class="clear-crops-btn" data-id="${t.id}">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h10M5 6v7a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V6M6 3h4M8 2v1"/></svg>
      Clear All Crops
    </button>`;
  if (t.type==='pagesize') {
    const m=t.settings.margins;
    const opts=Object.entries(PAGE_SIZES).map(([k,v])=>`<option value="${k}" ${t.settings.size===k?'selected':''}>${v.label}</option>`).join('')+
      `<option value="raw" ${t.settings.size==='raw'?'selected':''}>Raw cut size</option>`;
    return `
      <div><p class="ctrl-label">Size</p><select class="ctrl-select size-sel">${opts}</select></div>
      <label class="checkbox-row"><input type="checkbox" class="halfsheet-chk" ${t.settings.halfSheet?'checked':''}><span>Half sheet</span></label>
      <div><p class="ctrl-label">Orientation</p>
        <div class="btn-group">
          <button class="btn-group-item orient-btn ${t.settings.orientation==='portrait'?'active':''}" data-o="portrait">Portrait</button>
          <button class="btn-group-item orient-btn ${t.settings.orientation==='landscape'?'active':''}" data-o="landscape">Landscape</button>
        </div>
      </div>
      <div class="margin-section">
        <div class="margin-header"><p class="ctrl-label">Margins (in)</p>
          <button class="margin-lock-btn lock-btn">${m.locked?'🔒 Locked':'🔓 Unlocked'}</button></div>
        <div class="margin-input-area ${m.locked?'margin-single':'margin-grid'}">
          ${m.locked?`<input class="ctrl-input no-label margin-all" type="number" min="0" max="4" step="0.125" value="${m.top}">`
            :['t','r','b','l'].map((s,i)=>`<div class="margin-input-wrap"><label>${s.toUpperCase()}</label><input class="ctrl-input margin-${s}" type="number" min="0" max="4" step="0.125" value="${[m.top,m.right,m.bottom,m.left][i]}"></div>`).join('')}
        </div>
      </div>`;
  }
  if (t.type==='reorder') {
    const moves = t.settings.moves || [];
    return `<p class="ctrl-hint">Drag pages in the main panel to reorder them. Each move is recorded below.</p>
      <div class="reorder-moves-list" style="margin-top:8px;max-height:120px;overflow-y:auto;border:1px solid var(--border-1);border-radius:4px;padding:4px;background:var(--bg-2);">
        ${moves.length ? moves.map((m, i) => `
          <div class="reorder-move-item" style="display:flex;align-items:center;justify-content:space-between;padding:4px 8px;font-size:11px;border-bottom:1px solid var(--border-1);gap:8px;">
            <span style="opacity:0.8;">${i+1}. Page ${m.from+1} → ${m.to+1}</span>
            <button class="remove-move-btn" data-idx="${i}" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:14px;padding:0 4px;line-height:1;">×</button>
          </div>
        `).join('') : '<p style="padding:8px;font-size:11px;opacity:0.5;text-align:center;">No moves recorded yet</p>'}
      </div>
      ${moves.length ? `<button class="clear-moves-btn" data-id="${t.id}">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h10M5 6v7a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V6M6 3h4M8 2v1"/></svg>
        Clear All Moves
      </button>` : ''}`;
  }
  if (t.type==='remove')  return `<p class="ctrl-hint">Click pages in the main panel to toggle their removal from the document.</p>`;
  if (t.type==='insertblank') return `<div style="display:flex;align-items:center;gap:8px;"><p class="ctrl-label" style="margin:0;">Number of pages</p><input class="ctrl-input blank-count" type="number" min="1" step="1" value="${t.settings.count}" style="width:60px;"></div>`;
  if (t.type==='2up' || t.type==='4up') return `<label class="checkbox-row"><input type="checkbox" class="book-chk" ${t.settings.bookMode?'checked':''}><span>Book mode</span><span title="When checked, prints a foldable book. For 2-Up, padded to 4. For 4-Up, padded to 8 and folds into a mini-book." style="cursor:help;opacity:0.6;font-size:12px;"> ℹ️</span></label>`;
  return ``;
}

function attachCardListeners(card, t) {
  const onChange = async () => { invalidateCacheFrom(transformIndex(t.id)); await refreshDisplay(); };
  if (t.type==='crop') {
    card.querySelector('.sync-all-chk').addEventListener('change', e => { t.settings.syncAll=e.target.checked; onChange(); });
    card.querySelector('.clear-crops-btn').addEventListener('click', () => {
      if (confirm('Clear all crops in this transform?')) {
        t.settings.crops = t.settings.crops.map(() => []);
        t.settings.selected = null;
        onChange();
      }
    });
  }
  if (t.type==='pagesize') {
    const s=t.settings;
    card.querySelector('.size-sel').addEventListener('change', e => { s.size=e.target.value; onChange(); });
    card.querySelector('.halfsheet-chk').addEventListener('change', e => { s.halfSheet=e.target.checked; onChange(); });
    card.querySelectorAll('.orient-btn').forEach(b=>b.addEventListener('click',()=>{s.orientation=b.dataset.o;card.querySelectorAll('.orient-btn').forEach(x=>x.classList.toggle('active',x.dataset.o===s.orientation));onChange();}));
    card.querySelector('.lock-btn').addEventListener('click',()=>{s.margins.locked=!s.margins.locked;renderTransformList();});
    if (s.margins.locked) {
      card.querySelector('.margin-all')?.addEventListener('input',e=>{const v=Math.max(0,parseFloat(e.target.value)||0);s.margins.top=s.margins.right=s.margins.bottom=s.margins.left=v;onChange();});
    } else {
      ['t','r','b','l'].forEach(side=>{const map={t:'top',r:'right',b:'bottom',l:'left'};card.querySelector(`.margin-${side}`)?.addEventListener('input',e=>{s.margins[map[side]]=Math.max(0,parseFloat(e.target.value)||0);onChange();});});
    }
  }
  if (t.type==='2up' || t.type==='4up') {
    const chk = card.querySelector('.book-chk');
    if (chk) chk.addEventListener('change', e => { t.settings.bookMode=e.target.checked; onChange(); });
  }
  if (t.type==='insertblank') {
    const inp = card.querySelector('.blank-count');
    if (inp) inp.addEventListener('input', e => { t.settings.count=Math.max(1,parseInt(e.target.value)||1); onChange(); });
  }
  if (t.type==='reorder') {
    card.querySelectorAll('.remove-move-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        t.settings.moves.splice(idx, 1);
        onChange();
        renderTransformList();
      });
    });
    const clearBtn = card.querySelector('.clear-moves-btn');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      if (confirm('Clear all reorder moves?')) {
        t.settings.moves = [];
        onChange();
        renderTransformList();
      }
    });
  }
}

// ── EDIT MODE ───────────────────────────────────────────────────
async function enterEditMode(id) {
  if (S.editingId !== null) await exitEditMode();
  S.editingId = id;
  renderTransformList();
  showLoadingOverlay('Preparing…');
  try {
    await refreshDisplay();
  } finally {
    hideLoadingOverlay();
  }
}

async function exitEditMode() {
  S.editingId = null;
  renderTransformList();
  showLoadingOverlay('Computing pipeline…');
  try {
    initCache();
    await ensureCacheAt(S.transforms.length);
    renderPagesGrid();
  } finally {
    hideLoadingOverlay();
  }
  saveState();
}

function moveTransform(id, dir) {
  const idx = transformIndex(id), ni = idx+dir;
  if (ni<0||ni>=S.transforms.length) return;
  [S.transforms[idx],S.transforms[ni]]=[S.transforms[ni],S.transforms[idx]];
  invalidateCacheFrom(Math.min(idx,ni));
  renderTransformList();
  refreshDisplay();
  saveState();
}

async function removeTransform(id) {
  const idx = transformIndex(id);
  S.transforms=S.transforms.filter(t=>t.id!==id);
  if (S.editingId===id) S.editingId=null;
  invalidateCacheFrom(idx);
  renderTransformList();
  await refreshDisplay();
  saveState();
}

async function addTransform(type) {
  if (S.editingId!==null) await exitEditMode();
  const t = { id:uid(), type, settings:defaultSettings(type) };
  S.transforms.push(t);
  invalidateCacheFrom(S.transforms.length-1);
  await enterEditMode(t.id);
  saveState();
}

function defaultSettings(type) {
  const n = S.pipelineCache[S.transforms.length]?.pages.length || S.pages.length;
  if (type==='crop') return { 
    crops:Array.from({length:n},()=>[]), 
    syncAll:true, 
    selected:null,
    clearAll: () => {
      // We'll handle this in listeners
    }
  };
  if (type==='pagesize') return { size:'letter', orientation:'portrait', halfSheet:false, margins:{top:0.5,right:0.5,bottom:0.5,left:0.5,locked:true} };
  if (type==='2up' || type==='4up')      return { bookMode: true };
  if (type==='reorder')  return { moves: [] };
  if (type==='remove')   return { removedIndices: [] };
  if (type==='insertblank') return { count: 1 };
  return {};
}

function updateExportButton() {
  document.getElementById('export-btn').disabled = S.pages.length === 0;
}

// ── PAGE DELETE ─────────────────────────────────────────────────
function deletePage(idx) {
  const p = S.pages[idx];
  if (p && p.thumbId) deleteFileFromIDB(p.thumbId).catch(console.error);
  S.pages.splice(idx,1);
  for (const t of S.transforms) {
    if (t.type==='crop') { t.settings.crops.splice(idx,1); if(t.settings.selected?.pageIdx===idx) t.settings.selected=null; else if(t.settings.selected?.pageIdx>idx) t.settings.selected.pageIdx--; }
    if (t.type==='reorder') { t.settings.order=t.settings.order.filter(i=>i!==idx).map(i=>i>idx?i-1:i); }
  }
  saveState();
  invalidateCacheFrom(0);
  updateFileInfo(); updateExportButton();
  if (!S.pages.length) { document.getElementById('drop-zone').style.display='flex'; document.getElementById('pages-grid').style.display='none'; renderTransformList(); return; }
  refreshDisplay();
}

async function clearPagesOnly() {
  if (!S.pages.length && !document.getElementById('pipeline-loading')) return;
  if (!confirm('Clear all pages? Your transforms will be kept.')) return;
  currentLoadId++; hideLoadingOverlay();
  S.pages=[]; S.pipelineCache=[];
  saveState(); await clearFilesIDB();
  updateFileInfo(); updateExportButton(); renderTransformList();
  document.getElementById('drop-zone').style.display='flex';
  document.getElementById('pages-grid').style.display='none';
  document.getElementById('pages-grid').innerHTML='';
  toast('Pages cleared', 'success');
}

async function clearTransformsOnly() {
  if (!S.transforms.length) return;
  if (!confirm('Clear all transforms? Your pages will be kept.')) return;
  S.transforms=[]; S.editingId=null;
  saveState(); invalidateCacheFrom(0);
  updateFileInfo(); updateExportButton(); renderTransformList();
  if (S.pages.length) await refreshDisplay();
  toast('Transforms cleared', 'success');
}

async function clearAllPages() {
  currentLoadId++; hideLoadingOverlay();
  S.pages=[]; S.transforms=[]; S.pipelineCache=[]; S.editingId=null;
  await clearFilesIDB();
  localStorage.removeItem('ps-state');
  updateFileInfo(); updateExportButton(); renderTransformList();
  document.getElementById('drop-zone').style.display='flex';
  document.getElementById('pages-grid').style.display='none';
  document.getElementById('pages-grid').innerHTML='';
  toast('Started over', 'success');
}

// ── EXPORT ──────────────────────────────────────────────────────
async function embedImg(doc, bytes, mimeType) {
  const jpegs=['image/jpeg','image/jpg'];
  if (jpegs.includes(mimeType)) return doc.embedJpg(bytes);
  if (mimeType==='image/png') return doc.embedPng(bytes);
  const bitmap=await createImageBitmap(new Blob([bytes],{type:mimeType}));
  const off=new OffscreenCanvas(bitmap.width,bitmap.height);
  off.getContext('2d').drawImage(bitmap,0,0);
  return doc.embedPng(new Uint8Array(await(await off.convertToBlob({type:'image/png'})).arrayBuffer()));
}

async function buildInitialPDF() {
  const { PDFDocument } = PDFLib; 
  const out = await PDFDocument.create();
  const loadedDocs = new Map();
  for (const page of S.pages) {
    if (page.srcType === 'pdf') {
      let doc = loadedDocs.get(page.fileId);
      if (!doc) {
        const bytes = await getFileFromIDB(page.fileId);
        doc = await PDFDocument.load(bytes);
        loadedDocs.set(page.fileId, doc);
      }
      const [emb] = await out.embedPages([ doc.getPage(page.pdfSrcPageIdx) ]);
      out.addPage([page.dim.w, page.dim.h]).drawPage(emb, { x: 0, y: 0, width: page.dim.w, height: page.dim.h });
    } else {
      const bytes = await getFileFromIDB(page.fileId);
      const isPng = page.imgMimeType === 'image/png';
      const img = isPng ? await out.embedPng(bytes) : await out.embedJpg(bytes);
      out.addPage([page.dim.w, page.dim.h]).drawImage(img, { x: 0, y: 0, width: page.dim.w, height: page.dim.h });
    }
  }
  return out.save();
}

async function exportCrop(bytes, settings) {
  const {PDFDocument}=PDFLib; const src=await PDFDocument.load(bytes); const out=await PDFDocument.create(); const pgs=src.getPages();
  for (let pi=0;pi<pgs.length;pi++) {
    const page=pgs[pi]; const {width:pw,height:ph}=page.getSize(); const crops=settings.crops[pi]||[];
    if (!crops.length) { const [emb]=await out.embedPages([page]); out.addPage([pw,ph]).drawPage(emb,{x:0,y:0,width:pw,height:ph}); }
    else { for (const cr of crops) { const cx=cr.x*pw,cy=cr.y*ph,cw=cr.w*pw,ch=cr.h*ph,bot=ph-cy-ch; const [emb]=await out.embedPages([page],[{left:cx,bottom:bot,right:cx+cw,top:bot+ch}]); out.addPage([cw,ch]).drawPage(emb,{x:0,y:0,width:cw,height:ch}); } }
  }
  return out.save();
}

async function exportPageSize(bytes, settings) {
  const {PDFDocument}=PDFLib; const src=await PDFDocument.load(bytes); const out=await PDFDocument.create();
  for (const page of src.getPages()) {
    const {width:cw,height:ch}=page.getSize(); let tw,th;
    if (settings.size==='raw'){tw=cw;th=ch;}
    else{const ps=PAGE_SIZES[settings.size];tw=ps.w;th=ps.h;if(settings.halfSheet){tw/=2;th/=2;}if(settings.orientation==='landscape')[tw,th]=[th,tw];}
    const {top:mt,right:mr,bottom:mb,left:ml}=settings.margins;
    const avw=tw-ml*72-mr*72,avh=th-mt*72-mb*72,sc=Math.min(avw/cw,avh/ch);
    const sx=ml*72+(avw-cw*sc)/2,sy=mb*72+(avh-ch*sc)/2;
    const [emb]=await out.embedPages([page]); out.addPage([tw,th]).drawPage(emb,{x:sx,y:sy,width:cw*sc,height:ch*sc});
  }
  return out.save();
}

async function export2Up(bytes, settings) {
  const {PDFDocument}=PDFLib; const src=await PDFDocument.load(bytes); const out=await PDFDocument.create();
  const pgs=src.getPages(), n=pgs.length;
  
  const pad = settings.bookMode ? Math.ceil(n/4)*4 : Math.ceil(n/2)*2;
  const {width:pw,height:ph}=pgs[0].getSize();
  for (let i=0;i<pad/2;i++) {
    let li, ri;
    if (settings.bookMode) {
      li = i%2===0 ? pad-1-i : i;
      ri = i%2===0 ? i : pad-1-i;
    } else {
      li = i * 2;
      ri = i * 2 + 1;
    }
    const np=out.addPage([pw*2,ph]);
    if(li<n){const[e]=await out.embedPages([pgs[li]]);np.drawPage(e,{x:0,y:0,width:pw,height:ph});}
    if(ri<n){const[e]=await out.embedPages([pgs[ri]]);np.drawPage(e,{x:pw,y:0,width:pw,height:ph});}
  }
  return out.save();
}

async function export4Up(bytes, settings) {
  const {PDFDocument,degrees}=PDFLib; const src=await PDFDocument.load(bytes); const out=await PDFDocument.create();
  const pgs=src.getPages(), n=pgs.length;
  if(!n) return out.save();
  const pad = settings.bookMode ? Math.ceil(n/8)*8 : Math.ceil(n/4)*4;
  const {width:pw,height:ph}=pgs[0].getSize();
  if (settings.bookMode) {
    const numSpreads=pad/2, numFinalSheets=pad/4;
    const spreads=[];
    for (let i=1;i<=numSpreads;i++) {
      const frontIdx=i-1, backIdx=pad-i, isOdd=(i%2!==0);
      spreads.push({ lIdx: isOdd?backIdx:frontIdx, rIdx: isOdd?frontIdx:backIdx });
    }
    for (let j=0;j<numFinalSheets;j++) {
      const top=spreads[j], bottom=spreads[numSpreads-1-j];
      const np=out.addPage([pw,ph]);
      if(top.lIdx<n){const[e]=await out.embedPages([pgs[top.lIdx]]);np.drawPage(e,{x:0,y:ph/2,width:pw/2,height:ph/2});}
      if(top.rIdx<n){const[e]=await out.embedPages([pgs[top.rIdx]]);np.drawPage(e,{x:pw/2,y:ph/2,width:pw/2,height:ph/2});}
      if(bottom.rIdx<n){const[e]=await out.embedPages([pgs[bottom.rIdx]]);np.drawPage(e,{x:pw/2,y:ph/2,width:pw/2,height:ph/2,rotate:degrees(180)});}
      if(bottom.lIdx<n){const[e]=await out.embedPages([pgs[bottom.lIdx]]);np.drawPage(e,{x:pw,y:ph/2,width:pw/2,height:ph/2,rotate:degrees(180)});}
    }
  } else {
    for (let i=0;i<pad/4;i++) {
      const np=out.addPage([pw,ph]);
      for (let j=0;j<4;j++) {
        const idx=i*4+j;
        if(idx>=n) continue;
        const [e]=await out.embedPages([pgs[idx]]);
        const x=(j%2)*(pw/2), y=(Math.floor(j/2)===0?ph/2:0);
        np.drawPage(e,{x,y,width:pw/2,height:ph/2});
      }
    }
  }
  return out.save();
}

async function exportReorder(bytes, moves) {
  const {PDFDocument}=PDFLib; const src=await PDFDocument.load(bytes); const out=await PDFDocument.create();
  const pgs=src.getPages();
  const map = getReorderMap(pgs.length, moves);
  for (const idx of map) {
    const page=pgs[idx]; const {width:pw,height:ph}=page.getSize();
    const [emb]=await out.embedPages([page]); out.addPage([pw,ph]).drawPage(emb,{x:0,y:0,width:pw,height:ph});
  }
  return out.save();
}

async function exportRemove(bytes, settings) {
  const {PDFDocument}=PDFLib; const src=await PDFDocument.load(bytes); const out=await PDFDocument.create();
  const pgs=src.getPages();
  for (let i = 0; i < pgs.length; i++) {
    if (!settings.removedIndices.includes(i)) {
      const page=pgs[i]; const {width:pw,height:ph}=page.getSize();
      const [emb]=await out.embedPages([page]); out.addPage([pw,ph]).drawPage(emb,{x:0,y:0,width:pw,height:ph});
    }
  }
  return out.save();
}

async function exportInsertBlank(bytes, settings) {
  const {PDFDocument}=PDFLib; const doc=await PDFDocument.load(bytes);
  const pgs=doc.getPages();
  const ref = pgs.length>0 ? pgs[pgs.length-1] : null;
  const pw = ref ? ref.getWidth() : 8.5*72, ph = ref ? ref.getHeight() : 11*72;
  const c = Math.max(1, settings.count || 1);
  for(let i=0; i<c; i++) {
    const page = doc.addPage([pw, ph]);
    page.drawText(''); // Force content stream so it can be embedded later
  }
  return doc.save();
}

async function runExport() {
  if (!S.pages.length||!S.transforms.length) return;
  const btn=document.getElementById('export-btn');
  btn.disabled=true; btn.textContent='Exporting…';
  try {
    let bytes = await buildInitialPDF();
    for (const t of S.transforms) {
      if(t.type==='crop') bytes=await exportCrop(bytes,t.settings);
      else if(t.type==='pagesize') bytes=await exportPageSize(bytes,t.settings);
      else if(t.type==='2up') bytes=await export2Up(bytes,t.settings);
    else if(t.type==='4up') bytes=await export4Up(bytes,t.settings);
    else if(t.type==='reorder') {
      const moves = t.settings.moves || [];
      bytes = await exportReorder(bytes, moves);
    }
      else if(t.type==='remove') bytes=await exportRemove(bytes,t.settings);
      else if(t.type==='insertblank') bytes=await exportInsertBlank(bytes,t.settings);
    }
    const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
    Object.assign(document.createElement('a'),{href:url,download:'pagesmith-output.pdf'}).click();
    setTimeout(()=>URL.revokeObjectURL(url),5000);
    toast('PDF exported!','success');
  } catch(err) { console.error(err); toast('Export failed: '+err.message,'error'); }
  finally {
    btn.disabled=false;
    btn.innerHTML=`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v8M5 8l3 3 3-3M2 13h12"/></svg> Export PDF`;
  }
}



// ── INIT ────────────────────────────────────────────────────────
async function init() {
  await openDB(); // Open IndexedDB connection early

  applyTheme(localStorage.getItem('ps-theme') !== 'light'); // Default to dark
  document.getElementById('theme-toggle').addEventListener('click', () => applyTheme(!S.isDark));
  
  const savedState = localStorage.getItem('ps-state');
  if (savedState) {
    try {
      const st = JSON.parse(savedState);
      S.preventSave = true;
      S.transforms = st.transforms || [];
      S.zoom = st.zoom || 1;
      document.getElementById('zoom-slider').value = S.zoom;
      document.getElementById('zoom-label').textContent = Math.round(S.zoom * 100) + '%';
      
      renderTransformList();
      updateExportButton();
      
      if (st.pages && st.pages.length) {
        showLoadingOverlay('Restoring previous session...');
        const loadId = ++currentLoadId;
        try {
          for (const p of st.pages) {
            if (loadId !== currentLoadId) { hideLoadingOverlay(); return; }
            if (!p.thumbId) continue; // Skip legacy cache
            try {
              const bytes = await getFileFromIDB(p.thumbId);
              if (!bytes) continue;
              const blob = new Blob([bytes], { type: 'image/png' });
              const renderedImg = await createImageBitmap(blob);
              S.pages.push({ renderedImg, dim: p.dim, srcType: p.srcType, fileId: p.fileId, thumbId: p.thumbId, pdfSrcPageIdx: p.pdfSrcPageIdx, imgMimeType: p.imgMimeType });
            } catch(err) {
              console.warn("Skipping corrupt page thumbnail", err);
            }
          }
          if (loadId !== currentLoadId) { hideLoadingOverlay(); return; }
          if (S.pages.length > 0) {
            initCache();
            updateFileInfo();
            document.getElementById('drop-zone').style.display   = 'none';
            document.getElementById('pages-grid').style.display  = 'flex';
            await refreshDisplay();
          }
        } finally {
          hideLoadingOverlay();
        }
      }
    } catch(err) {
      console.error("Failed to parse saved state", err);
    } finally {
      S.preventSave = false;
    }
  }

  const pagesPanel = document.getElementById('pages-panel');
  const dropZone   = document.getElementById('drop-zone');

  document.getElementById('upload-btn').addEventListener('click', () => document.getElementById('file-input').click());
  document.getElementById('drop-upload-btn').addEventListener('click', () => document.getElementById('file-input').click());
  document.getElementById('file-input').addEventListener('change', e => { handleFiles(e.target.files); e.target.value=''; });
  pagesPanel.addEventListener('dragover', e => {
    e.preventDefault();
    // Auto-scroll during reorder drag
    if (reorderDragSrc !== -1) {
      const rect = pagesPanel.getBoundingClientRect();
      const threshold = 80;
      const scrollSpeed = 12;
      if (e.clientY < rect.top + threshold) pagesPanel.scrollTop -= scrollSpeed;
      else if (e.clientY > rect.bottom - threshold) pagesPanel.scrollTop += scrollSpeed;
    } else {
      dropZone.classList.add('drag-over');
    }
  });
  pagesPanel.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  pagesPanel.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('drag-over'); if(e.dataTransfer.files.length)handleFiles(e.dataTransfer.files); });

  document.getElementById('add-crop-btn').addEventListener('click',    () => addTransform('crop'));
  document.getElementById('add-pagesize-btn').addEventListener('click', () => addTransform('pagesize'));
  document.getElementById('add-2up-btn').addEventListener('click',      () => addTransform('2up'));
  document.getElementById('add-4up-btn').addEventListener('click',      () => addTransform('4up'));
  document.getElementById('add-reorder-btn').addEventListener('click',  () => addTransform('reorder'));
  document.getElementById('add-remove-btn').addEventListener('click',   () => addTransform('remove'));
  document.getElementById('add-blank-btn').addEventListener('click',    () => addTransform('insertblank'));
  document.getElementById('export-btn').addEventListener('click', runExport);
  document.getElementById('clear-pages-btn').addEventListener('click', clearPagesOnly);
  document.getElementById('clear-all-btn').addEventListener('click', async () => { if(confirm('Are you sure you want to completely start over? This will wipe all pages and settings securely.')) await clearAllPages(); });
  
  const transformsClearBtn = document.getElementById('clear-transforms-btn');
  if (transformsClearBtn) transformsClearBtn.addEventListener('click', clearTransformsOnly);

  const zoomSlider = document.getElementById('zoom-slider');
  const zoomLabel  = document.getElementById('zoom-label');
  zoomSlider.addEventListener('input', () => {
    S.zoom = parseFloat(zoomSlider.value);
    zoomLabel.textContent = Math.round(S.zoom*100)+'%';
    renderPagesGrid();
  });
}

init();
