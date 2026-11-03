/*
 * app.js — 相機、相簿、匯入、匯出
 * 全域命名空間 window.PB；editor.js 會掛上 PB.openEditor。
 */
(() => {
  'use strict';
  const PB = (window.PB = window.PB || {});
  const $ = id => document.getElementById(id);

  /* 可在載入本檔前先設定 window.PB.config 來覆寫（例如自架 Tesseract） */
  PB.config = Object.assign({
    tesseractSrc: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
    tesseractOptions: {},          // 例如 { workerPath, corePath, langPath }
    maxImportSize: 4096            // 匯入圖片的最長邊上限（避免手機記憶體不足）
  }, PB.config || {});

  /* ---------- 小工具 ---------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem('snapbooth.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('snapbooth.' + k, JSON.stringify(v)); } catch {} }
  };
  PB.store = store;

  let toastTimer;
  PB.toast = (text, ms = 2600) => {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), ms);
  };
  const announce = t => { $('live').textContent = t; };
  const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
  const fmtSize = b => (b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(2) + ' MB');

  const prefs = { fmt: store.get('fmt', 'image/png'), q: store.get('q', 92) };
  PB.prefs = prefs;

  /* ---------- 輸出 ---------- */
  PB.toBlob = (canvas, { type = prefs.fmt, q = prefs.q, scale = 100 } = {}) => new Promise(res => {
    let src = canvas;
    if (scale !== 100 || type === 'image/jpeg') {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(canvas.width * scale / 100));
      c.height = Math.max(1, Math.round(canvas.height * scale / 100));
      const x = c.getContext('2d');
      if (type === 'image/jpeg') { x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); } // JPEG 不支援透明
      x.imageSmoothingQuality = 'high';
      x.drawImage(canvas, 0, 0, c.width, c.height);
      src = c;
    }
    src.toBlob(b => res(b), type, type === 'image/png' ? undefined : q / 100);
  });

  PB.fileName = (blob, tag = 'photo') => {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const ext = EXT[blob.type] || 'png';
    return `snapbooth-${tag}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
  };

  PB.download = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  PB.copyCanvas = async canvas => {
    try {
      const blob = await PB.toBlob(canvas, { type: 'image/png' });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      PB.toast('已複製到剪貼簿');
    } catch (e) {
      PB.toast('此瀏覽器不允許複製圖片，請改用下載');
    }
  };

  /* ---------- 匯出對話框 ---------- */
  const dlg = $('exportDlg');
  let exp = { canvas: null, tag: 'photo', onSaveCopy: null, timer: 0 };
  const expOpts = () => ({ type: $('expFmt').value, q: +$('expQ').value, scale: +$('expScale').value });

  function refreshExport() {
    $('expQField').style.display = $('expFmt').value === 'image/png' ? 'none' : '';
    $('expQVal').textContent = $('expQ').value;
    clearTimeout(exp.timer);
    exp.timer = setTimeout(async () => {
      if (!exp.canvas) return;
      const o = expOpts();
      const b = await PB.toBlob(exp.canvas, o);
      if (!b) return;
      const w = Math.round(exp.canvas.width * o.scale / 100), h = Math.round(exp.canvas.height * o.scale / 100);
      $('expInfo').textContent = `${w} × ${h} px · 約 ${fmtSize(b.size)}`;
    }, 120);
  }

  PB.openExport = (canvas, tag = 'photo', { onSaveCopy } = {}) => {
    exp.canvas = canvas; exp.tag = tag; exp.onSaveCopy = onSaveCopy || null;
    $('expFmt').value = prefs.fmt; $('expQ').value = prefs.q; $('expScale').value = '100';
    const prev = $('expPrev');
    const k = Math.min(1, 480 / canvas.width, 220 / canvas.height);
    prev.width = Math.max(1, Math.round(canvas.width * k)); prev.height = Math.max(1, Math.round(canvas.height * k));
    prev.getContext('2d').drawImage(canvas, 0, 0, prev.width, prev.height);
    $('expSaveCopy').hidden = !onSaveCopy;
    $('expShare').hidden = !(navigator.share && navigator.canShare);
    refreshExport();
    dlg.showModal();
  };
  $('expFmt').addEventListener('change', () => { prefs.fmt = $('expFmt').value; store.set('fmt', prefs.fmt); $('fmtSel').value = prefs.fmt; syncQual(); refreshExport(); });
  $('expQ').addEventListener('input', () => { prefs.q = +$('expQ').value; store.set('q', prefs.q); $('qual').value = prefs.q; syncQual(); refreshExport(); });
  $('expScale').addEventListener('change', refreshExport);
  $('expDownload').onclick = async () => {
    const b = await PB.toBlob(exp.canvas, expOpts());
    if (b) { PB.download(b, PB.fileName(b, exp.tag)); PB.toast('已開始下載'); }
  };
  $('expCopy').onclick = () => PB.copyCanvas(exp.canvas);
  $('expShare').onclick = async () => {
    try {
      const b = await PB.toBlob(exp.canvas, expOpts());
      const f = new File([b], PB.fileName(b, exp.tag), { type: b.type });
      if (navigator.canShare({ files: [f] })) await navigator.share({ files: [f], title: 'Snapbooth 照片' });
      else PB.toast('此裝置無法分享檔案');
    } catch (e) { /* 使用者取消分享 */ }
  };
  $('expSaveCopy').onclick = () => { if (exp.onSaveCopy) exp.onSaveCopy(); dlg.close(); };

  /* ---------- 相機設定（全域） ---------- */
  const video = $('video'), msg = $('msg'), shutter = $('shutter');
  const state = { stream: null, mirror: store.get('mirror', true), grid: store.get('grid', false), photos: [], counting: null, nextId: 1, audio: null };

  const FILTERS = {
    none: { name: '原始', css: 'none' },
    gray: { name: '黑白', css: 'grayscale(1)', fn(d) { for (let i = 0; i < d.length; i += 4) { const g = .299 * d[i] + .587 * d[i + 1] + .114 * d[i + 2]; d[i] = d[i + 1] = d[i + 2] = g; } } },
    sepia: { name: '懷舊', css: 'sepia(.85)', fn(d) { for (let i = 0; i < d.length; i += 4) { const r = d[i], g = d[i + 1], b = d[i + 2]; d[i] = .393 * r + .769 * g + .189 * b; d[i + 1] = .349 * r + .686 * g + .168 * b; d[i + 2] = .272 * r + .534 * g + .131 * b; } } },
    vivid: { name: '鮮豔', css: 'contrast(1.15) saturate(1.5)', fn(d) { for (let i = 0; i < d.length; i += 4) { const g = .299 * d[i] + .587 * d[i + 1] + .114 * d[i + 2]; for (let c = 0; c < 3; c++) { let v = g + (d[i + c] - g) * 1.5; d[i + c] = (v - 128) * 1.15 + 128; } } } },
    fade: { name: '柔和', css: 'contrast(.9) brightness(1.1) saturate(.8)', fn(d) { for (let i = 0; i < d.length; i += 4) { const g = .299 * d[i] + .587 * d[i + 1] + .114 * d[i + 2]; for (let c = 0; c < 3; c++) { let v = g + (d[i + c] - g) * .8; d[i + c] = ((v - 128) * .9 + 128) * 1.1; } } } }
  };
  const supportsCtxFilter = (() => { try { return 'filter' in document.createElement('canvas').getContext('2d'); } catch { return false; } })();
  $('filterSel').innerHTML = Object.entries(FILTERS).map(([k, f]) => `<option value="${k}">${f.name}</option>`).join('');

  for (const [id, key, def] of [['resSel', 'res', '0'], ['timerSel', 'timer', '0'], ['filterSel', 'filter', 'none']]) {
    const el = $(id), v = store.get(key, def);
    if ([...el.options].some(o => o.value === v)) el.value = v;
    el.addEventListener('change', () => { store.set(key, el.value); if (id === 'filterSel') applyPreviewFilter(); });
  }
  $('fmtSel').value = prefs.fmt;
  $('qual').value = prefs.q;
  $('soundChk').checked = store.get('sound', true);
  function syncQual() {
    $('fmtSel').value = prefs.fmt; $('qual').value = prefs.q;
    $('qualVal').textContent = prefs.q;
    $('qualField').style.display = prefs.fmt === 'image/png' ? 'none' : '';
  }
  $('fmtSel').addEventListener('change', () => { prefs.fmt = $('fmtSel').value; store.set('fmt', prefs.fmt); syncQual(); });
  $('qual').addEventListener('input', () => { prefs.q = +$('qual').value; store.set('q', prefs.q); syncQual(); });
  $('soundChk').addEventListener('change', () => store.set('sound', $('soundChk').checked));
  syncQual();

  function applyPreview() {
    video.style.transform = state.mirror ? 'scaleX(-1)' : 'none';
    $('mirrorBtn').setAttribute('aria-pressed', state.mirror);
    $('grid').classList.toggle('on', state.grid);
    $('gridBtn').setAttribute('aria-pressed', state.grid);
  }
  function applyPreviewFilter() { video.style.filter = FILTERS[$('filterSel').value].css; }
  function toggleMirror() { state.mirror = !state.mirror; store.set('mirror', state.mirror); applyPreview(); announce(state.mirror ? '已開啟水平翻轉' : '已關閉水平翻轉'); }
  function toggleGrid() { state.grid = !state.grid; store.set('grid', state.grid); applyPreview(); }
  $('mirrorBtn').onclick = toggleMirror;
  $('gridBtn').onclick = toggleGrid;
  applyPreview(); applyPreviewFilter();

  /* ---------- 相機串流 ---------- */
  function showMsg(title, body, withBtn, btnText) {
    msg.innerHTML = `<h2></h2><p></p>${withBtn ? '<div><button class="btn primary" id="retryBtn"></button></div>' : ''}`;
    msg.querySelector('h2').textContent = title;
    msg.querySelector('p').textContent = body;
    if (withBtn) { const b = $('retryBtn'); b.textContent = btnText || '重試'; b.onclick = () => startCamera(); }
    msg.classList.add('on');
  }
  function stopStream() {
    if (state.stream) { state.stream.getTracks().forEach(t => t.stop()); state.stream = null; }
    video.srcObject = null;
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showMsg('瀏覽器不支援', '此瀏覽器無法使用相機，或頁面不是透過 HTTPS 開啟。請改用最新版 Chrome、Edge、Firefox 或 Safari。', false);
      return;
    }
    cancelCountdown();
    stopStream();
    shutter.disabled = true;
    showMsg('正在開啟相機…', '請在瀏覽器彈出的視窗中選擇「允許」。', false);

    const h = +$('resSel').value;
    const deviceId = $('deviceSel').value;
    const v = {};
    const validDevice = deviceId && !deviceId.startsWith('__') && deviceId !== '（尚未開啟）' && deviceId.length > 8;
    if (validDevice) v.deviceId = { exact: deviceId };
    if (h) { v.height = { ideal: h }; v.width = { ideal: Math.round(h * 16 / 9) }; }
    else { v.width = { ideal: 1920 }; v.height = { ideal: 1080 }; }

    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false });
    } catch (e) {
      if (v.deviceId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
        $('deviceSel').value = '__none';
        return startCamera();
      }
      const map = {
        NotAllowedError: ['沒有相機權限', '你已拒絕使用相機。請點網址列左側的鎖頭／相機圖示，把相機權限改為「允許」，再按重試。'],
        PermissionDeniedError: ['沒有相機權限', '你已拒絕使用相機。請在網址列的網站設定中允許相機後重試。'],
        NotFoundError: ['找不到相機', '偵測不到任何相機裝置，請確認鏡頭已連接且沒有被實體關閉。你也可以改用「匯入圖片」。'],
        NotReadableError: ['相機被占用', '相機可能正被其他程式（例如視訊會議軟體）使用，請關閉後重試。'],
        OverconstrainedError: ['解析度不支援', '此鏡頭不支援所選解析度，請改選「自動」。']
      };
      const [t, b] = map[e.name] || ['無法開啟相機', e.message || String(e)];
      showMsg(t, b, true);
      return;
    }

    video.srcObject = state.stream;
    try { await video.play(); } catch {}
    await new Promise(r => (video.videoWidth ? r() : video.addEventListener('loadedmetadata', r, { once: true })));
    msg.classList.remove('on');
    shutter.disabled = false;
    shutter.focus({ preventScroll: true });
    $('badge').textContent = `${video.videoWidth} × ${video.videoHeight}`;
    $('badge').classList.add('on');
    await refreshDevices();
    state.stream.getVideoTracks()[0].addEventListener('ended', () => {
      shutter.disabled = true;
      showMsg('相機已中斷', '相機連線已中斷，請重新開啟。', true, '重新開啟');
    });
  }

  async function refreshDevices() {
    try {
      const list = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      const cur = state.stream && state.stream.getVideoTracks()[0].getSettings().deviceId;
      const sel = $('deviceSel');
      sel.innerHTML = list.map((d, i) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || '鏡頭 ' + (i + 1))}</option>`).join('') || '<option value="__none">（無）</option>';
      if (cur && list.some(d => d.deviceId === cur)) sel.value = cur;
    } catch {}
  }

  $('startBtn').onclick = startCamera;
  $('heroStart').onclick = () => { $('camera').scrollIntoView({ behavior: 'smooth', block: 'center' }); if (!state.stream) startCamera(); };
  $('deviceSel').addEventListener('change', startCamera);
  $('resSel').addEventListener('change', () => { if (state.stream) startCamera(); });
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener)
    navigator.mediaDevices.addEventListener('devicechange', () => { if (state.stream) refreshDevices(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.stream && !state.stream.active) showMsg('相機已中斷', '請重新開啟相機。', true, '重新開啟');
  });

  /* ---------- 拍照 ---------- */
  function audioCtx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    state.audio = state.audio || new AC();
    return state.audio;
  }
  function playShutter() {
    if (!$('soundChk').checked) return;
    try {
      const ctx = audioCtx(), len = Math.floor(ctx.sampleRate * .08);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3) * .5;
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start();
    } catch {}
  }
  function beep() {
    if (!$('soundChk').checked) return;
    try {
      const ctx = audioCtx(), o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880; g.gain.value = .06;
      o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + .08);
    } catch {}
  }

  function takePhoto() {
    if (!state.stream || !video.videoWidth) return;
    const w = video.videoWidth, h = video.videoHeight;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: !supportsCtxFilter });
    const f = FILTERS[$('filterSel').value];
    ctx.save();
    if (state.mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    if (supportsCtxFilter && f.css !== 'none') ctx.filter = f.css;
    ctx.drawImage(video, 0, 0, w, h);
    ctx.restore();
    if (!supportsCtxFilter && f.fn) {
      const img = ctx.getImageData(0, 0, w, h);
      f.fn(img.data);
      ctx.putImageData(img, 0, 0);
    }
    playShutter();
    const fl = $('flash'); fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go');
    addPhoto(c);
    announce('已拍攝一張照片');
  }

  function startCountdown(sec) {
    let n = sec;
    const box = $('count'), num = $('countNum');
    shutter.setAttribute('aria-label', '取消倒數');
    const tick = () => {
      if (n <= 0) { cancelCountdown(); takePhoto(); return; }
      num.textContent = n; box.classList.add('on');
      num.style.animation = 'none'; void num.offsetWidth; num.style.animation = '';
      beep(); n--;
      state.counting = setTimeout(tick, 1000);
    };
    tick();
  }
  function cancelCountdown() {
    if (state.counting) { clearTimeout(state.counting); state.counting = null; }
    $('count').classList.remove('on');
    shutter.setAttribute('aria-label', '拍照');
  }
  function onShutter() {
    if (state.counting) { cancelCountdown(); return; }
    const t = +$('timerSel').value;
    t ? startCountdown(t) : takePhoto();
  }
  shutter.onclick = onShutter;

  /* ---------- 相簿 ---------- */
  async function quickDownload(p) {
    const b = await PB.toBlob(p.canvas);
    if (b) PB.download(b, PB.fileName(b, p.id));
  }
  function flipPhoto(p) {
    const c = p.canvas, tmp = document.createElement('canvas');
    tmp.width = c.width; tmp.height = c.height;
    tmp.getContext('2d').drawImage(c, 0, 0);
    const ctx = c.getContext('2d');
    ctx.save(); ctx.clearRect(0, 0, c.width, c.height);
    ctx.translate(c.width, 0); ctx.scale(-1, 1);
    ctx.drawImage(tmp, 0, 0); ctx.restore();
  }
  async function openLightbox(p) {
    const blob = await PB.toBlob(p.canvas, { type: 'image/png' });
    if (!blob) return;
    const img = $('lbImg');
    if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
    const url = URL.createObjectURL(blob);
    img.dataset.url = url; img.src = url;
    $('lightbox').showModal();
  }
  $('lightbox').addEventListener('click', () => $('lightbox').close());

  function openEdit(p, tool) {
    if (!PB.openEditor) { PB.toast('編輯器載入中，請稍後再試'); return; }
    PB.openEditor(p.canvas, out => {
      p.canvas.width = out.width; p.canvas.height = out.height;
      const x = p.canvas.getContext('2d');
      x.clearRect(0, 0, out.width, out.height);
      x.drawImage(out, 0, 0);
      PB.toast('已儲存編輯');
    }, tool);
  }

  function addPhoto(canvas, { edit = false } = {}) {
    const p = { id: state.nextId++, canvas };
    state.photos.unshift(p);
    const el = document.createElement('div');
    el.className = 'photo';
    el.innerHTML = '<div class="bar"><button class="btn primary sm" data-a="edit">✎ 編輯</button><button class="btn sm" data-a="dl">下載</button><button class="btn sm" data-a="copy">複製</button><button class="btn sm" data-a="flip" title="水平翻轉" aria-label="水平翻轉">↔</button><button class="btn sm danger" data-a="del">刪除</button></div>';
    canvas.title = '點擊放大';
    canvas.addEventListener('click', () => openLightbox(p));
    el.prepend(canvas);
    el.addEventListener('click', e => {
      const a = e.target.dataset && e.target.dataset.a;
      if (a === 'edit') openEdit(p);
      else if (a === 'dl') quickDownload(p);
      else if (a === 'copy') PB.copyCanvas(p.canvas);
      else if (a === 'flip') flipPhoto(p);
      else if (a === 'del') { state.photos = state.photos.filter(x => x !== p); el.remove(); syncGallery(); }
    });
    p.el = el;
    $('photos').prepend(el);
    syncGallery();
    if (edit) openEdit(p);
    return p;
  }
  PB.addPhoto = addPhoto;

  function syncGallery() {
    const n = state.photos.length;
    $('empty').style.display = n ? 'none' : '';
    $('count2').textContent = n ? `(${n})` : '';
    $('dlAll').disabled = $('clearAll').disabled = !n;
  }
  $('dlAll').onclick = async () => {
    for (const p of [...state.photos].reverse()) { await quickDownload(p); await new Promise(r => setTimeout(r, 300)); }
  };
  $('clearAll').onclick = () => {
    if (!confirm('確定要清空相簿嗎？尚未下載的照片將無法復原。')) return;
    state.photos = []; $('photos').innerHTML = ''; syncGallery();
  };

  /* ---------- 匯入圖片 ---------- */
  async function importFiles(files) {
    const list = [...files].filter(f => f.type.startsWith('image/'));
    if (!list.length) { PB.toast('請選擇圖片檔（JPG、PNG、WebP…）'); return; }
    let added = [];
    for (const f of list) {
      try {
        let bmp;
        try { bmp = await createImageBitmap(f, { imageOrientation: 'from-image' }); } catch { bmp = await createImageBitmap(f); }
        const k = Math.min(1, PB.config.maxImportSize / Math.max(bmp.width, bmp.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
        const x = c.getContext('2d');
        x.imageSmoothingQuality = 'high';
        x.drawImage(bmp, 0, 0, c.width, c.height);
        if (bmp.close) bmp.close();
        added.push(c);
      } catch (e) {
        PB.toast(`無法讀取「${f.name}」，此格式可能不受瀏覽器支援`);
      }
    }
    added.forEach((c, i) => addPhoto(c, { edit: added.length === 1 }));
    if (added.length > 1) PB.toast(`已匯入 ${added.length} 張圖片`);
  }
  $('importBtn').onclick = $('heroImport').onclick = () => $('fileIn').click();
  $('fileIn').addEventListener('change', e => { importFiles(e.target.files); e.target.value = ''; });

  let dragDepth = 0;
  window.addEventListener('dragenter', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; $('dropHint').classList.add('on'); } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropHint').classList.remove('on'); });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('dropHint').classList.remove('on'); if (e.dataTransfer && e.dataTransfer.files.length) importFiles(e.dataTransfer.files); });

  /* ---------- 快捷鍵 ---------- */
  document.addEventListener('keydown', e => {
    if (!$('editor').hidden || document.querySelector('dialog[open]')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (['select', 'input', 'textarea'].includes(tag)) return;
    if (e.code === 'Space' && tag !== 'button') { e.preventDefault(); if (!shutter.disabled) onShutter(); }
    else if (e.key === 'm' || e.key === 'M') toggleMirror();
    else if (e.key === 'g' || e.key === 'G') toggleGrid();
  });

  window.addEventListener('pagehide', stopStream);
  syncGallery();
})();
