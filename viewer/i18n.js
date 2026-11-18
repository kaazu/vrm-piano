// 画面の言語切り替え（日本語 / English）
// HTML は日本語で書いてあり、英語のときだけ下の表で置きかえる。
// 言語は ?lang=ja|en、なければブラウザの言語（ja 以外は英語）。
export const lang = (() => {
  const q = new URLSearchParams(location.search).get('lang');
  if (q === 'ja' || q === 'en') return q;
  return (navigator.language || 'en').toLowerCase().startsWith('ja') ? 'ja' : 'en';
})();

const EN = {
  // viewer
  '隠す(h)': 'Hide (h)',
  'VRM': 'VRM',
  'ファイルを選ぶ': 'Open file',
  'VRM ファイルをここにドロップするか、「ファイルを選ぶ」を押してください': 'Drop a VRM file here, or press "Open file"',
  '曲': 'Song',
  '読む': 'Load',
  '▶ 演奏': '▶ Play',
  '■ 終了': '■ Stop',
  '位置': 'Position',
  'コマ送り': 'Step',
  '⏮音': '⏮ note',
  '音⏭': 'note ⏭',
  '設定を書き出す (song.json)': 'Export settings (song.json)',
  '反応テスト': 'Glance test',
  '指の位置を自動調整': 'Auto-fit fingers',
  '演奏': 'Playing',
  '先読み(秒)': 'Look-ahead (s)',
  '手首の追従(秒)': 'Wrist follow (s)',
  '手首の高さ': 'Wrist height',
  '手首の手前(指長×)': 'Wrist back (× finger)',
  '指の届き(倍)': 'Finger reach (×)',
  '休み指の曲げ': 'Idle finger curl',
  '押下の深さ': 'Key press depth',
  '手首ひねり(deg)': 'Wrist twist (deg)',
  '曲げ反転': 'Flip curl',
  'ひろがり反転': 'Flip spread',
  '配置': 'Layout',
  '鍵盤の大きさ': 'Keyboard scale',
  '鍵盤の高さ': 'Keyboard height',
  '鍵盤の前後': 'Keyboard depth',
  '鍵盤の左右': 'Keyboard left/right',
  '体の前後': 'Body depth',
  '体の高さ': 'Body height',
  '正面': 'Front',
  '手元': 'Hands',
  '上から': 'Top',
  '横': 'Side',
  '揺れ・ビート': 'Sway & beat',
  '上体の傾き（手の方向）': 'Lean toward hands',
  '首のビート': 'Head beat',
  '下半身のビート': 'Knee beat',
  'BPM（0=自動）': 'BPM (0 = auto)',
  '拍のずれ(秒)': 'Beat offset (s)',
  '拍の単位': 'Beat unit',
  '1拍ごと': 'Every beat',
  '2拍ごと': 'Every 2 beats',
  '半拍ごと': 'Every half beat',
  '拍の取り方': 'Beat feel',
  '表拍': 'Downbeat',
  '裏拍（半拍ずらす）': 'Offbeat (half-beat shift)',
  '2拍・4拍（バックビート）': 'Backbeat (2 and 4)',
  'タップで合わせる': 'Tap tempo',
  'T キー / ここを押す': 'T key / click here',
  '消す': 'Clear',
  '再生しながら、自分が体を揺らすタイミングで T を押す（4回以上）': 'While playing, press T when you would nod to the music (4+ times)',
  '表情': 'Expression',
  'モード': 'Mode',
  '自動（曲・運指から）': 'Auto (from music & fingering)',
  'なし': 'None',
  '笑顔': 'Happy',
  'リラックス': 'Relaxed',
  '悲しい': 'Sad',
  '集中': 'Focused',
  '強さ': 'Intensity',
  '反応の速さ': 'Reaction speed',
  '目線は手元': 'Look at hands',
  '歌の口パク': 'Lip sync (vocals)',
  '口の開き(倍)': 'Mouth open (×)',
  '口を早める(秒)': 'Mouth lead (s)',
  '歌う間 笑顔を弱める': 'Reduce smile while singing',
  // autofit
  '指の位置 自動調整': 'Finger auto-fit',
  '指の位置 自動調整（全曲）': 'Finger auto-fit (all songs)',
  '違う鍵': 'Wrong key',
  '浮き': 'Floating',
  '届かない': 'Out of reach',
  '左右': 'X',
  '高さ': 'Height',
  '前後': 'Depth',
  '大きさ': 'Scale',
  '届き': 'Reach',
  '手首': 'Wrist',
  '手前': 'Back',
  'song.json を書き出す': 'Export song.json',
};

// 動的なメッセージ用
const EN_MSG = {
  loadingVrm: 'Loading VRM…',
  noVrm: 'No VRM yet — open or drop a .vrm file',
  vrmLoaded: 'VRM loaded. finger length:',
  vrmError: 'VRM error',
  loading: 'Loading…',
  samples: 'Samples',
  songError: 'Song error',
  exported: 'Exported song.json (overwrite songs/<id>/song.json with it)',
  fitDone: 'Adjusted. Use "Export settings" to save if it looks good',
  fitSame: 'The current values were already the best',
  fitError: 'Auto-fit error',
  tapMore: (n) => `${n} taps (${4 - n} more)`,
  tapResult: (n, bpm, auto, rel) => `${n} taps → ${bpm} BPM (auto ${auto}), ${rel}% after the beat (around 50% = offbeat)`,
  tapCleared: 'Taps cleared',
  hard: 'hard passage',
  needVrm: 'Open a VRM first',
  runN: (n) => `▶ Fit ${n} songs`,
  done: 'Done',
  downloaded: 'Downloaded (overwrite song.json in the folder named by the id)',
};
const JA_MSG = {
  loadingVrm: 'VRM 読込中…',
  noVrm: 'VRM がまだありません。.vrm ファイルを選ぶかドロップしてください',
  vrmLoaded: 'VRM を読み込みました。指の長さ:',
  vrmError: 'VRM エラー',
  loading: '読込中…',
  samples: '音源読込',
  songError: '曲のエラー',
  exported: 'song.json を書き出しました（songs/<曲>/song.json に上書きしてください）',
  fitDone: '調整しました。よければ「設定を書き出す」で保存',
  fitSame: '今の値のままが一番でした',
  fitError: '自動調整エラー',
  tapMore: (n) => `タップ ${n} 回（あと ${4 - n} 回）`,
  tapResult: (n, bpm, auto, rel) => `タップ ${n} 回 → ${bpm} BPM（自動 ${auto}）、拍の頭から ${rel}% の位置（50%前後なら裏拍）`,
  tapCleared: 'タップを消しました',
  hard: '難所',
  needVrm: '先に VRM を読み込んでください',
  runN: (n) => `▶ ${n} 曲を調整`,
  done: '完了',
  downloaded: 'ダウンロードしました（ファイル名の id のフォルダの song.json に上書き）',
};
export const msg = lang === 'en' ? EN_MSG : JA_MSG;

// 曲名: 日本語のときは nameJa があればそれを使う
export const songName = (s) => (lang === 'ja' && s.nameJa) || s.name;

// root の中の文字（テキストノード・option・title 属性）を英語に置きかえる
export function translate(root = document.body) {
  document.documentElement.lang = lang;
  if (lang !== 'en') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const raw = n.nodeValue; const key = raw.trim(); if (!key) continue;
    if (EN[key] != null) n.nodeValue = raw.replace(key, EN[key]);
    else if (EN[raw] != null) n.nodeValue = EN[raw];
  }
}
