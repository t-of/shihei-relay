// 画面の明るさ（設定の「画面」）。色がちらつかないよう、CSS より先に読む普通のスクリプト。
// 'light' / 'dark' なら html[data-theme] で固定、'auto'（無いとき）は OS に従う。
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  // 上下バーの色（theme-color）も合わせる。固定のときは media を外して両方同じ色にする
  const bg = { light: '#f4ead8', dark: '#1a0f0c' };
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    const own = m.media.includes('dark') ? 'dark' : 'light';
    m.content = bg[theme === 'light' || theme === 'dark' ? theme : own];
  });
}
try { applyTheme(JSON.parse(localStorage.getItem('shihei-relay.settings') || '{}').theme); } catch { /* 読めなければ OS に従う */ }
