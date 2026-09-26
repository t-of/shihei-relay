'use strict';

// カメラで記番号を読む（仕様「8. カメラで記番号を読む」）。
// Tesseract.js は自分のオリジン（vendor/tesseract/）に同梱し、カメラのボタンを初めて押したときだけ読む。
// 写真はどこにも送らない・保存しない。<video> の映像を <canvas> に一瞬写して読むだけで、
// 読み終わったら canvas は使い回す（新しい画像で上書きされる）。

import { extractSerialCandidate, parseSerial } from './bill.js';

const VENDOR = './vendor/tesseract'; // corePath・langPath は末尾に / を付けない（tesseract.js の作法）
const WHITELIST = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789'; // I・O を除く

let worker = null;
let loadingPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`読み込めません: ${src}`));
    document.head.appendChild(s);
  });
}

/** 部品のおよその大きさ（README・確認ダイアログの表示に使う） */
export const ASSET_SIZE_MB = 6; // tesseract.min.js + worker.min.js + core(simd-lstm) + eng.traineddata.gz の目安

/**
 * Tesseract のワーカーを用意する（初回だけ）。進み具合を 0〜1 で onProgress に渡す。
 */
export async function ensureWorker(onProgress) {
  if (worker) return worker;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    if (!window.Tesseract) {
      onProgress?.(0);
      await loadScript(`${VENDOR}/tesseract.min.js`);
    }
    const w = await window.Tesseract.createWorker('eng', 1, {
      workerPath: `${VENDOR}/worker.min.js`,
      workerBlobURL: false, // blob: のワーカーは CSP（worker-src 'self'）で止まり、準備中のまま進まなくなる
      corePath: VENDOR, // getCore.js がここから simd/relaxedsimd/非 simd の lstm 版を選ぶ
      langPath: VENDOR,
      cacheMethod: 'none', // 画像・言語データを IndexedDB に残さない（README・プライバシー方針どおり）
      gzip: true,
      logger: (m) => {
        if (m.status && typeof m.progress === 'number') onProgress?.(m.progress);
      },
    });
    await w.setParameters({
      tessedit_char_whitelist: WHITELIST,
      tessedit_pageseg_mode: '7', // PSM.SINGLE_LINE
    });
    worker = w;
    return w;
  })();
  return loadingPromise;
}

export function isWorkerReady() { return !!worker; }

/**
 * 枠の中の映像を切り抜いて、白黒・明るさの差を強めた画像にする。
 * @param {HTMLVideoElement} video
 * @param {{x:number,y:number,w:number,h:number}} box 映像内の枠（px）
 * @param {HTMLCanvasElement} outCanvas 作業用（使い回してよい）
 */
export function cropAndBinarize(video, box, outCanvas) {
  const SCALE = 2; // 2 倍に広げて小さい字を読みやすくする
  outCanvas.width = Math.round(box.w * SCALE);
  outCanvas.height = Math.round(box.h * SCALE);
  const ctx = outCanvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(video, box.x, box.y, box.w, box.h, 0, 0, outCanvas.width, outCanvas.height);

  const img = ctx.getImageData(0, 0, outCanvas.width, outCanvas.height);
  const d = img.data;
  // 明るさのヒストグラムから大津の2値化に近いしきい値を出す（お札は背景と字のコントラストが強い）
  const hist = new Array(256).fill(0);
  const gray = new Uint8ClampedArray(d.length / 4);
  for (let i = 0; i < gray.length; i++) {
    const g = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
    gray[i] = g;
    hist[g]++;
  }
  const threshold = otsuThreshold(hist, gray.length);
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i] > threshold ? 255 : 0;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return outCanvas;
}

/**
 * 2 値画像の黒い塊のうち、字の高さ・並びがそろったものだけを選ぶ（DOM に触れない。tools/test.mjs で確かめる）。
 * お札の地模様のかけらや枠の端で切れた模様を Tesseract が字と取り違え、きれいな画像でも空や
 * でたらめな結果になっていたため、字でない塊を消してから読ませる。
 * @param {Uint8Array} black 1 = 黒（W×H）
 * @returns {{ keep: (i:number) => boolean, box: {x0:number,y0:number,x1:number,y1:number}, charH: number } | null}
 */
export function pickChars(black, W, H) {
  const lab = new Int32Array(W * H);
  const comps = [];
  const stack = [];
  for (let i = 0; i < W * H; i++) {
    if (!black[i] || lab[i]) continue;
    const id = comps.length + 1;
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    lab[i] = id; stack.push(i);
    while (stack.length) {
      const p = stack.pop(), x = p % W, y = (p - x) / W;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && black[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack.push(p - 1); }
      if (x < W - 1 && black[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && black[p - W] && !lab[p - W]) { lab[p - W] = id; stack.push(p - W); }
      if (y < H - 1 && black[p + W] && !lab[p + W]) { lab[p + W] = id; stack.push(p + W); }
    }
    comps.push({ id, x0, y0, x1, y1, h: y1 - y0 + 1, w: x1 - x0 + 1 });
  }
  // 字の候補: 枠の上下に触れず、高さが枠の 2〜9 割、横に長すぎない
  const cand = comps.filter((c) => c.h > H * 0.2 && c.h < H * 0.9 && c.w < c.h * 1.2 && c.y0 > 0 && c.y1 < H - 1);
  if (cand.length < 6) return null;
  const median = (a) => a.sort((p, q) => p - q)[a.length >> 1];
  const charH = median(cand.map((c) => c.h));
  const midY = median(cand.map((c) => (c.y0 + c.y1) / 2));
  const kept = cand.filter((c) => Math.abs(c.h - charH) < charH * 0.25 && Math.abs((c.y0 + c.y1) / 2 - midY) < charH * 0.3);
  if (kept.length < 6) return null; // 記番号は 8〜10 文字。少なすぎたら字が枠に入っていない
  const ids = new Set(kept.map((c) => c.id));
  const box = {
    x0: Math.min(...kept.map((c) => c.x0)), y0: Math.min(...kept.map((c) => c.y0)),
    x1: Math.max(...kept.map((c) => c.x1)), y1: Math.max(...kept.map((c) => c.y1)),
  };
  return { keep: (i) => ids.has(lab[i]), box, charH };
}

const CHAR_H = 48;
/**
 * pickChars で選んだ字だけを白地に描き直し、字の高さを CHAR_H px にそろえて outCanvas に入れる。
 * Tesseract は字が大きすぎても読めない（映像の 2 倍だと空が返った）。字が見つからなければ false。
 */
export function cleanForOcr(srcCanvas, outCanvas) {
  const W = srcCanvas.width, H = srcCanvas.height;
  const d = srcCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const black = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) black[i] = d[i * 4] < 128 ? 1 : 0;
  const found = pickChars(black, W, H);
  if (!found) return false;
  const { keep, box, charH } = found;
  const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
  const tmp = document.createElement('canvas');
  tmp.width = bw; tmp.height = bh;
  const tctx = tmp.getContext('2d');
  const img = tctx.createImageData(bw, bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const o = (y * bw + x) * 4;
      const v = keep((y + box.y0) * W + x + box.x0) ? 0 : 255;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255;
    }
  }
  tctx.putImageData(img, 0, 0);
  const s = CHAR_H / charH, pad = 20;
  outCanvas.width = Math.round(bw * s) + pad * 2;
  outCanvas.height = Math.round(bh * s) + pad * 2;
  const ctx = outCanvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, outCanvas.width, outCanvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tmp, pad, pad, outCanvas.width - pad * 2, outCanvas.height - pad * 2);
  return true;
}

function otsuThreshold(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > bestVar) { bestVar = v; best = t; }
  }
  return best;
}

/**
 * 自動で読み続けるループ。形に合う同じ結果が 2 回続いたら止めて確定する。
 * @returns {{ stop: () => void }}
 */
export function startScanLoop({ video, canvas, frame, denom, typeId = null, onProgress, onMatch, onTick, onTimeout }) {
  const getDenom = () => (typeof denom === 'function' ? denom() : denom);
  const getTypeId = () => (typeof typeId === 'function' ? typeId() : typeId);
  let stopped = false;
  let lastKey = null;
  let streak = 0;
  let bestPartial = null;
  const startedAt = Date.now();
  const work = document.createElement('canvas'); // 切り抜いて白黒にした画像。canvas には字だけにしたものを出す

  async function tick() {
    if (stopped) return;
    if (video.readyState < 2 || video.videoWidth === 0) { schedule(); return; }

    const box = frameBoxInVideo(video, frame);
    cropAndBinarize(video, box, work);
    // 字が見つからない間は読まない（地模様をでたらめな文字に読んで、表示がちらつくのを防ぐ）
    if (!cleanForOcr(work, canvas)) { onTick?.(''); timedOut() || schedule(); return; }

    try {
      const w = await ensureWorker(onProgress);
      const { data } = await w.recognize(canvas);
      const text = (data?.text || '').trim();
      onTick?.(text);
      const rawCand = extractSerialCandidate(text);
      // extractSerialCandidate は末尾 2 文字の候補を先に返す。denom・typeId の形に合わなければ、
      // 末尾を 1 文字に切り詰めてもう一度確かめる（昔のお札と E 号券の両方で効く。仕様「19-4」）。
      let cand = rawCand;
      let serial = rawCand ? `${rawCand.prefix}${rawCand.digits}${rawCand.suffix}` : null;
      let ok = rawCand ? parseSerial(serial, getDenom(), getTypeId()).ok : false;
      if (rawCand && !ok && rawCand.suffix.length === 2) {
        const trimmed = { ...rawCand, suffix: rawCand.suffix.slice(-1) };
        const altSerial = `${trimmed.prefix}${trimmed.digits}${trimmed.suffix}`;
        if (parseSerial(altSerial, getDenom(), getTypeId()).ok) { cand = trimmed; serial = altSerial; ok = true; }
      }
      if (cand) {
        bestPartial = bestPartial || serial;
        if (ok) {
          if (serial === lastKey) {
            streak++;
            if (streak >= 2) { onMatch(serial, cand); return; }
          } else {
            lastKey = serial; streak = 1;
          }
        } else { lastKey = null; streak = 0; }
      } else { lastKey = null; streak = 0; }
    } catch (e) {
      console.error('recognize failed', e);
    }

    timedOut() || schedule();
  }

  function timedOut() {
    if (Date.now() - startedAt <= 20000) return false;
    onTimeout?.(bestPartial);
    return true;
  }

  function schedule() { if (!stopped) setTimeout(tick, 500); }
  schedule();

  return { stop: () => { stopped = true; } };
}

/**
 * 画面の枠（frame 要素）が、映像のどこに当たるかを求める。
 * 映像は object-fit: cover で画面いっぱいに広げているので、映像と画面の縦横比が違うと端が切れる。
 * 映像の割合で決め打ちすると、枠と違う場所を読んでしまう（iPhone で読めなかった原因）。
 */
export function frameBoxInVideo(video, frame) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!frame) return { x: vw * 0.08, y: vh * 0.42, w: vw * 0.84, h: vh * 0.16 };
  const v = video.getBoundingClientRect();
  const f = frame.getBoundingClientRect();
  const scale = Math.max(v.width / vw, v.height / vh);
  const offX = (v.width - vw * scale) / 2;
  const offY = (v.height - vh * scale) / 2;
  const x = Math.max(0, (f.left - v.left - offX) / scale);
  const y = Math.max(0, (f.top - v.top - offY) / scale);
  const w = Math.min(vw - x, f.width / scale);
  const h = Math.min(vh - y, f.height / scale);
  return { x, y, w, h };
}

/** 背面カメラの映像を取る。ダメなら理由を返す */
export async function openCamera(videoEl) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } });
    videoEl.srcObject = stream;
    await videoEl.play();
    return { ok: true, stream };
  } catch (e) {
    return { ok: false, reason: e?.name || String(e) };
  }
}

export function closeCamera(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}
