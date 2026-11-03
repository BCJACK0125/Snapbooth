/*
 * inpaint.js — 純 JavaScript 的影像修補（魔術橡皮擦）與顏色去背
 * 不依賴任何函式庫，也不需要下載模型，全部在使用者的 CPU 上執行。
 *
 *  PB.inpaint(imageData, mask, opts)      以周圍像素填補遮罩區域（push-pull 金字塔 + 平滑 + 噪點補償）
 *  PB.removeColor(imageData, x, y, opts)  點選顏色後把相似色區域變透明（魔術棒去背）
 */
(() => {
  'use strict';
  const PB = (window.PB = window.PB || {});
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

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

  PB.inpaint = function inpaint(img, maskIn, opts = {}) {
    const w = img.width, h = img.height, d = img.data;
    const mask = dilate(maskIn, w, h, opts.grow == null ? 2 : opts.grow);

    // 收集洞的像素
    let n = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
    if (!n) return false;
    if (n > w * h * 0.7) throw new Error('標記範圍太大，請縮小要消除的區域');
    const holes = new Int32Array(n);
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0, k = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (mask[i]) {
          holes[k++] = i;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    // ---- push：建立「已知像素」的加權金字塔 ----
    const mk = (pw, ph) => ({ w: pw, h: ph, r: new Float32Array(pw * ph), g: new Float32Array(pw * ph), b: new Float32Array(pw * ph), a: new Float32Array(pw * ph) });
    const L0 = mk(w, h);
    for (let i = 0; i < w * h; i++) {
      if (!mask[i]) {
        const j = i * 4;
        L0.r[i] = d[j]; L0.g[i] = d[j + 1]; L0.b[i] = d[j + 2]; L0.a[i] = 1;
      }
    }
    const lv = [L0];
    for (;;) {
      const s = lv[lv.length - 1];
      if (s.w <= 1 && s.h <= 1) break;
      const P = mk((s.w + 1) >> 1, (s.h + 1) >> 1);
      for (let y = 0; y < s.h; y++) {
        for (let x = 0; x < s.w; x++) {
          const i = y * s.w + x, j = (y >> 1) * P.w + (x >> 1);
          P.r[j] += s.r[i]; P.g[j] += s.g[i]; P.b[j] += s.b[i]; P.a[j] += s.a[i];
        }
      }
      lv.push(P);
    }
    const top = lv[lv.length - 1];
    if (top.a[0] === 0) throw new Error('找不到可參考的周邊像素');

    // ---- pull：由粗到細，洞的像素由上一層雙線性內插取得 ----
    let up = new Float32Array([top.r[0] / top.a[0], top.g[0] / top.a[0], top.b[0] / top.a[0]]);
    for (let k = lv.length - 2; k >= 0; k--) {
      const c = lv[k], pu = lv[k + 1];
      const f = new Float32Array(c.w * c.h * 3);
      for (let y = 0; y < c.h; y++) {
        const fy = clamp((y + 0.5) / 2 - 0.5, 0, pu.h - 1);
        const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, pu.h - 1), ty = fy - y0;
        for (let x = 0; x < c.w; x++) {
          const i = y * c.w + x, o = i * 3;
          if (c.a[i] > 0) {
            f[o] = c.r[i] / c.a[i]; f[o + 1] = c.g[i] / c.a[i]; f[o + 2] = c.b[i] / c.a[i];
          } else {
            const fx = clamp((x + 0.5) / 2 - 0.5, 0, pu.w - 1);
            const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, pu.w - 1), tx = fx - x0;
            const a = (y0 * pu.w + x0) * 3, b = (y0 * pu.w + x1) * 3, cc = (y1 * pu.w + x0) * 3, dd = (y1 * pu.w + x1) * 3;
            for (let ch = 0; ch < 3; ch++) {
              const top_ = up[a + ch] * (1 - tx) + up[b + ch] * tx;
              const bot_ = up[cc + ch] * (1 - tx) + up[dd + ch] * tx;
              f[o + ch] = top_ * (1 - ty) + bot_ * ty;
            }
          }
        }
      }
      up = f;
    }
    const F = up; // 第 0 層：每像素 3 個 float

    // ---- 平滑：只在洞內做 Gauss-Seidel，讓與邊界銜接自然 ----
    const nl = new Int32Array(n), nr = new Int32Array(n), nu = new Int32Array(n), nd = new Int32Array(n);
    for (let k = 0; k < n; k++) {
      const i = holes[k], x = i % w, y = (i / w) | 0;
      nl[k] = x > 0 ? i - 1 : i;
      nr[k] = x < w - 1 ? i + 1 : i;
      nu[k] = y > 0 ? i - w : i;
      nd[k] = y < h - 1 ? i + w : i;
    }
    const iters = opts.iterations || 48;
    for (let it = 0; it < iters; it++) {
      for (let k = 0; k < n; k++) {
        const o = holes[k] * 3, l = nl[k] * 3, r = nr[k] * 3, u = nu[k] * 3, dn = nd[k] * 3;
        F[o] = (F[l] + F[r] + F[u] + F[dn]) * 0.25;
        F[o + 1] = (F[l + 1] + F[r + 1] + F[u + 1] + F[dn + 1]) * 0.25;
        F[o + 2] = (F[l + 2] + F[r + 2] + F[u + 2] + F[dn + 2]) * 0.25;
      }
    }

    // ---- 噪點補償：量測周邊的顆粒感，避免填補區看起來像塑膠 ----
    let sigma = 0;
    {
      const x0 = Math.max(1, minX - 12), x1 = Math.min(w - 2, maxX + 12);
      const y0 = Math.max(1, minY - 12), y1 = Math.min(h - 2, maxY + 12);
      let sum = 0, cnt = 0;
      const lum = i => 0.299 * F[i * 3] + 0.587 * F[i * 3 + 1] + 0.114 * F[i * 3 + 2];
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = y * w + x;
          if (mask[i] || mask[i - 1] || mask[i + 1] || mask[i - w] || mask[i + w]) continue;
          const res = lum(i) - (lum(i - 1) + lum(i + 1) + lum(i - w) + lum(i + w)) * 0.25;
          sum += res * res; cnt++;
        }
      }
      if (cnt > 50) sigma = clamp((Math.sqrt(sum / cnt) / 1.118) * 0.9, 0, 14);
    }

    // ---- 寫回 ----
    for (let k = 0; k < n; k++) {
      const i = holes[k], o = i * 3, j = i * 4;
      let g = 0;
      if (sigma > 0) {
        const u1 = Math.random() || 1e-9, u2 = Math.random();
        g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sigma;
      }
      d[j] = F[o] + g; d[j + 1] = F[o + 1] + g; d[j + 2] = F[o + 2] + g;
      d[j + 3] = 255;
    }
    return true;
  };

  function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    const win = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      let s = 0;
      const row = y * w;
      for (let x = -r; x <= r; x++) s += src[row + clamp(x, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = s / win;
        s += src[row + clamp(x + r + 1, 0, w - 1)] - src[row + clamp(x - r, 0, w - 1)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += tmp[clamp(y, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = s / win;
        s += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x];
      }
    }
    return out;
  }

  PB.removeColor = function removeColor(img, sx, sy, opts = {}) {
    const w = img.width, h = img.height, d = img.data;
    sx = clamp(sx | 0, 0, w - 1); sy = clamp(sy | 0, 0, h - 1);
    const si = (sy * w + sx) * 4;
    if (d[si + 3] === 0) return 0;
    const tr = d[si], tg = d[si + 1], tb = d[si + 2];
    const thr = Math.pow((opts.tol == null ? 30 : opts.tol) * 2.2, 2);
    const match = i => {
      const j = i * 4;
      if (d[j + 3] === 0) return false;
      const dr = d[j] - tr, dg = d[j + 1] - tg, db = d[j + 2] - tb;
      return dr * dr + dg * dg + db * db <= thr;
    };
    const mask = new Uint8Array(w * h);
    let n = 0;
    if (opts.contiguous === false) {
      for (let i = 0; i < w * h; i++) if (match(i)) { mask[i] = 1; n++; }
    } else {
      const stack = new Int32Array(w * h);
      let sp = 0;
      const start = sy * w + sx;
      mask[start] = 1; stack[sp++] = start; n = 1;
      while (sp) {
        const i = stack[--sp], x = i % w;
        if (x > 0 && !mask[i - 1] && match(i - 1)) { mask[i - 1] = 1; stack[sp++] = i - 1; n++; }
        if (x < w - 1 && !mask[i + 1] && match(i + 1)) { mask[i + 1] = 1; stack[sp++] = i + 1; n++; }
        if (i >= w && !mask[i - w] && match(i - w)) { mask[i - w] = 1; stack[sp++] = i - w; n++; }
        if (i < w * (h - 1) && !mask[i + w] && match(i + w)) { mask[i + w] = 1; stack[sp++] = i + w; n++; }
      }
    }
    if (!n) return 0;
    const feather = opts.feather | 0;
    if (feather > 0) {
      const f = new Float32Array(w * h);
      for (let i = 0; i < f.length; i++) f[i] = mask[i];
      const b = boxBlur(f, w, h, feather);
      for (let i = 0; i < b.length; i++) {
        if (b[i] > 0) d[i * 4 + 3] = Math.round(d[i * 4 + 3] * (1 - b[i]));
      }
    } else {
      for (let i = 0; i < mask.length; i++) if (mask[i]) d[i * 4 + 3] = 0;
    }
    return n;
  };
})();
