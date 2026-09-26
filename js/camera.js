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
export function startScanLoop({ video, canvas, frame, denom, onProgress, onMatch, onTick, onTimeout }) {
  const getDenom = () => (typeof denom === 'function' ? denom() : denom);
  let stopped = false;
  let lastKey = null;
  let streak = 0;
  let bestPartial = null;
  const startedAt = Date.now();

  async function tick() {
    if (stopped) return;
    if (video.readyState < 2 || video.videoWidth === 0) { schedule(); return; }

    const box = frameBoxInVideo(video, frame);
    cropAndBinarize(video, box, canvas);

    try {
      const w = await ensureWorker(onProgress);
      const { data } = await w.recognize(canvas);
      const text = (data?.text || '').trim();
      onTick?.(text);
      const cand = extractSerialCandidate(text);
      if (cand) {
        const serial = `${cand.prefix}${cand.digits}${cand.suffix}`;
        bestPartial = bestPartial || serial;
        if (parseSerial(serial, getDenom()).ok) {
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

    if (Date.now() - startedAt > 20000) { onTimeout?.(bestPartial); return; }
    schedule();
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
