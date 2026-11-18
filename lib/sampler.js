// lib/sampler.js — ブラウザ内ピアノ音源（Salamander Grand Piano のサンプルを Web Audio で鳴らす）
//
// タイムライン JSON（pitch/start/end/velocity）をそのまま音にするので mp3 は不要。
// 既定では jsDelivr 上の @audio-samples/piano-velocity{N}（Salamander Grand Piano V3, ogg）を読む。
// サンプルのクレジット: Salamander Grand Piano by Alexander Holm (CC BY 3.0)
//
// 使い方（PianoPerformer が内部で使う。単体でも可）:
//   const s = new PianoSampler(ctx, { layers: [4, 8, 12, 16] });
//   await s.load();                       // 30音 × レイヤー数の ogg をデコード
//   s.noteOn(60, 90, ctx.currentTime + 0.1, 1.2);   // pitch, velocity, when(ctx時刻), 長さ(秒)
//   s.stopAll(0.3);                       // 鳴っている音を全部リリース

// Salamander のサンプル音高（3半音おき）: A0=21, C1=24, D#1=27, F#1=30 … C8=108（30音）
const NOTE_NAME = { 9: 'A', 0: 'C', 3: 'D#', 6: 'F#' };
const SAMPLE_PITCHES = [];
for (let p = 21; p <= 108; p += 3) SAMPLE_PITCHES.push({ pitch: p, name: `${NOTE_NAME[p % 12]}${Math.floor(p / 12) - 1}` });

const cache = new Map(); // url -> Promise<AudioBuffer>

export const DEFAULT_SAMPLER = {
  type: 'salamander',
  baseUrl: 'https://cdn.jsdelivr.net/npm/@audio-samples/piano-velocity{layer}/audio/',
  layers: [6, 12],
  gain: 1.0,
  sustain: 0.0,          // 擬似ペダル: 各音を何秒長く鳴らすか（同音の次の打鍵で止まる）
  release: 0.25,         // 鍵を離したあとの減衰（秒）
  velCurve: 1.0,         // 強弱の効き方（1 で素直、>1 で差が大きい）
};

export class PianoSampler {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.o = { ...DEFAULT_SAMPLER, ...opts };
    this.buffers = new Map();   // `${layer}:${pitch}` -> AudioBuffer
    this.out = ctx.createGain(); this.out.gain.value = this.o.gain;
    this.active = new Set();    // { src, g, end }
    this.loaded = false;
  }
  connect(node) { this.out.connect(node); return this; }
  async load(onProgress) {
    const jobs = [];
    let done = 0; const total = this.o.layers.length * SAMPLE_PITCHES.length;
    for (const layer of this.o.layers) {
      for (const s of SAMPLE_PITCHES) {
        const url = this.o.baseUrl.replace('{layer}', layer) + encodeURIComponent(`${s.name}v${layer}.ogg`);
        jobs.push(this._fetch(url).then((buf) => { this.buffers.set(`${layer}:${s.pitch}`, buf); done++; onProgress?.(done, total); }));
      }
    }
    await Promise.all(jobs);
    this.loaded = true;
  }
  _fetch(url) {
    if (!cache.has(url)) cache.set(url, fetch(url).then((r) => { if (!r.ok) throw new Error(`${r.status} ${url}`); return r.arrayBuffer(); }).then((ab) => this.ctx.decodeAudioData(ab)));
    return cache.get(url);
  }
  _pick(pitch, vel) {
    // レイヤー: Salamander は16層で velocity を8刻みに割り当て。手持ちの中で最も近い層
    const ideal = Math.max(1, Math.min(16, Math.ceil(vel / 8)));
    let layer = this.o.layers[0];
    for (const L of this.o.layers) if (Math.abs(L - ideal) < Math.abs(layer - ideal)) layer = L;
    // サンプル音高: 最も近いもの（3半音おきなので ±1半音以内）
    let sp = SAMPLE_PITCHES[0];
    for (const s of SAMPLE_PITCHES) if (Math.abs(s.pitch - pitch) < Math.abs(sp.pitch - pitch)) sp = s;
    return { buf: this.buffers.get(`${layer}:${sp.pitch}`), rate: Math.pow(2, (pitch - sp.pitch) / 12), layer };
  }
  /** pitch, velocity(1..127), when: ctx.currentTime 基準の開始時刻, dur: 鍵を押している秒数 */
  noteOn(pitch, vel, when, dur) {
    if (!this.loaded) return;
    const { buf, rate, layer } = this._pick(pitch, vel);
    if (!buf) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate;
    const g = ctx.createGain();
    // 層ごとの音量差はサンプル自体に入っているので、層内の細かい差だけゲインで補う
    const layerVel = layer * 8 - 4;
    const fine = Math.pow(vel / layerVel, this.o.velCurve);
    const v = Math.max(0.05, Math.min(1.6, fine)) * (0.55 + 0.45 * Math.pow(vel / 127, 0.8));
    g.gain.setValueAtTime(v, when);
    const rel = pitch >= 72 ? this.o.release * 0.6 : this.o.release;
    const end = when + Math.max(0.03, dur) + this.o.sustain;
    g.gain.setValueAtTime(v, end);
    g.gain.exponentialRampToValueAtTime(0.001, end + rel);
    src.connect(g); g.connect(this.out);
    src.start(when);
    src.stop(end + rel + 0.05);
    const rec = { src, g, end: end + rel };
    this.active.add(rec);
    src.onended = () => { this.active.delete(rec); try { g.disconnect(); } catch {} };
    return rec;
  }
  /** 全発音を止める（短いリリース付き） */
  stopAll(release = 0.25) {
    const now = this.ctx.currentTime;
    for (const r of this.active) {
      try {
        r.g.gain.cancelScheduledValues(now);
        r.g.gain.setValueAtTime(Math.max(0.001, r.g.gain.value), now);
        r.g.gain.exponentialRampToValueAtTime(0.001, now + release);
        r.src.stop(now + release + 0.02);
      } catch {}
    }
    this.active.clear();
  }
  setGain(v) { this.out.gain.value = v; }
}

/**
 * 楽譜由来の MIDI（ベロシティが全部同じ）に強弱を付ける。timeline.notes を書き換える。
 * 右手トップ音を旋律として強く、伴奏は弱く、音高が上がるほど少し強く、乱数で揺らす。
 * 既に強弱があるタイムラインには何もしない（force で強制）。
 */
export function applyDynamics(tl, { force = false, seed = 3 } = {}) {
  const vels = new Set(tl.notes.map((n) => n.velocity));
  if (!force && vels.size > 2) return false;
  let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const gauss = () => { const u = rnd() || 1e-9, v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const notes = [...tl.notes].sort((a, b) => a.start - b.start);
  let i = 0;
  while (i < notes.length) {
    let j = i; while (j + 1 < notes.length && notes[j + 1].start - notes[i].start <= 0.03) j++;
    const g = notes.slice(i, j + 1);
    const topR = Math.max(...g.filter((n) => n.hand === 'R').map((n) => n.pitch), -1);
    const lowL = Math.min(...g.filter((n) => n.hand === 'L').map((n) => n.pitch), 999);
    for (const n of g) {
      let base;
      if (n.hand === 'R') base = (n.pitch === topR ? 84 : 66) + (n.pitch - 72) * 0.45;
      else base = n.pitch === lowL ? 58 : 50;
      base += gauss() * 3.5;
      n.velocity = Math.round(Math.max(20, Math.min(120, base)));
    }
    i = j + 1;
  }
  return true;
}
