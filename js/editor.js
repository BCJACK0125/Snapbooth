/*
 * editor.js — 照片編輯器
 * 工具：調整、裁切、文字、塗鴉、橡皮擦（物件消除／去背）、相框、OCR
 * 所有運算都在瀏覽器端完成。
 */
(() => {
  'use strict';
  const PB = (window.PB = window.PB || {});
  const $ = id => document.getElementById(id);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const root = $('editor'), scrollEl = $('edScroll'), stack = $('edStack');
  const work = $('edCanvas'), over = $('edOverlay'), cropEl = $('edCrop'), ring = $('edRing'), panel = $('edPanel');
  const ctx = work.getContext('2d', { willReadFrequently: true });
  const octx = over.getContext('2d');

  let W = 0, H = 0, scale = 1, zoom = 'fit';
  let hist = [], hi = -1, original = null, onDone = null;
  let tool = null, toolName = '';
  const tick = () => new Promise(r => setTimeout(r, 40));
  const toast = t => PB.toast(t);

  function busy(on, txt, pct, cancellable) {
    $('edBusy').hidden = !on;
    if (txt) $('edBusyTxt').textContent = txt;
    const bar = $('edBusyBar');
    bar.hidden = !(on && typeof pct === 'number');
    if (!bar.hidden) bar.value = Math.max(0, Math.min(1, pct));
    $('edBusyCancel').hidden = !(on && cancellable);
  }
  $('edBusyCancel').onclick = () => { if (PB.ai) PB.ai.abort(); };

  /* ---------- 畫布尺寸與縮放 ---------- */
  function layout() {
    if (!W) return;
    const bw = scrollEl.clientWidth - 32, bh = scrollEl.clientHeight - 32;
    let s = zoom === 'fit' ? Math.min(bw / W, bh / H, 2) : zoom;
    s = Math.max(0.05, s || 1);
    scale = s;
    stack.style.width = W * s + 'px';
    stack.style.height = H * s + 'px';
    $('edZoomLbl').textContent = Math.round(s * 100) + '%';
  }
  function setSize(w, h) {
    W = w; H = h;
    work.width = w; work.height = h;
    over.width = w; over.height = h;
    layout();
  }
  function zoomBy(f) { zoom = clamp(scale * f, 0.05, 8); layout(); }
  $('edZoomIn').onclick = () => zoomBy(1.25);
  $('edZoomOut').onclick = () => zoomBy(0.8);
  $('edZoomLbl').onclick = () => { zoom = zoom === 'fit' ? 1 : 'fit'; layout(); };
  scrollEl.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.1 : 0.9); } }, { passive: false });
  window.addEventListener('resize', () => { if (!root.hidden && zoom === 'fit') layout(); });

  /* ---------- 歷史紀錄 ---------- */
  const snap = () => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    c.getContext('2d').drawImage(work, 0, 0);
    return c;
  };
  const maxHist = () => clamp(Math.floor(320e6 / Math.max(1, W * H * 4)), 6, 40);
  function pushHist() {
    hist.length = hi + 1;
    hist.push(snap());
    hi++;
    while (hist.length > maxHist()) { hist.shift(); hi--; }
    syncUndo();
  }
  function restore(c) {
    if (c.width !== W || c.height !== H) setSize(c.width, c.height);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(c, 0, 0);
  }
  function syncUndo() {
    $('edUndo').disabled = hi <= 0;
    $('edRedo').disabled = hi >= hist.length - 1;
    $('edReset').disabled = hi <= 0;
  }
  function undo() { if (hi <= 0) return; leaveTool(false); hi--; restore(hist[hi]); syncUndo(); enterTool(toolName); }
  function redo() { if (hi >= hist.length - 1) return; leaveTool(false); hi++; restore(hist[hi]); syncUndo(); enterTool(toolName); }
  function resetAll() {
    if (hi <= 0) return;
    leaveTool(false);
    restore(original);
    pushHist();
    enterTool(toolName);
    toast('已還原為原圖（仍可用「復原」回到上一步）');
  }
  $('edUndo').onclick = undo;
  $('edRedo').onclick = redo;
  $('edReset').onclick = resetAll;

  /* ---------- 工具切換 ---------- */
  const Tools = {};
  function markTabs() {
    document.querySelectorAll('#edTools button').forEach(b => b.setAttribute('aria-selected', b.dataset.tool === toolName));
  }
  function leaveTool(commit) {
    if (tool && tool.leave) tool.leave(commit);
    tool = null;
    over.style.pointerEvents = 'none';
    over.style.opacity = 1;
    octx.clearRect(0, 0, W, H);
    cropEl.hidden = true;
    ring.hidden = true;
  }
  function enterTool(name) {
    toolName = name;
    tool = Tools[name];
    markTabs();
    panel.innerHTML = '';
    over.style.pointerEvents = tool.pointer ? 'auto' : 'none';
    over.style.cursor = tool.cursor || 'crosshair';
    tool.enter();
    panel.scrollTop = 0;
  }
  function setTool(name) {
    if (name === toolName && tool) return;
    leaveTool(true);
    enterTool(name);
  }
  $('edTools').addEventListener('click', e => {
    const b = e.target.closest('button[data-tool]');
    if (b) setTool(b.dataset.tool);
  });

  /* ---------- 指標事件 ---------- */
  function pt(e) {
    const r = over.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height };
  }
  function moveRing(e) {
    const size = tool && tool.ringSize ? tool.ringSize() : 0;
    if (!size) { ring.hidden = true; return; }
    const r = stack.getBoundingClientRect();
    ring.hidden = false;
    ring.style.left = e.clientX - r.left + 'px';
    ring.style.top = e.clientY - r.top + 'px';
    ring.style.width = ring.style.height = Math.max(6, size * scale) + 'px';
  }
  over.addEventListener('pointerdown', e => {
    if (!tool || !tool.onDown || e.button > 0) return;
    e.preventDefault();
    over.setPointerCapture(e.pointerId);
    tool.onDown(pt(e), e);
  });
  over.addEventListener('pointermove', e => {
    moveRing(e);
    if (tool && tool.onMove) tool.onMove(pt(e), e);
  });
  const up = e => { if (tool && tool.onUp) tool.onUp(pt(e), e); };
  over.addEventListener('pointerup', up);
  over.addEventListener('pointercancel', up);
  over.addEventListener('pointerleave', () => { ring.hidden = true; });

  /* ======================================================================
     工具：調整（亮度／對比／飽和度／色溫／復古／暈影 + 濾鏡預設）
     ====================================================================== */
  Tools.adjust = (() => {
    const DEF = { bri: 0, con: 0, sat: 0, warm: 0, sep: 0, vig: 0 };
    const PRESETS = [
      ['原始', {}],
      ['黑白', { sat: -100, con: 12 }],
      ['懷舊', { sep: 70, sat: -10, warm: 20, vig: 30 }],
      ['鮮豔', { sat: 45, con: 15 }],
      ['柔和', { con: -15, bri: 8, sat: -12 }],
      ['冷調', { warm: -45, sat: 8 }],
      ['暖調', { warm: 45, sat: 5 }],
      ['電影', { con: 22, sat: -18, warm: 12, vig: 40, bri: -6 }]
    ];
    const SL = [['bri', '亮度', -100, 100], ['con', '對比', -100, 100], ['sat', '飽和度', -100, 100], ['warm', '色溫', -100, 100], ['sep', '復古', 0, 100], ['vig', '暈影', 0, 100]];
    let base = null, p = { ...DEF }, raf = 0, dirty = false;

    function adjustData(src, q) {
      const w = src.width, h = src.height;
      const out = new ImageData(new Uint8ClampedArray(src.data), w, h);
      const d = out.data;
      const bri = q.bri * 1.28;
      const c = q.con * 2.55, f = (259 * (c + 255)) / (255 * (259 - c));
      const s = 1 + q.sat / 100, warm = (q.warm / 100) * 32, sep = q.sep / 100, vig = q.vig / 100;
      const cx = w / 2, cy = h / 2;
      for (let y = 0; y < h; y++) {
        const dy = (y - cy) / cy, dy2 = dy * dy;
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          let r = (d[i] - 128) * f + 128 + bri;
          let g = (d[i + 1] - 128) * f + 128 + bri;
          let b = (d[i + 2] - 128) * f + 128 + bri;
          if (s !== 1) {
            const l = 0.299 * r + 0.587 * g + 0.114 * b;
            r = l + (r - l) * s; g = l + (g - l) * s; b = l + (b - l) * s;
          }
          r += warm; b -= warm;
          if (sep > 0) {
            const sr = 0.393 * r + 0.769 * g + 0.189 * b, sg = 0.349 * r + 0.686 * g + 0.168 * b, sb = 0.272 * r + 0.534 * g + 0.131 * b;
            r += (sr - r) * sep; g += (sg - g) * sep; b += (sb - b) * sep;
          }
          if (vig > 0) {
            const dx = (x - cx) / cx;
            const m = 1 - vig * 0.62 * (dx * dx + dy2);
            const mm = m < 0.15 ? 0.15 : m;
            r *= mm; g *= mm; b *= mm;
          }
          d[i] = r; d[i + 1] = g; d[i + 2] = b;
        }
      }
      return out;
    }
    const isDirty = () => Object.keys(DEF).some(k => p[k] !== DEF[k]);
    function render() {
      raf = 0;
      dirty = isDirty();
      ctx.putImageData(dirty ? adjustData(base, p) : base, 0, 0);
    }
    function schedule() { if (!raf) raf = requestAnimationFrame(render); }

    function enter() {
      base = ctx.getImageData(0, 0, W, H);
      p = { ...DEF }; dirty = false;
      panel.innerHTML = `
        <h4>調整與濾鏡</h4>
        <div class="thumbs" id="adPresets"></div>
        ${SL.map(([k, n, lo, hi_]) => `<label class="fl">${n}<b id="adv_${k}">0</b><input type="range" data-k="${k}" min="${lo}" max="${hi_}" value="0"></label>`).join('')}
        <div class="btns">
          <button class="btn" id="adCmp" title="按住即可對照原圖">按住對照</button>
          <button class="btn" id="adReset">重設</button>
        </div>
        <button class="btn primary" id="adApply">套用調整</button>
        <p class="note">切換到其他工具時會自動套用目前的調整。</p>`;
      // 預設濾鏡縮圖
      const tw = 96, th = 64, tc = document.createElement('canvas');
      tc.width = tw; tc.height = th;
      const tx = tc.getContext('2d', { willReadFrequently: true });
      const k = Math.max(tw / W, th / H);
      tx.drawImage(work, (tw - W * k) / 2, (th - H * k) / 2, W * k, H * k);
      const tdata = tx.getImageData(0, 0, tw, th);
      const box = $('adPresets');
      PRESETS.forEach(([name, vals], i) => {
        const b = document.createElement('button');
        b.className = 'thumb'; b.dataset.i = i;
        const cv = document.createElement('canvas'); cv.width = tw; cv.height = th;
        cv.getContext('2d').putImageData(adjustData(tdata, { ...DEF, ...vals }), 0, 0);
        b.append(cv, document.createTextNode(name));
        box.appendChild(b);
      });
      box.addEventListener('click', e => {
        const b = e.target.closest('.thumb');
        if (!b) return;
        p = { ...DEF, ...PRESETS[+b.dataset.i][1] };
        syncSliders(); schedule();
      });
      panel.querySelectorAll('input[type=range]').forEach(r => r.addEventListener('input', () => {
        p[r.dataset.k] = +r.value;
        $('adv_' + r.dataset.k).textContent = r.value;
        schedule();
      }));
      $('adReset').onclick = () => { p = { ...DEF }; syncSliders(); schedule(); };
      const cmp = $('adCmp');
      const showOrig = () => { if (raf) cancelAnimationFrame(raf), (raf = 0); ctx.putImageData(base, 0, 0); };
      cmp.addEventListener('pointerdown', showOrig);
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => cmp.addEventListener(ev, () => render()));
      $('adApply').onclick = () => {
        if (!isDirty()) { toast('尚未調整任何項目'); return; }
        render();
        pushHist();
        base = ctx.getImageData(0, 0, W, H);
        p = { ...DEF }; dirty = false; syncSliders();
        toast('已套用調整');
      };
    }
    function syncSliders() {
      panel.querySelectorAll('input[type=range]').forEach(r => {
        r.value = p[r.dataset.k];
        $('adv_' + r.dataset.k).textContent = r.value;
      });
    }
    function leave(commit) {
      if (!base) return;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (isDirty()) {
        if (commit) { ctx.putImageData(adjustData(base, p), 0, 0); pushHist(); }
        else ctx.putImageData(base, 0, 0);
      } else ctx.putImageData(base, 0, 0);
      base = null; dirty = false;
    }
    return { enter, leave };
  })();

  /* ======================================================================
     工具：裁切／旋轉／翻轉
     ====================================================================== */
  Tools.crop = (() => {
    let r = { x: 0, y: 0, w: 0, h: 0 }, ar = null, drag = null;
    const MIN = 24;
    const ARS = [['自由', null], ['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['16:9', 16 / 9], ['9:16', 9 / 16], ['3:2', 3 / 2], ['2:3', 2 / 3]];

    function show() {
      cropEl.hidden = false;
      cropEl.style.left = (r.x / W) * 100 + '%';
      cropEl.style.top = (r.y / H) * 100 + '%';
      cropEl.style.width = (r.w / W) * 100 + '%';
      cropEl.style.height = (r.h / H) * 100 + '%';
      const info = $('crInfo');
      if (info) info.textContent = `${Math.round(r.w)} × ${Math.round(r.h)} px`;
    }
    function fitAR() {
      if (!ar) return;
      let w = r.w, h = w / ar;
      if (h > r.h) { h = r.h; w = h * ar; }
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      r = { x: cx - w / 2, y: cy - h / 2, w, h };
    }
    function resize(d, s, dx, dy) {
      let l = s.x, t = s.y, rr = s.x + s.w, b = s.y + s.h;
      if (d.includes('w')) l = clamp(l + dx, 0, rr - MIN);
      if (d.includes('e')) rr = clamp(rr + dx, l + MIN, W);
      if (d.includes('n')) t = clamp(t + dy, 0, b - MIN);
      if (d.includes('s')) b = clamp(b + dy, t + MIN, H);
      if (ar) {
        const hz = /[we]/.test(d), vt = /[ns]/.test(d);
        let w = rr - l, h = b - t;
        if (hz && !vt) {
          const cy = s.y + s.h / 2;
          h = w / ar;
          const maxH = 2 * Math.min(cy, H - cy);
          if (h > maxH) { h = maxH; w = h * ar; if (d.includes('w')) l = rr - w; else rr = l + w; }
          t = cy - h / 2; b = t + h;
        } else if (vt && !hz) {
          const cx = s.x + s.w / 2;
          w = h * ar;
          const maxW = 2 * Math.min(cx, W - cx);
          if (w > maxW) { w = maxW; h = w / ar; if (d.includes('n')) t = b - h; else b = t + h; }
          l = cx - w / 2; rr = l + w;
        } else {
          if (w / ar > h) h = w / ar; else w = h * ar;
          const maxW = d.includes('w') ? rr : W - l, maxH = d.includes('n') ? b : H - t;
          if (w > maxW) { w = maxW; h = w / ar; }
          if (h > maxH) { h = maxH; w = h * ar; }
          if (d.includes('w')) l = rr - w; else rr = l + w;
          if (d.includes('n')) t = b - h; else b = t + h;
        }
      }
      r = { x: l, y: t, w: rr - l, h: b - t };
    }

    cropEl.addEventListener('pointerdown', e => {
      if (tool !== Tools.crop) return;
      e.preventDefault();
      cropEl.setPointerCapture(e.pointerId);
      drag = { d: e.target.dataset.d || 'move', sx: e.clientX, sy: e.clientY, s: { ...r } };
    });
    cropEl.addEventListener('pointermove', e => {
      if (!drag) return;
      const k = W / stack.getBoundingClientRect().width;
      const dx = (e.clientX - drag.sx) * k, dy = (e.clientY - drag.sy) * k;
      if (drag.d === 'move') r = { ...drag.s, x: clamp(drag.s.x + dx, 0, W - drag.s.w), y: clamp(drag.s.y + dy, 0, H - drag.s.h) };
      else resize(drag.d, drag.s, dx, dy);
      show();
    });
    const end = () => { drag = null; };
    cropEl.addEventListener('pointerup', end);
    cropEl.addEventListener('pointercancel', end);

    function transform(kind) {
      const src = snap();
      const swap = kind === 'rl' || kind === 'rr';
      const nw = swap ? H : W, nh = swap ? W : H;
      setSize(nw, nh);
      ctx.save();
      if (kind === 'rr') { ctx.translate(nw, 0); ctx.rotate(Math.PI / 2); }
      else if (kind === 'rl') { ctx.translate(0, nh); ctx.rotate(-Math.PI / 2); }
      else if (kind === 'fh') { ctx.translate(nw, 0); ctx.scale(-1, 1); }
      else if (kind === 'fv') { ctx.translate(0, nh); ctx.scale(1, -1); }
      ctx.drawImage(src, 0, 0);
      ctx.restore();
      pushHist();
      r = { x: 0, y: 0, w: W, h: H };
      fitAR(); show();
    }
    function apply() {
      const x = Math.round(r.x), y = Math.round(r.y), w = Math.round(r.w), h = Math.round(r.h);
      if (w < 2 || h < 2) return;
      if (w === W && h === H) { toast('裁切範圍等於整張圖片，請先調整裁切框'); return; }
      const src = snap();
      setSize(w, h);
      ctx.drawImage(src, x, y, w, h, 0, 0, w, h);
      pushHist();
      r = { x: 0, y: 0, w: W, h: H };
      fitAR(); show();
      toast(`已裁切為 ${w} × ${h}`);
    }

    function enter() {
      r = { x: 0, y: 0, w: W, h: H };
      ar = null;
      panel.innerHTML = `
        <h4>裁切與旋轉</h4>
        <div class="fl">長寬比<b id="crInfo"></b></div>
        <div class="seg wrap" id="crAr">${ARS.map(([n], i) => `<button data-i="${i}" aria-pressed="${i === 0}">${n}</button>`).join('')}</div>
        <div class="fl">旋轉與翻轉</div>
        <div class="grid4">
          <button class="btn" data-t="rl" title="向左旋轉 90°">⟲</button>
          <button class="btn" data-t="rr" title="向右旋轉 90°">⟳</button>
          <button class="btn" data-t="fh" title="水平翻轉">⇋</button>
          <button class="btn" data-t="fv" title="垂直翻轉">⇅</button>
        </div>
        <div class="btns"><button class="btn" id="crReset">重設</button><button class="btn primary" id="crApply">套用裁切</button></div>
        <p class="note">拖曳白色圓點調整範圍，拖曳框內移動位置。</p>`;
      $('crAr').addEventListener('click', e => {
        const b = e.target.closest('button');
        if (!b) return;
        ar = ARS[+b.dataset.i][1];
        $('crAr').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
        fitAR(); show();
      });
      panel.querySelectorAll('[data-t]').forEach(b => b.onclick = () => transform(b.dataset.t));
      $('crReset').onclick = () => { r = { x: 0, y: 0, w: W, h: H }; fitAR(); show(); };
      $('crApply').onclick = apply;
      show();
    }
    return { enter };
  })();

  /* ======================================================================
     工具：文字與貼圖
     ====================================================================== */
  Tools.text = (() => {
    const FONTS = {
      sans: ['黑體', 'system-ui,"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif'],
      serif: ['明體', '"Noto Serif TC","Songti TC","PMingLiU",serif'],
      hand: ['手寫風', '"Comic Sans MS","Chalkboard SE","Marker Felt","Kaiti TC","DFKai-SB",cursive'],
      mono: ['等寬', 'ui-monospace,Menlo,Consolas,monospace'],
      impact: ['粗標題', 'Impact,"Arial Black","Heiti TC",sans-serif']
    };
    const EMOJI = ['😀', '😍', '😎', '🥳', '❤️', '⭐', '🔥', '👍', '🎉', '✨', '💯', '📍'];
    const d = { text: '', x: 0, y: 0, size: 9, color: '#ffffff', font: 'sans', bold: true, outline: true, shadow: false, rot: 0 };
    let metrics = null, dragging = false, off = { x: 0, y: 0 };

    function lum(hex) {
      const n = parseInt(hex.slice(1), 16);
      return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    }
    function drawText(c, t, withBox) {
      if (!t.text) return null;
      const px = (t.size / 100) * W;
      const lines = t.text.split('\n'), lh = px * 1.2;
      c.save();
      c.font = `${t.bold ? 700 : 400} ${px}px ${FONTS[t.font][1]}`;
      const w = Math.max(...lines.map(l => c.measureText(l).width)), h = lh * lines.length;
      c.translate(t.x, t.y);
      c.rotate((t.rot * Math.PI) / 180);
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.lineJoin = 'round';
      lines.forEach((l, i) => {
        const y = (i - (lines.length - 1) / 2) * lh;
        if (t.shadow) { c.shadowColor = 'rgba(0,0,0,.55)'; c.shadowBlur = px * 0.12; c.shadowOffsetY = px * 0.05; }
        if (t.outline) {
          c.lineWidth = px * 0.14;
          c.strokeStyle = lum(t.color) > 0.6 ? '#000' : '#fff';
          c.strokeText(l, 0, y);
          c.shadowColor = 'transparent';
        }
        c.fillStyle = t.color;
        c.fillText(l, 0, y);
        c.shadowColor = 'transparent';
      });
      if (withBox) {
        const pad = px * 0.15;
        c.setLineDash([6 / scale, 5 / scale]);
        c.lineWidth = 2 / scale;
        c.strokeStyle = '#8b83ff';
        c.strokeRect(-w / 2 - pad, -h / 2 - pad, w + pad * 2, h + pad * 2);
      }
      c.restore();
      return { w, h };
    }
    function render() {
      octx.clearRect(0, 0, W, H);
      metrics = drawText(octx, d, true);
    }
    function hit(p) {
      if (!metrics) return false;
      const a = (-d.rot * Math.PI) / 180, dx = p.x - d.x, dy = p.y - d.y;
      const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
      const pad = (d.size / 100) * W * 0.3;
      return Math.abs(lx) <= metrics.w / 2 + pad && Math.abs(ly) <= metrics.h / 2 + pad;
    }
    function commit() {
      if (!d.text.trim()) return false;
      drawText(ctx, d, false);
      pushHist();
      d.text = '';
      return true;
    }

    function onDown(p) {
      if (d.text && hit(p)) off = { x: p.x - d.x, y: p.y - d.y };
      else { off = { x: 0, y: 0 }; d.x = p.x; d.y = p.y; }
      dragging = true;
      render();
      if (!d.text) { const t = $('txIn'); if (t) t.focus(); }
    }
    function onMove(p) { if (dragging) { d.x = p.x - off.x; d.y = p.y - off.y; render(); } }
    function onUp() { dragging = false; }

    function enter() {
      d.text = ''; d.x = W / 2; d.y = H / 2;
      panel.innerHTML = `
        <h4>文字與貼圖</h4>
        <label class="fl">文字內容<textarea id="txIn" rows="3" placeholder="輸入文字…（可換行）"></textarea></label>
        <div class="emoji" id="txEmoji">${EMOJI.map(e => `<button type="button" aria-label="插入 ${e}">${e}</button>`).join('')}</div>
        <label class="fl">字型<select id="txFont">${Object.entries(FONTS).map(([k, [n]]) => `<option value="${k}">${n}</option>`).join('')}</select></label>
        <label class="fl">大小<b id="txSzV">${d.size}%</b><input type="range" id="txSz" min="2" max="40" value="${d.size}"></label>
        <label class="fl">旋轉<b id="txRotV">${d.rot}°</b><input type="range" id="txRot" min="-180" max="180" value="${d.rot}"></label>
        <div class="row">
          <label class="fl" style="display:flex;gap:6px;align-items:center">顏色 <input type="color" id="txColor" value="${d.color}"></label>
          <label class="chk"><input type="checkbox" id="txBold" ${d.bold ? 'checked' : ''}> 粗體</label>
          <label class="chk"><input type="checkbox" id="txOut" ${d.outline ? 'checked' : ''}> 描邊</label>
          <label class="chk"><input type="checkbox" id="txSh" ${d.shadow ? 'checked' : ''}> 陰影</label>
        </div>
        <div class="btns"><button class="btn" id="txClear">清除</button><button class="btn primary" id="txApply">套用文字</button></div>
        <p class="note">在照片上點一下放置文字，拖曳可移動位置。</p>`;
      $('txFont').value = d.font;
      const bind = (id, fn) => $(id).addEventListener('input', () => { fn($(id)); render(); });
      bind('txIn', el => (d.text = el.value));
      bind('txFont', el => (d.font = el.value));
      bind('txSz', el => { d.size = +el.value; $('txSzV').textContent = d.size + '%'; });
      bind('txRot', el => { d.rot = +el.value; $('txRotV').textContent = d.rot + '°'; });
      bind('txColor', el => (d.color = el.value));
      bind('txBold', el => (d.bold = el.checked));
      bind('txOut', el => (d.outline = el.checked));
      bind('txSh', el => (d.shadow = el.checked));
      $('txEmoji').addEventListener('click', e => {
        const b = e.target.closest('button');
        if (!b) return;
        const t = $('txIn'); t.value += b.textContent; d.text = t.value; render();
      });
      $('txClear').onclick = () => { d.text = ''; $('txIn').value = ''; render(); };
      $('txApply').onclick = () => {
        if (!commit()) { toast('請先輸入文字'); return; }
        $('txIn').value = ''; render(); toast('已加入文字');
      };
      render();
    }
    function leave(commitIt) { if (commitIt) commit(); d.text = ''; }
    return { enter, leave, pointer: true, onDown, onMove, onUp, cursor: 'move' };
  })();

  /* ======================================================================
     工具：塗鴉（畫筆／螢光筆／直線／箭頭／方框／橢圓／馬賽克）
     ====================================================================== */
  Tools.draw = (() => {
    const KINDS = [['pen', '✏️ 畫筆'], ['hl', '🖍 螢光筆'], ['line', '╱ 直線'], ['arrow', '➜ 箭頭'], ['rect', '▭ 方框'], ['ellipse', '◯ 橢圓'], ['mosaic', '▦ 馬賽克']];
    const MUL = { pen: 1, hl: 4, line: 1, arrow: 1, rect: 1, ellipse: 1, mosaic: 3.5 };
    const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#af52de', '#ffffff', '#000000'];
    let kind = 'pen', color = '#ff3b30', size = 6, alpha = 100, fill = false;
    let down = false, pts = [], start = null, pattern = null;
    const px = () => Math.max(1, (size * MUL[kind] * Math.max(W, H)) / 1000);
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

    function setup() {
      octx.lineCap = 'round'; octx.lineJoin = 'round';
      octx.lineWidth = px();
      octx.strokeStyle = kind === 'mosaic' ? pattern : color;
      octx.fillStyle = color;
      over.style.opacity = kind === 'hl' ? 0.4 : kind === 'mosaic' ? 1 : alpha / 100;
    }
    function buildMosaic() {
      const cell = Math.max(6, Math.round(Math.max(W, H) / 70));
      const s = document.createElement('canvas');
      s.width = Math.ceil(W / cell); s.height = Math.ceil(H / cell);
      const sc = s.getContext('2d');
      sc.imageSmoothingQuality = 'high';
      sc.drawImage(work, 0, 0, s.width, s.height);
      const big = document.createElement('canvas');
      big.width = W; big.height = H;
      const bc = big.getContext('2d');
      bc.imageSmoothingEnabled = false;
      bc.drawImage(s, 0, 0, s.width, s.height, 0, 0, s.width * cell, s.height * cell);
      pattern = octx.createPattern(big, 'no-repeat');
    }
    function arrow(c, a, b, lw) {
      const ang = Math.atan2(b.y - a.y, b.x - a.x), hl = Math.max(14, lw * 4.5);
      c.beginPath(); c.moveTo(a.x, a.y);
      c.lineTo(b.x - Math.cos(ang) * hl * 0.6, b.y - Math.sin(ang) * hl * 0.6);
      c.stroke();
      c.beginPath(); c.moveTo(b.x, b.y);
      c.lineTo(b.x - hl * Math.cos(ang - 0.45), b.y - hl * Math.sin(ang - 0.45));
      c.lineTo(b.x - hl * Math.cos(ang + 0.45), b.y - hl * Math.sin(ang + 0.45));
      c.closePath(); c.fill();
    }
    function shape(a, b) {
      octx.clearRect(0, 0, W, H);
      const lw = px();
      if (kind === 'line') { octx.beginPath(); octx.moveTo(a.x, a.y); octx.lineTo(b.x, b.y); octx.stroke(); }
      else if (kind === 'arrow') arrow(octx, a, b, lw);
      else if (kind === 'rect') { fill ? octx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y) : octx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); }
      else if (kind === 'ellipse') {
        octx.beginPath();
        octx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
        fill ? octx.fill() : octx.stroke();
      }
    }
    const freehand = () => kind === 'pen' || kind === 'hl' || kind === 'mosaic';

    function onDown(p) {
      down = true; start = p; pts = [p];
      if (kind === 'mosaic') buildMosaic();
      octx.clearRect(0, 0, W, H);
      setup();
      if (freehand()) {
        octx.beginPath(); octx.moveTo(p.x, p.y); octx.lineTo(p.x + 0.01, p.y + 0.01); octx.stroke();
      }
    }
    function onMove(p) {
      if (!down) return;
      if (freehand()) {
        const n = pts.length, a = pts[n - 1], m = mid(a, p);
        const prev = n >= 2 ? mid(pts[n - 2], a) : pts[0];
        pts.push(p);
        octx.beginPath(); octx.moveTo(prev.x, prev.y); octx.quadraticCurveTo(a.x, a.y, m.x, m.y); octx.stroke();
      } else shape(start, p);
    }
    function onUp(p) {
      if (!down) return;
      down = false;
      if (freehand()) {
        const a = pts[pts.length - 1];
        octx.beginPath(); octx.moveTo(mid(pts[Math.max(0, pts.length - 2)], a).x, mid(pts[Math.max(0, pts.length - 2)], a).y); octx.lineTo(p.x, p.y); octx.stroke();
      } else shape(start, p);
      ctx.save();
      ctx.globalAlpha = kind === 'hl' ? 0.4 : kind === 'mosaic' ? 1 : alpha / 100;
      if (kind === 'hl') ctx.globalCompositeOperation = 'multiply';
      ctx.drawImage(over, 0, 0);
      ctx.restore();
      octx.clearRect(0, 0, W, H);
      over.style.opacity = 1;
      pushHist();
    }

    function syncRows() {
      $('drColorRow').style.display = kind === 'mosaic' ? 'none' : '';
      $('drAlphaRow').style.display = kind === 'pen' || kind === 'line' || kind === 'arrow' || kind === 'rect' || kind === 'ellipse' ? '' : 'none';
      $('drFillRow').style.display = kind === 'rect' || kind === 'ellipse' ? '' : 'none';
    }
    function enter() {
      panel.innerHTML = `
        <h4>塗鴉</h4>
        <div class="seg wrap" id="drKinds">${KINDS.map(([k, n]) => `<button data-k="${k}" aria-pressed="${k === kind}">${n}</button>`).join('')}</div>
        <div id="drColorRow" class="fl">顏色
          <div class="swatches" id="drSw">${COLORS.map(c => `<button class="swatch" data-c="${c}" style="background:${c}" aria-label="${c}" aria-pressed="${c === color}"></button>`).join('')}<input type="color" id="drColor" value="${color}" aria-label="自訂顏色"></div>
        </div>
        <label class="fl">粗細<b id="drSzV">${size}</b><input type="range" id="drSz" min="1" max="60" value="${size}"></label>
        <label class="fl" id="drAlphaRow">不透明度<b id="drAlV">${alpha}%</b><input type="range" id="drAl" min="10" max="100" value="${alpha}"></label>
        <label class="chk" id="drFillRow"><input type="checkbox" id="drFill" ${fill ? 'checked' : ''}> 填滿圖形</label>
        <p class="note">馬賽克可用來遮蔽人臉、車牌或個資。每次放開滑鼠／手指就是一個復原步驟。</p>`;
      $('drKinds').addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        kind = b.dataset.k;
        $('drKinds').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
        syncRows();
      });
      const setColor = c => { color = c; $('drColor').value = c; $('drSw').querySelectorAll('.swatch').forEach(s => s.setAttribute('aria-pressed', s.dataset.c === c)); };
      $('drSw').addEventListener('click', e => { const s = e.target.closest('.swatch'); if (s) setColor(s.dataset.c); });
      $('drColor').addEventListener('input', e => { color = e.target.value; $('drSw').querySelectorAll('.swatch').forEach(s => s.setAttribute('aria-pressed', false)); });
      $('drSz').addEventListener('input', e => { size = +e.target.value; $('drSzV').textContent = size; });
      $('drAl').addEventListener('input', e => { alpha = +e.target.value; $('drAlV').textContent = alpha + '%'; });
      $('drFill').addEventListener('change', e => (fill = e.target.checked));
      syncRows();
    }
    return { enter, pointer: true, onDown, onMove, onUp, ringSize: () => (freehand() ? px() : 0) };
  })();

  /* ======================================================================
     工具：魔術橡皮擦（物件消除 / 去背）
       · 消除引擎：快速（內建演算法）／ AI 標準（MI-GAN）／ AI 高品質（LaMa）
       · 自動選取主體：U²-Net-P / BiRefNet-lite 偵測後，交給消除引擎補背景
       · 去背：AI 自動（U²-Net-P / BiRefNet-lite）或點選顏色
     ====================================================================== */
  Tools.erase = (() => {
    const ENG = {
      fast:  { label: '快速（內建演算法）', note: '免下載、立即完成。適合小污點與單純背景。' },
      migan: { label: 'AI 標準・MI-GAN', bundle: 'migan', note: '速度快、品質佳，適合大多數情況。' },
      lama:  { label: 'AI 高品質・LaMa', bundle: 'lama', note: '品質最好，適合大面積或複雜背景。CPU 模式可能需要十幾秒到數十秒；建議使用 Wi-Fi 與支援 WebGPU 的瀏覽器。' }
    };
    const SEG = {
      u2netp:   { label: 'U²-Net-P（快速）', bundle: 'u2netp', note: '體積小、速度快，適合人物、商品等明確的主體。' },
      birefnet: { label: 'BiRefNet-lite（高品質）', bundle: 'birefnet', note: '邊緣與細節更好（髮絲、毛邊）。建議使用支援 WebGPU 的瀏覽器，否則會改用較大的 CPU 版本。' }
    };
    let mode = 'object', bgMode = 'ai';
    let engine = PB.store.get('eraseEngine', 'fast'), segModel = PB.store.get('segModel', 'u2netp');
    if (!ENG[engine]) engine = 'fast';
    if (!SEG[segModel]) segModel = 'u2netp';
    let size = 30, tol = 30, contig = true, feather = 1, down = false, last = null, hasMask = false;
    const brushPx = () => Math.max(2, (size * Math.max(W, H)) / 1000);
    const epName = ep => (ep === 'webgpu' ? 'WebGPU' : 'CPU');

    /* ---- 共用：進度 / 錯誤 ---- */
    const mb = b => (b / 1e6).toFixed(b >= 1e7 ? 0 : 1);
    function aiProgress(p) {
      if (p.stage === 'download') {
        const name = PB.ai.models[p.id] ? PB.ai.models[p.id].name : '模型';
        busy(true, `下載 AI 模型（${name}）… ${mb(p.loaded)} / ${mb(p.total)} MB`, p.total ? p.loaded / p.total : undefined, true);
      } else if (p.stage === 'cache') busy(true, '載入已下載的模型…');
      else if (p.stage === 'init') busy(true, '初始化模型…（首次較久）');
    }
    function aiError(e, what) {
      if (e && e.name === 'AbortError') { toast('已取消下載'); return; }
      toast(`${what}失敗：${(e && e.message) || e}`, 5200);
    }
    const sizeTxt = v => (v.bundle ? `（${PB.ai.sizeLabel(PB.ai.bundleSize(v.bundle))}）` : '');
    const bundleKey = async m => (m === 'birefnet' ? ((await PB.ai.webgpu()) ? 'birefnet' : 'birefnet32') : m);

    async function refreshOptions() {
      for (const [id, map] of [['erEng', ENG], ['erSeg', SEG], ['bgSeg', SEG]]) {
        const el = $(id);
        if (!el) continue;
        for (const opt of [...el.options]) {
          const m = map[opt.value];
          if (!m || !m.bundle) continue;
          const key = await bundleKey(m.bundle);
          const cached = await PB.ai.bundleCached(key);
          opt.textContent = `${m.label}（${PB.ai.sizeLabel(PB.ai.bundleSize(key))}${cached ? '・已下載' : ''}）`;
        }
      }
    }

    /* ---- 筆刷標記 ---- */
    function paintTo(p) {
      octx.strokeStyle = octx.fillStyle = '#ff3b30';
      octx.lineCap = octx.lineJoin = 'round';
      octx.lineWidth = brushPx();
      octx.beginPath(); octx.moveTo(last.x, last.y); octx.lineTo(p.x + 0.01, p.y + 0.01); octx.stroke();
      last = p; hasMask = true;
    }
    function overlayMask() {
      const od = octx.getImageData(0, 0, W, H).data;
      const m = new Uint8Array(W * H);
      for (let i = 0; i < m.length; i++) m[i] = od[i * 4 + 3] > 100 ? 1 : 0;
      return m;
    }

    /* ---- 消除 ---- */
    async function runInpaint() {
      if (!hasMask) { toast('請先用手指或滑鼠塗抹要消除的區域，或按「自動選取主體」'); return; }
      busy(true, engine === 'fast' ? '智慧消除中…' : '準備 AI 模型…');
      await tick();
      try {
        const m = overlayMask();
        let label = '';
        if (engine === 'fast') {
          const img = ctx.getImageData(0, 0, W, H);
          if (!PB.inpaint(img, m)) { toast('沒有偵測到標記區域'); return; }
          ctx.putImageData(img, 0, 0);
        } else {
          const patch = await PB.ai.inpaint(work, m, { model: engine, onProgress: aiProgress, onStatus: s => busy(true, s) });
          if (!patch) { toast('沒有偵測到標記區域'); return; }
          ctx.putImageData(patch.data, patch.x, patch.y);
          label = `（${PB.ai.models[patch.model].name}・${epName(patch.ep)}）`;
        }
        octx.clearRect(0, 0, W, H); hasMask = false;
        pushHist();
        toast('已消除' + label);
      } catch (e) { aiError(e, engine === 'fast' ? '消除' : 'AI 消除'); }
      finally { busy(false); }
    }

    /* ---- 自動選取主體（U-Net 系列偵測 → 交給消除引擎補背景） ---- */
    async function autoSelect() {
      busy(true, '準備 AI 模型…');
      await tick();
      try {
        const r = await PB.ai.segment(work, { model: segModel, onProgress: aiProgress, onStatus: s => busy(true, s) });
        const m = new Uint8Array(W * H);
        let cnt = 0;
        for (let i = 0; i < m.length; i++) if (r.alpha[i] > 0.5) { m[i] = 1; cnt++; }
        if (cnt < W * H * 0.0005) { toast('沒有偵測到明確的主體，請改用筆刷塗抹'); return; }
        if (cnt > W * H * 0.9) { toast('偵測到的範圍幾乎是整張圖，無法補背景，請改用筆刷塗抹'); return; }
        const md = PB.ai.dilateMask(m, W, H, clamp(Math.round(Math.max(W, H) * 0.004), 2, 12));
        const img = octx.getImageData(0, 0, W, H), d = img.data;
        for (let i = 0; i < md.length; i++) if (md[i]) { d[i * 4] = 255; d[i * 4 + 1] = 59; d[i * 4 + 2] = 48; d[i * 4 + 3] = 255; }
        octx.putImageData(img, 0, 0);
        over.style.opacity = 0.55; hasMask = true;
        toast(`已標記主體（${PB.ai.models[r.model].name}・${epName(r.ep)}）。可用筆刷補充，再按「執行消除」`, 4200);
      } catch (e) { aiError(e, '自動選取'); }
      finally { busy(false); }
    }

    /* ---- 去背 ---- */
    async function runBgAI() {
      busy(true, '準備 AI 模型…');
      await tick();
      try {
        const r = await PB.ai.segment(work, { model: segModel, onProgress: aiProgress, onStatus: s => busy(true, s) });
        const img = ctx.getImageData(0, 0, W, H), d = img.data;
        for (let i = 0; i < r.alpha.length; i++) d[i * 4 + 3] = Math.round(d[i * 4 + 3] * r.alpha[i]);
        ctx.putImageData(img, 0, 0);
        pushHist();
        toast(`已完成 AI 去背（${PB.ai.models[r.model].name}・${epName(r.ep)}），可下載為透明 PNG`, 4200);
      } catch (e) { aiError(e, 'AI 去背'); }
      finally { busy(false); }
    }
    async function runWand(p) {
      busy(true, '去背處理中…');
      await tick();
      try {
        const img = ctx.getImageData(0, 0, W, H);
        const n = PB.removeColor(img, p.x, p.y, { tol, contiguous: contig, feather });
        if (!n) { toast('這個位置沒有可移除的像素'); return; }
        ctx.putImageData(img, 0, 0);
        pushHist();
        toast('已移除 ' + n.toLocaleString() + ' 個像素（可調整容許度後復原重試）');
      } catch (e) { toast(e.message || '去背失敗'); }
      finally { busy(false); }
    }

    function onDown(p) {
      if (mode === 'bg') { if (bgMode === 'color') runWand(p); return; }
      down = true; last = p; over.style.opacity = 0.55;
      paintTo(p);
    }
    function onMove(p) { if (down && mode === 'object') paintTo(p); }
    function onUp() { down = false; }

    /* ---- 面板 ---- */
    const segSelect = id => `<label class="fl">偵測／去背模型<select id="${id}">${Object.entries(SEG).map(([k, v]) => `<option value="${k}" ${k === segModel ? 'selected' : ''}>${v.label}${sizeTxt(v)}</option>`).join('')}</select></label>`;
    const fillRow = `<div class="fl">填入背景色（填滿透明處）</div><div class="row"><input type="color" id="erBg" value="#ffffff" aria-label="背景色"><button class="btn" id="erFill">填入背景色</button></div>`;

    function renderPanel() {
      over.style.cursor = mode === 'object' ? 'crosshair' : bgMode === 'color' ? 'copy' : 'default';
      let body;
      if (mode === 'object') {
        body = `
          <label class="fl">消除引擎<select id="erEng">${Object.entries(ENG).map(([k, v]) => `<option value="${k}" ${k === engine ? 'selected' : ''}>${v.label}${sizeTxt(v)}</option>`).join('')}</select></label>
          <div class="note" id="erEngNote">${ENG[engine].note}</div>
          <label class="fl">筆刷大小<b id="erSzV">${size}</b><input type="range" id="erSz" min="5" max="120" value="${size}"></label>
          <div class="btns"><button class="btn" id="erClear">清除標記</button><button class="btn primary" id="erRun">✨ 執行消除</button></div>
          <h4 style="margin-top:6px">自動選取主體 <span class="tag">AI</span></h4>
          ${segSelect('erSeg')}
          <div class="note" id="erSegNote">${SEG[segModel].note}</div>
          <button class="btn" id="erSel">🎯 自動選取主體並標記</button>
          <p class="note">先塗抹要移除的路人或雜物，再按「執行消除」。也可以按「自動選取主體」讓 AI 標出主要人物／物體，再用同一個引擎把它移除並補上背景（偵測 + 修補的組合）。</p>`;
      } else {
        body = `
          <div class="seg" id="bgMode"><button data-b="ai" aria-pressed="${bgMode === 'ai'}">AI 自動</button><button data-b="color" aria-pressed="${bgMode === 'color'}">點選顏色</button></div>
          ${bgMode === 'ai' ? `
            ${segSelect('bgSeg')}
            <div class="note" id="bgSegNote">${SEG[segModel].note}</div>
            <button class="btn primary" id="bgRun">🪄 AI 一鍵去背</button>
            ${fillRow}
            <p class="note">AI 會分離出主體並產生柔邊的透明背景。完成後可下載為透明 PNG；JPEG 不支援透明，匯出時會填白底。</p>`
          : `
            <label class="fl">顏色容許度<b id="erTolV">${tol}</b><input type="range" id="erTol" min="1" max="100" value="${tol}"></label>
            <label class="fl">邊緣柔化<b id="erFeV">${feather}px</b><input type="range" id="erFe" min="0" max="4" value="${feather}"></label>
            <label class="chk"><input type="checkbox" id="erContig" ${contig ? 'checked' : ''}> 只移除相連區域</label>
            ${fillRow}
            <p class="note">點一下照片上想變透明的顏色（例如單色背景）。背景複雜時請改用「AI 自動」。</p>`}`;
      }
      panel.innerHTML = `<h4>魔術橡皮擦</h4><div class="seg" id="erMode"><button data-m="object" aria-pressed="${mode === 'object'}">消除物件</button><button data-m="bg" aria-pressed="${mode === 'bg'}">去背</button></div>${body}`;

      $('erMode').addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        mode = b.dataset.m; octx.clearRect(0, 0, W, H); hasMask = false; renderPanel();
      });
      if (mode === 'object') {
        $('erEng').addEventListener('change', e => { engine = e.target.value; PB.store.set('eraseEngine', engine); $('erEngNote').textContent = ENG[engine].note; });
        $('erSz').addEventListener('input', e => { size = +e.target.value; $('erSzV').textContent = size; });
        $('erClear').onclick = () => { octx.clearRect(0, 0, W, H); hasMask = false; };
        $('erRun').onclick = runInpaint;
        $('erSeg').addEventListener('change', e => { segModel = e.target.value; PB.store.set('segModel', segModel); $('erSegNote').textContent = SEG[segModel].note; });
        $('erSel').onclick = autoSelect;
      } else {
        $('bgMode').addEventListener('click', e => {
          const b = e.target.closest('button'); if (!b) return;
          bgMode = b.dataset.b; renderPanel();
        });
        $('erFill').onclick = () => {
          ctx.save(); ctx.globalCompositeOperation = 'destination-over';
          ctx.fillStyle = $('erBg').value; ctx.fillRect(0, 0, W, H); ctx.restore();
          pushHist(); toast('已填入背景色');
        };
        if (bgMode === 'ai') {
          $('bgSeg').addEventListener('change', e => { segModel = e.target.value; PB.store.set('segModel', segModel); $('bgSegNote').textContent = SEG[segModel].note; });
          $('bgRun').onclick = runBgAI;
        } else {
          $('erTol').addEventListener('input', e => { tol = +e.target.value; $('erTolV').textContent = tol; });
          $('erFe').addEventListener('input', e => { feather = +e.target.value; $('erFeV').textContent = feather + 'px'; });
          $('erContig').addEventListener('change', e => (contig = e.target.checked));
        }
      }
      refreshOptions();
    }
    function enter() { hasMask = false; renderPanel(); }
    function leave() { hasMask = false; }
    return { enter, leave, pointer: true, onDown, onMove, onUp, ringSize: () => (mode === 'object' ? brushPx() : 0) };
  })();

  /* ======================================================================
     工具：相框
     ====================================================================== */
  Tools.frame = (() => {
    const STYLES = { white: ['白框', '#ffffff'], polaroid: ['拍立得', '#fafafa'], black: ['黑框', '#111111'], round: ['圓角', '#ffffff'] };
    let style = 'white', color = '#ffffff', th = 4;
    function roundRect(c, x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      c.beginPath();
      c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
    }
    function apply() {
      const m = Math.min(W, H), p = Math.round((m * th) / 100), src = snap();
      if (style === 'round') {
        setSize(W, H); ctx.clearRect(0, 0, W, H);
        ctx.save(); roundRect(ctx, 0, 0, W, H, (m * th * 3) / 100); ctx.clip(); ctx.drawImage(src, 0, 0); ctx.restore();
      } else {
        const bottom = style === 'polaroid' ? Math.round(p * 3.4) : p;
        setSize(src.width + 2 * p, src.height + p + bottom);
        ctx.fillStyle = color; ctx.fillRect(0, 0, W, H);
        ctx.drawImage(src, p, p);
      }
      pushHist();
      toast('已加入相框');
    }
    function enter() {
      panel.innerHTML = `
        <h4>相框</h4>
        <div class="seg wrap" id="frSt">${Object.entries(STYLES).map(([k, [n]]) => `<button data-s="${k}" aria-pressed="${k === style}">${n}</button>`).join('')}</div>
        <label class="fl">粗細<b id="frThV">${th}%</b><input type="range" id="frTh" min="1" max="15" value="${th}"></label>
        <div class="row"><label class="fl" style="display:flex;gap:6px;align-items:center">顏色 <input type="color" id="frColor" value="${color}"></label></div>
        <button class="btn primary" id="frApply">套用相框</button>
        <p class="note">圓角會讓四個角變透明，請匯出為 PNG 或 WebP 以保留透明。</p>`;
      $('frSt').addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        style = b.dataset.s; color = STYLES[style][1]; $('frColor').value = color;
        $('frSt').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
      });
      $('frTh').addEventListener('input', e => { th = +e.target.value; $('frThV').textContent = th + '%'; });
      $('frColor').addEventListener('input', e => (color = e.target.value));
      $('frApply').onclick = apply;
    }
    return { enter };
  })();

  /* ======================================================================
     工具：文字辨識
       · 標準：Tesseract.js（體積小，英文與一般文件）
       · 進階：PaddleOCR PP-OCRv5（中文、排版、小字更準），模型按需下載
     ====================================================================== */
  Tools.ocr = (() => {
    const LANGS = [['chi_tra+eng', '繁體中文 + 英文'], ['chi_sim+eng', '簡體中文 + 英文'], ['eng', '英文'], ['jpn+eng', '日文 + 英文'], ['kor+eng', '韓文 + 英文']];
    const VARIANTS = [['multi', '通用（中・英・日）', 'ocr_multi'], ['latin', '拉丁語系（歐美）', 'ocr_latin']];
    const STATUS = { 'loading tesseract core': '載入辨識引擎…', 'initializing tesseract': '初始化…', 'loading language traineddata': '下載語言資料（首次較久，之後會快取）…', 'initializing api': '初始化…', 'recognizing text': '辨識中…' };
    let engine = PB.store.get('ocrEngine', 'standard');
    if (engine !== 'standard' && engine !== 'ai') engine = 'standard';
    let words = [], polys = [], running = false, k = 1, showBoxes = true, text = '';
    const CJK = '\\u3000-\\u303f\\u3400-\\u9fff\\uff00-\\uffef';
    const clean = s => s.replace(new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, 'g'), '$1').replace(/\n{3,}/g, '\n\n').trim();
    const mb = b => (b / 1e6).toFixed(b >= 1e7 ? 0 : 1);

    function loadLib() {
      if (window.Tesseract) return Promise.resolve();
      return new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = PB.config.tesseractSrc;
        s.onload = res;
        s.onerror = () => rej(new Error('無法載入 OCR 引擎，請檢查網路連線'));
        document.head.appendChild(s);
      });
    }
    function drawBoxes() {
      octx.clearRect(0, 0, W, H);
      if (!showBoxes) return;
      octx.lineWidth = Math.max(1, 2 / scale);
      octx.strokeStyle = 'rgba(139,131,255,.95)';
      octx.fillStyle = 'rgba(139,131,255,.18)';
      for (const w of words) {
        const b = w.bbox; if (!b) continue;
        const x = b.x0 / k, y = b.y0 / k, bw = (b.x1 - b.x0) / k, bh = (b.y1 - b.y0) / k;
        octx.fillRect(x, y, bw, bh); octx.strokeRect(x, y, bw, bh);
      }
      for (const q of polys) {
        octx.beginPath();
        q.forEach((p, i) => (i ? octx.lineTo(p[0], p[1]) : octx.moveTo(p[0], p[1])));
        octx.closePath(); octx.fill(); octx.stroke();
      }
    }
    function finish(t, st, label) {
      text = t;
      $('ocOut').value = text;
      $('ocActions').hidden = false;
      st.textContent = text ? `完成${label ? '（' + label + '）' : ''}，共 ${text.replace(/\s/g, '').length} 個字元` : '沒有偵測到文字';
      drawBoxes();
      if (!text) toast('沒有偵測到文字，試試換一個語言或引擎，或拍得更清楚');
    }

    async function runStandard(st, bar) {
      await loadLib();
      const lang = $('ocLang').value;
      const worker = await window.Tesseract.createWorker(lang, 1, Object.assign({
        logger: m => {
          if (m.status && STATUS[m.status]) st.textContent = STATUS[m.status] + (m.progress != null ? ` ${Math.round(m.progress * 100)}%` : '');
          if (typeof m.progress === 'number') bar.value = m.progress;
        }
      }, PB.config.tesseractOptions));
      // 以白底、最長邊 ≤ 2600px 的副本辨識（透明背景會讓辨識變差）
      k = Math.min(1, 2600 / Math.max(W, H));
      const input = document.createElement('canvas');
      input.width = Math.round(W * k); input.height = Math.round(H * k);
      const ix = input.getContext('2d');
      ix.fillStyle = '#fff'; ix.fillRect(0, 0, input.width, input.height);
      ix.imageSmoothingQuality = 'high';
      ix.drawImage(work, 0, 0, input.width, input.height);
      const { data } = await worker.recognize(input);
      await worker.terminate();
      polys = [];
      words = data.words || [];
      if (!words.length && data.blocks) {
        for (const b of data.blocks) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) words.push(w);
      }
      words = words.filter(w => (w.confidence == null || w.confidence > 40) && String(w.text || '').trim());
      finish(clean(data.text || ''), st, 'Tesseract');
    }

    async function runAI(st, bar) {
      const variant = $('ocVar').value;
      const flat = document.createElement('canvas');
      flat.width = W; flat.height = H;
      const fx = flat.getContext('2d');
      fx.fillStyle = '#fff'; fx.fillRect(0, 0, W, H); fx.drawImage(work, 0, 0);
      const res = await PB.ai.ocr(flat, {
        variant,
        onProgress: p => {
          if (p.stage === 'download') {
            const name = PB.ai.models[p.id] ? PB.ai.models[p.id].name : '模型';
            st.textContent = `下載 ${name}… ${mb(p.loaded)} / ${mb(p.total)} MB`;
            bar.hidden = false; bar.max = 1; bar.value = p.total ? p.loaded / p.total : 0;
            $('ocCancel').hidden = false;
          } else if (p.stage === 'cache') { st.textContent = '載入已下載的模型…'; }
          else if (p.stage === 'init') { st.textContent = '初始化模型…'; bar.removeAttribute('value'); $('ocCancel').hidden = true; }
        },
        onStatus: s => { st.textContent = s; $('ocCancel').hidden = true; bar.removeAttribute('value'); }
      });
      k = 1; words = []; polys = res.lines.map(l => l.poly);
      finish(res.text, st, 'PP-OCRv5・' + (res.ep === 'webgpu' ? 'WebGPU' : 'CPU'));
    }

    async function run() {
      if (running) return;
      running = true;
      const btn = $('ocRun'), bar = $('ocBar'), st = $('ocSt');
      btn.disabled = true; bar.hidden = false; bar.removeAttribute('value');
      st.textContent = '準備中…';
      try {
        if (engine === 'ai') await runAI(st, bar); else await runStandard(st, bar);
      } catch (e) {
        st.textContent = (e && e.name === 'AbortError') ? '已取消下載' : ((e && e.message) || '辨識失敗');
        if (engine === 'ai' && !(e && e.name === 'AbortError')) st.textContent += '（可改用「標準」引擎）';
        toast(st.textContent);
      } finally {
        running = false; btn.disabled = false; bar.hidden = true; $('ocCancel').hidden = true;
      }
    }

    async function refreshVariantLabels() {
      const el = $('ocVar');
      if (!el) return;
      for (const opt of [...el.options]) {
        const v = VARIANTS.find(x => x[0] === opt.value);
        const cached = await PB.ai.bundleCached(v[2]);
        opt.textContent = `${v[1]}（${PB.ai.sizeLabel(PB.ai.bundleSize(v[2]))}${cached ? '・已下載' : ''}）`;
      }
    }

    function renderPanel() {
      words = []; polys = []; text = '';
      octx.clearRect(0, 0, W, H);
      panel.innerHTML = `
        <h4>文字辨識 (OCR)</h4>
        <div class="seg" id="ocEng"><button data-e="standard" aria-pressed="${engine === 'standard'}">標準</button><button data-e="ai" aria-pressed="${engine === 'ai'}">進階 <span class="tag">AI</span></button></div>
        ${engine === 'standard'
          ? `<label class="fl">辨識語言<select id="ocLang">${LANGS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></label>
             <div class="note">Tesseract：體積小，適合英文與清晰的文件。第一次需下載引擎與語言資料。</div>`
          : `<label class="fl">模型<select id="ocVar">${VARIANTS.map(([v, n, key]) => `<option value="${v}">${n}（${PB.ai.sizeLabel(PB.ai.bundleSize(key))}）</option>`).join('')}</select></label>
             <div class="note">PaddleOCR PP-OCRv5：中文、混排、小字與傾斜文字更準，支援直排。首次使用約下載 21 MB，之後存在瀏覽器快取。韓文請使用「標準」。</div>`}
        <button class="btn primary" id="ocRun">🔎 開始辨識</button>
        <progress id="ocBar" max="1" hidden></progress>
        <button class="btn sm" id="ocCancel" hidden>取消下載</button>
        <div class="note" id="ocSt">在你的裝置上執行，圖片不會上傳。</div>
        <textarea id="ocOut" rows="8" placeholder="辨識結果會顯示在這裡，可直接修改"></textarea>
        <div id="ocActions" hidden>
          <label class="chk"><input type="checkbox" id="ocBoxes" ${showBoxes ? 'checked' : ''}> 在圖上顯示文字框</label>
          <div class="btns" style="margin-top:8px"><button class="btn" id="ocCopy">複製文字</button><button class="btn" id="ocTxt">下載 .txt</button></div>
        </div>`;
      $('ocEng').addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b || running) return;
        engine = b.dataset.e; PB.store.set('ocrEngine', engine); renderPanel();
      });
      if (engine === 'standard') {
        const saved = PB.store.get('ocrLang', 'chi_tra+eng');
        if (LANGS.some(l => l[0] === saved)) $('ocLang').value = saved;
        $('ocLang').addEventListener('change', e => PB.store.set('ocrLang', e.target.value));
      } else {
        const saved = PB.store.get('ocrVariant', 'multi');
        if (VARIANTS.some(l => l[0] === saved)) $('ocVar').value = saved;
        $('ocVar').addEventListener('change', e => PB.store.set('ocrVariant', e.target.value));
        refreshVariantLabels();
      }
      $('ocRun').onclick = run;
      $('ocCancel').onclick = () => PB.ai.abort();
      $('ocBoxes').addEventListener('change', e => { showBoxes = e.target.checked; drawBoxes(); });
      $('ocCopy').onclick = async () => {
        try { await navigator.clipboard.writeText($('ocOut').value); toast('已複製文字'); }
        catch { $('ocOut').select(); toast('請按 Ctrl+C 複製'); }
      };
      $('ocTxt').onclick = () => {
        const b = new Blob([$('ocOut').value], { type: 'text/plain;charset=utf-8' });
        PB.download(b, 'snapbooth-ocr.txt');
      };
    }
    return { enter: renderPanel };
  })();

  /* ======================================================================
     開啟 / 關閉 / 匯出
     ====================================================================== */
  function close() {
    leaveTool(false);
    toolName = '';
    root.hidden = true;
    document.body.classList.remove('no-scroll');
    onDone = null; hist = []; hi = -1; original = null;
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }
  let lastFocus = null;

  PB.openEditor = (canvas, done, startTool) => {
    lastFocus = document.activeElement;
    onDone = done;
    root.hidden = false;
    document.body.classList.add('no-scroll');
    zoom = 'fit';
    setSize(canvas.width, canvas.height);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(canvas, 0, 0);
    original = snap();
    hist = []; hi = -1;
    pushHist();
    leaveTool(false);
    toolName = '';
    enterTool(startTool && Tools[startTool] ? startTool : 'adjust');
    requestAnimationFrame(layout);
    $('edDone').focus({ preventScroll: true });
  };

  $('edCancel').onclick = () => {
    if (hi > 0 && !confirm('放棄所有未儲存的修改？')) return;
    close();
  };
  $('edDone').onclick = () => {
    leaveTool(true);
    const out = snap(), cb = onDone;
    close();
    if (cb) cb(out, 'replace');
  };
  $('edExport').onclick = () => {
    const n = toolName;
    leaveTool(true);
    enterTool(n);
    PB.openExport(work, 'edited', {
      onSaveCopy: () => { PB.addPhoto(snap()); toast('已另存為新照片'); }
    });
  };

  document.addEventListener('keydown', e => {
    if (root.hidden || document.querySelector('dialog[open]')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'textarea' || (tag === 'input' && (e.target.type === 'text'));
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !typing && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && !typing && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if (e.key === 'Escape' && !typing) { $('edCancel').click(); }
  });
})();
