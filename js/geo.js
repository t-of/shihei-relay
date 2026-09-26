'use strict';

// 市区町村の表・地図の投影・「今いる所」まわり。
// データは data/muni.json（出典・ライセンスは README）。よみ（ひらがな）は元データに無いため、
// 名前（漢字）の部分一致で候補を探す（ponytail: よみでの絞り込みは持たない。読みの表を別途
// 用意すれば足せる）。

let cache = null;

/** data/muni.json を読み込む（1 度だけ）。1,741 件、~150KB */
export async function loadMuni() {
  if (cache) return cache;
  const res = await fetch('./data/muni.json');
  cache = await res.json();
  return cache;
}

export function findByCode(list, code) {
  return list.find((m) => m.code === code) || null;
}

/** 名前（漢字）の部分一致で候補を探す。都道府県名でも絞れる */
export function searchMuni(list, query, limit = 8) {
  const q = (query || '').trim();
  if (!q) return [];
  const hits = list.filter((m) => m.name.includes(q) || m.pref.includes(q) || `${m.pref}${m.name}`.includes(q));
  // 完全一致・前方一致を先に
  hits.sort((a, b) => {
    const score = (m) => (m.name === q ? 0 : m.name.startsWith(q) ? 1 : 2);
    return score(a) - score(b);
  });
  return hits.slice(0, limit);
}

/** 端末の位置から、表の中でいちばん近い役場の市区町村を選ぶ */
export function nearestMuni(list, lat, lng, distanceKm) {
  let best = null, bestKm = Infinity;
  for (const m of list) {
    const km = distanceKm(lat, lng, m.lat, m.lng);
    if (km < bestKm) { bestKm = km; best = m; }
  }
  return best;
}

// ---- 地図の投影（data/japan.svg と同じ式。tools/make-outline.mjs で作った定数） ----

const LAT0 = 36, LNG0 = 137, SCALE = 800;
const COS0 = Math.cos((LAT0 * Math.PI) / 180);
// 輪郭 SVG の viewBox に合わせた原点のずらし（tools/make-outline.mjs の出力）
const OFFSET_X = 9078.077875819667;
const OFFSET_Y = 7627.6168;
export const JAPAN_VIEWBOX = { w: 14814.920742579563, h: 17023.5152 };

/** 緯度経度を、同梱の日本の輪郭 SVG と同じ座標系（viewBox 原点 0,0）へ */
export function project(lat, lng) {
  const x = (lng - LNG0) * COS0 * SCALE + OFFSET_X;
  const y = -(lat - LAT0) * SCALE + OFFSET_Y;
  return { x, y };
}
