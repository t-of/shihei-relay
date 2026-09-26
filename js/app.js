'use strict';

// 紙幣リレー — 画面の組み立て。ロジックは js/bill.js・js/geo.js に、Firebase は js/firebase.js に、
// カメラは js/camera.js に、音は js/sound.js に、地図は js/map.js に分けてある。

import * as Bill from './bill.js';
import * as Geo from './geo.js';
import * as Map from './map.js';
import * as Cam from './camera.js';
import * as FB from './firebase.js';
import { sfx, setSoundOn } from './sound.js';

// ---- 保存（localStorage、キーは shihei-relay. で始める） ----

const STORE = 'shihei-relay.';
function load(key, fallback) {
  try { const v = localStorage.getItem(STORE + key); return v == null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch { /* 保存できなくても遊べる */ }
}

const settings = Object.assign(
  { v: 1, sound: true, confirm: true, input: 'pad', lastDenom: null, lastMuni: null, guided: 0 },
  load('settings', {}),
);
const mine = Object.assign({ v: 1, bills: [] }, load('mine', {}));
const dex = Object.assign({ v: 1, found: {} }, load('dex', {}));
const saveSettings = () => save('settings', settings);
const saveMine = () => save('mine', mine);
const saveDex = () => save('dex', dex);

WebAppKit.init({ title: '紙幣リレー', text: 'お札の記番号と場所を登録して、紙幣の行方を追跡。同じお札が見つかれば移動の道のりが分かる。レア番号も判定。' });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
setSoundOn(settings.sound);

const APP_URL = 'https://t-of.github.io/shihei-relay/';
const $ = (id) => document.getElementById(id);

// ---- 状態 ----

let muniList = [];
const state = {
  denom: settings.lastDenom,
  buffer: '',
  color: null,
  muniCode: settings.lastMuni,
  camStream: null,
  camLoop: null,
  lastResultKey: null,
  relayKey: null,
};

// ---- 市区町村の表 ----

Geo.loadMuni().then((list) => {
  muniList = list;
  renderPlace();
});

function muniLabel(code) {
  const m = muniList.find((x) => x.code === code);
  return m ? `${m.pref} ${m.name}` : null;
}
function muniLatLng(code) {
  const m = muniList.find((x) => x.code === code);
  return m ? { lat: m.lat, lng: m.lng } : null;
}

// ---- 券種ボタン ----

const DENOM_LABEL = { 1000: '千円', 2000: '2千円', 5000: '5千円', 10000: '1万円' };
function renderDenoms() {
  const host = $('denoms');
  host.replaceChildren();
  for (const d of Bill.DENOMS) {
    const b = document.createElement('button');
    b.textContent = DENOM_LABEL[d];
    b.setAttribute('aria-pressed', String(d === state.denom));
    b.addEventListener('click', () => {
      state.denom = d;
      state.color = null;
      settings.lastDenom = d; saveSettings();
      sfx.choice();
      renderDenoms(); renderColors(); renderSerial();
    });
    host.appendChild(b);
  }
}

// ---- 記番号の枠・キーパッド ----

function currentParse() { return Bill.parseSerial(state.buffer, state.denom); }

function renderSerial() {
  const parsed = state.denom ? currentParse() : { ok: false };
  const host = $('serial-boxes');
  host.replaceChildren();
  const chars = parsed.ok ? [...parsed.prefix, ...parsed.digits, ...parsed.suffix] : [...state.buffer];
  // 形が合っているときだけ、prefix|digits|suffix の切れ目に隙間を入れる
  const gapAfter = parsed.ok ? new Set([parsed.prefix.length - 1, parsed.prefix.length + parsed.digits.length - 1]) : new Set();
  const max = state.denom === 2000 ? 9 : 10;
  chars.forEach((c, i) => {
    const b = document.createElement('div');
    b.className = 'box filled' + (gapAfter.has(i) ? ' gap-after' : '');
    b.textContent = c;
    host.appendChild(b);
  });
  for (let i = chars.length; i < max; i++) {
    const b = document.createElement('div');
    b.className = 'box';
    b.textContent = '-';
    host.appendChild(b);
  }
  renderColors(parsed);
  renderRegister(parsed);
}

function renderColors(parsedArg) {
  const parsed = parsedArg || (state.denom ? currentParse() : { ok: false });
  const host = $('colors');
  if (!parsed.ok) { host.hidden = true; return; }
  const cs = Bill.colorsFor(parsed.series, state.denom);
  if (cs.length <= 1) { state.color = cs[0] || null; host.hidden = true; return; }
  host.hidden = false;
  host.replaceChildren();
  const COLOR_CSS = { K: '#222', B: '#7a4a20', N: '#1a2a5e' };
  for (const c of cs) {
    const b = document.createElement('button');
    b.style.background = COLOR_CSS[c];
    b.title = Bill.COLOR_NAME[c];
    b.setAttribute('aria-pressed', String(c === state.color));
    b.addEventListener('click', () => { state.color = c; sfx.choice(); renderColors(parsed); renderRegister(parsed); });
    host.appendChild(b);
  }
}

function renderRegister(parsedArg) {
  const parsed = parsedArg || (state.denom ? currentParse() : { ok: false });
  const needsColor = parsed.ok && Bill.colorsFor(parsed.series, state.denom).length > 1;
  const ok = parsed.ok && !!state.muniCode && (!needsColor || !!state.color);
  $('btn-register').disabled = !ok;
  if (parsed.ok && !$('serial-boxes').dataset.wasOk) sfx.serialReady();
  $('serial-boxes').dataset.wasOk = parsed.ok ? '1' : '';
}

const KEY_ROWS = [
  [...Bill.ALPHABET],
  [...'0123456789'],
];
function renderKeypad() {
  const host = $('keypad');
  host.replaceChildren();
  for (const row of KEY_ROWS) {
    for (const ch of row) {
      const b = document.createElement('button');
      b.textContent = ch;
      b.addEventListener('click', () => typeChar(ch));
      host.appendChild(b);
    }
  }
  const del = document.createElement('button');
  del.textContent = '消す';
  del.className = 'key--del';
  del.addEventListener('click', () => { state.buffer = state.buffer.slice(0, -1); sfx.key(false); renderSerial(); });
  host.appendChild(del);
}

function typeChar(ch) {
  const max = state.denom === 2000 ? 9 : 10;
  if (state.buffer.length >= max) return;
  state.buffer += ch;
  sfx.key(/[A-Z]/.test(ch));
  renderSerial();
}

document.addEventListener('keydown', (e) => {
  if (currentView() !== 'input' || document.activeElement?.tagName === 'INPUT') return;
  if (/^[a-zA-Z0-9]$/.test(e.key)) typeChar(e.key.toUpperCase());
  else if (e.key === 'Backspace') { state.buffer = state.buffer.slice(0, -1); renderSerial(); }
  else if (e.key === 'Enter' && !$('btn-register').disabled) $('btn-register').click();
});

// ---- 場所 ----

function renderPlace() {
  $('place-text').textContent = state.muniCode ? `${muniLabel(state.muniCode)}で登録 ›` : '場所を選ぶ ›';
  renderRegister();
}

$('btn-place').addEventListener('click', () => openPlaceSheet());
$('btn-place-close').addEventListener('click', () => $('place-sheet').hidden = true);
$('btn-here').addEventListener('click', () => {
  if (!navigator.geolocation) { toast('位置情報が使えません'); return; }
  navigator.geolocation.getCurrentPosition((pos) => {
    const m = Geo.nearestMuni(muniList, pos.coords.latitude, pos.coords.longitude, Bill.distanceKm);
    if (m) selectMuni(m.code);
  }, () => toast('位置情報が使えません。市区町村名で探してください'));
});
$('place-search').addEventListener('input', (e) => {
  const hits = Geo.searchMuni(muniList, e.target.value, 8);
  const host = $('place-candidates');
  host.replaceChildren();
  for (const m of hits) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.textContent = `${m.pref} ${m.name}`;
    b.addEventListener('click', () => selectMuni(m.code));
    li.appendChild(b);
    host.appendChild(li);
  }
});
function selectMuni(code) {
  state.muniCode = code;
  settings.lastMuni = code; saveSettings();
  $('place-sheet').hidden = true;
  sfx.choice();
  renderPlace();
}
function openPlaceSheet() {
  $('place-search').value = '';
  $('place-candidates').replaceChildren();
  $('place-sheet').hidden = false;
}

// ---- 登録 ----

function formatSerial(parsed) { return `${parsed.prefix} ${parsed.digits} ${parsed.suffix}`; }

$('btn-register').addEventListener('click', () => {
  const parsed = currentParse();
  if (!parsed.ok || !state.muniCode) return;
  if (settings.confirm) {
    $('confirm-text').textContent = `${formatSerial(parsed)}（${DENOM_LABEL[state.denom]}）を ${muniLabel(state.muniCode)}に登録します`;
    $('confirm-skip').checked = false;
    $('confirm-sheet').hidden = false;
  } else {
    doRegister(parsed);
  }
});
$('btn-confirm-cancel').addEventListener('click', () => $('confirm-sheet').hidden = true);
$('btn-confirm-ok').addEventListener('click', () => {
  if ($('confirm-skip').checked) { settings.confirm = false; saveSettings(); }
  $('confirm-sheet').hidden = true;
  doRegister(currentParse());
});

async function doRegister(parsed) {
  const key = Bill.buildKey({ series: parsed.series, denom: state.denom, color: state.color, serial: parsed.serial });
  const rareHits = Bill.rareChecks(parsed.digits, { series: parsed.series, prefix: parsed.prefix, suffix: parsed.suffix });
  const feature = rareHits.length ? null : Bill.smallFeature(parsed.digits);
  const newRare = rareHits.filter((r) => !dex.found[r.id]);
  for (const r of rareHits) if (!dex.found[r.id]) dex.found[r.id] = Date.now();
  if (newRare.length) saveDex();

  let outcome;
  if (FB.isConfigured()) {
    const res = await FB.registerSighting(key, state.muniCode, { muniLatLng, distanceKm: Bill.distanceKm });
    if (!res.ok) {
      if (res.reason === 'already-registered') toast('このお札はもう登録しています');
      else toast('登録できませんでした（時間をおいて試してください）');
      sfx.error();
      return;
    }
    outcome = res;
  } else {
    outcome = { ok: true, first: true, offline: true };
  }

  upsertMine(key, state.muniCode, outcome);
  if (settings.guided < 2) { settings.guided++; saveSettings(); $('guide').hidden = settings.guided >= 2; }
  showResult({ key, parsed, denom: state.denom, muniCode: state.muniCode, rareHits, feature, outcome });
}

function upsertMine(key, muniCode, outcome) {
  let entry = mine.bills.find((b) => b.key === key);
  if (!entry) {
    entry = { key, muni: muniCode, at: Date.now(), seen: outcome.n || 1, rare: [], km: 0 };
    mine.bills.unshift(entry);
  } else {
    entry.muni = muniCode;
    entry.at = Date.now();
    entry.seen = outcome.n || entry.seen;
    if (outcome.km) entry.km = (entry.km || 0) + outcome.km;
  }
  if (mine.bills.length > 1000) mine.bills.length = 1000;
  saveMine();
}

// ---- 結果 ----

function showResult({ key, parsed, denom, muniCode, rareHits, feature, outcome }) {
  state.lastResultKey = key;
  const body = $('result-body');
  const here = muniLatLng(muniCode);
  let html = '';
  if (outcome.first) {
    sfx.firstRegister();
    html += `<h2>登録しました</h2><p>ここから旅が始まります — ${muniLabel(muniCode)}</p>`;
  } else {
    sfx.rediscoverArrive();
    const dur = Bill.formatDuration(Date.now() - outcome.prevAt);
    html += `<h2>再発見！</h2><p>${muniLabel(outcome.prevMuni)} → ${muniLabel(muniCode)}</p>`;
    html += `<p><b>${dur}で ${outcome.km} km</b> 旅してきました</p>`;
    html += `<p class="muted">このお札を手にした ${outcome.n} 人目</p>`;
  }
  if (outcome.offline) html += `<p class="muted">共有の記録はまだ準備中です（サーバーの設定待ち）。自分の記録には残しました。</p>`;
  if (rareHits.length) {
    sfx.rare();
    html += rareHits.map((r) => `<p class="rare-hit">✨ ${r.name}（${r.odds}）</p>`).join('');
    if (rareHits.some((r) => !dex.found[r.id])) sfx.dexComplete();
  } else if (feature) {
    html += `<p class="muted">${feature}</p>`;
  }
  html += `<p class="muted">${formatSerial(parsed)}（${DENOM_LABEL[denom]}）</p>`;
  body.innerHTML = ''; // 直前の内容を消してから安全な API で組み立てる
  const wrap = document.createElement('div');
  wrap.innerHTML = html; // ここに入る文字列はすべてこちらが作った定型文と市区町村名（表由来）で、外部入力はない
  body.appendChild(wrap);

  if (here) {
    const mapHost = document.createElement('div');
    mapHost.className = 'map-host';
    body.appendChild(mapHost);
    Map.mountMap(mapHost).then((svg) => {
      if (!outcome.first && outcome.prevMuni) {
        const from = muniLatLng(outcome.prevMuni);
        if (from) { Map.addLine(svg, from, here); Map.addPoint(svg, from); }
      }
      Map.addPoint(svg, here, { self: true, pulse: outcome.first });
    });
  }

  $('result-view').hidden = false;
  const actions = document.querySelectorAll('.result-actions button');
  actions.forEach((b) => { b.disabled = true; });
  setTimeout(() => actions.forEach((b) => { b.disabled = false; }), 500);
}

$('btn-again').addEventListener('click', () => {
  closeResult();
  state.buffer = '';
  state.color = null;
  renderSerial();
});
$('btn-result-close').addEventListener('click', closeResult);
function closeResult() {
  $('result-view').hidden = true;
  $('result-view').dataset.ready = '';
  $('result-body').replaceChildren();
}
$('btn-relay').addEventListener('click', () => {
  if (!state.lastResultKey) return;
  WebAppKit.share({ text: 'このお札、登録してつないでね（紙幣リレー）', url: `${APP_URL}#r=${encodeURIComponent(state.lastResultKey)}` });
});
$('btn-share-result').addEventListener('click', () => {
  const entry = mine.bills.find((b) => b.key === state.lastResultKey);
  if (!entry) return;
  WebAppKit.share({ text: `お札を 1 枚、リレーに出した（${muniLabel(entry.muni) || ''}から）#紙幣リレー`, url: APP_URL });
});
$('btn-journey').addEventListener('click', () => { if (state.lastResultKey) openJourney(state.lastResultKey); });

// ---- 1 枚の道のり ----

async function openJourney(key) {
  $('journey-view').hidden = false;
  $('journey-list').textContent = '読み込み中…';
  const host = $('journey-map');
  const svg = await Map.mountMap(host);
  if (!FB.isConfigured()) {
    $('journey-list').textContent = '共有の道のりはまだ準備中です（サーバーの設定待ち）。';
    const entry = mine.bills.find((b) => b.key === key);
    if (entry) { const p = muniLatLng(entry.muni); if (p) Map.addPoint(svg, p, { self: true }); }
    return;
  }
  const res = await FB.fetchJourney(key);
  if (!res.ok) { $('journey-list').textContent = '読み込めませんでした。'; return; }
  const rows = res.rows.map((r) => ({ ...r, ll: muniLatLng(r.muni) })).filter((r) => r.ll);
  rows.forEach((r, i) => { if (i > 0) Map.addLine(svg, rows[i - 1].ll, r.ll); });
  rows.forEach((r, i) => Map.addPoint(svg, r.ll, { self: i === rows.length - 1 }));
  const listHost = $('journey-list');
  listHost.replaceChildren();
  rows.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'journey-row';
    const when = new Date(r.at).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const dist = i > 0 ? `<span class="muted">前から ${Bill.distanceKm(rows[i - 1].ll.lat, rows[i - 1].ll.lng, r.ll.lat, r.ll.lng)} km</span>` : '';
    row.innerHTML = `<span>${when} ・ ${muniLabel(r.muni) || ''}</span>${dist}`;
    listHost.appendChild(row);
  });
}
$('btn-journey-close').addEventListener('click', () => { $('journey-view').hidden = true; });

// ---- カメラ ----

$('btn-camera').addEventListener('click', openCamera);
$('btn-cam-close').addEventListener('click', closeCameraView);

async function openCamera() {
  if (!state.denom) { toast('先に券種を選んでください'); return; }
  const supportsCam = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  $('cam-overlay').hidden = false;
  renderCamDenoms();
  if (!supportsCam) { $('cam-overlay').hidden = true; $('cam-file').click(); return; }

  $('cam-hint').textContent = '読み取りの準備中（初回のみ・約 6MB）…';
  const opened = await Cam.openCamera($('cam-video'));
  if (!opened.ok) {
    $('cam-overlay').hidden = true;
    toast('カメラが使えません。設定からこのサイトのカメラを許可するか、キーパッドで打ってください（設定 → Safari → カメラ）');
    return;
  }
  state.camStream = opened.stream;
  Cam.ensureWorker((p) => { $('cam-hint').textContent = `読み取りの準備中… ${Math.round(p * 100)}%`; })
    .then(() => {
      $('cam-hint').textContent = '記番号を枠に合わせてください';
      state.camLoop = Cam.startScanLoop({
        video: $('cam-video'),
        canvas: $('cam-canvas'),
        denom: () => state.denom,
        onMatch: (serial) => {
          sfx.camHit();
          if (navigator.vibrate) navigator.vibrate(30);
          state.buffer = serial;
          closeCameraView();
          renderSerial();
          toast('読み取った番号です。お札と見比べてください');
        },
        onTimeout: (partial) => {
          sfx.camMiss();
          closeCameraView();
          if (partial) state.buffer = partial;
          renderSerial();
          toast('読み取れませんでした。明るい所で・お札を平らに・枠いっぱいに');
        },
      });
    });
}

function renderCamDenoms() {
  const host = $('cam-denoms');
  host.replaceChildren();
  for (const d of Bill.DENOMS) {
    const b = document.createElement('button');
    b.textContent = DENOM_LABEL[d];
    b.setAttribute('aria-pressed', String(d === state.denom));
    b.addEventListener('click', () => { state.denom = d; renderCamDenoms(); sfx.choice(); });
    host.appendChild(b);
  }
}

function closeCameraView() {
  if (state.camLoop) { state.camLoop.stop(); state.camLoop = null; }
  if (state.camStream) { Cam.closeCamera(state.camStream); state.camStream = null; }
  $('cam-overlay').hidden = true;
}

$('cam-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await img.decode().catch(() => {});
  const canvas = $('cam-canvas');
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
  URL.revokeObjectURL(img.src);
  toast('読み取っています…');
  const w = await Cam.ensureWorker();
  const { data } = await w.recognize(canvas);
  const cand = Bill.extractSerialCandidate(data.text || '');
  if (cand) { state.buffer = `${cand.prefix}${cand.digits}${cand.suffix}`; renderSerial(); toast('読み取った番号です。お札と見比べてください'); }
  else toast('読み取れませんでした。キーパッドで打ってください');
  e.target.value = '';
});

// ---- タブ ----

function currentView() {
  return document.querySelector('.tab[aria-current="page"]')?.dataset.tab || 'input';
}
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'));
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== tab; });
  if (tab === 'mine') renderMine();
  if (tab === 'everyone') renderEveryone();
}

// ---- 自分の記録 ----

function renderMine() {
  const total = mine.bills.length;
  const byDenom = {};
  for (const b of mine.bills) byDenom[b.key.match(/[EFD](\d+)/)?.[1] || '?'] = (byDenom[b.key.match(/[EFD](\d+)/)?.[1] || '?'] || 0) + 1;
  const rediscovered = mine.bills.filter((b) => (b.seen || 1) > 1).length;
  const totalKm = mine.bills.reduce((s, b) => s + (b.km || 0), 0);
  const muniCount = new Set(mine.bills.map((b) => b.muni)).size;
  $('mine-summary').innerHTML = [
    ['登録', `${total} 枚`], ['再発見', `${rediscovered} 枚`], ['旅した合計', `${totalKm} km`], ['登録した市区町村', `${muniCount}`],
  ].map(([label, val]) => `<div class="card"><b>${escapeHtml(val)}</b><span>${escapeHtml(label)}</span></div>`).join('');

  Map.mountMap($('mine-map')).then((svg) => {
    const seen = new Set();
    for (const b of mine.bills) {
      if (seen.has(b.muni)) continue;
      seen.add(b.muni);
      const p = muniLatLng(b.muni);
      if (p) Map.addPoint(svg, p);
    }
  });

  const dexHost = $('mine-dex');
  dexHost.replaceChildren();
  const NAMES = { zorome: 'ゾロ目', kiriban: 'キリ番', wakai: '若い番号', kaidan: '階段', kagami: '鏡', kurikaeshi: 'くり返し', zorozoro: 'ぞろぞろ', eiji: '英字もそろう' };
  for (const id of Bill.RARE_IDS) {
    const el = document.createElement('div');
    el.className = `slot ${dex.found[id] ? 'got' : 'pending'}`;
    el.textContent = NAMES[id] || id;
    dexHost.appendChild(el);
  }

  const sort = $('mine-sort').value;
  const sorted = [...mine.bills].sort((a, b) => sort === 'far' ? (b.km || 0) - (a.km || 0) : sort === 'denom' ? Number(b.key.match(/\d+/)) - Number(a.key.match(/\d+/)) : b.at - a.at);
  const listHost = $('mine-list');
  listHost.replaceChildren();
  for (const b of sorted) {
    const row = document.createElement('div');
    row.className = 'bill-row';
    row.innerHTML = `<span>${escapeHtml(muniLabel(b.muni) || '')}</span><span class="muted">${b.km || 0} km</span>`;
    row.addEventListener('click', () => openJourney(b.key));
    listHost.appendChild(row);
  }
}
$('mine-sort').addEventListener('change', renderMine);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- みんな ----

async function renderEveryone() {
  if (!FB.isConfigured()) {
    $('global-stats').innerHTML = '<div class="card"><span>準備中です（サーバーの設定待ち）</span></div>';
    $('hit-list').replaceChildren();
    return;
  }
  const [stats, hits] = await Promise.all([FB.fetchGlobalStats(), FB.fetchRecentHits(20)]);
  if (stats.ok) {
    $('global-stats').innerHTML = [['再発見', `${stats.hitCount} 件`], ['最長の旅', `${stats.longestKm} km`]]
      .map(([label, val]) => `<div class="card"><b>${escapeHtml(val)}</b><span>${escapeHtml(label)}</span></div>`).join('');
  }
  const listHost = $('hit-list');
  listHost.replaceChildren();
  if (!hits.ok || hits.rows.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'まだ再発見はありません。リレーのリンクで最初の 1 本をつなごう';
    listHost.appendChild(p);
    return;
  }
  for (const h of hits.rows) {
    const row = document.createElement('div');
    row.className = 'hit-row';
    row.innerHTML = `<span>${escapeHtml(muniLabel(h.from) || '')} → ${escapeHtml(muniLabel(h.to) || '')}</span><span class="muted">${h.km} km・${Bill.formatDuration(h.mins * 60000)}</span>`;
    listHost.appendChild(row);
  }
}

// ---- 設定 ----

$('btn-settings').addEventListener('click', openSettings);
$('btn-settings-close').addEventListener('click', () => $('settings-view').hidden = true);
function openSettings() {
  $('opt-sound').checked = settings.sound;
  $('opt-confirm').checked = settings.confirm;
  $('opt-input').value = settings.input;
  $('settings-view').hidden = false;
}
$('opt-sound').addEventListener('change', (e) => { settings.sound = e.target.checked; setSoundOn(settings.sound); saveSettings(); });
$('opt-confirm').addEventListener('change', (e) => { settings.confirm = e.target.checked; saveSettings(); });
$('opt-input').addEventListener('change', (e) => { settings.input = e.target.value; saveSettings(); });

const PRIVACY_TEXT = `カメラの映像は端末の中で文字を読むためだけに使い、送らず、残しません。
写真はどこにも保存しません。
登録した市区町村と日時は、そのお札の記番号を知っている人にだけ見えます。登録した人が誰かは分かりません。
「みんな」の画面には記番号を出しません。`;
const CREDIT_TEXT = `市区町村の緯度経度・コード: 総務省・国土交通省の公開データを含む jp-address-search（MIT License, uiuifree）
日本の輪郭: Natural Earth（パブリックドメイン）
文字を読む部品: Tesseract.js / tesseract.js-core（Apache License 2.0）
英語の学習データ: tessdata_fast（Apache License 2.0, tesseract-ocr）`;
$('link-privacy').addEventListener('click', (e) => { e.preventDefault(); showText('プライバシー', PRIVACY_TEXT); });
$('link-credit').addEventListener('click', (e) => { e.preventDefault(); showText('データと部品の出典', CREDIT_TEXT); });
function showText(title, text) {
  $('text-title').textContent = title;
  $('text-body').textContent = text;
  $('text-sheet').hidden = false;
}
$('btn-text-close').addEventListener('click', () => $('text-sheet').hidden = true);

// ---- トースト ----

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---- リレーのリンク（#r=<key>） ----

function tryRelayLink() {
  const m = location.hash.match(/^#r=(.+)$/);
  if (!m) return;
  const key = decodeURIComponent(m[1]);
  const parts = key.match(/^([EFD])(\d+)([KBN])-(.+)$/);
  if (!parts) return;
  const [, series, denomStr, color, serial] = parts;
  const denom = Number(denomStr);
  if (!Bill.DENOMS.includes(denom)) return;
  const parsed = Bill.parseSerial(serial, denom);
  if (!parsed.ok || parsed.series !== series) return;
  state.denom = denom;
  state.buffer = serial;
  state.color = color;
  state.relayKey = key;
  $('relay-banner').hidden = false;
  sfx.relayReceived();
  switchTab('input');
  renderDenoms();
  renderSerial();
}

// ---- 手順の帯（はじめての人向け、2 回登録したら畳む） ----

$('guide').hidden = settings.guided >= 2;

// ---- 初期化 ----

renderDenoms();
renderKeypad();
renderSerial();
renderPlace();
tryRelayLink();
