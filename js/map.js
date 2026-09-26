'use strict';

// 日本の輪郭 SVG に点・線を描く。data/japan.svg は data/muni.json と同じ座標系（js/geo.js の project）。

import { project, JAPAN_VIEWBOX } from './geo.js';

let outlineMarkup = null;

async function loadOutline() {
  if (outlineMarkup) return outlineMarkup;
  const res = await fetch('./data/japan.svg');
  outlineMarkup = await res.text();
  return outlineMarkup;
}

/** host（<div>）の中に日本の輪郭 SVG を差し込み、操作用の <svg> を返す */
export async function mountMap(host) {
  host.innerHTML = await loadOutline();
  const svg = host.querySelector('svg');
  svg.classList.add('jp-map');
  enableZoom(host, svg);
  return svg;
}

const MAX_ZOOM = 12;

/** ピンチ・ドラッグ・Ctrl+ホイール（Mac のトラックパッドのピンチも）・＋－ボタンで拡大縮小。viewBox を動かす */
function enableZoom(host, svg) {
  const full = svg.viewBox.baseVal;
  const W = full.width, H = full.height;
  let v = { x: 0, y: 0, w: W, h: H };
  const apply = () => {
    v.w = Math.min(W, Math.max(W / MAX_ZOOM, v.w));
    v.h = v.w * H / W;
    v.x = Math.min(W - v.w, Math.max(0, v.x));
    v.y = Math.min(H - v.h, Math.max(0, v.y));
    svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    svg.style.setProperty('--z', W / v.w); // 拡大しても点と線の見た目の大きさを保つ（style.css）
    host.classList.toggle('is-zoomed', v.w < W);
  };
  // 画面上の点 (cx, cy) を中心に f 倍する
  const zoomAt = (f, cx, cy) => {
    const r = svg.getBoundingClientRect();
    const px = v.x + (cx - r.left) / r.width * v.w;
    const py = v.y + (cy - r.top) / r.height * v.h;
    v.w /= f;
    v.h = v.w * H / W;
    v.x = px - (cx - r.left) / r.width * v.w;
    v.y = py - (cy - r.top) / r.height * v.h;
    apply();
  };
  const center = () => { const r = svg.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };

  svg.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return; // ふつうのホイールはページのスクロールに使う
    e.preventDefault();
    zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
  }, { passive: false });

  const pts = new Map();
  let last = null; // 前回の { x, y, d }（中心と 2 本指の距離）
  const snapshot = () => {
    const a = [...pts.values()];
    const x = a.reduce((s, p) => s + p.x, 0) / a.length;
    const y = a.reduce((s, p) => s + p.y, 0) / a.length;
    const d = a.length > 1 ? Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) : 0;
    return { x, y, d };
  };
  svg.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    svg.setPointerCapture(e.pointerId);
    last = snapshot();
  });
  svg.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = snapshot();
    if (pts.size === 1 && v.w >= W) { last = now; return; } // 縮小しきっているときの 1 本指はページのスクロール
    const r = svg.getBoundingClientRect();
    v.x -= (now.x - last.x) / r.width * v.w;
    v.y -= (now.y - last.y) / r.height * v.h;
    apply();
    if (last.d && now.d) zoomAt(now.d / last.d, now.x, now.y);
    last = now;
  });
  const up = (e) => { pts.delete(e.pointerId); last = pts.size ? snapshot() : null; };
  svg.addEventListener('pointerup', up);
  svg.addEventListener('pointercancel', up);
  svg.addEventListener('dblclick', (e) => zoomAt(v.w < W / 4 ? 1 / MAX_ZOOM : 2, e.clientX, e.clientY));

  const bar = document.createElement('div');
  bar.className = 'map-zoom';
  for (const [label, name, f] of [['＋', '拡大', 2], ['－', '縮小', 0.5]]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-label', name);
    b.addEventListener('click', () => zoomAt(f, ...center()));
    bar.appendChild(b);
  }
  host.appendChild(bar);
}

/** 市区町村コードの点を打つ。self なら見た目を変える */
export function addPoint(svg, { lat, lng }, { self = false, pulse = false } = {}) {
  const { x, y } = project(lat, lng);
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('cx', x.toFixed(1));
  dot.setAttribute('cy', y.toFixed(1));
  dot.setAttribute('r', self ? 26 : 20);
  dot.setAttribute('class', `jp-dot${self ? ' jp-dot--self' : ''}${pulse ? ' jp-dot--pulse' : ''}`);
  svg.appendChild(dot);
  return dot;
}

/** 2 点を結ぶ線を引く */
export function addLine(svg, from, to) {
  const a = project(from.lat, from.lng);
  const b = project(to.lat, to.lng);
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', a.x.toFixed(1));
  line.setAttribute('y1', a.y.toFixed(1));
  line.setAttribute('x2', b.x.toFixed(1));
  line.setAttribute('y2', b.y.toFixed(1));
  line.setAttribute('class', 'jp-line');
  svg.insertBefore(line, svg.firstChild.nextSibling); // 輪郭の上・点の下
  return line;
}

export function clearMarks(svg) {
  svg.querySelectorAll('.jp-dot, .jp-line, .jp-count, .jp-ring, .jp-tap').forEach((n) => n.remove());
}

// ---- みんなの地図（仕様「21」。市区町村ごとの数を大きさ・濃さで出す） ----

/**
 * 市区町村ごとの登録の数を、点の大きさ（半径 rPx、CSS ピクセル相当）と濃さ（opacity）で描く。
 * 大きい点から先に描く（後で描いた小さい点が隠れないように、呼び出し側で数の多い順に呼ぶ）。
 */
export function addCountPoint(svg, { lat, lng }, { rPx = 90, opacity = 0.6 } = {}) {
  const { x, y } = project(lat, lng);
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('cx', x.toFixed(1));
  dot.setAttribute('cy', y.toFixed(1));
  dot.setAttribute('class', 'jp-count');
  dot.style.setProperty('r', `calc(${rPx}px / var(--z, 1))`);
  dot.style.opacity = String(opacity);
  svg.appendChild(dot);
  return dot;
}

/** 自分が登録した市区町村の輪（集計の点が無くても出す。仕様「21-6」） */
export function addRing(svg, { lat, lng }) {
  const { x, y } = project(lat, lng);
  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  ring.setAttribute('cx', x.toFixed(1));
  ring.setAttribute('cy', y.toFixed(1));
  ring.setAttribute('class', 'jp-ring');
  svg.appendChild(ring);
  return ring;
}

/**
 * 見えない大きめの当たり判定（44px 相当）を点の上に重ね、押しやすくする（点そのものは小さいことがあるため）。
 * ponytail: 画面上のピクセル距離での厳密な 44px 保証ではなく、地図の viewBox 上の固定サイズ（ズームで
 * 見た目の大きさが変わらない他の点と同じ仕組み）。ズームし切った状態でも指 1 本で押せる大きさにしてある。
 */
export function addTapTarget(svg, { lat, lng }, onTap) {
  const { x, y } = project(lat, lng);
  const hit = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  hit.setAttribute('cx', x.toFixed(1));
  hit.setAttribute('cy', y.toFixed(1));
  hit.setAttribute('class', 'jp-tap');
  hit.style.setProperty('r', 'calc(260px / var(--z, 1))');
  hit.addEventListener('click', onTap);
  svg.appendChild(hit);
  return hit;
}

/** 道のりが狭い範囲のときに使う、点を囲む viewBox（拡大表示） */
export function tightViewBox(points, pad = 400) {
  const pts = points.map((p) => project(p.lat, p.lng));
  const minX = Math.min(...pts.map((p) => p.x)) - pad;
  const minY = Math.min(...pts.map((p) => p.y)) - pad;
  const maxX = Math.max(...pts.map((p) => p.x)) + pad;
  const maxY = Math.max(...pts.map((p) => p.y)) + pad;
  const w = Math.max(maxX - minX, JAPAN_VIEWBOX.w * 0.08);
  const h = Math.max(maxY - minY, JAPAN_VIEWBOX.h * 0.08);
  return `${minX} ${minY} ${w} ${h}`;
}
