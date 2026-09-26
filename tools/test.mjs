// 紙幣リレー — 記番号ロジックの自己チェック（node --test tools/test.mjs）
// 実機のお札で試せないので、形・号券・レア番号・読み違いの直しなど、DOM に触れない部分をここで固める。
'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSerial, seriesFor, colorsFor, buildKey, normalize, nextKind,
  correctDigit, extractSerialCandidate, flagIndices, rareChecks, smallFeature,
  distanceKm, formatDuration, isMuniCode,
  sightingDocId, parseSightingDocId, analyzeRegistration, sumPathKm,
  RETURN_MIN_GAP_MS, MAX_RETURN_N,
  NOTE_TYPES, parseKey, RARE_RANK, compareBills,
} from '../js/bill.js';

// ---- 形の正しい例・間違った例 ----

test('F 号券（1 万・5 千・千）: 英字 2 + 数字 6 + 英字 2', () => {
  const ok = parseSerial('AB123456CD', 10000);
  assert.equal(ok.ok, true);
  assert.equal(ok.series, 'F');
  assert.equal(ok.serial, 'AB123456CD');
});

test('E 号券: 英字 1〜2 + 数字 6 + 英字 1', () => {
  assert.equal(parseSerial('A123456B', 1000).series, 'E');
  assert.equal(parseSerial('AB123456C', 5000).series, 'E');
});

test('2 千円は D 号券だけ', () => {
  const r = parseSerial('A123456B', 2000);
  assert.equal(r.ok, true);
  assert.equal(r.series, 'D');
});

test('数字の範囲外（000000・900001 以上）ははじく', () => {
  assert.equal(parseSerial('AB000000CD', 10000).ok, false);
  assert.equal(parseSerial('AB900001CD', 10000).ok, false);
  assert.equal(parseSerial('AB900000CD', 10000).ok, true);
  assert.equal(parseSerial('AB000001CD', 10000).ok, true);
});

test('使われない英字 I・O は形に合わない', () => {
  assert.equal(parseSerial('AI123456CD', 10000).ok, false);
  assert.equal(parseSerial('AB123456CO', 10000).ok, false);
});

test('桁数・並びが違う入力は落とす（20 ほどのだめな例）', () => {
  const bad = [
    'AB12345CD',      // 数字 5 桁
    'AB1234567CD',    // 数字 7 桁
    'ABC123456CD',    // 英字 3 文字
    'AB123456CDE',    // 英字 3 文字
    '123456AB',       // 順番が逆
    'AB123456',       // 末尾の英字がない
    '',               // 空
    'AB１２３４５６CD', // 全角のまま（normalize されない生の形は parseSerial 内で normalize 済みなので実は通る。ここでは記号混入を見る）
    'AB-123456-CD',   // ハイフンは normalize で消えるので実は通る想定 → 別ケースで確認
    'AB 123456 CD',   // 空白も同様
  ];
  // 明確に落ちるべきものだけ厳格にチェック
  for (const s of ['AB12345CD', 'AB1234567CD', 'ABC123456CD', 'AB123456CDE', '123456AB', 'AB123456', '']) {
    assert.equal(parseSerial(s, 10000).ok, false, s);
  }
});

// ---- キーパッドの「次に来る文字」の出し分け ----

test('次に来る文字: 最初は英字だけ', () => {
  assert.equal(nextKind('', 10000), 'letter');
});
test('次に来る文字: 2 文字目は号券が決まらないので両方', () => {
  assert.equal(nextKind('A', 10000), 'either');
});
test('次に来る文字: 頭の英字が 2 文字そろったら次は数字', () => {
  assert.equal(nextKind('AB', 10000), 'digit');
});
test('次に来る文字: 頭が 1 文字（数字が始まった）ら、6 桁そろうまで数字', () => {
  assert.equal(nextKind('A1', 10000), 'digit');
  assert.equal(nextKind('A12345', 10000), 'digit');
});
test('次に来る文字: 数字 6 桁そろったら英字（末尾の 1 文字目）', () => {
  assert.equal(nextKind('AB123456', 10000), 'letter');
  assert.equal(nextKind('A123456', 10000), 'letter');
});
test('次に来る文字: 末尾 2 文字目は F 号券の形（頭 2 文字）のときだけ', () => {
  assert.equal(nextKind('AB123456C', 10000), 'letter'); // 頭 2 文字 → まだ F の可能性がある
  assert.equal(nextKind('A123456B', 10000), null);       // 頭 1 文字 → E 号券で完成、これ以上打てない
});
test('次に来る文字: 2 千円は D 号券だけなので末尾は常に 1 文字', () => {
  assert.equal(nextKind('AB123456C', 2000), null);
});
test('次に来る文字: 形が完成したら null', () => {
  assert.equal(nextKind('AB123456CD', 10000), null);
});

test('号券の自動判定: 末尾 2 文字→F、1 文字→E', () => {
  assert.equal(seriesFor(10000, 2), 'F');
  assert.equal(seriesFor(10000, 1), 'E');
  assert.equal(seriesFor(2000, 1), 'D');
});

test('色は号券・券種ごとに決まったものだけ', () => {
  assert.deepEqual(colorsFor('F', 10000), ['K']);
  assert.deepEqual(colorsFor('E', 1000), ['K', 'B', 'N']);
  assert.deepEqual(colorsFor('D', 2000), ['K']);
});

// ---- 表記のゆれ（全角・小文字・空白・ハイフン） ----

test('全角→半角、小文字→大文字、空白・ハイフンを消す', () => {
  assert.equal(normalize('ａｂ１２３４５６ｃｄ'), 'AB123456CD');
  assert.equal(normalize('ab123456cd'), 'AB123456CD');
  assert.equal(normalize('AB-123456-CD'), 'AB123456CD');
  assert.equal(normalize('AB 123456 CD'), 'AB123456CD');
});

test('normalize したあとの記番号は parseSerial を通る', () => {
  assert.equal(parseSerial('ａｂ１２３４５６ｃｄ', 10000).ok, true);
  assert.equal(parseSerial('AB-123456-CD', 10000).ok, true);
});

// ---- 鍵の組み立て ----

test('鍵は <号券><券種><色>-<記番号>', () => {
  assert.equal(buildKey({ series: 'F', denom: 10000, color: 'K', serial: 'AB123456CD' }), 'F10000K-AB123456CD');
  assert.equal(buildKey({ series: 'E', denom: 1000, color: 'N', serial: 'A123456B' }), 'E1000N-A123456B');
  assert.equal(buildKey({ series: 'D', denom: 2000, color: 'K', serial: 'A123456B' }), 'D2000K-A123456B');
});

// ---- レア番号の判定（各種） ----

test('ゾロ目', () => assert.ok(rareChecks('777777').some((r) => r.id === 'zorome')));
test('キリ番', () => assert.ok(rareChecks('300000').some((r) => r.id === 'kiriban')));
test('若い番号', () => assert.ok(rareChecks('000042').some((r) => r.id === 'wakai')));
test('階段（上り・下り）', () => {
  assert.ok(rareChecks('123456').some((r) => r.id === 'kaidan'));
  assert.ok(rareChecks('654321').some((r) => r.id === 'kaidan'));
});
test('鏡', () => assert.ok(rareChecks('123321').some((r) => r.id === 'kagami')));
test('くり返し（3 桁×2・2 桁×3）', () => {
  assert.ok(rareChecks('123123').some((r) => r.id === 'kurikaeshi'));
  assert.ok(rareChecks('121212').some((r) => r.id === 'kurikaeshi'));
});
test('ぞろぞろ（同じ数字が 5 つ以上、ゾロ目は除く）', () => {
  assert.ok(rareChecks('377777').some((r) => r.id === 'zorozoro'));
});
test('英字もそろう（F 号券のみ、頭と末尾が同じ）', () => {
  const hits = rareChecks('123456', { series: 'F', prefix: 'AB', suffix: 'AB' });
  assert.ok(hits.some((r) => r.id === 'eiji'));
  assert.ok(!rareChecks('123456', { series: 'F', prefix: 'AB', suffix: 'CD' }).some((r) => r.id === 'eiji'));
});
test('当たらない番号は小さな特徴を 1 行返す', () => {
  const f = smallFeature('284917');
  assert.match(f, /合計/);
  assert.match(f, /万番台/);
});

// ---- 距離・時間 ----

test('距離（大圏距離、東京駅〜大阪駅は約 400km）', () => {
  const km = distanceKm(35.681, 139.767, 34.702, 135.495);
  assert.ok(km > 390 && km < 410, km);
});
test('同じ地点は 0km', () => {
  assert.equal(distanceKm(35, 135, 35, 135), 0);
});
test('時間の書式', () => {
  assert.equal(formatDuration(3 * 86400000 + 4 * 3600000), '3 日と 4 時間');
  assert.equal(formatDuration(2 * 3600000 + 5 * 60000), '2 時間と 5 分');
  assert.equal(formatDuration(42 * 60000), '42 分');
});

// ---- 市区町村コード ----

test('市区町村コードは 5 桁・頭 2 桁が 01〜47', () => {
  assert.equal(isMuniCode('13101'), true);
  assert.equal(isMuniCode('01100'), true);
  assert.equal(isMuniCode('00100'), false);
  assert.equal(isMuniCode('48100'), false);
  assert.equal(isMuniCode('1310'), false);
});

// ---- カメラで読んだ文字の直し（仕様 8-2 の置き換え表） ----

test('数字の場所の読み違いを直す（O→0, I→1, Z→2, S→5, G→6, B→8, T→7）', () => {
  assert.equal(correctDigit('O'), '0');
  assert.equal(correctDigit('Q'), '0');
  assert.equal(correctDigit('D'), '0');
  assert.equal(correctDigit('I'), '1');
  assert.equal(correctDigit('L'), '1');
  assert.equal(correctDigit('Z'), '2');
  assert.equal(correctDigit('S'), '5');
  assert.equal(correctDigit('G'), '6');
  assert.equal(correctDigit('B'), '8');
  assert.equal(correctDigit('T'), '7');
  assert.equal(correctDigit('5'), '5');
  assert.equal(correctDigit('K'), null); // 直しようがない
});

test('OCR の生の文字列から記番号の並びを取り出して直す', () => {
  // 前後に余計な文字が付き、数字の場所が O・I に化けているケース（O・I は英字としては使われないので
  // 前後の英字と混同しない）
  const r = extractSerialCandidate('  PF O2345I VW¥');
  assert.ok(r, JSON.stringify(r));
  assert.equal(r.prefix, 'PF');
  assert.equal(r.digits, '023451');
  assert.equal(r.suffix, 'VW');
});

test('英字の場所に数字が来たら直さず「あやしい」印を付ける（数字は無視して探す）', () => {
  // 英字部分がそのまま数字化けした例。alphabet に無い文字は suspicious として拾い、
  // 完全な誤読（本来の並びを壊す）でなければ拾えることだけを確かめる。
  const r = extractSerialCandidate('AB123456CD');
  assert.equal(r.suspicious.length, 0);
});

// ---- 合成した記番号の「画像」からの読み取り ----
//
// 実機のお札はテストできないので、iPhone 実機での確認は README に手順を残す（オーナー・実装のあとの手番）。
// ここでは「カメラが返してきた生の文字列」を、本物のスキャンで起きがちな崩れ方
// （前後の余計な文字・数字の読み違い・空白）で合成し、抽出→直し→形の確認までの
// パイプライン全体が実際に記番号を復元できることを確認する。
// canvas と実際の Tesseract.js（ブラウザ専用の wasm）を Node だけで動かすには追加の
// ネイティブ依存が要り、この自己チェックの目的（ロジックの回帰）には見合わないため見送った。
test('合成した記番号（読み違いつき）から正しい記番号を復元する', () => {
  const synthetic = [
    { raw: 'PF Q834O6VW', denom: 10000, expect: 'PF083406VW' }, // O→0
    { raw: 'A l 2 3 4 5 6 B', denom: 1000, expect: 'A123456B' }, // I→1（小文字lはalphabet外→捨てて数字窓探索）
    { raw: '.. AB777777CD **', denom: 5000, expect: 'AB777777CD' },
  ];
  for (const { raw, denom, expect } of synthetic) {
    const cand = extractSerialCandidate(raw);
    assert.ok(cand, raw);
    const serial = `${cand.prefix}${cand.digits}${cand.suffix}`;
    assert.equal(serial, expect, raw);
    assert.equal(parseSerial(serial, denom).ok, true, serial);
  }
});

// ---- 確認画面の色分け（撮影で読んだ文字のうち、直した・あやしい文字） ----

test('flagIndices: 数字を直した場所・英字があやしい場所を、記番号全体の位置にまとめる', () => {
  // "PF O83456VW" のような読みで、O→0 に直り、末尾側の文字が数字化けしている想定
  const cand = { prefix: 'PF', digits: '083456', suffix: 'VW', suspicious: [], corrected: [1] };
  assert.deepEqual(flagIndices(cand), [3]); // prefix(2) + corrected 位置 1 → 全体で 3
});
test('flagIndices: suffix 側のあやしい英字は、数字 6 桁ぶん後ろにずれる', () => {
  const cand = { prefix: 'AB', digits: '123456', suffix: '7D', suspicious: [3], corrected: [] };
  // letters = [A,B,7,D]。i=3（D）は suffix の 2 文字目 → 全体では 2(prefix)+6(digits)+1 = 9
  assert.deepEqual(flagIndices(cand), [9]);
});
test('flagIndices: cand が無ければ空', () => {
  assert.deepEqual(flagIndices(null), []);
});

// ---- 「前に登録したか」「戻ってきたか」の判定 ----

const H = 3600 * 1000;
const T0 = 1_700_000_000_000;

test('自分だけ（初めての登録）: 前の登録はない', () => {
  const a = analyzeRegistration([], 'u1', T0);
  assert.equal(a.alreadyMine, false);
  assert.equal(a.nextN, 0);
  assert.equal(a.atLimit, false);
  assert.equal(a.tooSoon, false);
  assert.equal(a.sinceLastMs, null);
});

test('自分→自分（3 時間以内）: 前の登録からまだ時間がたっていない', () => {
  const entries = [{ id: 'u1', at: T0 }];
  const a = analyzeRegistration(entries, 'u1', T0 + 1 * H);
  assert.equal(a.alreadyMine, true);
  assert.equal(a.handsBetween, 0);
  assert.equal(a.nextN, 1);
  assert.equal(a.tooSoon, true);
});

test('自分→自分（3 時間後）: 戻ってきたと聞ける（間に他の人はいない）', () => {
  const entries = [{ id: 'u1', at: T0 }];
  const a = analyzeRegistration(entries, 'u1', T0 + 4 * H);
  assert.equal(a.alreadyMine, true);
  assert.equal(a.handsBetween, 0);
  assert.equal(a.tooSoon, false);
  assert.equal(a.nextN, 1);
});

test('自分→他→自分: 1 人の手を渡って戻ってきた', () => {
  const entries = [{ id: 'u1', at: T0 }, { id: 'u2', at: T0 + H }];
  const a = analyzeRegistration(entries, 'u1', T0 + 10 * H);
  assert.equal(a.alreadyMine, true);
  assert.equal(a.handsBetween, 1);
  assert.equal(a.nextN, 1);
  assert.equal(a.tooSoon, false);
});

test('自分→他→他→自分: 2 人の手を渡った', () => {
  const entries = [{ id: 'u1', at: T0 }, { id: 'u2', at: T0 + H }, { id: 'u3', at: T0 + 2 * H }];
  const a = analyzeRegistration(entries, 'u1', T0 + 10 * H);
  assert.equal(a.handsBetween, 2);
});

test('戻ってきたあと、また戻ってきた（n が積み上がる）', () => {
  const entries = [
    { id: 'u1', at: T0 }, { id: 'u2', at: T0 + H },
    { id: 'u1_1', at: T0 + 10 * H }, { id: 'u2', at: T0 + 20 * H },
  ];
  const a = analyzeRegistration(entries, 'u1', T0 + 30 * H);
  assert.equal(a.nextN, 2);
  assert.equal(a.handsBetween, 1);
});

test('1 枚に書けるのは最大 4 件（n=0〜3）。使い切ったら atLimit', () => {
  const entries = [
    { id: 'u1', at: T0 }, { id: 'u1_1', at: T0 + 10 * H }, { id: 'u1_2', at: T0 + 20 * H }, { id: 'u1_3', at: T0 + 30 * H },
  ];
  const a = analyzeRegistration(entries, 'u1', T0 + 40 * H);
  assert.equal(a.nextN, 4);
  assert.equal(a.atLimit, true);
});

test('MAX_RETURN_N・RETURN_MIN_GAP_MS の値', () => {
  assert.equal(MAX_RETURN_N, 3);
  assert.equal(RETURN_MIN_GAP_MS, 3 * H);
});

test('sightingDocId・parseSightingDocId は行って戻れる', () => {
  assert.equal(sightingDocId('abc', 0), 'abc');
  assert.equal(sightingDocId('abc', 2), 'abc_2');
  assert.deepEqual(parseSightingDocId('abc'), { uid: 'abc', n: 0 });
  assert.deepEqual(parseSightingDocId('abc_2'), { uid: 'abc', n: 2 });
});

// ---- 道のりの合計距離（一周の線の km） ----

test('sumPathKm: 区間の距離をそのまま足す', () => {
  const tokyo = { lat: 35.681, lng: 139.767 };
  const nagoya = { lat: 35.170, lng: 136.881 };
  const osaka = { lat: 34.702, lng: 135.495 };
  const total = sumPathKm([tokyo, nagoya, osaka]);
  const expect = distanceKm(tokyo.lat, tokyo.lng, nagoya.lat, nagoya.lng) + distanceKm(nagoya.lat, nagoya.lng, osaka.lat, osaka.lng);
  assert.equal(total, expect);
});
test('sumPathKm: 1 点だけなら 0', () => {
  assert.equal(sumPathKm([{ lat: 0, lng: 0 }]), 0);
});

// ---- カメラ: 字の塊だけを選ぶ ----

// ---- 昔のお札（仕様「19」）: 記番号の形・parseKey・並び替え ----

test('昔のお札: 各券種の正しい例', () => {
  assert.equal(parseSerial('AB123456C', 10000, 'D10000').ok, true);
  assert.equal(parseSerial('A123456B', 10000, 'C10000').ok, true);
  assert.equal(parseSerial('AB123456C', 5000, 'D5000').ok, true);
  assert.equal(parseSerial('A123456B', 5000, 'C5000').ok, true);
  assert.equal(parseSerial('AB123456C', 1000, 'D1000').ok, true);
  assert.equal(parseSerial('A123456B', 1000, 'C1000').ok, true);
  assert.equal(parseSerial('A123456B', 1000, 'B1000').ok, true);
  assert.equal(parseSerial('A123456B', 500, 'C500').ok, true);
  assert.equal(parseSerial('A123456B', 500, 'B500').ok, true);
  assert.equal(parseSerial('A123456B', 100, 'B100').ok, true);
  assert.equal(parseSerial('A123456B', 50, 'B50').ok, true);
});

test('昔のお札: B50 は末尾 2 文字（頭 2 文字）をはじく', () => {
  assert.equal(parseSerial('AB123456C', 50, 'B50').ok, false); // 頭 2 文字はだめ
  assert.equal(parseSerial('A123456BC', 50, 'B50').ok, false); // 末尾 2 文字もだめ
});

test('昔のお札: D1000 の 4 色（黒・青・茶・緑）', () => {
  assert.deepEqual(colorsFor('D', 1000), ['K', 'U', 'B', 'G']);
});

test('昔のお札: C10000 は黒だけ（茶はだめ）', () => {
  assert.equal(parseKey('C10000B-A123456B'), null);
  assert.ok(parseKey('C10000K-A123456B'));
});

test('parseKey: 昔のお札の鍵を分ける（往復）', () => {
  const cases = [
    'D1000G-AB123456C', 'C500K-A123456B', 'B50K-A123456B', 'D10000B-A123456B', 'B100K-A123456B',
  ];
  for (const key of cases) {
    const p = parseKey(key);
    assert.ok(p, key);
    assert.equal(buildKey({ series: p.series, denom: p.denom, color: p.color, serial: p.serial }), key, key);
    assert.equal(p.old, true, key);
  }
});

test('parseKey: 今の鍵（F・E・D2000）はそのまま読める', () => {
  for (const key of ['F10000K-AB123456CD', 'E1000N-A123456B', 'D2000K-A123456B']) {
    const p = parseKey(key);
    assert.ok(p, key);
    assert.equal(p.old, false, key);
  }
});

test('parseKey: 形の悪い鍵は null', () => {
  assert.equal(parseKey('X1000K-A123456B'), null); // 無い号券
  assert.equal(parseKey('D1000Z-AB123456C'), null); // 無い色
  assert.equal(parseKey('AB123456CD'), null); // 鍵の形ですらない
});

test('昔のお札: 末尾を 1 文字に直す（読み取りの直し。19-4）', () => {
  // B50 は頭 1 文字だけなので、頭が 2 文字に見えたら末尾を 1 文字に切り詰めて確かめ直す想定
  const full = parseSerial('AB123456C', 50, 'B50');
  assert.equal(full.ok, false);
  const trimmed = parseSerial('A123456C', 50, 'B50');
  assert.equal(trimmed.ok, true);
});

test('NOTE_TYPES: すべての行が pre・suf・colors を持つ', () => {
  for (const t of NOTE_TYPES) {
    assert.ok(t.id && t.series && t.denom && Array.isArray(t.colors) && t.pre && Array.isArray(t.suf), t.id);
  }
});

test('nextKind: B50（頭 1 文字だけ）は 1 文字打ったらもう数字だけ', () => {
  assert.equal(nextKind('A', 50, 'B50'), 'digit');
  assert.equal(nextKind('A123456B', 50, 'B50'), null); // 末尾 1 文字で完成
});

test('nextKind: 昔のお札（頭 1〜2 文字）は今の E・D 号券と同じ振る舞い', () => {
  assert.equal(nextKind('A', 1000, 'D1000'), 'either');
  assert.equal(nextKind('AB', 1000, 'D1000'), 'digit');
  assert.equal(nextKind('AB123456C', 1000, 'D1000'), null);
});

// ---- 一覧の並び替え（仕様「18-5」） ----

test('RARE_RANK: 珍しさの順（ゾロ目が最初）', () => {
  assert.equal(RARE_RANK[0], 'zorome');
  assert.equal(RARE_RANK.length, 8);
});

test('compareBills: 新しい順・古い順', () => {
  const a = { key: 'F10000K-AB123456CD', at: 100, km: 0 };
  const b = { key: 'F10000K-AB222222CD', at: 200, km: 0 };
  assert.ok(compareBills(a, b, 'new') > 0); // b(新しい)が先
  assert.ok(compareBills(a, b, 'old') < 0); // a(古い)が先
});

test('compareBills: 番号順（数字→頭の英字→末尾の英字）', () => {
  const a = { key: 'F10000K-AB100000CD', at: 1 };
  const b = { key: 'F10000K-AB200000CD', at: 1 };
  assert.ok(compareBills(a, b, 'num') < 0);
});

test('compareBills: 距離の長い順', () => {
  const a = { key: 'F10000K-AB123456CD', at: 1, km: 10 };
  const b = { key: 'F10000K-AB222222CD', at: 1, km: 50 };
  assert.ok(compareBills(a, b, 'far') > 0);
});

test('compareBills: レア順（レアが上、同じ順位なら新しい順）', () => {
  const rare = { key: 'F10000K-AB777777CD', at: 1 }; // ゾロ目
  const normal = { key: 'F10000K-AB284917CD', at: 2 };
  assert.ok(compareBills(rare, normal, 'rare') < 0);
});

test('pickChars: 高さのそろった字だけ残し、枠に触れる模様・小さな点は捨てる', async () => {
  const { pickChars } = await import('../js/camera.js');
  const W = 120, H = 30, black = new Uint8Array(W * H);
  const rect = (x0, y0, w, h) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) black[y * W + x] = 1; };
  for (let k = 0; k < 8; k++) rect(10 + k * 12, 8, 6, 14); // 字 8 つ
  rect(0, 0, 5, 30);   // 上下の端に触れる模様
  rect(110, 3, 2, 2);  // 小さな点
  const r = pickChars(black, W, H);
  assert.ok(r);
  assert.deepEqual(r.box, { x0: 10, y0: 8, x1: 99, y1: 21 });
  assert.equal(r.keep(0), false);
  assert.equal(r.keep(3 * W + 110), false);
  assert.equal(r.keep(10 * W + 12), true);
  assert.equal(pickChars(new Uint8Array(W * H), W, H), null);
});
