/*
 * ai.js — 進階 AI 功能（全部在使用者的瀏覽器執行，按需動態載入）
 *
 *   PB.ai.inpaint(canvas, mask, {model:'migan'|'lama'})   物件消除（MI-GAN / LaMa）
 *   PB.ai.segment(canvas, {model:'u2netp'|'birefnet'})    主體分割 / 去背（U²-Net-P / BiRefNet-lite）
 *   PB.ai.ocr(canvas, {variant:'multi'|'latin'})          PP-OCRv5 文字辨識（純 JS 管線）
 *
 * 設計重點
 *  - ONNX Runtime Web 與模型檔都是「使用者按下按鈕才下載」，並存入 Cache Storage，之後不再下載。
 *  - 優先 WebGPU，失敗自動退回 WASM；輸入/輸出張量名稱在執行時讀取，不寫死。
 *  - 對模型輸出做自我檢查（遮罩極性、數值範圍、fp16/fp32 型別），降低因模型版本差異而壞掉的風險。
 *  - 可用 PB.config.models / PB.config.ort 改成自行託管（見 README）。
 */
(() => {
  'use strict';
  const PB = (window.PB = window.PB || {});
  PB.config = PB.config || {};
  const cfg = PB.config;
  cfg.ort = Object.assign({ version: '1.22.0', base: '', forceWasm: false }, cfg.ort || {});
  cfg.models = cfg.models || {};

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0); return c; };
  const ctx2 = (c) => c.getContext('2d', { willReadFrequently: true });
  const tick = () => new Promise(r => setTimeout(r, 0));
  const MB = b => (b / 1e6 >= 10 ? Math.round(b / 1e6) : (b / 1e6).toFixed(1)) + ' MB'; // 與 Hugging Face 顯示一致（十進位）

  /* ====================================================================
     模型清單（大小與授權來自 Hugging Face 檔案清單）
     ==================================================================== */
  const HF = 'https://huggingface.co';
  const OCR = `${HF}/nakamura196/ppocrv5-mobile-web-onnx/resolve/main`;
  const MODELS = {
    migan:    { kind: 'inpaint', name: 'MI-GAN',            size: 28079181,  license: 'MIT',        url: `${HF}/edgetools/migan/resolve/main/migan_pipeline_v2.onnx` },
    lama:     { kind: 'inpaint', name: 'LaMa',              size: 208044816, license: 'Apache-2.0', url: `${HF}/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx` },
    u2netp:   { kind: 'segment', name: 'U²-Net-P',          size: 4574861,   license: 'Apache-2.0', url: `${HF}/BritishWerewolf/U-2-Netp/resolve/main/onnx/model.onnx`, input: 320, act: 'auto', minmax: true },
    birefnet: { kind: 'segment', name: 'BiRefNet-lite (fp16)', size: 114538221, license: 'MIT',     url: `${HF}/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model_fp16.onnx`, input: 1024, act: 'sigmoid', webgpuOnly: true },
    birefnet32: { kind: 'segment', name: 'BiRefNet-lite (fp32)', size: 224005088, license: 'MIT',   url: `${HF}/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model.onnx`, input: 1024, act: 'sigmoid' },
    ppocr_det:       { kind: 'ocr',  name: 'PP-OCRv5 偵測',        size: 4766440,  license: 'Apache-2.0', url: `${OCR}/PP-OCRv5_mobile_det.onnx`, webgpu: false },
    ppocr_rec:       { kind: 'ocr',  name: 'PP-OCRv5 辨識（通用）', size: 16537064, license: 'Apache-2.0', url: `${OCR}/PP-OCRv5_mobile_rec.onnx`, webgpu: false },
    ppocr_dict:      { kind: 'data', name: 'PP-OCRv5 字典（通用）', size: 110781,   license: 'Apache-2.0', url: `${OCR}/PP-OCRv5_mobile_rec.dict.json` },
    ppocr_rec_latin: { kind: 'ocr',  name: 'PP-OCRv5 辨識（拉丁）', size: 8044305,  license: 'Apache-2.0', url: `${OCR}/latin_PP-OCRv5_mobile_rec.onnx`, webgpu: false },
    ppocr_dict_latin:{ kind: 'data', name: 'PP-OCRv5 字典（拉丁）', size: 4291,     license: 'Apache-2.0', url: `${OCR}/latin_PP-OCRv5_mobile_rec.dict.json` }
  };
  const modelUrl = id => cfg.models[id] || MODELS[id].url;

  /* 給 UI 的「功能 → 需要哪些檔案」 */
  const BUNDLES = {
    migan: ['migan'], lama: ['lama'], u2netp: ['u2netp'],
    birefnet: ['birefnet'], birefnet32: ['birefnet32'],
    ocr_multi: ['ppocr_det', 'ppocr_rec', 'ppocr_dict'],
    ocr_latin: ['ppocr_det', 'ppocr_rec_latin', 'ppocr_dict_latin']
  };
  const bundleSize = key => BUNDLES[key].reduce((s, id) => s + MODELS[id].size, 0);

  /* ====================================================================
     Cache Storage + 下載（含進度、可取消）
     ==================================================================== */
  const CACHE = 'snapbooth-models-v1';
  const cacheOpen = async () => { try { return await caches.open(CACHE); } catch { return null; } };

  async function isCached(id) {
    const c = await cacheOpen();
    if (!c) return false;
    try { return !!(await c.match(modelUrl(id))); } catch { return false; }
  }
  async function bundleCached(key) {
    const r = await Promise.all(BUNDLES[key].map(isCached));
    return r.every(Boolean);
  }

  let ctrl = null;
  const abort = () => { if (ctrl) ctrl.abort(); };

  async function fetchModel(id, onProgress) {
    const m = MODELS[id], url = modelUrl(id);
    const cache = await cacheOpen();
    if (cache) {
      try {
        const hit = await cache.match(url);
        if (hit) { onProgress && onProgress({ stage: 'cache', id }); return await hit.arrayBuffer(); }
      } catch { /* 忽略快取錯誤，改走網路 */ }
    }
    ctrl = new AbortController();
    const signal = ctrl.signal;
    try {
      onProgress && onProgress({ stage: 'download', id, loaded: 0, total: m.size });
      let res;
      try { res = await fetch(url, { signal, mode: 'cors', credentials: 'omit' }); }
      catch (e) {
        if (e && e.name === 'AbortError') throw e;
        let host = ''; try { host = new URL(url, location.href).host; } catch {}
        throw new Error(`無法下載「${m.name}」，請檢查網路連線${host ? '（' + host + '）' : ''}`);
      }
      if (!res.ok) throw new Error(`下載「${m.name}」失敗（HTTP ${res.status}）`);
      const total = +res.headers.get('content-length') || m.size || 0;
      let buf;
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader(), chunks = [];
        let loaded = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value); loaded += value.length;
          onProgress && onProgress({ stage: 'download', id, loaded, total: Math.max(total, loaded) });
        }
        const all = new Uint8Array(loaded);
        let o = 0;
        for (const c of chunks) { all.set(c, o); o += c.length; }
        buf = all.buffer;
      } else buf = await res.arrayBuffer();
      if (cache) {
        try { await cache.put(url, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } })); }
        catch { /* 配額不足等情況：仍可使用，只是不快取 */ }
      }
      return buf;
    } finally { ctrl = null; }
  }

  async function removeFromCache(ids) {
    const c = await cacheOpen();
    if (!c) return;
    for (const id of ids) { try { await c.delete(modelUrl(id)); } catch {} }
  }

  /* ====================================================================
     ONNX Runtime Web（動態載入）
     ==================================================================== */
  let gpuP = null;
  const webgpuOK = () => (gpuP = gpuP || (async () => {
    try { if (cfg.ort.forceWasm || !navigator.gpu) return false; return !!(await navigator.gpu.requestAdapter()); }
    catch { return false; }
  })());

  function addScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = res;
      s.onerror = () => { s.remove(); rej(new Error('載入失敗：' + src)); };
      document.head.appendChild(s);
    });
  }
  let ortP = null;
  function loadOrt() {
    if (window.ort) return Promise.resolve(window.ort);
    if (ortP) return ortP;
    ortP = (async () => {
      const base = cfg.ort.base || `https://cdn.jsdelivr.net/npm/onnxruntime-web@${cfg.ort.version}/dist/`;
      const files = (await webgpuOK()) ? ['ort.webgpu.min.js', 'ort.min.js'] : ['ort.min.js'];
      let last;
      for (const f of files) {
        try {
          await addScript(base + f);
          if (window.ort) {
            try {
              window.ort.env.wasm.wasmPaths = base;
              window.ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
            } catch {}
            return window.ort;
          }
        } catch (e) { last = e; }
      }
      throw new Error('無法載入 ONNX Runtime（' + ((last && last.message) || '網路錯誤') + '）');
    })();
    ortP.catch(() => { ortP = null; });
    return ortP;
  }

  /* ====================================================================
     Session 管理（最多保留 3 個，其餘釋放）
     ==================================================================== */
  const sessions = new Map();
  const MAX_SESSIONS = 3;
  async function evict() {
    while (sessions.size > MAX_SESSIONS) {
      let oldest = null;
      for (const r of sessions.values()) if (!oldest || r.t < oldest.t) oldest = r;
      sessions.delete(oldest.id);
      try { await oldest.session.release(); } catch {}
    }
  }
  async function createSession(id, buf, ep) {
    const ort = await loadOrt();
    return ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: [ep], graphOptimizationLevel: 'all' });
  }
  async function getSession(id, onProgress) {
    const hit = sessions.get(id);
    if (hit) { hit.t = Date.now(); return hit; }
    const m = MODELS[id];
    const buf = await fetchModel(id, onProgress);
    onProgress && onProgress({ stage: 'init', id });
    await tick();
    const eps = (m.webgpu !== false && (await webgpuOK())) ? ['webgpu', 'wasm'] : ['wasm'];
    let session = null, ep = '', lastErr = null;
    for (const e of eps) {
      if (m.webgpuOnly && e !== 'webgpu') continue;
      try { session = await createSession(id, buf, e); ep = e; break; } catch (err) { lastErr = err; }
    }
    if (!session) throw new Error('模型初始化失敗：' + ((lastErr && lastErr.message) || '此裝置不支援'));
    const rec = { id, session, ep, t: Date.now() };
    sessions.set(id, rec);
    await evict();
    return rec;
  }
  /* 推論；WebGPU 執行失敗時自動改用 WASM 重試一次 */
  async function run(rec, feeds) {
    try { return await rec.session.run(feeds); }
    catch (e) {
      const m = MODELS[rec.id];
      if (rec.ep !== 'webgpu' || m.webgpuOnly || /float16|fp16/i.test(String(e && e.message))) throw e;
      try { await rec.session.release(); } catch {}
      sessions.delete(rec.id);
      const buf = await fetchModel(rec.id);
      rec.session = await createSession(rec.id, buf, 'wasm');
      rec.ep = 'wasm';
      sessions.set(rec.id, rec);
      return rec.session.run(feeds);
    }
  }
  function releaseAll() {
    for (const r of sessions.values()) { try { r.session.release(); } catch {} }
    sessions.clear();
  }

  /* ====================================================================
     張量與影像小工具
     ==================================================================== */
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  function f32toF16(arr) {
    const out = new Uint16Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      f32[0] = arr[i];
      const x = u32[0], sign = (x >>> 16) & 0x8000;
      let exp = ((x >>> 23) & 0xff) - 127 + 15, man = x & 0x7fffff, h;
      if (exp <= 0) h = exp < -10 ? sign : sign + (((man | 0x800000) >> (1 - exp)) + 0x1000 >> 13);
      else if (exp >= 31) h = sign | 0x7c00 | (man ? 0x200 : 0);
      else h = sign + (exp << 10) + ((man + 0x1000) >> 13);
      out[i] = h;
    }
    return out;
  }
  function f16toF32(u16) {
    const out = new Float32Array(u16.length);
    for (let i = 0; i < u16.length; i++) {
      const h = u16[i], s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
      out[i] = e === 0 ? s * 6.103515625e-5 * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * Math.pow(2, e - 15) * (1 + f / 1024);
    }
    return out;
  }
  /* 把輸出張量轉成 Float32Array（支援 float16 / uint8 / 其他） */
  function toF32(t) {
    const d = t.data;
    if (d instanceof Float32Array) return d;
    if (t.type === 'float16') return (typeof Float16Array !== 'undefined' && d instanceof Float16Array) ? Float32Array.from(d) : f16toF32(d);
    return Float32Array.from(d);
  }
  const tensor = (type, data, dims) => new window.ort.Tensor(type, data, dims);

  function drawFlat(src, sx, sy, sw, sh, dw, dh, bg = '#fff') {
    const c = mk(dw, dh), x = ctx2(c);
    x.fillStyle = bg; x.fillRect(0, 0, dw, dh);
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, sx, sy, sw, sh, 0, 0, dw, dh);
    return c;
  }
  /* RGBA → CHW float，可指定 BGR 順序與 mean/std（以 0..1 為基準） */
  function toCHW(data, n, mean, std, bgr) {
    const out = new Float32Array(3 * n);
    for (let c = 0; c < 3; c++) {
      const si = bgr ? 2 - c : c, m = mean[c], s = std[c], o = c * n;
      for (let p = 0; p < n; p++) out[o + p] = (data[p * 4 + si] / 255 - m) / s;
    }
    return out;
  }
  function dilate(mask, w, h, r) {
    let cur = mask;
    for (let k = 0; k < r; k++) {
      const nxt = new Uint8Array(cur);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (cur[i]) continue;
          if ((x > 0 && cur[i - 1]) || (x < w - 1 && cur[i + 1]) || (y > 0 && cur[i - w]) || (y < h - 1 && cur[i + w])) nxt[i] = 1;
        }
      }
      cur = nxt;
    }
    return cur;
  }
  function blur(src, w, h, r) {
    if (r < 1) return src;
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h), win = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w; let s = 0;
      for (let x = -r; x <= r; x++) s += src[row + clamp(x, 0, w - 1)];
      for (let x = 0; x < w; x++) { tmp[row + x] = s / win; s += src[row + clamp(x + r + 1, 0, w - 1)] - src[row + clamp(x - r, 0, w - 1)]; }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += tmp[clamp(y, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) { out[y * w + x] = s / win; s += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x]; }
    }
    return out;
  }
  const IMN_M = [0.485, 0.456, 0.406], IMN_S = [0.229, 0.224, 0.225];
  const find = (names, re, fb) => names.find(n => re.test(n)) || names[fb];

  /* ====================================================================
     物件消除：MI-GAN / LaMa
       1) 只取標記區域周圍的 ROI（LaMa 固定 512×512，MI-GAN 最長邊 ≤ 1024）
       2) 推論後只把「洞」貼回原圖並羽化邊緣 → 其餘像素與原圖完全相同
       3) 自我檢查：若模型保留的已知區域與輸入差異過大，嘗試反轉遮罩極性
     ==================================================================== */
  async function inpaint(src, maskIn, opt = {}) {
    const id = opt.model || 'migan', M = MODELS[id];
    if (!M || M.kind !== 'inpaint') throw new Error('未知的消除模型：' + id);
    const W = src.width, H = src.height, status = opt.onStatus || (() => {});

    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) if (maskIn[row + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return null;
    const grow = opt.grow != null ? opt.grow : Math.max(3, Math.round(Math.max(W, H) / 450));
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1, cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;

    // ROI
    let rw, rh;
    if (id === 'lama') { const side = Math.max(512, Math.ceil(Math.max(bw, bh) * 1.8)); rw = Math.min(W, side); rh = Math.min(H, side); }
    else { const m = Math.max(64, Math.round(Math.max(bw, bh) * 0.75)); rw = Math.min(W, bw + 2 * m); rh = Math.min(H, bh + 2 * m); }
    const rx = clamp(Math.round(cx - rw / 2), 0, W - rw), ry = clamp(Math.round(cy - rh / 2), 0, H - rh);

    // 模型輸入尺寸與（LaMa 的）置中放置位置
    let tw, th, dx = 0, dy = 0, sw, sh;
    if (id === 'lama') {
      tw = th = 512;
      const k = 512 / Math.max(rw, rh);
      sw = Math.max(1, Math.round(rw * k)); sh = Math.max(1, Math.round(rh * k));
      dx = (512 - sw) >> 1; dy = (512 - sh) >> 1;
    } else {
      const k = Math.min(1, 1024 / Math.max(rw, rh));
      tw = Math.max(64, Math.round((rw * k) / 8) * 8); th = Math.max(64, Math.round((rh * k) / 8) * 8);
      sw = tw; sh = th;
    }

    const roi = ctx2(src).getImageData(rx, ry, rw, rh);
    let rm = new Uint8Array(rw * rh);
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) rm[y * rw + x] = maskIn[(ry + y) * W + rx + x];
    rm = dilate(rm, rw, rh, grow);

    // 輸入影像
    const tc = mk(tw, th), tx = ctx2(tc);
    tx.fillStyle = '#fff'; tx.fillRect(0, 0, tw, th);
    tx.imageSmoothingQuality = 'high';
    if (id === 'lama' && (sw !== tw || sh !== th)) tx.drawImage(src, rx, ry, rw, rh, 0, 0, tw, th); // 邊緣補的是被拉伸的內容，比純色自然
    tx.drawImage(src, rx, ry, rw, rh, dx, dy, sw, sh);
    const tImg = tx.getImageData(0, 0, tw, th).data;

    // 輸入遮罩
    const mc = mk(rw, rh), mctx = ctx2(mc), mi = mctx.createImageData(rw, rh);
    for (let i = 0; i < rm.length; i++) { const v = rm[i] ? 255 : 0; mi.data[i * 4] = mi.data[i * 4 + 1] = mi.data[i * 4 + 2] = v; mi.data[i * 4 + 3] = 255; }
    mctx.putImageData(mi, 0, 0);
    const mtc = mk(tw, th), mtx = ctx2(mtc);
    mtx.fillStyle = '#000'; mtx.fillRect(0, 0, tw, th);
    mtx.imageSmoothingQuality = 'high';
    mtx.drawImage(mc, 0, 0, rw, rh, dx, dy, sw, sh);
    const md = mtx.getImageData(0, 0, tw, th).data, n = tw * th;
    const hole = new Uint8Array(n);
    for (let p = 0; p < n; p++) hole[p] = md[p * 4] > 96 ? 1 : 0;

    status('載入 AI 模型…');
    const rec = await getSession(id, opt.onProgress);
    const names = rec.session.inputNames, outName = rec.session.outputNames[0];
    const nImg = find(names, /img|image/i, 0), nMask = find(names, /mask/i, 1);

    async function once(flip) {
      let feeds;
      if (id === 'lama') {
        const img = new Float32Array(3 * n), msk = new Float32Array(n);
        for (let p = 0; p < n; p++) { img[p] = tImg[p * 4] / 255; img[n + p] = tImg[p * 4 + 1] / 255; img[2 * n + p] = tImg[p * 4 + 2] / 255; msk[p] = (hole[p] ^ flip) ? 1 : 0; }
        feeds = { [nImg]: tensor('float32', img, [1, 3, th, tw]), [nMask]: tensor('float32', msk, [1, 1, th, tw]) };
      } else {
        const img = new Uint8Array(3 * n), msk = new Uint8Array(n);
        for (let p = 0; p < n; p++) { img[p] = tImg[p * 4]; img[n + p] = tImg[p * 4 + 1]; img[2 * n + p] = tImg[p * 4 + 2]; msk[p] = (hole[p] ^ flip) ? 0 : 255; } // MI-GAN：0 = 要消除，255 = 保留
        feeds = { [nImg]: tensor('uint8', img, [1, 3, th, tw]), [nMask]: tensor('uint8', msk, [1, 1, th, tw]) };
      }
      status('AI 推論中…（' + (rec.ep === 'webgpu' ? 'WebGPU' : 'CPU') + '）');
      await tick();
      const res = await run(rec, feeds);
      const o = res[outName] || res[rec.session.outputNames[0]];
      let d = o.data;
      const rgba = new Uint8ClampedArray(n * 4);
      let scale = 1;
      if (!(d instanceof Uint8Array || d instanceof Uint8ClampedArray)) {
        d = toF32(o);
        let mx = 0;
        for (let i = 0; i < d.length; i += 97) if (d[i] > mx) mx = d[i];
        scale = mx <= 1.5 ? 255 : 1; // 有些匯出是 0..1，有些是 0..255
      }
      for (let p = 0; p < n; p++) { rgba[p * 4] = d[p] * scale; rgba[p * 4 + 1] = d[n + p] * scale; rgba[p * 4 + 2] = d[2 * n + p] * scale; rgba[p * 4 + 3] = 255; }
      // 已知區域應該與輸入幾乎相同
      let sum = 0, cnt = 0;
      for (let p = 0; p < n; p += 5) {
        const x = p % tw, y = (p / tw) | 0;
        if (hole[p] || x < dx || y < dy || x >= dx + sw || y >= dy + sh) continue;
        sum += Math.abs(rgba[p * 4] - tImg[p * 4]) + Math.abs(rgba[p * 4 + 1] - tImg[p * 4 + 1]) + Math.abs(rgba[p * 4 + 2] - tImg[p * 4 + 2]); cnt += 3;
      }
      return { rgba, diff: cnt ? sum / cnt : 0 };
    }

    let best = await once(0);
    if (best.diff > 18) {
      const alt = await once(1);
      if (alt.diff < best.diff) best = alt;
    }

    // 貼回：只替換洞，邊緣羽化
    const oc = mk(tw, th);
    oc.getContext('2d').putImageData(new ImageData(best.rgba, tw, th), 0, 0);
    const rc = mk(rw, rh), rctx = ctx2(rc);
    rctx.imageSmoothingQuality = 'high';
    rctx.drawImage(oc, dx, dy, sw, sh, 0, 0, rw, rh);
    const outRoi = rctx.getImageData(0, 0, rw, rh).data;
    const fm = new Float32Array(rw * rh);
    for (let i = 0; i < fm.length; i++) fm[i] = rm[i];
    const bl = blur(fm, rw, rh, Math.max(1, Math.round(grow / 2)));
    const o = roi.data;
    for (let i = 0; i < rw * rh; i++) {
      const a = rm[i] ? 1 : bl[i];
      if (a <= 0.003) continue;
      const j = i * 4;
      o[j] = o[j] * (1 - a) + outRoi[j] * a;
      o[j + 1] = o[j + 1] * (1 - a) + outRoi[j + 1] * a;
      o[j + 2] = o[j + 2] * (1 - a) + outRoi[j + 2] * a;
      if (rm[i]) o[j + 3] = 255;
    }
    return { x: rx, y: ry, w: rw, h: rh, data: roi, model: id, ep: rec.ep, knownDiff: best.diff };
  }

  /* ====================================================================
     主體分割 / 去背：U²-Net-P、BiRefNet-lite
     回傳與原圖同尺寸的 alpha（Float32Array, 0..1）
     ==================================================================== */
  async function segment(src, opt = {}) {
    let id = opt.model || 'u2netp';
    if (id === 'birefnet' && !(await webgpuOK())) id = 'birefnet32'; // fp16 版只能在 WebGPU 執行
    const M = MODELS[id];
    if (!M || M.kind !== 'segment') throw new Error('未知的分割模型：' + id);
    const status = opt.onStatus || (() => {});
    const W = src.width, H = src.height, S = M.input;

    status('載入 AI 模型…');
    const rec = await getSession(id, opt.onProgress);
    const small = drawFlat(src, 0, 0, W, H, S, S);
    const input = toCHW(ctx2(small).getImageData(0, 0, S, S).data, S * S, IMN_M, IMN_S, false);
    const inName = rec.session.inputNames[0], dims = [1, 3, S, S];

    status('AI 推論中…（' + (rec.ep === 'webgpu' ? 'WebGPU' : 'CPU') + '）');
    await tick();
    let out;
    try { out = await run(rec, { [inName]: tensor('float32', input, dims) }); }
    catch (e) {
      if (!/float16|fp16/i.test(String(e && e.message))) throw e;
      out = await run(rec, { [inName]: tensor('float16', f32toF16(input), dims) }); // 模型輸入是 fp16 時自動改送 fp16
    }
    let t = null;
    for (const name of rec.session.outputNames) {
      const c = out[name];
      if (c && c.data && c.data.length >= S * S && (!t || c.data.length === S * S)) { t = c; if (c.data.length === S * S) break; }
    }
    if (!t) throw new Error('模型輸出格式不符');
    const isU8 = t.data instanceof Uint8Array || t.data instanceof Uint8ClampedArray;
    const raw = isU8 ? t.data : toF32(t);
    const P = new Float32Array(S * S), off = raw.length - S * S;
    if (isU8) for (let i = 0; i < P.length; i++) P[i] = raw[off + i] / 255;
    else {
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < P.length; i++) { const v = raw[off + i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      const sig = M.act === 'sigmoid' || (M.act === 'auto' && !(mn >= -0.001 && mx <= 1.001));
      for (let i = 0; i < P.length; i++) { const v = raw[off + i]; P[i] = sig ? 1 / (1 + Math.exp(-v)) : v; }
    }
    if (M.minmax) {
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < P.length; i++) { if (P[i] < mn) mn = P[i]; if (P[i] > mx) mx = P[i]; }
      if (mx - mn > 1e-6) for (let i = 0; i < P.length; i++) P[i] = (P[i] - mn) / (mx - mn);
    }
    // 放大回原尺寸（雙線性）
    const mc = mk(S, S), mx2 = ctx2(mc), mi = mx2.createImageData(S, S);
    for (let i = 0; i < S * S; i++) { const v = clamp(Math.round(P[i] * 255), 0, 255); mi.data[i * 4] = mi.data[i * 4 + 1] = mi.data[i * 4 + 2] = v; mi.data[i * 4 + 3] = 255; }
    mx2.putImageData(mi, 0, 0);
    const big = drawFlat(mc, 0, 0, S, S, W, H, '#000');
    const bd = ctx2(big).getImageData(0, 0, W, H).data;
    const alpha = new Float32Array(W * H);
    for (let i = 0; i < alpha.length; i++) {
      const a = bd[i * 4] / 255;
      const u = clamp((a - 0.06) / 0.88, 0, 1);      // 去除低信心雜訊、讓主體更實
      alpha[i] = u * u * (3 - 2 * u);
    }
    return { alpha, model: id, ep: rec.ep };
  }

  /* ====================================================================
     PP-OCRv5：偵測（DB）→ 旋轉文字框裁切 → 辨識（CTC）
     純 JS 後處理，不依賴 OpenCV
     ==================================================================== */
  function convexHull(pts) {
    pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts;
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    lo.pop(); up.pop();
    return lo.concat(up);
  }
  /* 最小面積外接矩形：回傳中心、兩軸單位向量與半長 */
  function minAreaRect(hull) {
    let best = null;
    const n = hull.length;
    for (let i = 0; i < n; i++) {
      const a = hull[i], b = hull[(i + 1) % n];
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const l = Math.hypot(dx, dy);
      if (l < 1e-9) continue;
      dx /= l; dy /= l;
      const nx = -dy, ny = dx;
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const p of hull) {
        const u = p[0] * dx + p[1] * dy, v = p[0] * nx + p[1] * ny;
        if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
      const area = (u1 - u0) * (v1 - v0);
      if (!best || area < best.area) {
        const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
        best = { area, cx: uc * dx + vc * nx, cy: uc * dy + vc * ny, e1: [dx, dy], e2: [nx, ny], h1: (u1 - u0) / 2, h2: (v1 - v0) / 2 };
      }
    }
    return best;
  }
  function bboxRect(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, e1: [1, 0], e2: [0, 1], h1: (x1 - x0) / 2 + 0.5, h2: (y1 - y0) / 2 + 0.5 };
  }
  function orderQuad(q) {
    const s = q.slice().sort((a, b) => a[0] - b[0]);
    const l = s.slice(0, 2).sort((a, b) => a[1] - b[1]), r = s.slice(2).sort((a, b) => a[1] - b[1]);
    return [l[0], r[0], r[1], l[1]]; // tl, tr, br, bl
  }

  /* DB 後處理：二值化 → 連通區塊 → 最小外接矩形 → unclip */
  function dbBoxes(prob, mw, mh, o = {}) {
    const thresh = o.thresh || 0.3, boxThresh = o.boxThresh || 0.6, unclip = o.unclip || 1.5;
    const bin = new Uint8Array(mw * mh);
    for (let i = 0; i < bin.length; i++) bin[i] = prob[i] > thresh ? 1 : 0;
    const seen = new Uint8Array(mw * mh), stack = new Int32Array(mw * mh), boxes = [];
    for (let s = 0; s < bin.length; s++) {
      if (!bin[s] || seen[s]) continue;
      let sp = 0, cnt = 0, sum = 0;
      const pts = [];
      stack[sp++] = s; seen[s] = 1;
      while (sp) {
        const i = stack[--sp], x = i % mw, y = (i / mw) | 0;
        cnt++; sum += prob[i];
        if (x === 0 || y === 0 || x === mw - 1 || y === mh - 1 || !bin[i - 1] || !bin[i + 1] || !bin[i - mw] || !bin[i + mw]) pts.push([x, y]);
        for (let yy = y - 1; yy <= y + 1; yy++) {
          if (yy < 0 || yy >= mh) continue;
          for (let xx = x - 1; xx <= x + 1; xx++) {
            if (xx < 0 || xx >= mw) continue;
            const j = yy * mw + xx;
            if (bin[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j; }
          }
        }
      }
      if (cnt < 8 || sum / cnt < boxThresh) continue;
      let P = pts;
      if (P.length > 3000) { const st = Math.ceil(P.length / 3000); P = P.filter((_, k) => k % st === 0); }
      const hull = convexHull(P);
      const r = hull.length >= 3 ? minAreaRect(hull) : bboxRect(P);
      if (!r) continue;
      const w = 2 * r.h1, h = 2 * r.h2;
      if (Math.min(w, h) < 3) continue;
      const d = (w * h * unclip) / (2 * (w + h));
      const a = r.h1 + d, b = r.h2 + d;
      if (Math.min(2 * a, 2 * b) < 5) continue;
      const q = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => [
        r.cx + sx * a * r.e1[0] + sy * b * r.e2[0],
        r.cy + sx * a * r.e1[1] + sy * b * r.e2[1]
      ]);
      boxes.push({ quad: q, score: sum / cnt });
    }
    return boxes;
  }

  function cropQuad(src, q) {
    const [tl, tr, br, bl] = q;
    const cw = Math.max(1, Math.round(Math.max(Math.hypot(tr[0] - tl[0], tr[1] - tl[1]), Math.hypot(br[0] - bl[0], br[1] - bl[1]))));
    const ch = Math.max(1, Math.round(Math.max(Math.hypot(bl[0] - tl[0], bl[1] - tl[1]), Math.hypot(br[0] - tr[0], br[1] - tr[1]))));
    const c = mk(cw, ch), x = ctx2(c);
    x.fillStyle = '#fff'; x.fillRect(0, 0, cw, ch);
    // 裁切座標 → 原圖座標：p = tl + u*s + v*t；畫布需要反矩陣
    const a = (tr[0] - tl[0]) / cw, b = (tr[1] - tl[1]) / cw, cc = (bl[0] - tl[0]) / ch, d = (bl[1] - tl[1]) / ch;
    const det = a * d - b * cc;
    if (Math.abs(det) < 1e-9) return c;
    const ia = d / det, ic = -cc / det, ib = -b / det, id = a / det;
    x.imageSmoothingQuality = 'high';
    x.setTransform(ia, ib, ic, id, -(ia * tl[0] + ic * tl[1]), -(ib * tl[0] + id * tl[1]));
    x.drawImage(src, 0, 0);
    x.setTransform(1, 0, 0, 1, 0, 0);
    if (ch / cw >= 1.5) { // 直排文字：逆時針轉 90°
      const r = mk(ch, cw), rx = ctx2(r);
      rx.translate(0, cw); rx.rotate(-Math.PI / 2); rx.drawImage(c, 0, 0);
      return r;
    }
    return c;
  }

  function ctcDecode(logits, T, C, dict) {
    let text = '', prev = 0, sum = 0, n = 0;
    for (let t = 0; t < T; t++) {
      let bi = 0, bv = -Infinity;
      const o = t * C;
      for (let c = 0; c < C; c++) { const v = logits[o + c]; if (v > bv) { bv = v; bi = c; } }
      if (bi !== 0 && bi !== prev) {
        text += bi - 1 < dict.length ? dict[bi - 1] : ' ';
        sum += bv; n++;
      }
      prev = bi;
    }
    return { text, score: n ? sum / n : 0 };
  }

  async function loadDict(id, onProgress) {
    const buf = await fetchModel(id, onProgress);
    const arr = JSON.parse(new TextDecoder('utf-8').decode(buf));
    if (!Array.isArray(arr)) throw new Error('字典格式不符');
    return arr;
  }

  async function ocr(src, opt = {}) {
    const variant = opt.variant === 'latin' ? 'latin' : 'multi';
    const recId = variant === 'latin' ? 'ppocr_rec_latin' : 'ppocr_rec';
    const dictId = variant === 'latin' ? 'ppocr_dict_latin' : 'ppocr_dict';
    const status = opt.onStatus || (() => {});
    const W = src.width, H = src.height;

    status('載入偵測模型…');
    const det = await getSession('ppocr_det', opt.onProgress);
    status('載入辨識模型…');
    const rec = await getSession(recId, opt.onProgress);
    const dict = await loadDict(dictId, opt.onProgress);

    // ---- 偵測 ----
    const maxSide = cfg.ocrMaxSide || 1536;
    let k = Math.max(W, H) > maxSide ? maxSide / Math.max(W, H) : 1;
    if (Math.min(W, H) * k < 64) k = 64 / Math.min(W, H);
    const mw = Math.max(32, Math.round((W * k) / 32) * 32), mh = Math.max(32, Math.round((H * k) / 32) * 32);
    const dc = drawFlat(src, 0, 0, W, H, mw, mh);
    // PaddleOCR 以 BGR 順序套用 ImageNet 的 mean/std
    const input = toCHW(ctx2(dc).getImageData(0, 0, mw, mh).data, mw * mh, IMN_M, IMN_S, true);
    status('偵測文字區域…');
    await tick();
    const dout = await run(det, { [det.session.inputNames[0]]: tensor('float32', input, [1, 3, mh, mw]) });
    const dt = dout[det.session.outputNames[0]], dd = toF32(dt);
    if (dd.length < mw * mh) throw new Error('偵測模型輸出尺寸不符');
    const prob = dd.length === mw * mh ? dd : dd.subarray(dd.length - mw * mh);
    const sx = W / mw, sy = H / mh;
    let boxes = dbBoxes(prob, mw, mh, opt).map(b => ({
      quad: orderQuad(b.quad.map(p => [p[0] * sx, p[1] * sy])), score: b.score
    }));
    if (!boxes.length) return { text: '', lines: [] };

    // 閱讀順序：先依垂直位置分行，同一行由左到右
    for (const b of boxes) {
      const q = b.quad;
      b.cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4; b.cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
      b.h = Math.min(Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]), Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]));
    }
    boxes.sort((a, b) => a.cy - b.cy);
    const rows = [];
    for (const b of boxes) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(b.cy - row.cy) <= 0.5 * Math.max(row.h, b.h)) { row.items.push(b); row.cy = (row.cy * (row.items.length - 1) + b.cy) / row.items.length; row.h = Math.max(row.h, b.h); }
      else rows.push({ cy: b.cy, h: b.h, items: [b] });
    }
    const ordered = [];
    rows.forEach((r, ri) => {
      r.items.sort((a, b) => a.cx - b.cx);
      for (const b of r.items) { b.rowIndex = ri; ordered.push(b); }
    });

    // ---- 辨識 ----
    const lines = [], recIn = rec.session.inputNames[0];
    for (let i = 0; i < ordered.length; i++) {
      status(`辨識文字 ${i + 1} / ${ordered.length}`);
      if (i % 3 === 2) await tick();
      const b = ordered[i];
      const crop = cropQuad(src, b.quad);
      const ratio = crop.width / crop.height;
      const rw = Math.min(3200, Math.max(8, Math.ceil(48 * ratio))), iw = Math.max(320, rw);
      const rc = mk(iw, 48), rx = ctx2(rc);
      rx.fillStyle = 'rgb(128,128,128)'; rx.fillRect(0, 0, iw, 48);
      rx.imageSmoothingQuality = 'high';
      rx.drawImage(crop, 0, 0, crop.width, crop.height, 0, 0, rw, 48);
      const rin = toCHW(rx.getImageData(0, 0, iw, 48).data, iw * 48, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], true);
      const rout = await run(rec, { [recIn]: tensor('float32', rin, [1, 3, 48, iw]) });
      const ro = rout[rec.session.outputNames[0]], rd = toF32(ro);
      const T = ro.dims[ro.dims.length - 2], C = ro.dims[ro.dims.length - 1];
      const r = ctcDecode(rd, T, C, dict);
      if (r.text.trim() && r.score >= 0.3) lines.push({ poly: b.quad, text: r.text, score: r.score, row: b.rowIndex });
    }
    // 同一行的片段以空白相接
    const out = [];
    for (const l of lines) {
      if (out.length && out[out.length - 1].row === l.row) out[out.length - 1].text += ' ' + l.text;
      else out.push({ row: l.row, text: l.text });
    }
    return { text: out.map(o => o.text).join('\n'), lines: lines.map(l => ({ poly: l.poly, text: l.text, score: l.score })), ep: rec.ep };
  }

  /* ====================================================================
     模型管理對話框
     ==================================================================== */
  const ROWS = [
    ['消除・標準', 'MI-GAN', ['migan']],
    ['消除・高品質', 'LaMa', ['lama']],
    ['去背・快速', 'U²-Net-P', ['u2netp']],
    ['去背・高品質（WebGPU）', 'BiRefNet-lite fp16', ['birefnet']],
    ['去背・高品質（CPU）', 'BiRefNet-lite fp32', ['birefnet32']],
    ['文字辨識・通用', 'PP-OCRv5 偵測＋辨識', ['ppocr_det', 'ppocr_rec', 'ppocr_dict']],
    ['文字辨識・拉丁語系', 'PP-OCRv5 拉丁辨識', ['ppocr_rec_latin', 'ppocr_dict_latin']]
  ];
  async function renderManager() {
    const box = document.getElementById('mmList');
    if (!box) return;
    box.innerHTML = '';
    let total = 0;
    for (const [title, sub, ids] of ROWS) {
      const cached = (await Promise.all(ids.map(isCached))).every(Boolean);
      const size = ids.reduce((s, i) => s + MODELS[i].size, 0);
      if (cached) total += size;
      const row = document.createElement('div');
      row.className = 'mm-row';
      row.innerHTML = '<div><b></b><small></small></div><span class="mm-st"></span><button type="button" class="btn sm danger" hidden>刪除</button>';
      row.querySelector('b').textContent = title;
      row.querySelector('small').textContent = `${sub} · ${MB(size)}`;
      row.querySelector('.mm-st').textContent = cached ? '已下載' : '未下載';
      const btn = row.querySelector('button');
      btn.hidden = !cached;
      btn.onclick = async () => {
        await removeFromCache(ids);
        for (const i of ids) { const r = sessions.get(i); if (r) { try { r.session.release(); } catch {} sessions.delete(i); } }
        renderManager();
      };
      box.appendChild(row);
    }
    const t = document.getElementById('mmTotal');
    if (t) {
      let extra = '';
      try { const e = await navigator.storage.estimate(); if (e && e.usage > 1e6) extra = ` · 本站已使用儲存空間 ${MB(e.usage)}`; } catch {}
      t.textContent = `已下載的 AI 模型共 ${MB(total)}${extra}`;
    }
  }
  function openManager() {
    const dlg = document.getElementById('modelDlg');
    if (!dlg) return;
    renderManager();
    if (!dlg.open) dlg.showModal();
  }
  async function clearAll() {
    releaseAll();
    try { await caches.delete(CACHE); } catch {}
    renderManager();
  }
  document.addEventListener('DOMContentLoaded', () => {
    const open = document.getElementById('manageModels');
    if (open) open.addEventListener('click', openManager);
    const clr = document.getElementById('mmClear');
    if (clr) clr.addEventListener('click', () => { if (confirm('要刪除所有已下載的 AI 模型嗎？之後使用時會重新下載。')) clearAll(); });
  });

  /* ====================================================================
     對外介面
     ==================================================================== */
  PB.ai = {
    models: MODELS, bundles: BUNDLES, bundleSize, bundleCached, isCached, sizeLabel: MB,
    webgpu: webgpuOK, abort, clearAll, openManager,
    inpaint, segment, ocr,
    dilateMask: dilate,
    _t: { dbBoxes, ctcDecode, minAreaRect, convexHull, f32toF16, f16toF32, cropQuad, orderQuad }
  };
})();
