'use strict';

// Firebase の設定はここ 1 か所だけ。オーナーが Firebase コンソールでプロジェクトを作ったら、
// ウェブアプリを登録して出てくる値をそのまま埋める（README の「Firebase の準備」を参照）。
// apiKey は公開してよい値（守りは firestore.rules 側）。
//
// null のままなら、登録・道のり・みんなの画面は「準備中」を出し、それ以外
// （キーパッド・カメラでの読み取り・レア番号の判定・自分の記録の端末内の部分）は今までどおり動く。
//
// appCheckSiteKey: App Check（reCAPTCHA v3）のサイトキー。null のままなら App Check は使わない
// （今までどおり動く）。オーナーが Firebase コンソールで作ったら、README の「Firebase の準備」
// のとおりここに入れる。
window.SHIHEI_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyACTCnsBOjgUsbmJ8_-uotTuhdf3et7W3s',
  authDomain: 'tof-shihei-relay.firebaseapp.com',
  projectId: 'tof-shihei-relay',
  storageBucket: 'tof-shihei-relay.firebasestorage.app',
  messagingSenderId: '14511379370',
  appId: '1:14511379370:web:87e6e887a3bb66dd9751d3',
  appCheckSiteKey: null,
};

// みんなの地図の集計（agg/{id}。仕様「21」）の書き込みのスイッチ。
// firestore.rules に agg 用のルールがまだ公開されていない本番でこれを true にすると、
// 集計の書き込みが permission-denied になり、登録そのものが失敗する。
// ディレクターが新しい firestore.rules を Firebase コンソールで公開したあと、ここを true にして出す。
window.SHIHEI_AGG_ENABLED = true;

// 例:
// window.SHIHEI_FIREBASE_CONFIG = {
//   apiKey: 'AIza...',
//   authDomain: 'tof-shihei-relay.firebaseapp.com',
//   projectId: 'tof-shihei-relay',
//   storageBucket: 'tof-shihei-relay.appspot.com',
//   messagingSenderId: '...',
//   appId: '1:...:web:...',
//   appCheckSiteKey: '6Lc...',
// };
