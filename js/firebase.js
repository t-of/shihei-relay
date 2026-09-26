'use strict';

// Firebase まわり（匿名ログイン・Firestore の読み書き）を 1 か所にまとめる。
// firebase-config.js が null のとき（オーナーがまだプロジェクトを作っていないとき）は、
// すべての関数が { ok: false, reason: 'not-configured' } を返す。呼び出し側はこれを見て「準備中」を出す。
//
// データの形は README の「## データ」と firestore.rules を正本とする。ここを変えたら両方直す。

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
 * お札を 1 枚登録する。sightings・users・（再発見なら）hits を 1 つのバッチで書く。
 * 距離・時間の計算に市区町村の緯度経度が要るので、呼び出し側（app.js）が
 * `muniLatLng(code) => { lat, lng } | null` と `distanceKm(lat1,lng1,lat2,lng2) => number` を渡す
 * （js/geo.js・js/bill.js のものをそのまま渡せる）。
 *
 * @returns {Promise<{ ok:true, first:boolean, prevMuni?:string, prevAt?:number, km?:number, mins?:number, n?:number }
 *          | { ok:false, reason:string }>}
 */
export async function registerSighting(key, muniCode, { muniLatLng, distanceKm } = {}) {
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
    if (allSnap.docs.some((d) => d.id === uid)) return { ok: false, reason: 'already-registered' };
    const prevDoc = allSnap.docs[allSnap.docs.length - 1];
    const prev = prevDoc ? prevDoc.data() : null;
    const n = allSnap.size + 1;

    const batch = s.writeBatch(db);
    const now = Date.now();
    batch.set(s.doc(db, 'bills', key, 'sightings', uid), { muni: muniCode, at: s.serverTimestamp(), v: 1 });

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
      mins = Math.max(0, Math.round((now - toMillis(prev.at)) / 60000));
      const hitsRef = s.doc(s.collection(db, 'hits'));
      batch.set(hitsRef, {
        denom: Number(key.match(/\d+/)?.[0] || 0),
        from: prev.muni, to: muniCode, km, mins, n,
        at: s.serverTimestamp(), v: 1,
      });
    }
    await batch.commit();
    return prev
      ? { ok: true, first: false, prevMuni: prev.muni, prevAt: toMillis(prev.at), km, mins, n }
      : { ok: true, first: true };
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
