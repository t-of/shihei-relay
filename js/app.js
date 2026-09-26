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

// confirm（登録前の確かめのスキップ）は廃止（確かめは必ず出す）。古いデータに残っていても読み捨てる。
// listSort・listFilter・lastNoteType は「18」「19」で足した項目。無いときの初期値はここで入るので、
// 古いデータもそのまま引き継げる（キーは変えていない）。
const SORTS = new Set(['new', 'old', 'num', 'rare', 'far']);
const FILTERS = new Set(['all', 'fav', 'rare']);
const settings = Object.assign(
  { v: 1, sound: true, input: 'pad', lastDenom: null, lastMuni: null, guided: 0, listSort: 'new', listFilter: 'all', lastNoteType: null },
  load('settings', {}),
);
if (!SORTS.has(settings.listSort)) settings.listSort = 'new';
if (!FILTERS.has(settings.listFilter)) settings.listFilter = 'all';
if (!Bill.NOTE_TYPES.some((t) => t.old && t.id === settings.lastNoteType)) settings.lastNoteType = null;
const mine = Object.assign({ v: 1, bills: [] }, load('mine', {}));
const dex = Object.assign({ v: 1, found: {} }, load('dex', {}));
const saveSettings = () => save('settings', settings);
const saveMine = () => save('mine', mine);
const saveDex = () => save('dex', dex);

WebAppKit.init({ title: '紙幣リレー', text: 'お札の記番号と場所を登録して、紙幣の行方を追跡。同じお札が見つかれば移動の道のりが分かる。レア番号も判定。' });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
setSoundOn(settings.sound);

const APP_URL = 'https://shihei-relay.t-of.workers.dev/';
const $ = (id) => document.getElementById(id);

// 「紙幣リレーを広める」（アプリそのものの紹介）。押した回数などは記録しない。
const SPREAD_TEXT = 'お札の記番号を登録して行方をたどるアプリ「紙幣リレー」。広まるほど、同じお札に出会えるようになります。';
function spreadShare() { WebAppKit.share({ text: SPREAD_TEXT, url: APP_URL }); }

// ---- 状態 ----

let muniList = [];
const state = {
  denom: settings.lastDenom,
  noteType: settings.lastNoteType, // 昔のお札を選んでいるとき NOTE_TYPES の id。それ以外は null
  buffer: '',
  color: null,
  muniCode: settings.lastMuni,
  camStream: null,
  camLoop: null,
  lastResultKey: null,
  relayKey: null,
  flaggedIdx: [], // 撮影で読んで直した・あやしい文字の場所（確認画面で色を変えて出す）
  pending: null,  // 確認画面に出している { parsed, key }
  shareImageData: null, // 再発見のとき、画像共有ボタン用の材料（下の shareResultImage）
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

const DENOM_LABEL = { 50: '五十円', 100: '百円', 500: '五百円', 1000: '千円', 2000: '二千円', 5000: '五千円', 10000: '一万円' };
const COLOR_CSS = { K: '#222', B: '#7a4a20', N: '#1a2a5e', U: '#1f4fa8', G: '#1f5c3a' };

/** 券種の表示名。昔のお札を選んでいるときは「千円（昔・夏目漱石）」のように肖像も添える（仕様「19-2」） */
function denomLabel(denom, noteTypeId) {
  const row = noteTypeId && Bill.NOTE_TYPES.find((t) => t.id === noteTypeId);
  return row ? `${DENOM_LABEL[row.denom]}（${row.short}）` : DENOM_LABEL[denom];
}

function renderDenoms() {
  const host = $('denoms');
  host.replaceChildren();
  for (const d of Bill.DENOMS) {
    const b = document.createElement('button');
    b.textContent = DENOM_LABEL[d];
    b.setAttribute('aria-pressed', String(!state.noteType && d === state.denom));
    b.addEventListener('click', () => {
      state.denom = d;
      state.noteType = null;
      state.color = null;
      state.buffer = '';
      settings.lastDenom = d; settings.lastNoteType = null; saveSettings();
      sfx.choice();
      renderDenoms(); renderColors(); renderSerial();
    });
    host.appendChild(b);
  }
  const oldRow = state.noteType && Bill.NOTE_TYPES.find((t) => t.id === state.noteType);
  const more = document.createElement('button');
  more.className = 'denom-more';
  more.textContent = oldRow ? oldRow.short : 'もっと見る';
  more.setAttribute('aria-pressed', String(!!oldRow));
  more.addEventListener('click', openOldSheet);
  host.appendChild(more);
}

// ---- 昔のお札（仕様「19」） ----

function selectOldNote(row) {
  state.denom = row.denom;
  state.noteType = row.id;
  state.color = null;
  state.buffer = '';
  settings.lastDenom = row.denom; settings.lastNoteType = row.id; saveSettings();
  $('old-sheet').hidden = true;
  sfx.choice();
  renderDenoms(); renderColors(); renderSerial();
}

function openOldSheet() {
  const host = $('old-list');
  host.replaceChildren();
  const groups = [10000, 5000, 1000, 500, 100, 50];
  for (const d of groups) {
    const rows = Bill.NOTE_TYPES.filter((t) => t.old && t.denom === d);
    if (!rows.length) continue;
    host.appendChild(el('h3', 'old-group', DENOM_LABEL[d]));
    for (const row of rows) {
      const b = document.createElement('button');
      b.className = 'old-item';
      b.textContent = `${row.portrait}　${row.from} 年から`;
      b.addEventListener('click', () => selectOldNote(row));
      host.appendChild(b);
      if (row.id === 'D10000') {
        host.appendChild(el('p', 'old-note', '今の福沢諭吉の一万円札（2004 年から）と違い、ホログラム（表の左下の光る部分）がないもの'));
      }
    }
  }
  $('old-sheet').hidden = false;
}
$('btn-old-close').addEventListener('click', () => { $('old-sheet').hidden = true; });

// ---- 記番号の枠・キーパッド ----

function currentParse() { return Bill.parseSerial(state.buffer, state.denom, state.noteType); }

function renderSerial() {
  const parsed = state.denom ? currentParse() : { ok: false };
  const host = $('serial-boxes');
  host.replaceChildren();
  const chars = parsed.ok ? [...parsed.prefix, ...parsed.digits, ...parsed.suffix] : [...state.buffer];
  // 形が合っているときだけ、prefix|digits|suffix の切れ目に隙間を入れる
  const gapAfter = parsed.ok ? new Set([parsed.prefix.length - 1, parsed.prefix.length + parsed.digits.length - 1]) : new Set();
  // 号券が決まったら（形に合ったら）枠の数もその形に合わせる（仕様「4-2」）。
  // 決まるまでは、いちばん多い E/D 号券の 9 マスぶんだけ空き枠を見せておく（F 号券の 10 個目は打った時点で増える）。
  const max = parsed.ok ? chars.length : Math.max(chars.length, 9);
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
  renderKeypad();
}

function renderColors(parsedArg) {
  const parsed = parsedArg || (state.denom ? currentParse() : { ok: false });
  const host = $('colors');
  if (!parsed.ok) { host.hidden = true; return; }
  const cs = Bill.colorsFor(parsed.series, state.denom);
  if (cs.length <= 1) { state.color = cs[0] || null; host.hidden = true; return; }
  host.hidden = false;
  host.replaceChildren();
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

// キーパッドは「いまの位置で打てる文字」（js/bill.js の nextKind）だけを大きく出す。
// お札の旅にない、いちばんの入力の速さの決め手（仕様「4-2」の 1）。
function keysFor(kind) {
  if (kind === 'letter') return [...Bill.ALPHABET];
  if (kind === 'digit') return [...'0123456789'];
  if (kind === 'either') return [...Bill.ALPHABET, ...'0123456789'];
  return [];
}
function renderKeypad() {
  const kind = Bill.nextKind(state.buffer, state.denom, state.noteType);
  const keys = keysFor(kind);
  const host = $('keypad');
  host.replaceChildren();
  for (const ch of keys) {
    const b = document.createElement('button');
    b.textContent = ch;
    b.addEventListener('click', () => typeChar(ch));
    host.appendChild(b);
  }
  const del = document.createElement('button');
  del.textContent = '消す';
  del.className = 'key--del';
  del.disabled = state.buffer.length === 0;
  del.addEventListener('click', () => { state.buffer = state.buffer.slice(0, -1); state.flaggedIdx = []; sfx.key(false); renderSerial(); });
  host.appendChild(del);
}

function typeChar(ch) {
  const kind = Bill.nextKind(state.buffer, state.denom, state.noteType);
  const isLetter = Bill.ALPHABET.includes(ch);
  const isDigit = /[0-9]/.test(ch);
  const allowed = (kind === 'letter' && isLetter) || (kind === 'digit' && isDigit) || (kind === 'either' && (isLetter || isDigit));
  if (!allowed) return;
  state.buffer += ch;
  state.flaggedIdx = []; // 手で打ち直したら、撮影の色分けは消す
  sfx.key(isLetter);
  renderSerial();
}

document.addEventListener('keydown', (e) => {
  if (currentView() !== 'input' || document.activeElement?.tagName === 'INPUT') return;
  if (/^[a-zA-Z0-9]$/.test(e.key)) typeChar(e.key.toUpperCase());
  else if (e.key === 'Backspace') { state.buffer = state.buffer.slice(0, -1); state.flaggedIdx = []; renderSerial(); }
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

// ---- 登録（確認画面は必ず出す。スキップの設定は無い） ----

function formatSerial(parsed) { return `${parsed.prefix} ${parsed.digits} ${parsed.suffix}`; }
function formatDateTime(ms) {
  return new Date(ms).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

$('btn-register').addEventListener('click', () => {
  const parsed = currentParse();
  if (!parsed.ok || !state.muniCode) return;
  openConfirmSheet(parsed);
});

function openConfirmSheet(parsed) {
  const key = Bill.buildKey({ series: parsed.series, denom: state.denom, color: state.color, serial: parsed.serial });
  state.pending = { parsed, key };

  // 撮影で読んだ文字のうち、直した・あやしい文字は色を変えたまま出す
  const flagged = new Set(state.flaggedIdx || []);
  const serialHost = $('confirm-serial');
  serialHost.replaceChildren();
  [...formatSerial(parsed).replace(/ /g, '')].forEach((c, i) => {
    serialHost.appendChild(el('span', `cbox${flagged.has(i) ? ' cbox--flag' : ''}`, c));
  });

  const colorText = state.color && Bill.COLOR_NAME[state.color] ? `・${Bill.COLOR_NAME[state.color]}` : '';
  $('confirm-meta').textContent = `${denomLabel(state.denom, state.noteType)}${colorText}・${muniLabel(state.muniCode)}`;

  const prior = mine.bills.find((b) => b.key === key);
  const priorHost = $('confirm-prior');
  if (prior) {
    priorHost.hidden = false;
    priorHost.textContent = `このお札は前に登録しています（${formatDateTime(prior.at)}・${muniLabel(prior.muni) || ''}）`;
  } else {
    priorHost.hidden = true;
  }

  $('confirm-sheet').hidden = false;
}
$('btn-confirm-cancel').addEventListener('click', () => { $('confirm-sheet').hidden = true; });
$('btn-confirm-ok').addEventListener('click', () => {
  $('confirm-sheet').hidden = true;
  if (state.pending) attemptRegister(state.pending.parsed, state.pending.key, false);
});

// 「また手元に来ましたか？」（前に自分が登録していたとき、サーバーに聞いて分かる）
$('btn-return-yes').addEventListener('click', () => {
  $('ask-return-sheet').hidden = true;
  if (state.pending) attemptRegister(state.pending.parsed, state.pending.key, true);
});
$('btn-return-no').addEventListener('click', () => { $('ask-return-sheet').hidden = true; });

async function attemptRegister(parsed, key, confirmedReturn) {
  if (!FB.isConfigured()) {
    finishRegister(parsed, key, { ok: true, first: true, comeback: false, offline: true });
    return;
  }
  const res = await FB.registerSighting(key, state.muniCode, { muniLatLng, distanceKm: Bill.distanceKm }, confirmedReturn);
  if (!res.ok) {
    if (res.reason === 'ask-return') {
      $('ask-return-text').textContent =
        `このお札は前に登録しています（${formatDateTime(res.lastAt)}・${muniLabel(res.lastMuni) || ''}）。また手元に来ましたか？`;
      $('ask-return-sheet').hidden = false;
    } else if (res.reason === 'too-soon') {
      showText('前の登録からまだ時間がたっていません', `前回 ${formatDateTime(res.lastAt)}・${muniLabel(res.lastMuni) || ''} に登録しています。しばらくしてからもう一度お試しください。`);
    } else if (res.reason === 'return-limit') {
      showText('登録できません', 'このお札はもう十分に登録されています。');
    } else if (res.reason === 'permission-denied') {
      toast('登録できませんでした（時間をおいて試してください）');
      sfx.error();
    } else {
      // resource-exhausted など: 混み合っているだけなので、登録は端末に残し、共有はあとで
      finishRegister(parsed, key, { ok: true, first: true, comeback: false, offline: true, congested: true });
    }
    return;
  }
  finishRegister(parsed, key, res);
}

function finishRegister(parsed, key, outcome) {
  const rareHits = Bill.rareChecks(parsed.digits, { series: parsed.series, prefix: parsed.prefix, suffix: parsed.suffix });
  const feature = rareHits.length ? null : Bill.smallFeature(parsed.digits);
  const newRare = rareHits.filter((r) => !dex.found[r.id]);
  for (const r of rareHits) if (!dex.found[r.id]) dex.found[r.id] = Date.now();
  if (outcome.comeback && !dex.found.kaiki) dex.found.kaiki = Date.now();
  // 昔のお札の図鑑の枠（仕様「19-7」）: 初めて登録したときだけ埋まる
  const oldFirst = !!state.noteType && !dex.found.mukashi;
  if (oldFirst) { dex.found.mukashi = Date.now(); sfx.dexComplete(); }
  if (newRare.length || outcome.comeback || oldFirst) saveDex();

  upsertMine(key, state.muniCode, outcome);
  if (settings.guided < 2) { settings.guided++; saveSettings(); $('guide').hidden = settings.guided >= 2; }
  state.flaggedIdx = [];
  showResult({ key, parsed, denom: state.denom, noteType: state.noteType, muniCode: state.muniCode, rareHits, feature, outcome, oldFirst });
}

function upsertMine(key, muniCode, outcome) {
  let entry = mine.bills.find((b) => b.key === key);
  if (!entry) {
    entry = { key, muni: muniCode, at: Date.now(), seen: outcome.n || 1, rare: [], km: 0, comebacks: 0 };
    mine.bills.unshift(entry);
  } else {
    entry.muni = muniCode;
    entry.at = Date.now();
    entry.seen = outcome.n || entry.seen;
    if (outcome.km) entry.km = (entry.km || 0) + outcome.km;
  }
  if (outcome.comeback) entry.comebacks = (entry.comebacks || 0) + 1;
  trimMine();
  saveMine();
}

// 1,000 件を超えたら、お気に入りでない・いちばん古い（at が小さい）ものから消す（仕様「18-6」）。
// お気に入りだけで 1,000 件あるときだけ、いちばん古いお気に入りを消す。
function trimMine() {
  while (mine.bills.length > 1000) {
    let idx = -1, oldestAt = Infinity;
    mine.bills.forEach((b, i) => { if (!b.fav && b.at < oldestAt) { idx = i; oldestAt = b.at; } });
    if (idx === -1) mine.bills.forEach((b, i) => { if (b.at < oldestAt) { idx = i; oldestAt = b.at; } });
    mine.bills.splice(idx, 1);
  }
}

// ---- 結果 ----

function showResult({ key, parsed, denom, noteType, muniCode, rareHits, feature, outcome, oldFirst }) {
  state.lastResultKey = key;
  const body = $('result-body');
  const here = muniLatLng(muniCode);
  body.replaceChildren();
  const add = (tag, cls, text) => { const e = el(tag, cls, text); body.appendChild(e); return e; };

  let loopLatLngs = null;
  if (outcome.comeback) {
    sfx.rare(); // おかえりは、レア番号と同じきらっとした音にする
    const loop = outcome.loop || [];
    loopLatLngs = loop.map((p) => muniLatLng(p.muni)).filter(Boolean);
    const totalKm = Bill.sumPathKm(loopLatLngs, Bill.distanceKm);
    if (outcome.handsBetween > 0) {
      add('h2', null, 'おかえりなさい');
      add('p', null, `${outcome.handsBetween} 人の手を渡って戻ってきました`);
      const b = document.createElement('b');
      b.textContent = `${Bill.formatDuration(Date.now() - outcome.prevAt)}で ${totalKm} km`;
      const p = add('p', null, null);
      p.appendChild(b);
      p.append(' の旅でした');
    } else {
      add('h2', null, 'おかえりなさい');
      add('p', null, `${Bill.formatDuration(Date.now() - outcome.prevAt)}ぶりに戻ってきました`);
      add('p', 'muted', '紙幣リレーを使っていない人の手も渡ってきたのかもしれません。');
    }
  } else if (outcome.first) {
    sfx.firstRegister();
    add('h2', null, '登録しました');
    add('p', null, `ここから旅が始まります — ${muniLabel(muniCode)}`);
    if (!outcome.offline) {
      add('p', 'muted', 'このお札は、まだあなただけの記録です。広まるほど、行方が見つかりやすくなります。');
    }
  } else {
    sfx.rediscoverArrive();
    const dur = Bill.formatDuration(Date.now() - outcome.prevAt);
    add('h2', null, '再発見！');
    add('p', null, `${muniLabel(outcome.prevMuni)} → ${muniLabel(muniCode)}`);
    const b = document.createElement('b');
    b.textContent = `${dur}で ${outcome.km} km`;
    const p = add('p', null, null);
    p.appendChild(b);
    p.append(' 旅してきました');
    add('p', 'muted', `このお札を手にした ${outcome.n} 人目`);
    // 再発見のときだけ、画像で共有するボタンを出す（仕様: お札の絵・記番号は入れない）
    state.shareImageData = {
      fromLabel: muniLabel(outcome.prevMuni), toLabel: muniLabel(muniCode),
      fromLL: muniLatLng(outcome.prevMuni), toLL: here,
      days: dur, km: outcome.km, n: outcome.n,
    };
  }
  if (outcome.first || outcome.comeback) state.shareImageData = null;
  $('btn-share-image').hidden = !state.shareImageData;
  if (outcome.congested) add('p', 'muted', CONGESTION_TEXT_REGISTER + ' 自分の記録には残しました。');
  else if (outcome.offline) add('p', 'muted', '共有の記録はまだ準備中です（サーバーの設定待ち）。自分の記録には残しました。');
  if (rareHits.length) {
    sfx.rare();
    for (const r of rareHits) add('p', 'rare-hit', `✨ ${r.name}（${r.odds}）`);
    add('p', 'muted', '珍しい番号でも、額面以上の価値は保証されません。');
    if (rareHits.some((r) => !dex.found[r.id])) sfx.dexComplete();
  } else if (feature && !outcome.comeback) {
    add('p', 'muted', feature);
  }
  if (oldFirst) add('p', 'rare-hit', '昔のお札を登録しました');
  const oldRow = noteType && Bill.NOTE_TYPES.find((t) => t.id === noteType);
  const denomParen = oldRow ? `${DENOM_LABEL[oldRow.denom]}・${oldRow.short}` : DENOM_LABEL[denom];
  add('p', 'muted', `${formatSerial(parsed)}（${denomParen}）`);

  if (outcome.comeback && loopLatLngs && loopLatLngs.length > 1) {
    const mapHost = document.createElement('div');
    mapHost.className = 'map-host';
    body.appendChild(mapHost);
    Map.mountMap(mapHost).then((svg) => {
      for (let i = 1; i < loopLatLngs.length; i++) Map.addLine(svg, loopLatLngs[i - 1], loopLatLngs[i]);
      loopLatLngs.forEach((p, i) => Map.addPoint(svg, p, { self: i === loopLatLngs.length - 1 }));
    });
  } else if (here) {
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

  // 一致がなかったとき（初めての登録）だけ、アプリを広める呼びかけを添える。押しつけがましく
  // 毎回出さないよう、再発見のとき（すでに嬉しい結果があるとき）は出さない。
  $('spread-group').hidden = !(outcome.first && !outcome.offline);
  $('btn-share-result').hidden = !$('spread-group').hidden; // 広めるボタンがあるときは、共有を並べない

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
$('btn-spread').addEventListener('click', spreadShare);
$('btn-spread-everyone').addEventListener('click', spreadShare);
$('btn-share-result').addEventListener('click', () => {
  const entry = mine.bills.find((b) => b.key === state.lastResultKey);
  if (!entry) return;
  WebAppKit.share({ text: `お札を 1 枚、リレーに出した（${muniLabel(entry.muni) || ''}から）#紙幣リレー`, url: APP_URL });
});
$('btn-journey').addEventListener('click', () => { if (state.lastResultKey) openJourney(state.lastResultKey); });
$('btn-share-image').addEventListener('click', () => { if (state.shareImageData) shareResultImage(state.shareImageData); });

// ---- 再発見の画像共有（お札の絵・記番号は入れない） ----

let outlineTextCache = null;
async function loadOutlineText() {
  if (outlineTextCache) return outlineTextCache;
  const res = await fetch('./data/japan.svg');
  outlineTextCache = await res.text();
  return outlineTextCache;
}

/** 2 点を結ぶ小さな地図（SVG）を <img> にして返す。読み込めなければ null */
async function buildRouteMapImage(fromLL, toLL) {
  if (!fromLL || !toLL) return null;
  try {
    const svgText = await loadOutlineText();
    const inner = svgText.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
    const p1 = Geo.project(fromLL.lat, fromLL.lng);
    const p2 = Geo.project(toLL.lat, toLL.lng);
    const vb = Map.tightViewBox([fromLL, toLL], 1200);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">`
      + '<style>path{fill:rgba(138,42,31,0.16);stroke:rgba(42,23,16,0.25);stroke-width:24}</style>'
      + inner
      + `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="#b8860b" stroke-width="60" stroke-linecap="round"/>`
      + `<circle cx="${p1.x}" cy="${p1.y}" r="70" fill="#b8860b"/>`
      + `<circle cx="${p2.x}" cy="${p2.y}" r="95" fill="#1f6fb2"/>`
      + '</svg>';
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally { URL.revokeObjectURL(url); }
  } catch { return null; } // 地図は無くても共有画像は作れる
}

/** 再発見の結果を 1200x630 の画像にする。お札の絵・記番号は描かない */
async function buildShareCanvas({ fromLabel, toLabel, fromLL, toLL, days, km, n }) {
  const W = 1200, H = 630;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f4ead8';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#8a2a1f';
  ctx.fillRect(0, 0, W, 16);

  ctx.fillStyle = '#2a1710';
  ctx.font = '700 32px sans-serif';
  ctx.fillText('紙幣リレー', 64, 90);

  ctx.font = '700 48px sans-serif';
  ctx.fillText(`${fromLabel || '？'} → ${toLabel || '？'}`, 64, 220, 620);

  ctx.font = '700 42px sans-serif';
  ctx.fillText(`${days}で ${km} km`, 64, 290, 620);
  ctx.font = '400 34px sans-serif';
  ctx.fillText('旅してきました', 64, 340, 620);

  ctx.fillStyle = '#7a6152';
  ctx.font = '400 30px sans-serif';
  ctx.fillText(`このお札を手にした ${n} 人目`, 64, 400, 620);

  ctx.font = '400 26px sans-serif';
  ctx.fillText('shihei-relay.t-of.workers.dev ・ #紙幣リレー', 64, H - 48, 900);

  const mapImg = await buildRouteMapImage(fromLL, toLL);
  if (mapImg) ctx.drawImage(mapImg, 700, 60, 440, 500);

  return canvas;
}

async function shareResultImage(data) {
  const text = `${data.fromLabel || ''} → ${data.toLabel || ''}\n${data.days}で ${data.km} km 旅してきました（${data.n} 人目）#紙幣リレー`;
  if (navigator.canShare) {
    try {
      const canvas = await buildShareCanvas(data);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      if (blob) {
        const file = new File([blob], 'shihei-relay.png', { type: 'image/png' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], text, url: APP_URL });
          return;
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return; // キャンセルは何もしない
    }
  }
  WebAppKit.share({ text, url: APP_URL });
}

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
    // r は Firestore から来た値（fetchJourney）なので、textContent で入れる（innerHTML に入れない）。
    const row = document.createElement('div');
    row.className = 'journey-row';
    const when = new Date(r.at).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const left = document.createElement('span');
    left.textContent = `${when} ・ ${muniLabel(r.muni) || ''}`;
    row.appendChild(left);
    if (i > 0) {
      const right = document.createElement('span');
      right.className = 'muted';
      right.textContent = `前から ${Bill.distanceKm(rows[i - 1].ll.lat, rows[i - 1].ll.lng, r.ll.lat, r.ll.lng)} km`;
      row.appendChild(right);
    }
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
        frame: document.querySelector('.cam-frame'),
        denom: () => state.denom,
        typeId: () => state.noteType,
        onTick: (text) => { $('cam-hint').textContent = text ? `読んでいます: ${text.replace(/\s+/g, ' ').slice(0, 20)}` : '記番号を枠に合わせてください'; },
        onMatch: (serial, cand) => {
          sfx.camHit();
          if (navigator.vibrate) navigator.vibrate(30);
          state.buffer = serial;
          state.flaggedIdx = Bill.flagIndices(cand);
          closeCameraView();
          renderSerial();
          toast('読み取った番号です。お札と見比べてください');
        },
        onTimeout: (partial) => {
          sfx.camMiss();
          closeCameraView();
          if (partial) { state.buffer = partial; state.flaggedIdx = []; }
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
    b.setAttribute('aria-pressed', String(!state.noteType && d === state.denom));
    b.addEventListener('click', () => { state.denom = d; state.noteType = null; renderCamDenoms(); sfx.choice(); });
    host.appendChild(b);
  }
  // 昔のお札を選んでいるときだけ、その札の名を明るく出す（撮影の画面ではシートを開かない。閉じて入力で変える）
  const oldRow = state.noteType && Bill.NOTE_TYPES.find((t) => t.id === state.noteType);
  if (oldRow) {
    const b = document.createElement('button');
    b.textContent = oldRow.short;
    b.setAttribute('aria-pressed', 'true');
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
  if (cand) {
    state.buffer = `${cand.prefix}${cand.digits}${cand.suffix}`;
    state.flaggedIdx = Bill.flagIndices(cand);
    renderSerial();
    toast('読み取った番号です。お札と見比べてください');
  }
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
//
// 一覧（仕様「18」）は別の画面にせず、「記録を見る」ボタンでこの場で開閉する（オーナーの決定、20 節）。
// 開閉の状態はページを開いている間だけ覚える（保存しない）。

let mineListOpen = false;

function billRareHits(b) {
  const p = Bill.parseKey(b.key);
  return p ? Bill.rareChecks(p.digits, { series: p.series, prefix: p.prefix, suffix: p.suffix }) : [];
}

function renderMine() {
  const total = mine.bills.length;
  const rediscovered = mine.bills.filter((b) => (b.seen || 1) > 1).length;
  const totalKm = mine.bills.reduce((s, b) => s + (b.km || 0), 0);
  const muniCount = new Set(mine.bills.map((b) => b.muni)).size;
  const summaryHost = $('mine-summary');
  summaryHost.replaceChildren();
  for (const [label, val] of [
    ['登録', `${total} 枚`], ['再発見', `${rediscovered} 枚`], ['旅した合計', `${totalKm} km`], ['登録した市区町村', `${muniCount}`],
  ]) summaryHost.appendChild(statCard(label, val));

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
  const NAMES = {
    zorome: 'ゾロ目', kiriban: 'キリ番', wakai: '若い番号', kaidan: '階段', kagami: '鏡',
    kurikaeshi: 'くり返し', zorozoro: 'ぞろぞろ', eiji: '英字もそろう',
    kaiki: '戻ってきたお札', mukashi: '昔のお札',
  };
  // 「戻ってきたお札」「昔のお札」は、番号の判定とは別の枠として同じ図鑑に並べる
  for (const id of [...Bill.RARE_IDS, 'kaiki', 'mukashi']) {
    dexHost.appendChild(el('div', `slot ${dex.found[id] ? 'got' : 'pending'}`, NAMES[id] || id));
  }

  const toggle = $('btn-mine-toggle');
  const recordsHost = $('mine-records');
  const emptyHost = $('mine-empty');
  const emptyBtn = $('btn-mine-empty-register');
  if (total === 0) {
    toggle.hidden = true;
    recordsHost.hidden = true;
    emptyHost.hidden = false;
    emptyBtn.hidden = false;
    return;
  }
  emptyHost.hidden = true;
  emptyBtn.hidden = true;
  toggle.hidden = false;
  toggle.textContent = mineListOpen ? '閉じる ▲' : `記録を見る（${total} 枚）›`;
  toggle.setAttribute('aria-expanded', String(mineListOpen));
  recordsHost.hidden = !mineListOpen;
  if (mineListOpen) renderMineList();
}
$('btn-mine-toggle').addEventListener('click', () => {
  mineListOpen = !mineListOpen;
  sfx.choice();
  renderMine();
});
$('btn-mine-empty-register').addEventListener('click', () => switchTab('input'));

const DENOM_GROUP_ORDER = [10000, 5000, 2000, 1000, 500, 100, 50];

function renderMineList() {
  const favCount = mine.bills.filter((b) => b.fav).length;
  const rareCount = mine.bills.filter((b) => billRareHits(b).length > 0).length;
  const filterHost = $('mine-filter');
  filterHost.replaceChildren();
  for (const [id, label] of [
    ['all', `すべて ${mine.bills.length}`], ['fav', `★ お気に入り ${favCount}`], ['rare', `✨ レア ${rareCount}`],
  ]) {
    const b = document.createElement('button');
    b.textContent = label;
    b.setAttribute('aria-pressed', String(settings.listFilter === id));
    b.addEventListener('click', () => { settings.listFilter = id; saveSettings(); sfx.choice(); renderMineList(); });
    filterHost.appendChild(b);
  }

  $('mine-sort').value = settings.listSort;

  let list = mine.bills;
  if (settings.listFilter === 'fav') list = list.filter((b) => b.fav);
  else if (settings.listFilter === 'rare') list = list.filter((b) => billRareHits(b).length > 0);

  const groupsHost = $('mine-groups');
  groupsHost.replaceChildren();
  if (list.length === 0) {
    const msg = settings.listFilter === 'fav' ? '★ を押したお札が、ここに集まります'
      : settings.listFilter === 'rare' ? 'レア番号のお札はまだありません' : 'まだ登録したお札はありません';
    groupsHost.appendChild(el('p', 'muted', msg));
    return;
  }

  for (const d of DENOM_GROUP_ORDER) {
    const rows = list.filter((b) => Bill.parseKey(b.key)?.denom === d);
    if (!rows.length) continue;
    rows.sort((a, b) => Bill.compareBills(a, b, settings.listSort));
    const details = document.createElement('details');
    details.open = true;
    details.addEventListener('toggle', () => sfx.choice());
    details.appendChild(el('summary', null, `${DENOM_LABEL[d]}札 ${rows.length} 枚`));
    const rowsHost = el('div', 'bill-list');
    for (const b of rows) rowsHost.appendChild(billRow(b));
    details.appendChild(rowsHost);
    groupsHost.appendChild(details);
  }
}
$('mine-sort').addEventListener('change', (e) => { settings.listSort = e.target.value; saveSettings(); sfx.choice(); renderMineList(); });

function billRow(b) {
  const p = Bill.parseKey(b.key);
  const row = el('div', 'rec-row');
  const main = el('div', 'rec-main');
  const line1 = el('div', 'rec-line1');
  if (p) {
    if (Bill.colorsFor(p.series, p.denom).length > 1) {
      const dot = el('span', 'rec-dot');
      dot.style.background = COLOR_CSS[p.color] || '#888';
      line1.appendChild(dot);
      line1.appendChild(el('span', 'muted', Bill.COLOR_NAME[p.color] || ''));
    }
    line1.appendChild(el('span', 'rec-serial', formatSerial(p)));
    const noteRow = Bill.NOTE_TYPES.find((t) => t.id === p.typeId);
    if (noteRow?.old) line1.appendChild(el('span', 'badge badge--old', noteRow.short));
    for (const r of billRareHits(b)) line1.appendChild(el('span', 'badge badge--rare', `✨${r.name}`));
  } else {
    line1.appendChild(el('span', 'rec-serial', b.key));
  }
  main.appendChild(line1);

  const parts = [muniLabel(b.muni), formatDateTime(b.at)].filter(Boolean);
  if (b.km) parts.push(`${b.km} km`);
  if (b.comebacks) parts.push(`おかえり×${b.comebacks}`);
  main.appendChild(el('div', 'rec-line2 muted', parts.join(' ・ ')));
  row.appendChild(main);

  const fav = document.createElement('button');
  fav.className = 'rec-fav';
  fav.setAttribute('aria-label', 'お気に入り');
  fav.setAttribute('aria-pressed', String(!!b.fav));
  fav.textContent = b.fav ? '★' : '☆';
  fav.addEventListener('click', (e) => {
    e.stopPropagation();
    if (b.fav) delete b.fav; else { b.fav = true; sfx.choice(); }
    saveMine();
    renderMineList();
  });
  row.appendChild(fav);

  row.addEventListener('click', () => openJourney(b.key));
  return row;
}

// 外から来た文字（Firestore の値など）を innerHTML に入れないための小さな組み立て。
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function statCard(label, val) {
  const card = el('div', 'card');
  card.appendChild(el('b', null, val));
  card.appendChild(el('span', null, label));
  return card;
}

// ---- みんな ----

// 再発見がこの件数を下回るうちは、「広める」の呼びかけをみんなの画面の上に出す。
const SPREAD_THRESHOLD = 5;

// 上限（resource-exhausted）や network の失敗のときの案内。permission-denied（形の不正など）は含めない。
const CONGESTION_TEXT_REGISTER = '登録が混み合っているか、通信がつながらないため、みんなとの照合ができませんでした。日本時間の夕方（17 時ごろ）より後にもう一度お試しください。';
const CONGESTION_TEXT_VIEW = 'アクセスが混み合っているか、通信がつながらないため、みんなの画面を出せません。日本時間の夕方（17 時ごろ）より後にもう一度お試しください。';
const isCongested = (res) => !res.ok && res.reason !== 'permission-denied';

// 「みんな」タブは開くたびに読み取りが多い（再発見数・最長の旅・最近 20 件で約 22 回）ので、
// 5 分間は端末に取っておいた結果を使い回す（Firestore 無料枠を守るため）。
const EVERYONE_CACHE_KEY = 'everyoneCache';
const EVERYONE_CACHE_TTL_MS = 5 * 60 * 1000;
function loadEveryoneCache() {
  try {
    const raw = sessionStorage.getItem(STORE + EVERYONE_CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (!c || Date.now() - c.at > EVERYONE_CACHE_TTL_MS) return null;
    return c;
  } catch { return null; }
}
function saveEveryoneCache(stats, hits) {
  try { sessionStorage.setItem(STORE + EVERYONE_CACHE_KEY, JSON.stringify({ at: Date.now(), stats, hits })); } catch { /* 取っておけなくても遊べる */ }
}

async function renderEveryone() {
  const statsHost = $('global-stats');
  if (!FB.isConfigured()) {
    $('spread-banner').hidden = true;
    statsHost.replaceChildren(el('div', 'card', null));
    statsHost.firstChild.appendChild(el('span', null, '準備中です（サーバーの設定待ち）'));
    $('hit-list').replaceChildren();
    return;
  }
  // stats.hitCount・longestKm、hits.rows の中身（h.from・h.to・h.km・h.mins）はすべて Firestore から来た値。
  // innerHTML に入れず、textContent で入れる（RULES.md §1 の推奨）。
  const cached = loadEveryoneCache();
  let stats, hits;
  if (cached) {
    ({ stats, hits } = cached);
  } else {
    [stats, hits] = await Promise.all([FB.fetchGlobalStats(), FB.fetchRecentHits(20)]);
    saveEveryoneCache(stats, hits);
  }
  if (stats.ok) {
    statsHost.replaceChildren();
    statsHost.appendChild(statCard('再発見', `${stats.hitCount} 件`));
    statsHost.appendChild(statCard('最長の旅', `${stats.longestKm} km`));
  } else if (isCongested(stats)) {
    statsHost.replaceChildren(el('div', 'card', null));
    statsHost.firstChild.appendChild(el('span', null, CONGESTION_TEXT_VIEW));
  }
  const few = stats.ok ? stats.hitCount < SPREAD_THRESHOLD : (hits.ok && hits.rows.length < SPREAD_THRESHOLD);
  $('spread-banner').hidden = !few;
  const listHost = $('hit-list');
  listHost.replaceChildren();
  if (!hits.ok) {
    if (isCongested(hits)) listHost.appendChild(el('p', 'muted', CONGESTION_TEXT_VIEW));
    return;
  }
  if (hits.rows.length === 0) {
    listHost.appendChild(el('p', 'muted', 'まだ再発見はありません。リレーのリンクで最初の 1 本をつなごう'));
    return;
  }
  for (const h of hits.rows) {
    const row = el('div', 'hit-row');
    const label = h.comeback ? `🔁 ${muniLabel(h.from) || ''} → ${muniLabel(h.to) || ''}` : `${muniLabel(h.from) || ''} → ${muniLabel(h.to) || ''}`;
    row.appendChild(el('span', null, label));
    row.appendChild(el('span', 'muted', `${h.km} km・${Bill.formatDuration(h.mins * 60000)}`));
    listHost.appendChild(row);
  }
}

// ---- 設定 ----

$('btn-settings').addEventListener('click', openSettings);
$('btn-settings-close').addEventListener('click', () => $('settings-view').hidden = true);
function openSettings() {
  $('opt-sound').checked = settings.sound;
  $('opt-input').value = settings.input;
  $('opt-theme').value = settings.theme || 'auto';
  $('settings-view').hidden = false;
}
$('opt-sound').addEventListener('change', (e) => { settings.sound = e.target.checked; setSoundOn(settings.sound); saveSettings(); });
$('opt-input').addEventListener('change', (e) => { settings.input = e.target.value; saveSettings(); });
$('opt-theme').addEventListener('change', (e) => { settings.theme = e.target.value; saveSettings(); applyTheme(settings.theme); });

const TERMS_TEXT = `紙幣リレーは無料で使えます。使うと、次のことに同意したものとします。

・登録は、手元にある本物のお札だけにしてください。持っていないお札の記番号や、でたらめな場所を登録しないでください。
・お札に書き込んだり、傷つけたりしないでください。
・登録された場所や日時は、使う人が入れたものです。正しいとは限りません。
・珍しい番号でも、額面以上の価値は保証されません。高く買い取ると持ちかける人や、警察・銀行を名乗ってお札の番号を聞く人には気をつけてください。
・いたずらと思われる登録は、知らせずに消すことがあります。
・アプリは予告なく変えたり、止めたりすることがあります。これで生じた損害の責任は負いかねます（法律で認められない場合を除きます）。
・サービスを終えるときは、できるだけ前もってアプリの中で知らせ、送られた登録は消します。
・未成年の方は、保護者の方と相談のうえで使ってください。
・今後、アプリの中に広告を出すことがあります。
・送る情報と見える範囲は「プライバシー」のページのとおりです。
・この規約を変えるときは、このアプリの中で知らせます。

問い合わせ: https://t-of.github.io/contact/`;
const CREDIT_TEXT = `市区町村の緯度経度・コード: 総務省・国土交通省の公開データを含む jp-address-search（MIT License, uiuifree）
日本の輪郭: Natural Earth（パブリックドメイン）
文字を読む部品: Tesseract.js / tesseract.js-core（Apache License 2.0）
英語の学習データ: tessdata_fast（Apache License 2.0, tesseract-ocr）`;
$('link-terms').addEventListener('click', (e) => { e.preventDefault(); showText('利用規約', TERMS_TEXT); });
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
  const parsed = Bill.parseKey(key); // 昔のお札の鍵も含めて、形の確かめを通ったものだけ使う
  if (!parsed) return;
  state.denom = parsed.denom;
  state.noteType = parsed.old ? parsed.typeId : null;
  state.buffer = parsed.serial;
  state.color = parsed.color;
  state.relayKey = key;
  settings.lastDenom = state.denom; settings.lastNoteType = state.noteType; saveSettings();
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
renderSerial(); // renderKeypad も内部で呼ぶ
renderPlace();
tryRelayLink();
