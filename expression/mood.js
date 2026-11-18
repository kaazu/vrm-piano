// 曲と運指の状態から「気分」と表情ウェイトを作る（依存なし、Node/ブラウザ共通）
//
// 入力: タイムライン JSON（notes: pitch/start/end/velocity/hand/finger/difficulty）
// 1. analyze(): 一定間隔(step 秒)で特徴量の列を作る
//    density   : 直近0.6秒の打鍵数
//    loudness  : 直近1秒の平均ベロシティ (0..1)
//    majorness : 直近1.5秒の音の長調らしさ (-1..1)  Krumhansl-Schmuckler のキー相関
//    register  : 平均音高 (MIDI)
//    difficulty: 前後0.5秒の運指コストの最大値
//    stretch   : 同時に押さえている音の手ごとの広がり(半音)の最大
//    rest      : 直前の打鍵からの経過秒
// 2. ExpressionDriver: 特徴量 → 気分(valence/arousal/focus) → 表情ウェイト（平滑化つき）

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function corr(a, b) {
  const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}

export function majorness(pcWeights) {
  if (pcWeights.every((w) => w === 0)) return 0;
  let bestMaj = -1, bestMin = -1;
  for (let k = 0; k < 12; k++) {
    const rot = pcWeights.map((_, i) => pcWeights[(i + k) % 12]);
    bestMaj = Math.max(bestMaj, corr(rot, MAJOR));
    bestMin = Math.max(bestMin, corr(rot, MINOR));
  }
  return Math.tanh((bestMaj - bestMin) * 6);
}

export function analyze(timeline, { step = 0.05 } = {}) {
  const notes = [...timeline.notes].sort((a, b) => a.start - b.start);
  const dur = Math.max(...notes.map((n) => n.end)) + 1;
  const frames = [];
  for (let t = 0; t <= dur; t += step) {
    let dens = 0, loud = 0, loudN = 0, diff = 0, pitchSum = 0, pitchN = 0, lastStart = -Infinity;
    const pc = new Array(12).fill(0);
    const spans = { L: [], R: [] };
    for (const n of notes) {
      if (n.start > t + 0.5) break;
      if (n.start > t - 0.6 && n.start <= t) { dens++; loud += n.velocity; loudN++; }
      if (n.start > t - 1.5 && n.start <= t) { pc[n.pitch % 12] += (n.velocity / 127) * Math.min(1, n.end - n.start + 0.1); pitchSum += n.pitch; pitchN++; }
      if (Math.abs(n.start - t) <= 0.5) diff = Math.max(diff, n.difficulty || 0);
      if (n.start <= t && (n.fingerEnd ?? n.end) >= t) spans[n.hand]?.push(n.pitch); // 手の広がり: 指を離した音（ペダルで残る）は数えない
      if (n.start <= t) lastStart = Math.max(lastStart, n.start);
    }
    const span = (a) => (a.length > 1 ? Math.max(...a) - Math.min(...a) : 0);
    frames.push({
      t: +t.toFixed(3), density: dens, loudness: loudN ? loud / loudN / 127 : 0, majorness: majorness(pc),
      register: pitchN ? pitchSum / pitchN : 60, difficulty: diff, stretch: Math.max(span(spans.L), span(spans.R)),
      rest: t - lastStart,
    });
  }
  const pct = (arr, q) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * q))] || 0; };
  const stats = { densP85: pct(frames.map((f) => f.density), 0.85), diffP50: pct(frames.map((f) => f.difficulty), 0.5), diffP95: pct(frames.map((f) => f.difficulty), 0.95) };
  return { step, frames, stats };
}

// 曲ごとの分布に合わせたドライバ設定
export function paramsFromStats(st) {
  return { densHigh: Math.max(3, st.densP85), diffLow: st.diffP50, diffHigh: Math.max(st.diffP50 + 5, st.diffP95) };
}

export function featuresAt(analysis, t) {
  const i = Math.max(0, Math.min(analysis.frames.length - 1, Math.round(t / analysis.step)));
  return analysis.frames[i];
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// 特徴量 → 気分 → 表情。update(features, dt) を毎フレーム呼ぶ
export class ExpressionDriver {
  constructor(params = {}) {
    this.p = {
      diffLow: 8, diffHigh: 35,     // 運指コストがこの範囲で focus 0→1
      stretchHigh: 12,              // 手の広がり(半音)がこれ以上で苦しい
      densHigh: 6, intensity: 1.0,
      tauMood: 0.25,                // 気分の平滑化（秒）
      attack: 0.08, release: 0.35,  // 表情: 立ち上がりは速く、戻りはゆっくり（秒）
      reaction: 1.0,                // 全体の反応速度（大きいほど速い）
      ...params,
    };
    this.mood = { valence: 0, arousal: 0, focus: 0 };
    this.w = { happy: 0, relaxed: 0, sad: 0, angry: 0, surprised: 0, squint: 0, mouthAa: 0, mouthOu: 0 };
    this.lastLoud = 0; this.pulse = 0;
    this.blinkT = 2 + Math.random() * 3; this.blink = 0;
  }
  update(f, dt) {
    const p = this.p;
    const lerp = (cur, target, tau) => cur + (target - cur) * (1 - Math.exp(-dt * p.reaction / tau));
    // 気分
    const arousalT = clamp01(f.density / p.densHigh * 0.6 + f.loudness * 0.5);
    const valenceT = f.majorness * (0.6 + 0.4 * clamp01(f.loudness + 0.3)) + (f.register - 64) / 48 * 0.2;
    const focusT = clamp01(Math.max((f.difficulty - p.diffLow) / (p.diffHigh - p.diffLow), (f.stretch - 7) / (p.stretchHigh - 7)));
    this.mood.valence = lerp(this.mood.valence, Math.max(-1, Math.min(1, valenceT)), p.tauMood);
    this.mood.arousal = lerp(this.mood.arousal, arousalT, p.tauMood);
    this.mood.focus = lerp(this.mood.focus, focusT, focusT > this.mood.focus ? 0.12 : 0.5);
    // 急に強く鳴った → 驚き/アクセント
    const jump = Math.max(0, f.loudness - this.lastLoud - 0.15); this.lastLoud = lerp(this.lastLoud, f.loudness, 0.5);
    this.pulse = Math.min(1, this.pulse * Math.exp(-dt / 0.25) + jump * 3);
    const { valence: v, arousal: a, focus: fo } = this.mood;
    const restCalm = clamp01((f.rest - 1.5) / 2);  // 休符が続くとリラックス
    const target = {
      happy: clamp01(Math.max(0, v) * (0.35 + 0.65 * a) * (1 - fo * 0.85)),
      relaxed: clamp01(Math.max(0, v) * (1 - a) * 0.6 * (1 - fo) + restCalm * 0.35),
      sad: clamp01(Math.max(0, -v) * (1 - a) * 0.7 * (1 - fo * 0.5)),
      angry: clamp01(fo * 0.45 + Math.max(0, -v) * a * 0.25),       // 眉をひそめる（真剣）
      squint: clamp01(fo * 0.3),                                      // 目を細める
      surprised: clamp01(this.pulse * (1 - fo) * 0.6),
      mouthAa: clamp01(Math.max(0, v) * a * 0.2 * (1 - fo)),         // 楽しいと口が少し開く
      mouthOu: clamp01(fo * 0.25),                                    // 集中で口を結ぶ
    };
    for (const k in target) { const tg = target[k] * p.intensity; this.w[k] = lerp(this.w[k], tg, tg > this.w[k] ? p.attack : p.release); }
    // まばたき
    this.blinkT -= dt;
    if (this.blinkT <= 0) { this.blink = 1; this.blinkT = 2.5 + Math.random() * 3.5 + fo * 2; }
    else if (this.blink > 0) this.blink = Math.max(0, this.blink - dt / 0.12);
    return this.w;
  }
}

// ---- ビート推定: 打鍵の立ち上がり列の自己相関からテンポと拍の位相を求める ----
export function estimateBeat(timeline, { minBpm = 60, maxBpm = 180 } = {}) {
  const notes = timeline.notes; const res = 0.01;
  const dur = Math.max(...notes.map((n) => n.end)) + 1;
  const N = Math.ceil(dur / res); const env = new Float32Array(N);
  for (const n of notes) { const i = Math.round(n.start / res); if (i < N) env[i] += n.velocity / 127; }
  // 自己相関（半拍の倍音を避けるため、候補ラグとその2倍の和で評価）
  let best = { score: -1, lag: 0 };
  for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.5) {
    const lag = Math.round(60 / bpm / res); let sc = 0, sc2 = 0;
    for (let i = 0; i + lag * 2 < N; i++) { sc += env[i] * env[i + lag]; sc2 += env[i] * env[i + lag * 2]; }
    const score = sc + sc2 * 0.5;
    if (score > best.score) best = { score, lag, bpm };
  }
  const period = best.lag * res;
  // 位相: グリッドに乗る打鍵が最大になるオフセット
  let bestOff = 0, bestSum = -1;
  for (let off = 0; off < period; off += res) {
    let sum = 0; for (let t = off; t < dur; t += period) { const i = Math.round(t / res); if (i < N) sum += env[i] + (env[i - 1] || 0) * 0.5 + (env[i + 1] || 0) * 0.5; }
    if (sum > bestSum) { bestSum = sum; bestOff = off; }
  }
  return { bpm: best.bpm, period, offset: bestOff };
}
// 拍の位相 0..1（0 が拍の頭）
export const beatPhase = (beat, t) => (((t - beat.offset) / beat.period) % 1 + 1) % 1;
export const beatIndex = (beat, t) => Math.floor((t - beat.offset) / beat.period);
