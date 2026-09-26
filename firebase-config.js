'use strict';

// Firebase の設定はここ 1 か所だけ。オーナーが Firebase コンソールでプロジェクトを作ったら、
// ウェブアプリを登録して出てくる値をそのまま埋める（README の「Firebase の準備」を参照）。
// apiKey は公開してよい値（守りは firestore.rules 側）。
//
// null のままなら、登録・道のり・みんなの画面は「準備中」を出し、それ以外
// （キーパッド・カメラでの読み取り・レア番号の判定・自分の記録の端末内の部分）は今までどおり動く。
window.SHIHEI_FIREBASE_CONFIG = null;

// 例:
// window.SHIHEI_FIREBASE_CONFIG = {
//   apiKey: 'AIza...',
//   authDomain: 'tof-shihei-relay.firebaseapp.com',
//   projectId: 'tof-shihei-relay',
//   storageBucket: 'tof-shihei-relay.appspot.com',
//   messagingSenderId: '...',
//   appId: '1:...:web:...',
// };
