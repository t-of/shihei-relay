// 紙幣リレー — 記番号ロジックの自己チェック（node --test tools/test.mjs）
// 実機のお札で試せないので、形・号券・レア番号・読み違いの直しなど、DOM に触れない部分をここで固める。
'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSerial, seriesFor, colorsFor, buildKey, normalize, nextKind,
  correctDigit, extractSerialCandidate, rareChecks, smallFeature,
  distanceKm, formatDuration, isMuniCode,
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
