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
  return svg;
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
  svg.querySelectorAll('.jp-dot, .jp-line').forEach((n) => n.remove());
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
