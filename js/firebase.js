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
 *   - `reason: 'ask-return'`   「また手元に来ましたか？」を聞く。「戻ってきた」を選んだら
 *                              `confirmedReturn: true` でもう一度呼ぶ（間にほかの人がいてもいなくてもよい。
 *                              紙幣リレーを使っていない人の手を渡ってきたこともあるため）。
 *
 * @returns {Promise<{ ok:true, first:boolean, comeback:boolean, handsBetween?:number, loop?:{muni:string,at:number}[],
 *            prevMuni?:string, prevAt?:number, km?:number, mins?:number, n?:number }
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
    const n = entries.length + 1;
    const comeback = analysis.alreadyMine; // ここまで来たら confirmedReturn 済み・時間もあいている

    const batch = s.writeBatch(db);
    batch.set(s.doc(db, 'bills', key, 'sightings', docId), { muni: muniCode, at: s.serverTimestamp(), v: 1 });

    const userRef = s.doc(db, 'users', uid);
    const userSnap = await s.getDoc(userRef);
    const u = userSnap.exists() ? userSnap.data() : null;
    const sinceOk = u && now - toMillis(u.since) < 24 * 3600 * 1000;
    batch.set(userRef, {
      last: s.serverTimestamp(),
      since: sinceOk ? u.since : s.serverTimestamp(),
      n: sinceOk ? (u.n || 0) + 1 : 1,
      v: 1,
    });

    let km = 0, mins = 0;
    if (prev) {
      const a = muniLatLng?.(prev.muni), b = muniLatLng?.(muniCode);
      if (a && b && distanceKm) km = distanceKm(a.lat, a.lng, b.lat, b.lng);
      mins = Math.max(0, Math.round((now - prev.at) / 60000));
      const hitsRef = s.doc(s.collection(db, 'hits'));
      batch.set(hitsRef, {
        denom: Number(key.match(/\d+/)?.[0] || 0),
        from: prev.muni, to: muniCode, km, mins, n, comeback,
        at: s.serverTimestamp(), v: 1,
      });
    }
    await batch.commit();

    if (!prev) return { ok: true, first: true, comeback: false };
    const out = { ok: true, first: false, comeback, prevMuni: prev.muni, prevAt: prev.at, km, mins, n };
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

/** 自分の登録を消す */
export async function deleteSighting(key) {
  const f = await ready();
  if (!f) return notConfigured();
  const { db, auth, storeMod: s } = f;
  const uid = auth.currentUser?.uid;
  if (!uid) return notConfigured('not-signed-in');
  try {
    await s.deleteDoc(s.doc(db, 'bills', key, 'sightings', uid));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.code || e) };
  }
}

/** みんなの画面: 最近の再発見 20 件（記番号を持たない） */
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
 * みんなの画面の全体の数。「登録数」は、どのお札にも記番号を伏せてある関係で数える手段がない
 * （bills 全体の一覧を誰も読めない設計のため）ので、ここでは再発見数と最長の旅だけを返す。
 * ponytail: 登録の総数を出すには専用の counters ドキュメントと transaction が要る。使う人が
 * 増えてから、書き込みが増える広告版のタイミングで足す。
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

function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  return 0;
}

export function isConfigured() {
  return !!config;
}
