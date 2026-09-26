'use strict';

// Firebase まわり（匿名ログイン・Firestore の読み書き）を 1 か所にまとめる。
// firebase-config.js が null のとき（オーナーがまだプロジェクトを作っていないとき）は、
// すべての関数が { ok: false, reason: 'not-configured' } を返す。呼び出し側はこれを見て「準備中」を出す。
//
// データの形は README の「## データ」と firestore.rules を正本とする。ここを変えたら両方直す。

import * as Bill from './bill.js';

const FIREBASE_VERSION = '12.19.0';
const CDN = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;

const config = window.SHIHEI_FIREBASE_CONFIG || null;
// みんなの地図の集計（agg/{id}。仕様「21」）の書き込みのスイッチ。既定は false（firebase-config.js を見よ）。
// rules がまだ公開されていない本番でこれを true にすると、集計の書き込みが permission-denied になり、
// 登録そのものが失敗する。ディレクターが rules を公開してから true にする。
const AGG_ENABLED = !!window.SHIHEI_AGG_ENABLED;

let fb = null;     // { app, auth, db, ...関数 }
let readyPromise = null;

function notConfigured(reason = 'not-configured') {
  return { ok: false, reason };
}

/** 初期化して匿名ログインまで済ませる。設定がなければ null のまま */
export function ready() {
  if (!config) return Promise.resolve(null);
  if (readyPromise) return readyPromise;
  readyPromise = init();
  return readyPromise;
}

async function init() {
  const [{ initializeApp }, authMod, storeMod] = await Promise.all([
    import(`${CDN}/firebase-app.js`),
    import(`${CDN}/firebase-auth.js`),
    import(`${CDN}/firebase-firestore.js`),
  ]);
  const app = initializeApp(config);

  // App Check（reCAPTCHA v3）: サイトキーがあるときだけ、Firestore を使う前に有効にする。
  // ボットによる読み取り連打から無料枠を守るためのもの（README の「Firebase の準備」）。
  if (config.appCheckSiteKey) {
    const { initializeAppCheck, ReCaptchaV3Provider } = await import(`${CDN}/firebase-app-check.js`);
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(config.appCheckSiteKey),
      isTokenAutoRefreshEnabled: true,
    });
  }

  const auth = authMod.getAuth(app);
  const db = storeMod.getFirestore(app);

  await new Promise((resolve) => {
    const off = authMod.onAuthStateChanged(auth, (user) => {
      if (user) { off(); resolve(user); }
    });
    authMod.signInAnonymously(auth).catch(() => resolve(null));
  });

  fb = { app, auth, db, authMod, storeMod };
  return fb;
}

/**
 * お札を 1 枚登録する。sightings・users・（前に誰かの登録があれば）hits を 1 つのバッチで書く。
 * 距離・時間の計算に市区町村の緯度経度が要るので、呼び出し側（app.js）が
 * `muniLatLng(code) => { lat, lng } | null` と `distanceKm(lat1,lng1,lat2,lng2) => number` を渡す
 * （js/geo.js・js/bill.js のものをそのまま渡せる）。
 *
 * 前にも自分（同じ uid）がこのお札を登録していたときは、まず `confirmedReturn` なしで呼ぶ。
 *   - `reason: 'too-soon'`      前の自分の登録から `Bill.RETURN_MIN_GAP_MS`（3 時間）経っていない。登録させない。
 *   - `reason: 'return-limit'` もう 4 件（n=0〜3）使い切っている。登録させない。
 *   - `reason: 'ask-return'`   「今回は、前の登録からどう動きましたか？」を聞く。選んだ答えで
 *                              `confirmedReturn` を付けてもう一度呼ぶ。
 *     - `'carried'`  ずっと自分が持ち歩いていた。sightings には書くが、hits（みんなの一致の記録）には
 *                     書かない・comeback にもしない（手を離れていないため）。
 *     - `'returned'` 人の手を渡って戻ってきた（間にほかの人がいてもいなくてもよい。紙幣リレーを
 *                     使っていない人の手を渡ってきたこともあるため）。今までの comeback と同じ扱い。
 *
 * @returns {Promise<{ ok:true, first:boolean, comeback:boolean, carried?:boolean, handsBetween?:number,
 *            loop?:{muni:string,at:number}[], prevMuni?:string, prevAt?:number, km?:number, mins?:number, n?:number }
 *          | { ok:false, reason:string, lastMuni?:string, lastAt?:number, sinceLastMs?:number }>}
 */
export async function registerSighting(key, muniCode, { muniLatLng, distanceKm } = {}, confirmedReturn = false) {
  const f = await ready();
  if (!f) return notConfigured();
  const { db, auth, storeMod: s } = f;
  const uid = auth.currentUser?.uid;
  if (!uid) return notConfigured('not-signed-in');

  try {
    const sightingsRef = s.collection(db, 'bills', key, 'sightings');
    // ponytail: rules が 1 回の list を 100 件までに制限しているので、100 人を超えたお札は
    // 人数（n）が頭打ちになる。それだけ動いたお札を気にする段階になったら別の数え方に上げる。
    const allSnap = await s.getDocs(s.query(sightingsRef, s.orderBy('at', 'asc'), s.limit(100)));
    const now = Date.now();
    const entries = allSnap.docs.map((d) => ({ id: d.id, at: toMillis(d.data().at), muni: d.data().muni }));

    const analysis = Bill.analyzeRegistration(entries, uid, now);
    if (analysis.alreadyMine) {
      const last = entries[analysis.lastMineIndex];
      if (analysis.atLimit) return { ok: false, reason: 'return-limit', lastMuni: last.muni, lastAt: last.at };
      if (analysis.tooSoon) return { ok: false, reason: 'too-soon', lastMuni: last.muni, lastAt: last.at, sinceLastMs: analysis.sinceLastMs };
      if (!confirmedReturn) return { ok: false, reason: 'ask-return', lastMuni: last.muni, lastAt: last.at, handsBetween: analysis.handsBetween };
    }

    const docId = Bill.sightingDocId(uid, analysis.nextN);
    const prev = entries.length ? entries[entries.length - 1] : null; // 直前の登録（自分でも他人でもよい）
    const carried = confirmedReturn === 'carried';
    // 持ち歩いていただけのときは、手が離れていないので「前の自分の登録」からの移動を見る
    // （間に他人の登録があっても、ここでは無視する。ユーザーが選んだ答えをそのまま信じる）。
    const basis = carried ? entries[analysis.lastMineIndex] : prev;
    const n = entries.length + 1;
    const comeback = analysis.alreadyMine && !carried; // ここまで来たら confirmedReturn 済み・時間もあいている

    const userRef = s.doc(db, 'users', uid);
    const userSnap = await s.getDoc(userRef);
    const u = userSnap.exists() ? userSnap.data() : null;
    const sinceOk = u && now - toMillis(u.since) < 24 * 3600 * 1000;
    // rules の withinRate（前回から 30 秒・24 時間で 50 回）に当たると permission-denied になるので、先に見て理由を返す。
    // 端末の時計のずれに 2 秒の余裕を見る。
    const sinceLast = u?.last ? now - toMillis(u.last) : Infinity;
    if (sinceLast < 32 * 1000) return { ok: false, reason: 'rate-wait', waitSec: Math.ceil((32 * 1000 - sinceLast) / 1000) };
    if (sinceOk && (u.n || 0) >= 50) return { ok: false, reason: 'rate-day' };

    let km = 0, mins = 0;
    if (basis) {
      const a = muniLatLng?.(basis.muni), b = muniLatLng?.(muniCode);
      if (a && b && distanceKm) km = distanceKm(a.lat, a.lng, b.lat, b.lng);
      mins = Math.max(0, Math.round((now - basis.at) / 60000));
    }

    // みんなの地図の集計（仕様「21」）。typeId が分かる（= key が NOTE_TYPES にある形の）ときだけ、
    // agg/all・今日の agg/d<年>-<月>-<日> の該当セルを +1 する。users に付ける b・s は、rules の
    // isCountUp が「今回の新しい登録の分だけ」であることを確かめる手がかり（README の「## データ」）。
    // 持ち歩き（carried）でも登録の回数として +1 する。hits には書かない。
    const typeId = AGG_ENABLED ? Bill.parseKey(key)?.typeId : null;

    // 1 つのバッチを組み立てて送る（dayId だけ差し替えられるように関数にしてある。0 時の前後の再送用）。
    const commitBatch = (dayId) => {
      const batch = s.writeBatch(db);
      batch.set(s.doc(db, 'bills', key, 'sightings', docId), { muni: muniCode, at: s.serverTimestamp(), v: 1 });
      const userDoc = {
        last: s.serverTimestamp(),
        since: sinceOk ? u.since : s.serverTimestamp(),
        n: sinceOk ? (u.n || 0) + 1 : 1,
        v: 1,
      };
      if (typeId) Object.assign(userDoc, { b: key, s: docId });
      batch.set(userRef, userDoc);
      // 持ち歩いただけのときは、みんなの一致の記録（hits）には書かない
      if (prev && !carried) {
        const hitsRef = s.doc(s.collection(db, 'hits'));
        const hit = {
          denom: Number(key.match(/\d+/)?.[0] || 0),
          from: prev.muni, to: muniCode, km, mins, n, comeback,
          at: s.serverTimestamp(), v: 1,
        };
        if (typeId) hit.ty = typeId;
        batch.set(hitsRef, hit);
      }
      if (typeId) {
        const cell = { m: { [muniCode]: { [typeId]: s.increment(1) } }, v: 1 };
        batch.set(s.doc(db, 'agg', 'all'), cell, { merge: true });
        batch.set(s.doc(db, 'agg', dayId), cell, { merge: true });
      }
      return batch.commit();
    };

    const dayId = Bill.jstDayId(now);
    try {
      await commitBatch(dayId);
    } catch (e) {
      // 日本時間 0 時の前後 10 分は、端末の時計と rules の request.time の日付がずれて agg の
      // 書き込みだけ拒まれることがある（仕様「21-5」）。その間だけ、となりの日の id でもう 1 回だけ送る。
      const minuteOfDay = Bill.jstMinuteOfDay(now);
      const nearMidnight = minuteOfDay <= 10 || minuteOfDay >= 1440 - 10;
      if (typeId && nearMidnight && String(e?.code) === 'permission-denied') {
        const otherDay = Bill.jstDayId(now + (minuteOfDay <= 10 ? -1 : 1) * 86400000);
        await commitBatch(otherDay);
      } else {
        throw e;
      }
    }

    if (!basis) return { ok: true, first: true, comeback: false };
    if (carried) return { ok: true, first: false, comeback: false, carried: true, prevMuni: basis.muni, prevAt: basis.at, km, mins, n };
    const out = { ok: true, first: false, comeback, prevMuni: basis.muni, prevAt: basis.at, km, mins, n };
    if (comeback) {
      out.handsBetween = analysis.handsBetween;
      // 一周の線・合計距離用: 自分の前の登録から、今回までの市区町村の並び
      out.loop = entries.slice(analysis.lastMineIndex).map((e) => ({ muni: e.muni, at: e.at }));
      out.loop.push({ muni: muniCode, at: now });
    }
    return out;
  } catch (e) {
    console.error('register failed', e);
    return { ok: false, reason: String(e?.code || e) };
  }
}

/** そのお札のこれまでの登録（道のり）。key を知っている人だけが読める */
export async function fetchJourney(key) {
  const f = await ready();
  if (!f) return notConfigured();
  const { db, storeMod: s } = f;
  try {
    const snap = await s.getDocs(s.query(s.collection(db, 'bills', key, 'sightings'), s.orderBy('at', 'asc'), s.limit(100)));
    return { ok: true, rows: snap.docs.map((d) => ({ id: d.id, ...d.data(), at: toMillis(d.data().at) })) };
  } catch (e) {
    return { ok: false, reason: String(e?.code || e) };
  }
}

/**
 * 自分がそのお札に登録したものを全部消す（最初の登録 {uid} と、戻ってきた・持ち歩いた登録 {uid}_1〜_3）。
 * 存在しない文書を消しても Firestore はエラーにしない（rules の delete も isOwnSightingDocId で許可済み）ので、
 * まとめて消してよい。hits（記番号を持たない、みんなの一致の記録）は消さない。
 */
export async function deleteSighting(key) {
  const f = await ready();
  if (!f) return notConfigured();
  const { db, auth, storeMod: s } = f;
  const uid = auth.currentUser?.uid;
  if (!uid) return notConfigured('not-signed-in');
  try {
    const docIds = [0, 1, 2, 3].map((n) => Bill.sightingDocId(uid, n));
    await Promise.all(docIds.map((id) => s.deleteDoc(s.doc(db, 'bills', key, 'sightings', id))));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.code || e) };
  }
}

/** みんなの画面: 最近の再発見 50 件（記番号を持たない）。期間・お札などの絞り込みは端末の中でする */
export async function fetchRecentHits(limitN = 20) {
  const f = await ready();
  if (!f) return notConfigured();
  const { db, storeMod: s } = f;
  try {
    const snap = await s.getDocs(s.query(s.collection(db, 'hits'), s.orderBy('at', 'desc'), s.limit(limitN)));
    return { ok: true, rows: snap.docs.map((d) => ({ id: d.id, ...d.data(), at: toMillis(d.data().at) })) };
  } catch (e) {
    return { ok: false, reason: String(e?.code || e) };
  }
}

/**
 * みんなの画面の全体の数（再発見数・最長の旅）。登録の総数は、AGG_ENABLED のときは
 * `fetchAgg(['all'])` の `m` を足せば出る（仕様「21」・js/bill.js の sumCells）ので、ここでは返さない。
 * AGG_ENABLED が false の間（rules 公開前）は、登録の総数を出す手段がない
 * （bills 全体の一覧を誰も読めない設計のため）。
 */
export async function fetchGlobalStats() {
  const f = await ready();
  if (!f) return notConfigured();
  const { db, storeMod: s } = f;
  try {
    const countSnap = await s.getCountFromServer(s.collection(db, 'hits'));
    const longestSnap = await s.getDocs(s.query(s.collection(db, 'hits'), s.orderBy('km', 'desc'), s.limit(1)));
    const longest = longestSnap.empty ? null : longestSnap.docs[0].data();
    return { ok: true, hitCount: countSnap.data().count, longestKm: longest?.km ?? 0 };
  } catch (e) {
    return { ok: false, reason: String(e?.code || e) };
  }
}

/**
 * みんなの地図（仕様「21」）: agg/{id} を並べて読む。`agg/all` 1 つ、期間が「今日」ならその日の
 * 1 つ、「7 日間」なら過去 7 日分（js/bill.js の recentDayIds）。誰でも get できる（rules）。
 * @param {string[]} ids 'all' や jstDayId() が返す 'd2026-9-27' のような id
 * @returns {Promise<{ ok:true, mList: (object|null)[] } | { ok:false, reason:string }>}
 */
export async function fetchAgg(ids) {
  const f = await ready();
  if (!f) return notConfigured();
  const { db, storeMod: s } = f;
  try {
    const docs = await Promise.all(ids.map((id) => s.getDoc(s.doc(db, 'agg', id))));
    return { ok: true, mList: docs.map((d) => (d.exists() ? d.data().m : null)) };
  } catch (e) {
    return { ok: false, reason: String(e?.code || e) };
  }
}

function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  return 0;
}

export function isConfigured() {
  return !!config;
}

/** みんなの地図の集計（agg）を使ってよいか（rules がまだのうちは false。firebase-config.js を見よ） */
export function isAggEnabled() {
  return AGG_ENABLED;
}
