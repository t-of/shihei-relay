'use strict';

// 紙幣の記番号まわりの純粋なロジック（DOM に触れない。node --test からそのまま読める）。
// 号券・券種・色・形は仕様「7. 記番号の形と判定」のとおり。

// 記番号に使う英字は 24 文字（I・O を使わない）。
export const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export const DENOMS = [1000, 2000, 5000, 10000];

// 券種の表(仕様「19-3」)。号券・券種の組み合わせごとに、使える色・記番号の形(pre=頭の英字の最大の数、
// suf=末尾の英字の数の候補)をここに 1 つだけ置く。old: true は「もっと見る」に出す、今は発行していないお札。
export const NOTE_TYPES = [
  { id: 'F10000', series: 'F', denom: 10000, colors: ['K'], pre: 2, suf: [2] },
  { id: 'F5000', series: 'F', denom: 5000, colors: ['K'], pre: 2, suf: [2] },
  { id: 'F1000', series: 'F', denom: 1000, colors: ['K'], pre: 2, suf: [2] },
  { id: 'E10000', series: 'E', denom: 10000, colors: ['K', 'B'], pre: 2, suf: [1] },
  { id: 'E5000', series: 'E', denom: 5000, colors: ['K', 'B'], pre: 2, suf: [1] },
  { id: 'E1000', series: 'E', denom: 1000, colors: ['K', 'B', 'N'], pre: 2, suf: [1] },
  { id: 'D2000', series: 'D', denom: 2000, colors: ['K'], pre: 2, suf: [1] },
  // ---- 昔のお札（仕様「19」。今は発行していないが法的に有効） ----
  { id: 'D10000', series: 'D', denom: 10000, colors: ['K', 'B'], pre: 2, suf: [1], old: true, portrait: '福沢諭吉', from: 1984, short: '昔・福沢諭吉' },
  { id: 'C10000', series: 'C', denom: 10000, colors: ['K'], pre: 2, suf: [1], old: true, portrait: '聖徳太子', from: 1958, short: '昔・聖徳太子' },
  { id: 'D5000', series: 'D', denom: 5000, colors: ['K', 'B'], pre: 2, suf: [1], old: true, portrait: '新渡戸稲造', from: 1984, short: '昔・新渡戸稲造' },
  { id: 'C5000', series: 'C', denom: 5000, colors: ['K'], pre: 2, suf: [1], old: true, portrait: '聖徳太子', from: 1957, short: '昔・聖徳太子' },
  { id: 'D1000', series: 'D', denom: 1000, colors: ['K', 'U', 'B', 'G'], pre: 2, suf: [1], old: true, portrait: '夏目漱石', from: 1984, short: '昔・夏目漱石' },
  { id: 'C1000', series: 'C', denom: 1000, colors: ['K', 'U'], pre: 2, suf: [1], old: true, portrait: '伊藤博文', from: 1963, short: '昔・伊藤博文' },
  { id: 'B1000', series: 'B', denom: 1000, colors: ['K'], pre: 2, suf: [1], old: true, portrait: '聖徳太子', from: 1950, short: '昔・聖徳太子' },
  { id: 'C500', series: 'C', denom: 500, colors: ['K'], pre: 2, suf: [1], old: true, portrait: '岩倉具視', from: 1969, short: '昔・岩倉具視' },
  { id: 'B500', series: 'B', denom: 500, colors: ['K'], pre: 2, suf: [1], old: true, portrait: '岩倉具視', from: 1951, short: '昔・岩倉具視' },
  { id: 'B100', series: 'B', denom: 100, colors: ['K'], pre: 2, suf: [1], old: true, portrait: '板垣退助', from: 1953, short: '昔・板垣退助' },
  { id: 'B50', series: 'B', denom: 50, colors: ['K'], pre: 1, suf: [1], old: true, portrait: '高橋是清', from: 1951, short: '昔・高橋是清' },
];

export const COLOR_NAME = { K: '黒', B: '茶', N: '紺', U: '青', G: '緑' };

const RE_F = /^[A-HJ-NP-Z]{2}[0-9]{6}[A-HJ-NP-Z]{2}$/;
const RE_1 = /^[A-HJ-NP-Z]{1,2}[0-9]{6}[A-HJ-NP-Z]$/; // E・D 号券

function noteType(id) { return NOTE_TYPES.find((t) => t.id === id); }

/** 号券・券種に使える色の一覧。分からない組み合わせは空配列 */
export function colorsFor(series, denom) {
  const row = NOTE_TYPES.find((t) => t.series === series && t.denom === denom);
  return row ? row.colors : [];
}

/** 末尾の英字が 2 文字なら F 号券、1 文字なら E 号券（1 万・5 千・千のみ）。2 千円は常に D 号券 */
export function seriesFor(denom, tailLen) {
  if (denom === 2000) return 'D';
  return tailLen === 2 ? 'F' : 'E';
}

// ---- 表記のゆれの直し（全角→半角、小文字→大文字、空白・ハイフンを消す） ----

const ZEN_TABLE = (() => {
  const m = {};
  for (let i = 0; i < 10; i++) m[String.fromCharCode(0xFF10 + i)] = String(i);
  for (let i = 0; i < 26; i++) {
    m[String.fromCharCode(0xFF21 + i)] = String.fromCharCode(0x41 + i); // 全角 A-Z
    m[String.fromCharCode(0xFF41 + i)] = String.fromCharCode(0x41 + i); // 全角 a-z → 半角大文字
  }
  return m;
})();

/** 全角の数字・英字を半角に、小文字を大文字に、空白・ハイフンを取る */
export function normalize(raw) {
  return String(raw ?? '')
    .split('').map((c) => ZEN_TABLE[c] || c).join('')
    .toUpperCase()
    .replace(/[\s\-ー－]/g, '');
}

// ---- 記番号の判定 ----

/**
 * 記番号の文字列を、券種に合う号券の形へ当てはめる。
 * @param {string} raw 打った・読んだ文字（正規化前でもよい）
 * @param {number} denom 1000/2000/5000/10000（typeId があるときは、その行の denom と同じはず）
 * @param {string|null} typeId NOTE_TYPES の id。「もっと見る」で選んだ昔のお札のとき。無ければ形から号券を自動判定
 * @returns {{ ok: true, series: string, prefix: string, digits: string, suffix: string, serial: string }
 *          | { ok: false, reason: string }}
 */
export function parseSerial(raw, denom, typeId = null) {
  const s = normalize(raw);

  if (typeId) {
    const row = noteType(typeId);
    if (!row || row.denom !== denom) return { ok: false, reason: '券種が不明' };
    const preRange = row.pre === 1 ? '{1}' : '{1,2}';
    for (const sufLen of [...row.suf].sort((a, b) => b - a)) {
      const re = new RegExp(`^([A-HJ-NP-Z]${preRange})([0-9]{6})([A-HJ-NP-Z]{${sufLen}})$`);
      const m = s.match(re);
      if (!m) continue;
      const [, prefix, digits, suffix] = m;
      const n = parseInt(digits, 10);
      if (n < 1 || n > 900000) return { ok: false, reason: '数字が範囲外（000001〜900000）' };
      return { ok: true, series: row.series, prefix, digits, suffix, serial: `${prefix}${digits}${suffix}` };
    }
    return { ok: false, reason: '記番号の形に合いません' };
  }

  if (!DENOMS.includes(denom)) return { ok: false, reason: '券種が不明' };

  // F 号券の形（英字 2 + 数字 6 + 英字 2）を先に、次に E・D 号券の形（英字 1〜2 + 数字 6 + 英字 1）を試す。
  const attempts = denom === 2000
    ? [[RE_1, /^([A-Z]{1,2})([0-9]{6})([A-Z])$/]]
    : [[RE_F, /^([A-Z]{2})([0-9]{6})([A-Z]{2})$/], [RE_1, /^([A-Z]{1,2})([0-9]{6})([A-Z])$/]];

  for (const [pattern, capture] of attempts) {
    if (!pattern.test(s)) continue;
    const m = s.match(capture);
    if (!m) continue;
    const [, prefix, digits, suffix] = m;
    const n = parseInt(digits, 10);
    if (n < 1 || n > 900000) return { ok: false, reason: '数字が範囲外（000001〜900000）' };
    const series = seriesFor(denom, suffix.length);
    return { ok: true, series, prefix, digits, suffix, serial: `${prefix}${digits}${suffix}` };
  }
  return { ok: false, reason: '記番号の形に合いません' };
}

/**
 * いまの位置（buffer の続き）で次に打てるのは英字か数字かを返す。
 * キーパッド側はこれを見て、その位置で入りうる文字だけを大きく出す（仕様「4-2」）。
 *
 * 記番号は「英字 1〜2 + 数字 6 + 英字 1〜2」の並び（F 号券だけ両端 2 文字、2 千円は末尾 1 文字だけ）。
 * 先頭は必ず英字。2 文字目は、英字の続き（頭 2 文字＝F 号券の形）か、もう数字が始まる（頭 1 文字）か
 * まだ決まらないので両方を返す。数字が 6 桁そろったら次は英字、そこから先は号券が決まっているかどうかで
 * もう 1 文字打てるかが決まる。
 * @param {string|null} typeId NOTE_TYPES の id。昔のお札を選んでいるとき
 * @returns {'letter' | 'digit' | 'either' | null} null は、これ以上打っても形に合わないとき
 */
export function nextKind(buffer, denom, typeId = null) {
  const s = normalize(buffer);
  const n = s.length;
  if (n === 0) return 'letter';

  const row = typeId ? noteType(typeId) : null;
  const preMax = row ? row.pre : 2;

  const firstDigitIdx = [...s].findIndex((c) => /[0-9]/.test(c));
  if (firstDigitIdx === -1) {
    // まだ数字が出てきていない＝頭の英字の途中
    if (preMax === 1) return 'digit'; // 頭は必ず 1 文字（B50 など）。もう数字の始まり
    if (n === 1) return 'either'; // 頭が 1 文字（もう数字が始まる）か 2 文字（もう 1 英字）か、まだ決まらない
    return 'digit'; // 頭の英字は 2 文字まで。次は数字の始まり
  }

  const prefixLen = firstDigitIdx;
  const digitsTyped = n - prefixLen;
  if (digitsTyped < 6) return 'digit';
  if (digitsTyped === 6) return 'letter'; // 末尾の英字 1 文字目
  if (digitsTyped === 7) {
    // 2 文字目の英字が打てるのは F 号券の形（頭 2 文字・末尾 2 文字）のときだけ。
    // 2 千円は D 号券だけなので末尾は常に 1 文字。昔のお札(row)は末尾 1 文字のものしか無い。
    const maxSuf = row ? Math.max(...row.suf) : (denom !== 2000 ? 2 : 1);
    return maxSuf >= 2 && prefixLen === preMax ? 'letter' : null;
  }
  return null; // もう形は完成している
}

/** お札の鍵を組み立てる。例: F10000K-AB123456CD */
export function buildKey({ series, denom, color, serial }) {
  return `${series}${denom}${color}-${serial}`;
}

/** 記番号の完成した見た目かどうか（キーパッド側で「登録」を押せるかに使う） */
export function isComplete(raw, denom) {
  return parseSerial(raw, denom).ok;
}

/**
 * お札の鍵を分ける（仕様「19-4」）。`<号券><券種><色>-<記番号>` の形と、券種・色・号券・記番号の
 * 組み合わせが NOTE_TYPES にあるものだけを返す。合わなければ null（一覧・自分の記録の並びに使う）。
 * @returns {{ series, denom, color, typeId, prefix, digits, suffix, serial, old } | null}
 */
export function parseKey(key) {
  const m = String(key).match(/^([BCDEF])(\d+)([KBNUG])-(.+)$/);
  if (!m) return null;
  const [, series, denomStr, color] = m;
  const denom = Number(denomStr);
  const row = NOTE_TYPES.find((t) => t.series === series && t.denom === denom);
  if (!row || !row.colors.includes(color)) return null;
  const parsed = parseSerial(m[4], denom, row.old ? row.id : null);
  if (!parsed.ok || parsed.series !== series) return null;
  return {
    series, denom, color, typeId: row.id, old: !!row.old,
    prefix: parsed.prefix, digits: parsed.digits, suffix: parsed.suffix, serial: parsed.serial,
  };
}

// ---- カメラで読んだ文字の直し（仕様 8-2 の置き換え表） ----

// 数字の場所での読み違い。ここに無い文字は「あやしい文字」として残す。
const TO_DIGIT = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', G: '6', B: '8', T: '7' };

/** OCR が数字の場所で読んだ 1 文字を、ありうる数字に直す（直せなければ null） */
export function correctDigit(ch) {
  if (/[0-9]/.test(ch)) return ch;
  return TO_DIGIT[ch] ?? null;
}

/**
 * OCR の生の文字列から「英字 1〜2 + 数字 6 + 英字 1〜2」の並びを探し、直しながら組み立てる。
 * 英字の場所に数字が来たときは直さず、その文字はそのまま「あやしい」印を付けて返す。
 * @returns {{ prefix: string, digits: string, suffix: string, suspicious: number[] } | null}
 */
export function extractSerialCandidate(rawOcrText) {
  const s = normalize(rawOcrText).replace(/[^A-Z0-9]/g, '');
  // 数字 6 桁になりそうな窓を総当たりで探す（前後の余計な文字は捨てる）。
  // B・D・G・L・S・T・Z は英字にも数字の読み違いにもなりうるので、まず「そのまま数字だけの窓」を
  // 優先し（strict）、それが無いときだけ読み違いの直しを使う窓を探す（strict でない）。
  // こうしないと、その手前の英字まで数字の続きとして飲み込んでしまうことがある。
  for (const strict of [true, false]) {
    for (let start = 0; start <= s.length - 6; start++) {
      const digitsWindow = s.slice(start, start + 6);
      if (strict && !/^[0-9]{6}$/.test(digitsWindow)) continue;
      const digits = [...digitsWindow].map(correctDigit);
      if (digits.some((d) => d === null)) continue;
      const before = s.slice(0, start);
      const after = s.slice(start + 6);
      // 直した数字の場所（元の文字と違っていた桁）。確認画面で色を変えて出す
      const corrected = [];
      [...digitsWindow].forEach((ch, i) => { if (ch !== digits[i]) corrected.push(i); });
      for (const plen of [2, 1]) {
        for (const slen of [2, 1]) {
          if (before.length < plen || after.length < slen) continue;
          const prefix = before.slice(-plen);
          const suffix = after.slice(0, slen);
          const suspicious = [];
          const letters = [...prefix, ...suffix];
          let bad = false;
          letters.forEach((ch, i) => {
            if (!ALPHABET.includes(ch)) { suspicious.push(i); if (/[0-9]/.test(ch)) return; bad = true; }
          });
          if (bad) continue;
          return { prefix, digits: digits.join(''), suffix, suspicious, corrected };
        }
      }
    }
  }
  return null;
}

/**
 * extractSerialCandidate が返す suspicious（英字部分の場所）・corrected（数字部分の場所）を、
 * 「prefix + digits + suffix」を並べた記番号全体の中の場所（0 始まり）にまとめる。
 * 確認画面で、直した・あやしい文字だけ色を変えて出すのに使う。
 */
export function flagIndices(cand) {
  if (!cand) return [];
  const { prefix, suspicious = [], corrected = [] } = cand;
  const out = new Set();
  // letters = [...prefix, ...suffix]。suffix 側（i >= prefix.length）は、間に数字 6 桁が挟まる分だけ後ろへずらす
  for (const i of suspicious) out.add(i < prefix.length ? i : i + 6);
  for (const i of corrected) out.add(prefix.length + i);
  return [...out].sort((a, b) => a - b);
}

// ---- レア番号の判定（端末の中だけ） ----

const RARE_DEFS = [
  { id: 'zorome', name: 'ゾロ目', odds: '90 万枚に 9 枚', test: (d) => new Set(d).size === 1 },
  { id: 'kiriban', name: 'キリ番', odds: '90 万枚に 9 枚', test: (d) => d.slice(1) === '00000' },
  { id: 'wakai', name: '若い番号', odds: '90 万枚に 100 枚', test: (d) => parseInt(d, 10) >= 1 && parseInt(d, 10) <= 100 },
  {
    id: 'kaidan', name: '階段', odds: '90 万枚に 9 枚ほど',
    test: (d) => {
      const nums = [...d].map(Number);
      const up = nums.every((n, i) => i === 0 || n === (nums[i - 1] + 1) % 10);
      const down = nums.every((n, i) => i === 0 || n === (nums[i - 1] + 9) % 10);
      return up || down;
    },
  },
  { id: 'kagami', name: '鏡', odds: '90 万枚に 900 枚', test: (d) => d === [...d].reverse().join('') },
  { id: 'kurikaeshi', name: 'くり返し', odds: '90 万枚に 990 枚ほど', test: (d) => d.slice(0, 3) === d.slice(3) || (d.slice(0, 2) === d.slice(2, 4) && d.slice(2, 4) === d.slice(4)) },
  { id: 'zorozoro', name: 'ぞろぞろ', odds: '90 万枚に 450 枚ほど', test: (d) => Math.max(...Object.values(tally(d))) >= 5 },
];
const RARE_LETTERS = { id: 'eiji', name: '英字もそろう', odds: '576 分の 1（F 号券）', test: () => false };

function tally(digits) {
  const t = {};
  for (const c of digits) t[c] = (t[c] || 0) + 1;
  return t;
}

/**
 * 記番号の 6 桁がレア番号に当たるかを判定する。英字もそろう（F 号券）は series・prefix・suffix が要る。
 * @returns {{ id: string, name: string, odds: string }[]} 当たった判定（複数のことがある）
 */
export function rareChecks(digits, opts = {}) {
  const hits = RARE_DEFS.filter((r) => r.test(digits)).map(({ id, name, odds }) => ({ id, name, odds }));
  if (opts.series === 'F' && opts.prefix && opts.suffix && opts.prefix === opts.suffix) {
    hits.push({ id: RARE_LETTERS.id, name: RARE_LETTERS.name, odds: RARE_LETTERS.odds });
  }
  return hits;
}

/** レア番号に当たらなかったときの、いつも出す小さな特徴（1 行） */
export function smallFeature(digits) {
  const nums = [...digits].map(Number);
  const sum = nums.reduce((a, b) => a + b, 0);
  const freq = tally(digits);
  const [topDigit, topCount] = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
  const band = digits.slice(0, 2).replace(/^0+/, '') || '0';
  return `数字の合計 ${sum}・「${topDigit}」が ${topCount} 個・${band}万番台`;
}

export const RARE_IDS = [...RARE_DEFS.map((r) => r.id), RARE_LETTERS.id];

// 珍しさの順（一覧の「レア順」に使う。仕様「18-5」）。判定を足したらここにも足す。
export const RARE_RANK = ['zorome', 'kiriban', 'kaidan', 'wakai', 'kagami', 'zorozoro', 'kurikaeshi', 'eiji'];

/** そのお札のいちばん珍しい判定の順位と、当たった数（レアでなければ null。一覧の「レア順」に使う） */
function rareInfo(bill) {
  const p = parseKey(bill.key);
  if (!p) return null;
  const hits = rareChecks(p.digits, { series: p.series, prefix: p.prefix, suffix: p.suffix });
  if (!hits.length) return null;
  return { bestRank: Math.min(...hits.map((h) => RARE_RANK.indexOf(h.id))), count: hits.length };
}

/**
 * 一覧の並び替え（仕様「18-5」）。券種のまとまりの中でこの順に並べる。
 * @param {{key,at,km}} a
 * @param {{key,at,km}} b
 * @param {'new'|'old'|'num'|'rare'|'far'} sort
 */
export function compareBills(a, b, sort) {
  if (sort === 'old') return a.at - b.at;
  if (sort === 'far') return ((b.km || 0) - (a.km || 0)) || (b.at - a.at);
  if (sort === 'num') {
    const pa = parseKey(a.key), pb = parseKey(b.key);
    const da = pa?.digits || '', db = pb?.digits || '';
    if (da !== db) return da < db ? -1 : 1;
    const pfa = pa?.prefix || '', pfb = pb?.prefix || '';
    if (pfa !== pfb) return pfa < pfb ? -1 : 1;
    const sfa = pa?.suffix || '', sfb = pb?.suffix || '';
    if (sfa !== sfb) return sfa < sfb ? -1 : 1;
    return b.at - a.at;
  }
  if (sort === 'rare') {
    const ia = rareInfo(a), ib = rareInfo(b);
    if (ia && ib) return (ia.bestRank - ib.bestRank) || (ib.count - ia.count) || (b.at - a.at);
    if (ia && !ib) return -1;
    if (!ia && ib) return 1;
    return b.at - a.at;
  }
  return b.at - a.at; // 'new'(既定)
}

// ---- 距離・時間 ----

const EARTH_KM = 6371;

/** 2 点の大圏距離（km、整数） */
export function distanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(EARTH_KM * c);
}

/** ミリ秒の差を「3 日と 4 時間」のような 1 行にする */
export function formatDuration(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const minsLeft = mins % 60;
  if (days > 0) return hours ? `${days} 日と ${hours} 時間` : `${days} 日`;
  if (hours > 0) return minsLeft ? `${hours} 時間と ${minsLeft} 分` : `${hours} 時間`;
  return `${minsLeft} 分`;
}

/** 市区町村コードの形（5 桁、頭 2 桁が 01〜47） */
export function isMuniCode(code) {
  return /^[0-9]{5}$/.test(code) && Number(code.slice(0, 2)) >= 1 && Number(code.slice(0, 2)) <= 47;
}

// ---- 「前に登録したか」「戻ってきたか」の判定 ----
//
// 1 枚のお札に、同じ人（uid）が複数回登録できるのは「戻ってきた」ときだけ。
// 文書の id は最初が `{uid}`（n=0）、戻ってきたときは `{uid}_{n}`（n=1,2,3）。
// 1 人が書けるのは最大 4 件（n=0〜3）まで。

export const RETURN_MIN_GAP_MS = 3 * 3600 * 1000; // 前の自分の登録から、これだけ空けないと「戻ってきた」を選べない
export const MAX_RETURN_N = 3;

const RETURN_ID_RE = /^([^_]+)_([1-3])$/;

/** 文書の id を組み立てる。n=0（最初の登録）は uid そのまま */
export function sightingDocId(uid, n) {
  return n > 0 ? `${uid}_${n}` : uid;
}

/** 文書の id から uid と n を取り出す（形が違えば n=0 として uid をそのまま返す） */
export function parseSightingDocId(id) {
  const m = String(id).match(RETURN_ID_RE);
  if (m) return { uid: m[1], n: Number(m[2]) };
  return { uid: String(id), n: 0 };
}

/**
 * このお札に対して、いま登録しようとしている人（uid）が前にも登録しているか、
 * 何人の手を渡ったか、次に書ける文書の id はどれかを判定する。
 * @param {{ id: string, at: number }[]} entries そのお札の sightings。at の昇順（古い順）
 * @param {string} uid いま登録しようとしている人
 * @param {number} now 現在時刻（ms）。テストのため引数で受け取れるようにしてある
 * @returns {{
 *   alreadyMine: boolean,        前にもこの人が登録しているか
 *   lastMineIndex: number,       その最後の登録の位置（無ければ -1）
 *   handsBetween: number,        その登録のあと、他の人が何回登録したか（＝渡った手の数）
 *   nextN: number,               次に登録するときの n
 *   atLimit: boolean,            もう 4 件目（n=0〜3）を使い切っている
 *   sinceLastMs: number | null,  前の自分の登録からの経過（ms）。alreadyMine が false なら null
 *   tooSoon: boolean,            前の自分の登録から RETURN_MIN_GAP_MS だけ経っていない
 * }}
 */
export function analyzeRegistration(entries, uid, now = Date.now()) {
  let lastMineIndex = -1;
  let maxN = -1;
  entries.forEach((e, i) => {
    const p = parseSightingDocId(e.id);
    if (p.uid === uid) { lastMineIndex = i; if (p.n > maxN) maxN = p.n; }
  });
  const alreadyMine = lastMineIndex !== -1;
  const handsBetween = alreadyMine ? entries.length - 1 - lastMineIndex : 0;
  const nextN = alreadyMine ? maxN + 1 : 0;
  const sinceLastMs = alreadyMine ? now - entries[lastMineIndex].at : null;
  return {
    alreadyMine,
    lastMineIndex,
    handsBetween,
    nextN,
    atLimit: nextN > MAX_RETURN_N,
    sinceLastMs,
    tooSoon: alreadyMine && sinceLastMs < RETURN_MIN_GAP_MS,
  };
}

/** 緯度経度の並びを、そのまま順に足した合計距離（km）。地図の一周の線・道のりの合計に使う */
export function sumPathKm(points, distanceKmFn = distanceKm) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distanceKmFn(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
  }
  return total;
}
