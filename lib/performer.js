// PianoPerformer: VRM にピアノ演奏をさせるライブラリ（DOM 非依存）
//
// 使い方:
//   import { PianoPerformer } from './lib/performer.js';
//   const perf = new PianoPerformer({ THREE });     // three は利用側のものを渡す（二重読み込み回避）
//   perf.attach(vrm, scene);                         // VRM は利用側が読み込んだもの（VRM 0.x は rotateVRM0 済みであること。VRM 1.0 もそのまま使える）
//   perf.frame.position.set(x, 0, z); perf.frame.rotation.y = yaw;  // 部屋のどこで弾くか（省略時は原点・+Z 向き）。鍵盤は frame の子
//   perf.getStand()                                  // キャラが立つ位置と向く点（歩いて行かせる用）
//   await perf.loadSong(await loadSongConfig('songs/bach_polonaise_f/song.json'));
//   perf.play();                                     // 手を鍵盤に乗せて（約1秒）演奏開始
//   ... 毎フレーム: perf.update(dt)  （利用側のアニメーションの後、vrm.update(dt) の前に呼ぶ）
//   perf.stop();                                     // 手を下ろす
//
// 座って弾く（ゲーミングチェアなど）: perf.setOptions({ seated: true, keyboard: { range: 'song' } })
//   seated: 体の置き場所・脚・腰は利用側に任せる（placeBody・下半身のビートなし、終わっても脚・腰・上半身を戻さない）
//   perf.alignToBody(): いまの腰の位置から keyboard.offset を決める（立って調整した song.json の値を、座った体にそのまま使える）
//   keyboard.range: 'full'（88 鍵）| 'song'（曲で使う音の範囲だけ）。perf.keyboardSpan で鍵盤の幅と中心（frame ローカル）が分かる
//
// ブレンド: perf.weight (0..1) で影響度。利用側が先に付けたポーズから、演奏ポーズへ slerp する。
// 上書き: perf.setOverride({ head: {yaw, pitch}, expressions: {happy: 1} }, seconds) で、手を止めずに頭と表情だけ差し替え。
// 状態: perf.getState(), perf.on('start'|'end'|'note'|'section', fn)

import { analyze, featuresAt, ExpressionDriver, paramsFromStats, estimateBeat, beatPhase, beatIndex } from '../expression/mood.js';
import { PianoSampler, applyDynamics, DEFAULT_SAMPLER } from './sampler.js';

export const DEFAULT_OPTIONS = {
  keyboard: { scale: 0.65, height: 0.76, z: 0.28, x: 0, range: 'full', offset: { x: 0, y: 0, z: 0 } },
  body: { x: 0, y: 0, z: 0 },
  play: { lookahead: 0.12, wristTau: 0.06, wristHeight: 0.055, reach: 0.9, wristBack: 0.75, tipSolve: true, wristWeighted: true, tipCorrect: false, idleCurl: 0.35, press: 0.012, wristTwist: 0, flipCurl: false, flipYaw: false },
  sway: { lean: 0.8, beatHead: 0.7, beatBody: 0.7 },
  beat: { bpm: 0, offset: 0, div: 1, feel: 'down' },      // feel: 'down' | 'off' | 'back'
  expression: { mode: 'auto', intensity: 1, reaction: 1.5, lookahead: 0.15, lookAtHands: true },
  lipsync: { enabled: true, gain: 1, lead: 0.03, happyDuck: 0.6 },   // 歌の口パク（song.lipsync があるとき）。lead: 音より何秒早く口を動かすか、happyDuck: 歌っている間 笑顔をどれだけ弱めるか
  transition: { inSec: 1.0, outSec: 0.8 },
  idlePose: 'arms-down',   // 演奏していないときの腕: 'arms-down' | 'none'（利用側が自前でポーズを付けるなら 'none'）
  placeBody: true,         // 演奏中、体を frame 基準の立ち位置へ寄せる
  seated: false,           // 座って弾く: 脚・腰・体の位置は利用側のまま（下半身のビートと placeBody を使わない）
};

// 曲ごとの設定（song.json の options）に入れない、使う側（画面）の設定。
// 古い書き出しで song.json に入っていても無視する（入っていると、ゲーム実況の座った腕が「下ろした腕」で上書きされる）
const APP_OPTIONS = ['idlePose', 'placeBody', 'seated'], APP_KEYBOARD = ['range', 'offset'];
export function songOptions(o) {
  const r = { ...o }; for (const k of APP_OPTIONS) delete r[k];
  if (r.keyboard) { r.keyboard = { ...r.keyboard }; for (const k of APP_KEYBOARD) delete r.keyboard[k]; }
  return r;
}
const deepMerge = (a, b) => { const o = { ...a }; for (const k in b) o[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) ? deepMerge(a[k] || {}, b[k]) : b[k]; return o; };
const isBlack = (p) => [1, 3, 6, 8, 10].includes(p % 12);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ---- 音声時計: AudioContext 基準（OBS ブラウザソースでも音と動きがずれない）----
class AudioClock {
  constructor() { this.ctx = null; this.buffer = null; this.src = null; this.startAt = 0; this.offset = 0; this.playing = false; this.duration = 0; this.gain = null; this.synth = null; this.notes = null; this.nextIdx = 0; }
  /** 音源モード: mp3 の代わりにタイムラインの音をサンプラーで鳴らす */
  setSynth(sampler, notes) { this.synth = sampler; this.notes = notes ? [...notes].sort((a, b) => a.start - b.start) : null; this.nextIdx = 0; }
  async load(url) {
    this.ctx = this.ctx || new (globalThis.AudioContext || globalThis.webkitAudioContext)();
    if (!this.gain) { this.gain = this.ctx.createGain(); this.an = this.ctx.createAnalyser(); this.an.fftSize = 256; this.gain.connect(this.an); this.an.connect(this.ctx.destination); this._anBuf = new Float32Array(256); }
    if (url) {
      const res = await fetch(url); if (!res.ok) throw new Error(`cannot load audio ${res.status}: ${url}`);
      try { this.buffer = await this.ctx.decodeAudioData(await res.arrayBuffer()); }
      catch (e) { throw new Error(`cannot decode audio (format not supported by this browser? OBS may not play mp3; try ogg/wav): ${url}`); }
    } else this.buffer = null;
    this.duration = this.buffer ? this.buffer.duration : 0;
    if (url) this.setSynth(null, null);
  }
  get time() { return this.playing ? this.offset + (this.ctx.currentTime - this.startAt) : this.offset; }
  play() {
    if (this.playing) return;
    if (this.ctx?.state === 'suspended') this.ctx.resume();
    if (this.buffer) { this.src = this.ctx.createBufferSource(); this.src.buffer = this.buffer; this.src.connect(this.gain); this.src.start(0, this.offset); }
    this.startAt = this.ctx ? this.ctx.currentTime : performance.now() / 1000; this.playing = true;
    if (this.synth && this.notes) { let i = 0; while (i < this.notes.length && this.notes[i].start < this.offset - 0.001) i++; this.nextIdx = i; this.tick(); }
  }
  pause() { if (!this.playing) return; this.offset = this.time; if (this.src) { try { this.src.stop(); } catch {} this.src = null; } if (this.synth) this.synth.stopAll(0.25); this.playing = false; }
  seek(t) { const was = this.playing; this.pause(); this.offset = Math.max(0, t); if (was) this.play(); }
  tick() {
    // 音源モード: 0.5 秒先まで AudioContext の時刻で予約する（毎フレーム呼ぶ）
    if (!this.playing || !this.synth || !this.notes) return;
    const horizon = this.time + 0.5;
    while (this.nextIdx < this.notes.length && this.notes[this.nextIdx].start <= horizon) {
      const n = this.notes[this.nextIdx++];
      const when = this.startAt + (n.start - this.offset);
      if (when >= this.ctx.currentTime - 0.01) this.synth.noteOn(n.pitch, n.velocity || 80, Math.max(when, this.ctx.currentTime), n.end - n.start);
    }
  }
  setVolume(v) { if (this.gain) this.gain.gain.value = v; }
  // 出力レベル（0〜1, RMS）: 配信ソフトで音が出ないときの切り分け用
  level() { if (!this.an) return 0; this.an.getFloatTimeDomainData(this._anBuf); let s = 0; for (const x of this._anBuf) s += x * x; return Math.sqrt(s / this._anBuf.length); }
  // 状態の要約（デバッグ表示用）
  info() { const c = this.ctx; return { state: c?.state, synth: !!this.synth, rate: c?.sampleRate, buffer: this.buffer ? Math.round(this.buffer.duration) : null, playing: this.playing, time: Math.round(this.time * 10) / 10, gain: this.gain?.gain.value, level: Math.round(this.level() * 1000) / 1000 }; }
}

export class PianoPerformer {
  constructor({ THREE }) {
    this.THREE = THREE;
    this.options = deepMerge(DEFAULT_OPTIONS, {});
    this.weight = 0; this._weightTarget = 0; this._state = 'idle'; // idle | entering | playing | paused | leaving
    this.clock = new AudioClock();
    this.vrm = null; this.scene = null; this.song = null; this.tl = null; this.analysis = null; this.driver = null; this.beat = null;
    this.keys = new Map(); this.keyboard = new THREE.Group(); this.keyboard.name = 'piano-keyboard';
    this.frame = new THREE.Group(); this.frame.name = 'piano-station'; // 演奏の基準座標（+Z が正面）。鍵盤と視線ターゲットはこの子
    this._frontYaw = Math.PI; // モデル本来の正面を +Z に向ける回転（VRM 0.x は -Z が正面なので π、VRM 1.0 は +Z が正面なので 0。attach で決める）
    this._ROT_FRONT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    this._listeners = {}; this._override = null; this._overrideUntil = 0;
    this._hands = { L: null, R: null }; this._arm = { L: {}, R: {} }; this._legs = { L: {}, R: {} }; this._body = {};
    this._sway = { lean: 0, energy: 0 }; this._springs = { head: { x: 0, v: 0 }, body: { x: 0, v: 0 }, lastIndex: null, lastT: 0 }; this._beatOut = { head: 0, body: 0, cont: 0 };
    this._pressed = new Set(); this._lastT = 0; this._ended = false; this._lastActivePitches = new Set();
    this.lookTarget = new THREE.Object3D(); this.lookTarget.name = 'piano-look-target';
    this.frame.add(this.keyboard); this.frame.add(this.lookTarget);
  }

  // ---------- 公開 API ----------
  on(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); return this; }
  _emit(ev, data) { for (const fn of this._listeners[ev] || []) fn(data); }

  attach(vrm, scene) {
    this.vrm = vrm; this.scene = scene;
    // VRM 0.x（meta.metaVersion '0'）はモデル本来の正面が -Z、VRM 1.0 は +Z
    this._frontYaw = vrm.meta?.metaVersion === '0' ? Math.PI : 0;
    this._ROT_FRONT.setFromAxisAngle(new this.THREE.Vector3(0, 1, 0), this._frontYaw);
    scene.add(this.frame);
    this._measure();
    this._buildKeyboard();
    return this;
  }
  dispose() {
    this.stop(true);
    if (this.scene) this.scene.remove(this.frame);
    if (this.vrm?.lookAt) this.vrm.lookAt.target = null;
    this.vrm = null; this.scene = null;
  }
  setOptions(partial) {
    const prevScale = this.options.keyboard.scale, prevRange = this.options.keyboard.range;
    this.options = deepMerge(this.options, partial);
    if (this.options.keyboard.scale !== prevScale || this.options.keyboard.range !== prevRange) this._buildKeyboard();
    if (this.driver) { this.driver.p.intensity = this.options.expression.intensity; this.driver.p.reaction = this.options.expression.reaction; }
  }
  async loadSong(song, { silent = false } = {}) {
    // song: { name, audio, timeline (object or url), options }
    // silent: 音声もサンプラーも読まない（自動調整など、動きだけ計算したいとき）
    this.song = song;
    this.tl = typeof song.timeline === 'string' ? await (await fetch(song.timeline, { cache: 'no-cache' })).json() : song.timeline;
    this.tl.notes.sort((a, b) => a.start - b.start);
    // 歌の口パク: lipsync.json（{ fps, keys: ["aa","ih","ou","ee","oh"], frames: [0..100 の整数を 1 コマ 5 個ずつ平たく並べたもの] }）
    this.lip = null;
    if (song.lipsync) { try { this.lip = typeof song.lipsync === 'string' ? await (await fetch(song.lipsync, { cache: 'no-cache' })).json() : song.lipsync; } catch (e) { console.warn('cannot load lipsync', e); } }
    this.tl.duration = Math.max(...this.tl.notes.map((n) => n.end));
    this._songRange = [Math.min(...this.tl.notes.map((n) => n.pitch)), Math.max(...this.tl.notes.map((n) => n.pitch))];
    if (this.options.keyboard.range === 'song') this._buildKeyboard();
    this.analysis = analyze(this.tl);
    this.driver = new ExpressionDriver(paramsFromStats(this.analysis.stats));
    this.beat = estimateBeat(this.tl);
    if (song.options) this.setOptions(songOptions(song.options));
    this.options.play.fingerCorr = song.options?.play?.fingerCorr || null;
    if (this.vrm) { this.resetFingerCorr(); this.setFingerCorr(this.options.play.fingerCorr); }
    this.setOptions({}); // driver に intensity 反映
    if (silent) { if (!song.audio && (song.synth?.dynamics !== false) && applyDynamics(this.tl)) { this.analysis = analyze(this.tl); this.driver = new ExpressionDriver(paramsFromStats(this.analysis.stats)); this.setOptions({}); } this._ended = false; return { notes: this.tl.notes.length, duration: this.tl.duration, bpm: this.beat.bpm }; }
    await this.clock.load(song.audio || null);
    if (!song.audio) {
      // 音源モード: mp3 なし。タイムラインの音をブラウザ内のピアノ音源で鳴らす
      const so = { ...DEFAULT_SAMPLER, ...(song.synth || {}) };
      if (so.dynamics !== false && applyDynamics(this.tl)) { this.analysis = analyze(this.tl); this.driver = new ExpressionDriver(paramsFromStats(this.analysis.stats)); this.setOptions({}); }
      const key = JSON.stringify([so.baseUrl, so.layers]);
      if (!this._sampler || this._samplerKey !== key) {
        this._sampler = new PianoSampler(this.clock.ctx, so).connect(this.clock.gain); this._samplerKey = key;
        await this._sampler.load((d, t) => this._emit('samplerProgress', { done: d, total: t }));
      } else { this._sampler.o = { ...this._sampler.o, ...so }; this._sampler.setGain(so.gain); }
      this.clock.setSynth(this._sampler, this.tl.notes);
      this.clock.duration = this.tl.duration + 1.5;
    }
    this.clock.seek(0); this._ended = false;
    return { notes: this.tl.notes.length, duration: this.tl.duration, bpm: this.beat.bpm };
  }
  get duration() { return this.tl ? Math.max(this.tl.duration, this.clock.duration) : 0; }
  get time() { return this.clock.time; }
  get state() { return this._state; }
  play() {
    if (!this.tl) return;
    if (this._ended || this.clock.time >= this.duration - 0.05) { this.clock.seek(0); this._resetDynamics(); this._lastActivePitches = new Set(); } // 前回最後まで弾いたあとは頭から
    this._ended = false; this._state = this.weight < 0.99 ? 'entering' : 'playing'; this._weightTarget = 1; this.clock.play(); this._emit('start', this.getState());
  }
  pause() { this.clock.pause(); this._state = 'paused'; }
  resume() { this.clock.play(); this._state = 'playing'; }
  seek(t) { this.clock.seek(clamp(t, 0, this.duration)); this._ended = false; this._resetDynamics(); }
  stop(immediate = false) {
    this.clock.pause(); this.clock.seek(0); this._weightTarget = 0; this._state = 'leaving';
    if (immediate) { this.weight = 0; this._state = 'idle'; }
  }
  setOverride(o, seconds = 1.5) { this._override = o; this._overrideUntil = performance.now() / 1000 + seconds; }
  glance(yaw = 0.4, pitch = -0.1, seconds = 1.5, expressions = { happy: 0.5 }) { this.setOverride({ head: { yaw, pitch }, expressions }, seconds); }
  getState() {
    const t = this.time; const f = this.analysis ? featuresAt(this.analysis, t) : null; const m = this.driver?.mood || {};
    return { state: this._state, song: this.song?.name || null, time: t, duration: this.duration, progress: this.duration ? t / this.duration : 0,
      bpm: this.beat?.bpm || 0, difficulty: f?.difficulty || 0, isHard: f ? f.difficulty > (this.driver?.p.diffHigh || 30) * 0.8 : false,
      mood: { valence: m.valence || 0, arousal: m.arousal || 0, focus: m.focus || 0 }, weight: this.weight };
  }
  // キャラが立つ位置（world）と向く点。frame の +Z が正面
  getStand() {
    const b = this.options.body; const pos = this.frame.localToWorld(new this.THREE.Vector3(b.x, 0, b.z));
    return { pos, look: this.frame.localToWorld(new this.THREE.Vector3(b.x, 0.8, b.z + 2)), yaw: this._standYaw() };
  }
  _standYaw() { const e = new this.THREE.Euler().setFromQuaternion(this.frame.getWorldQuaternion(new this.THREE.Quaternion()), 'YXZ'); return e.y + this._frontYaw; } // VRM 0.x は -Z が正面なので π 回す、VRM 1.0 はそのまま
  // 演奏空間 P（frame ローカル）と world の変換
  _toP(v) { return this.frame.worldToLocal(v.clone()); }
  _toW(v) { return this.frame.localToWorld(v.clone()); }
  _qToP(q) { return this.frame.getWorldQuaternion(new this.THREE.Quaternion()).invert().multiply(q); }
  // 現在の調整値を song.json 用に書き出す
  exportOptions() { return songOptions(JSON.parse(JSON.stringify(this.options))); }

  // ---------- 鍵盤 ----------
  _buildKeyboard() {
    const { THREE } = this; const ks = this.options.keyboard.scale;
    while (this.keyboard.children.length) this.keyboard.remove(this.keyboard.children[0]);
    this.keys.clear();
    const WW = 0.0235 * ks, WL = 0.15 * ks, BW = 0.0135 * ks, BL = 0.095 * ks;
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.5 }), blackMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.4 });
    let wi = 0; const whiteCount = 52;
    const xOf = (i) => -(i - (whiteCount - 1) / 2) * WW; // 低音がキャラの左(+X)側
    // range 'song': 曲で使う音の範囲（両側に 2 半音、端は白鍵）だけ作る。鍵の位置は 88 鍵のときと同じ（運指・調整値がそのまま使える）
    let lo = 21, hi = 108;
    if (this.options.keyboard.range === 'song' && this._songRange) {
      lo = Math.max(21, this._songRange[0] - 2); hi = Math.min(108, this._songRange[1] + 2);
      while (lo > 21 && isBlack(lo)) lo--; while (hi < 108 && isBlack(hi)) hi++;
    }
    let xMin = Infinity, xMax = -Infinity;
    for (let p = 21; p <= 108; p++) {
      const inRange = p >= lo && p <= hi;
      if (!inRange) { if (!isBlack(p)) wi++; continue; }
      if (!isBlack(p)) { xMin = Math.min(xMin, xOf(wi) - WW / 2); xMax = Math.max(xMax, xOf(wi) + WW / 2); }
      if (!isBlack(p)) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(WW * 0.94, 0.02 * ks, WL), whiteMat.clone()); m.position.set(xOf(wi), 0, 0); this.keyboard.add(m);
        this.keys.set(p, { mesh: m, x: xOf(wi), zPress: -WL * 0.32, top: 0.01 * ks, y0: 0 }); wi++;
      } else {
        const x = xOf(wi - 1) - WW / 2 - ([1, 6].includes(p % 12) ? -0.002 : [3, 10].includes(p % 12) ? 0.002 : 0) * ks;
        const m = new THREE.Mesh(new THREE.BoxGeometry(BW, 0.022 * ks, BL), blackMat.clone()); m.position.set(x, 0.011 * ks, (WL - BL) / 2); this.keyboard.add(m); // 黒鍵は奥(+Z)
        this.keys.set(p, { mesh: m, x, zPress: 0.015 * ks, top: 0.022 * ks, y0: 0.011 * ks });
      }
    }
    const width = xMax - xMin + 0.06 * ks, center = (xMin + xMax) / 2;
    const body = new THREE.Mesh(new THREE.BoxGeometry(width, 0.04 * ks, WL + 0.04 * ks), new THREE.MeshStandardMaterial({ color: 0x3a2a24 }));
    body.position.set(center, -0.03 * ks, 0); this.keyboard.add(body);
    // 鍵盤の外形（keyboard ローカル。x は中心と幅、y は底、z は奥行き）。座って弾くときに台の大きさを合わせる用
    this.keyboardSpan = { center, width, depth: WL + 0.04 * ks, bottom: -0.05 * ks, lo, hi };
  }
  // 実際の鍵盤の位置（frame ローカル）= keyboard の値 + offset（座ったときのずれ）
  _kb() { const k = this.options.keyboard, o = k.offset || {}; return { x: k.x + (o.x || 0), height: k.height + (o.y || 0), z: k.z + (o.z || 0) }; }
  /** 座ったときなど、体の位置が立ち位置（frame 原点 + body）とちがうとき: いまの腰の位置と、立って調整したときの腰の位置の差を keyboard.offset にする。
   *  上半身は演奏中まっすぐに起こすので、腰が下がった・後ろへ引いた分だけ鍵盤を動かせば、腕と鍵盤の関係は立ったときと同じになる */
  alignToBody() {
    const { THREE } = this; const hips = this._body.hips?.node; if (!hips || !this._body.hipsP) return null;
    this.vrm.scene.updateMatrixWorld(true);
    const cur = this._toP(hips.getWorldPosition(new THREE.Vector3())), b = this.options.body;
    const rest = this._body.hipsP.clone().add(new THREE.Vector3(b.x, b.y, b.z));
    const offset = { x: +(cur.x - rest.x).toFixed(4), y: +(cur.y - rest.y).toFixed(4), z: +(cur.z - rest.z).toFixed(4) };
    this.options.keyboard.offset = offset; return offset;
  }
  _keyWorld(p) { const k = this.keys.get(p); if (!k) return null; const kb = this.keyboard.position; return new this.THREE.Vector3(kb.x + k.x, kb.y + k.top, kb.z + k.zPress); }
  // 指が狙う点: 鍵の打鍵点から、その指の学習したずれを引く
  _aimPoint(s, f, pitch) { const T = this._keyWorld(pitch); if (!T) return null; const c = this._hands[s].fingers[f]?.corr; if (c && this.options.play.tipCorrect === true) { T.x -= c.x; T.z -= c.z; } return T; }
  // 指先のずれの学習（積分）: 押している指の指先と鍵の差を少しずつ補正に足す。手の形（親指・小指の開き）による一定のずれが消える
  _learnTips(out, t, dt) {
    const o = this.options.play; if (o.tipCorrect !== true || !(dt > 0) || dt > 0.1) return;
    const { THREE } = this; const k = Math.min(1, dt / (o.tipLearnSec || 0.4)), lim = 0.035;
    this.vrm.scene.updateMatrixWorld(true);
    const a = this._tmpA || (this._tmpA = new THREE.Vector3()), b = this._tmpB || (this._tmpB = new THREE.Vector3());
    for (const s of ['L', 'R']) for (let f = 0; f < 5; f++) {
      const note = out[s][f], fg = this._hands[s].fingers[f]; if (!note || !fg || !(note.start + 0.02 <= t && t <= (note.fingerEnd ?? note.end))) continue;
      const T = this._keyWorld(note.pitch); if (!T) continue;
      fg.nodes[1].getWorldPosition(a); fg.nodes[2].getWorldPosition(b);
      const tip = this._toP(b.clone().add(b.clone().sub(a).normalize().multiplyScalar(fg.l3)));
      fg.corr.x = clamp(fg.corr.x + (tip.x - T.x) * k, -lim, lim);
      fg.corr.z = clamp(fg.corr.z + (tip.z - T.z) * k, -lim, lim);
    }
  }
  /** 学習した指先の補正（song.json の play.fingerCorr 用） */
  getFingerCorr() { const r = {}; for (const s of ['L', 'R']) r[s] = this._hands[s].fingers.map((fg) => (fg ? [+fg.corr.x.toFixed(4), +fg.corr.z.toFixed(4)] : [0, 0])); return r; }
  resetFingerCorr() { for (const s of ['L', 'R']) for (const fg of this._hands[s]?.fingers || []) if (fg) fg.corr.set(0, 0, 0); }
  setFingerCorr(c) { if (!c) return; for (const s of ['L', 'R']) (c[s] || []).forEach((v, f) => { const fg = this._hands[s]?.fingers[f]; if (fg && v) fg.corr.set(v[0], 0, v[1]); }); }

  // ---------- VRM 計測 ----------
  _measure() {
    const { THREE, vrm } = this; const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z), Q = () => new THREE.Quaternion();
    const hum = vrm.humanoid; hum.resetNormalizedPose(); vrm.scene.updateMatrixWorld(true);
    // 休め姿勢を「演奏空間 P」で記録する。P = VRM ルート基準で、モデルの正面が +Z になるよう回したもの（VRM 0.x は 180°、VRM 1.0 はそのまま）
    const sq = vrm.scene.getWorldQuaternion(Q()).invert(), R = this._ROT_FRONT;
    const wp = (n) => { const v = vrm.scene.worldToLocal(n.getWorldPosition(V3())); return v.applyQuaternion(R); };
    const wq = (n) => R.clone().multiply(sq.clone().multiply(n.getWorldQuaternion(Q())));
    const FING = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
    for (const s of ['L', 'R']) {
      const side = s === 'L' ? 'left' : 'right';
      const u = hum.getNormalizedBoneNode(side + 'UpperArm'), l = hum.getNormalizedBoneNode(side + 'LowerArm'), h = hum.getNormalizedBoneNode(side + 'Hand');
      const pu = wp(u), pl = wp(l), ph = wp(h);
      this._arm[s] = { u, l, h, L1: pu.distanceTo(pl), L2: pl.distanceTo(ph), dirU: pl.clone().sub(pu).normalize(), dirL: ph.clone().sub(pl).normalize(), qU: wq(u), qL: wq(l), qH: wq(h) };
      const qHinv = this._arm[s].qH.clone().invert();
      const fingers = [];
      for (let f = 0; f < 5; f++) {
        const joints = f === 0 ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
        const nodes = joints.map((j) => hum.getNormalizedBoneNode(side + FING[f] + j));
        if (nodes.some((n) => !n)) { fingers.push(null); continue; }
        const P = nodes.map((n) => wp(n));
        const l1 = P[0].distanceTo(P[1]), l2 = P[1].distanceTo(P[2]), l3 = l2 * 0.8;
        fingers.push({ nodes, l1, l2, l3, base: P[0].clone().sub(ph).applyQuaternion(qHinv), len: l1 + l2 + l3, corr: V3() }); // corr: 指先のずれの学習値（演奏空間 x,z）
      }
      this._hands[s] = { fingers, alongSign: s === 'L' ? -1 : 1, pos: V3(0, 0.85, 0.2), target: V3(0, 0.85, 0.2), lastActive: -10 };
      const ul = hum.getNormalizedBoneNode(side + 'UpperLeg'), ll = hum.getNormalizedBoneNode(side + 'LowerLeg'), ft = hum.getNormalizedBoneNode(side + 'Foot');
      if (ul && ll && ft) {
        const pul = wp(ul), pll = wp(ll), pft = wp(ft);
        this._legs[s] = { ul, ll, ft, thigh: pul.distanceTo(pll), shin: pll.distanceTo(pft), qU: wq(ul), qL: wq(ll), qF: wq(ft) };
      }
    }
    for (const b of ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head']) { const n = hum.getNormalizedBoneNode(b); if (n) this._body[b] = { node: n, q: wq(n) }; }
    this._body.hipsRest = hum.getNormalizedBoneNode('hips').position.clone();
    this._body.hipsP = wp(hum.getNormalizedBoneNode('hips')); // 立ったときの腰（演奏空間、キャラの足元が原点）
    this.handInfo = { fingerLen: this._hands.L.fingers.map((f) => f ? f.len : 0) };
  }
  _applyIdlePose() {
    if (this.options.idlePose !== 'arms-down') return;
    const { THREE } = this;
    for (const s of ['L', 'R']) {
      const A = this._arm[s]; const sign = s === 'L' ? 1 : -1;
      const parentQ = this._qToP(A.u.parent.getWorldQuaternion(new THREE.Quaternion()));
      const dU = this._rotFromTo(A.dirU, new THREE.Vector3(sign * 0.25, -1, 0.05).normalize()); // 腕を下ろす
      A.u.quaternion.copy(parentQ.clone().invert().multiply(dU.clone().multiply(A.qU)));
      A.l.quaternion.identity(); A.h.quaternion.identity();
    }
  }
  _resetDynamics() { const sp = this._springs; sp.head.x = sp.head.v = sp.body.x = sp.body.v = 0; sp.lastIndex = null; }

  // ---------- 毎フレーム ----------
  update(dt) {
    if (!this.vrm || !this.tl) return;
    dt = Math.min(0.1, Math.max(0.0001, dt));
    // 入り/終わりのブレンド
    const tr = this.options.transition;
    const rate = this._weightTarget > this.weight ? dt / tr.inSec : dt / tr.outSec;
    this.weight = clamp(this.weight + Math.sign(this._weightTarget - this.weight) * rate, 0, 1);
    if (this._state === 'entering' && this.weight >= 0.999) this._state = 'playing';
    if (this._state === 'leaving' && this.weight <= 0.001) {
      this._state = 'idle'; this._clearKeys();
      // 触ったボーンをレストに戻す（利用側が毎フレームポーズを付けるなら上書きされるだけ）
      // seated: 脚・腰・上半身・腕は利用側が毎フレーム付けているので触らない（戻すと 1 コマだけ立ち姿勢になり、髪も揺れる）。指だけ戻す
      const seated = this.options.seated;
      for (const s of ['L', 'R']) { const A = this._arm[s]; if (!seated) [A.u, A.l, A.h].forEach((n) => n.quaternion.identity()); for (const f of this._hands[s].fingers) if (f) f.nodes.forEach((n) => n.quaternion.identity()); const G = this._legs[s]; if (G.ul && !seated) [G.ul, G.ll, G.ft].forEach((n) => n.quaternion.identity()); }
      if (!seated) { for (const b of ['spine', 'chest', 'neck', 'head']) this._body[b]?.node.quaternion.identity(); if (this._body.hips) this._body.hips.node.position.copy(this._body.hipsRest); }
      const em = this.vrm.expressionManager; if (em) for (const n of ['happy', 'relaxed', 'sad', 'angry', 'surprised', 'Surprised', 'aa', 'ih', 'ou', 'ee', 'oh', 'blink']) if (em.getExpression(n)) em.setValue(n, 0);
      if (this.vrm.lookAt) this.vrm.lookAt.target = null;
      this._emit('end', this.getState());
    }
    if (this.weight <= 0) { this._clearKeys(); this._applyIdlePose(); return; }
    this.clock.tick();
    const t = this.clock.time;
    if (this.clock.playing && !this._ended && t >= this.duration) { this._ended = true; this.clock.pause(); this._emit('songEnd', this.getState()); this._weightTarget = 0; this._state = 'leaving'; }
    this._apply(t, dt);
    this._lastT = t;
  }

  _apply(t, dt) {
    const { THREE, vrm } = this; const o = this.options; const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z), Q = () => new THREE.Quaternion();
    const w = this.weight;
    // 利用側のポーズを退避（ブレンド用）
    const snapshot = new Map(); const bones = [];
    for (const s of ['L', 'R']) { const A = this._arm[s]; bones.push(A.u, A.l, A.h); for (const f of this._hands[s].fingers) if (f) bones.push(...f.nodes); const G = this._legs[s]; if (G.ul && !o.seated) bones.push(G.ul, G.ll, G.ft); }
    for (const b of ['spine', 'chest', 'neck', 'head']) if (this._body[b]) bones.push(this._body[b].node);
    if (w < 1) { this._applyIdlePose(); for (const b of bones) snapshot.set(b, b.quaternion.clone()); }
    const hipsNode = this._body.hips?.node; const hipsBefore = hipsNode ? hipsNode.position.clone() : null;

    const kb = this._kb(); this.keyboard.position.set(kb.x, kb.height, kb.z);
    // 体を立ち位置へ寄せる（歩いて来た位置の誤差を、入りのブレンド中に吸収）
    if (o.placeBody !== false && !o.seated) {
      const want = this.frame.localToWorld(V3(o.body.x, o.body.y, o.body.z)); const k = w >= 1 ? 1 : 1 - Math.exp(-dt / 0.25);
      vrm.scene.position.lerp(want, k);
      const yaw = this._standYaw(); let dy = yaw - vrm.scene.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); vrm.scene.rotation.y += dy * k;
    }
    const { out, active } = this._assignments(t);
    this._beatOut = this._beatImpulses(t, dt);
    if (!o.seated) this._applyLowerBeat();
    vrm.scene.updateMatrixWorld(true);
    this._applySway(t, dt, active);
    // 鍵
    this._clearKeys();
    for (const p of active) { const k = this.keys.get(p); if (k) { k.mesh.position.y = k.y0 - o.play.press; k.mesh.material.emissive.setHex(0x335577); this._pressed.add(k); } }
    // 手首・腕
    const k = 1 - Math.exp(-dt / o.play.wristTau);
    const wr = o.play.wristTwist * Math.PI / 180;
    for (const s of ['L', 'R']) { const H = this._hands[s]; H.pos.lerp(this._wristTarget(s, out[s], t), k); this._solveArm(s, H.pos, this._handQuat(s, wr)); }
    vrm.scene.updateMatrixWorld(true);
    for (const s of ['L', 'R']) this._poseHand(s, out[s], t, this._handQuat(s, wr));
    this._applyExpression(t, dt);
    this._learnTips(out, t, dt);
    // ブレンド
    if (w < 1) {
      for (const b of bones) { const prev = snapshot.get(b); if (prev) b.quaternion.copy(prev.slerp(b.quaternion, w)); }
      if (hipsNode && hipsBefore) hipsNode.position.lerp(hipsBefore, 1 - w);
    }
    // ノートイベント
    for (const p of active) if (!this._lastActivePitches.has(p)) this._emit('note', { pitch: p, time: t });
    this._lastActivePitches = active;
  }
  _clearKeys() { for (const k of this._pressed) { k.mesh.position.y = k.y0; k.mesh.material.emissive.setHex(0); } this._pressed.clear(); }

  // ---------- 割り当て ----------
  _assignments(t) {
    const look = this.options.play.lookahead, release = 0.08;
    const out = { L: [null, null, null, null, null], R: [null, null, null, null, null] }; const active = new Set();
    // fe = 指（と鍵）が上がる時刻。運指で「指を離して音はペダルで残す」音は fingerEnd、それ以外は end
    const fe = (x) => x.fingerEnd ?? x.end;
    const rank = (x) => (x.start <= t && t <= fe(x)) ? 0 : x.start > t ? 1 : 2;
    for (const n of this.tl.notes) {
      if (n.start > t + look) break;
      if (fe(n) < t - release) continue;
      if (rank(n) === 0) active.add(n.pitch);
      const slot = out[n.hand], f = n.finger - 1, cur = slot[f];
      if (!cur || rank(n) < rank(cur) || (rank(n) === rank(cur) && Math.abs(n.start - t) < Math.abs(cur.start - t))) slot[f] = n;
    }
    return { out, active };
  }

  // ---------- 腕 IK ----------
  _rotFromTo(a, b) { return new this.THREE.Quaternion().setFromUnitVectors(a, b); }
  _handQuat(s, twist) {
    const { THREE } = this; const A = this._arm[s];
    const Qy = this._rotFromTo(A.dirL, new THREE.Vector3(0, 0, 1));
    const Qt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (s === 'L' ? 1 : -1) * twist);
    return Qt.multiply(Qy).multiply(A.qH);
  }
  _solveArm(s, target, Qh) {
    const { THREE } = this; const A = this._arm[s]; const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
    const sign = s === 'L' ? 1 : -1;
    const parentQ = this._qToP(A.u.parent.getWorldQuaternion(new THREE.Quaternion()));
    const p0 = this._toP(A.u.getWorldPosition(new THREE.Vector3()));
    const d = target.clone().sub(p0); let dist = d.length();
    const maxR = (A.L1 + A.L2) * 0.995; if (dist > maxR) { d.multiplyScalar(maxR / dist); dist = maxR; }
    const dirN = d.clone().normalize();
    const angA = Math.acos(clamp((A.L1 * A.L1 + dist * dist - A.L2 * A.L2) / (2 * A.L1 * dist), -1, 1));
    const pole = V3(sign * 0.6, -1, -0.5).normalize();
    const perp = pole.sub(dirN.clone().multiplyScalar(pole.dot(dirN))).normalize();
    const elbowDir = dirN.clone().multiplyScalar(Math.cos(angA)).add(perp.multiplyScalar(Math.sin(angA)));
    const dU = this._rotFromTo(A.dirU, elbowDir), Qu = dU.clone().multiply(A.qU);
    A.u.quaternion.copy(parentQ.clone().invert().multiply(Qu));
    const elbowPos = p0.clone().add(elbowDir.clone().multiplyScalar(A.L1));
    const dir2 = target.clone().sub(elbowPos).normalize();
    const dL = this._rotFromTo(A.dirL.clone().applyQuaternion(dU), dir2), Ql = dL.clone().multiply(dU).multiply(A.qL);
    A.l.quaternion.copy(Qu.clone().invert().multiply(Ql));
    A.h.quaternion.copy(Ql.clone().invert().multiply(Qh));
  }
  _wristTarget(s, slot, t) {
    const H = this._hands[s]; const o = this.options; const kb = this._kb(), kh = kb.height, kz = kb.z, wh = o.play.wristHeight;
    const xs = [], zs = [], ws = []; const Qh = this._handQuat(s, 0); const look = o.play.lookahead || 0.12, weighted = o.play.wristWeighted !== false;
    for (let f = 0; f < 5; f++) {
      const note = slot[f]; if (!note || !H.fingers[f]) continue;
      const T = this._aimPoint(s, f, note.pitch); if (!T) continue;
      const off = H.fingers[f].base.clone().applyQuaternion(Qh);
      xs.push(T.x - off.x); zs.push(T.z - off.z - H.fingers[f].len * (o.play.wristBack ?? 0.75));
      // 重み: 押した直後 > 押さえている > これから弾く（近いほど重い）> 離した直後。届かない和音では新しく押す音を優先する
      let w = 1;
      if (weighted) {
        if (note.start <= t && t <= (note.fingerEnd ?? note.end)) w = t - note.start < 0.15 ? 3 : 1;
        else if (note.start > t) w = 0.3 + 1.7 * (1 - clamp((note.start - t) / look, 0, 1));
        else w = 0.2;
      }
      ws.push(w);
    }
    if (xs.length) { H.lastActive = t; const W = ws.reduce((a, b) => a + b); H.target.set(xs.reduce((a, x, i) => a + x * ws[i], 0) / W, kh + wh, zs.reduce((a, z, i) => a + z * ws[i], 0) / W); }
    else if (t - H.lastActive > 1.0 || H.lastActive < 0) {
      // 休み/開始前: 鍵盤の自分側の上で待機
      if (H.lastActive < 0) H.target.set(kb.x + (s === 'L' ? 0.12 : -0.12), kh + wh + 0.03, kz - 0.03);
      else { H.target.y = kh + wh + 0.03; H.target.z = Math.min(H.target.z, kz - 0.02); }
    }
    return H.target;
  }

  // ---------- 指 ----------
  _fingerAngles(fg, along, down, reachScale) {
    const L = fg.len * reachScale; const r = Math.min(Math.hypot(along, down), L * 0.995);
    const fk = (th) => { let a = 0, x = 0, y = 0; for (const [l, k] of [[fg.l1, 1], [fg.l2, 1.1], [fg.l3, 0.7]]) { a += th * k; x += l * reachScale * Math.cos(a); y += l * reachScale * Math.sin(a); } return [x, y]; };
    let lo = 0, hi = 1.5;
    for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; const [x, y] = fk(mid); if (Math.hypot(x, y) > r) lo = mid; else hi = mid; }
    const th = (lo + hi) / 2; const [x, y] = fk(th);
    return [Math.atan2(down, along) - Math.atan2(y, x) + th, th * 1.1, th * 0.7];
  }
  _poseHand(s, slot, t, Qh) {
    const { THREE } = this; const H = this._hands[s], A = this._arm[s], o = this.options.play;
    // 指の曲げは骨のローカル Z 軸まわり。VRM 1.0 の正規化ボーンは VRM 0.x と Y 軸まわりに 180° 違うので、Z 軸まわりの向きが逆になる（Y 軸まわりの開きは同じ）
    const curlSign = (s === 'R' ? -1 : 1) * (this._frontYaw ? 1 : -1) * (o.flipCurl ? -1 : 1), yawSign = -H.alongSign * (o.flipYaw ? -1 : 1);
    const Qinv = Qh.clone().invert(); const handPos = this._toP(A.h.getWorldPosition(new THREE.Vector3()));
    const Z = new THREE.Vector3(0, 0, 1), Y = new THREE.Vector3(0, 1, 0);
    for (let f = 0; f < 5; f++) {
      const fg = H.fingers[f]; if (!fg) continue; const note = slot[f];
      let a1 = 0.25 + o.idleCurl * 0.5, a2 = 0.3 + o.idleCurl * 0.6, a3 = 0.15 + o.idleCurl * 0.3, yaw = 0, Tgt = null;
      if (note) {
        const T = this._aimPoint(s, f, note.pitch); Tgt = T;
        if (T) {
          const isActive = note.start <= t && t <= (note.fingerEnd ?? note.end);
          T.y += isActive ? -o.press * 0.8 : 0.012;
          const base = handPos.clone().add(fg.base.clone().applyQuaternion(Qh));
          const v = T.clone().sub(base).applyQuaternion(Qinv);
          const along = v.x * H.alongSign, down = -v.y, lateral = v.z;
          [a1, a2, a3] = this._fingerAngles(fg, Math.max(0.02, along), down, o.reach);
          yaw = clamp(Math.atan2(lateral, Math.max(0.02, along)), -0.6, 0.6);
          if (f === 0) { yaw = clamp(Math.atan2(lateral, Math.max(0.02, along)) * (o.thumbYaw ?? 0), -1.0, 1.0); a1 *= 0.5; a2 *= 0.6; a3 *= 0.6; } // 親指: 向きが他の指と違うので係数で（0 = 横に開かない）
        }
      }
      const qCurl = new THREE.Quaternion().setFromAxisAngle(Z, curlSign * a1);
      fg.nodes[0].quaternion.setFromAxisAngle(Y, yawSign * yaw).multiply(qCurl);
      fg.nodes[1].quaternion.setFromAxisAngle(Z, curlSign * a2);
      fg.nodes[2].quaternion.setFromAxisAngle(Z, curlSign * a3);
      // 指先の左右を鍵に合わせる（実際の指先位置を見ながら、ひろがりを割線法で 2 回直す）。手の形の近似による横ずれを消す
      if (Tgt && o.tipSolve !== false) {
        const lim = o.yawLimit ?? 0.8;
        const setYaw = (y) => { fg.nodes[0].quaternion.setFromAxisAngle(Y, yawSign * y).multiply(qCurl); };
        let y0 = yaw, e0 = this._tipP(fg).x - Tgt.x;
        for (let it = 0; it < 2 && Math.abs(e0) > 0.0015; it++) {
          const y1 = y0 + (y0 > 0 ? -0.06 : 0.06); setYaw(y1); const e1 = this._tipP(fg).x - Tgt.x;
          const d = (e1 - e0) / (y1 - y0); if (Math.abs(d) < 1e-3) { setYaw(y0); break; }
          const yn = clamp(y0 - e0 / d, -lim, lim); setYaw(yn); const en = this._tipP(fg).x - Tgt.x;
          if (Math.abs(en) >= Math.abs(e0)) { setYaw(y0); break; }
          y0 = yn; e0 = en;
        }
      }
    }
  }
  // 指先の位置（演奏空間）。指の付け根から下だけ行列を更新して求める
  _tipP(fg) {
    const { THREE } = this; fg.nodes[0].updateMatrixWorld(true);
    const a = this._tpA || (this._tpA = new THREE.Vector3()), b = this._tpB || (this._tpB = new THREE.Vector3());
    fg.nodes[1].getWorldPosition(a); fg.nodes[2].getWorldPosition(b);
    return this._toP(b.clone().add(b.clone().sub(a).normalize().multiplyScalar(fg.l3)));
  }

  // ---------- ビート ----------
  _currentBeat(t) {
    if (!this.beat) return null; const b = this.options.beat;
    const base = b.bpm > 0 ? 60 / b.bpm : this.beat.period;
    const period = base * (b.feel === 'back' ? 2 : b.div);
    const feelOff = b.feel === 'back' ? base : b.feel === 'off' ? base * 0.5 * b.div : 0;
    const bt = { period, offset: this.beat.offset + b.offset + feelOff };
    return { phase: beatPhase(bt, t), index: beatIndex(bt, t), period, offset: bt.offset };
  }
  _stepSpring(sp, dt, hz, zeta, impulse) { const w = 2 * Math.PI * hz; sp.v += impulse; sp.v += (-w * w * sp.x - 2 * zeta * w * sp.v) * dt; sp.x += sp.v * dt; return sp.x; }
  _beatImpulses(t, dt) {
    const b = this._currentBeat(t); const sp = this._springs; if (!b) return { head: 0, body: 0, cont: 0 };
    if (Math.abs(t - sp.lastT) > 1) { sp.lastIndex = b.index; sp.head.x = sp.head.v = sp.body.x = sp.body.v = 0; }
    sp.lastT = t;
    const kick = sp.lastIndex !== null && b.index !== sp.lastIndex ? 1 : 0; sp.lastIndex = b.index;
    const head = this._stepSpring(sp.head, dt, 1.8, 0.35, kick * 26 * this.options.sway.beatHead);
    const body = this._stepSpring(sp.body, dt, 1.2, 0.45, kick * 16 * this.options.sway.beatBody);
    return { head, body, cont: (t - b.offset) / b.period };
  }
  _applyLowerBeat() {
    const { THREE } = this; const amt = this.options.sway.beatBody; const L = this._legs.L; if (!this.beat || !L.ul) return;
    const bob = clamp(this._beatOut.body, -0.3, 1.5), shift = Math.sin(this._beatOut.cont * Math.PI / 2) * amt;
    let maxBend = 0; const X = new THREE.Vector3(1, 0, 0);
    for (const s of ['L', 'R']) {
      const G = this._legs[s]; const sign = s === 'L' ? 1 : -1;
      const kneeBend = Math.max(0, 0.14 * bob + 0.07 * Math.max(0, -shift * sign)); maxBend = Math.max(maxBend, kneeBend);
      const parentQ = this._qToP(G.ul.parent.getWorldQuaternion(new THREE.Quaternion()));
      const dU = new THREE.Quaternion().setFromAxisAngle(X, kneeBend), Qu = dU.clone().multiply(G.qU);
      G.ul.quaternion.copy(parentQ.clone().invert().multiply(Qu));
      const dL = new THREE.Quaternion().setFromAxisAngle(X, -kneeBend * 2), Ql = dL.clone().multiply(dU).multiply(G.qL);
      G.ll.quaternion.copy(Qu.clone().invert().multiply(Ql));
      G.ft.quaternion.copy(Ql.clone().invert().multiply(G.qF));
    }
    const hips = this._body.hips?.node;
    if (hips) { hips.position.copy(this._body.hipsRest); hips.position.y -= (L.thigh + L.shin) * (1 - Math.cos(maxBend)); }
  }
  _applySway(t, dt, active) {
    const { THREE } = this; if (!this._body.spine) return; const amount = this.options.sway.lean;
    const L = this._hands.L.pos, R = this._hands.R.pos;
    const hx = (L.x + R.x) / 2 + (Math.max(0, L.x - 0.2) - Math.max(0, -R.x - 0.2)) * 0.5;
    const st = this._sway;
    st.lean += (clamp(-hx * 1.6, -0.35, 0.35) - st.lean) * (1 - Math.exp(-dt / 0.3));
    st.energy += (Math.min(1, active.size / 4) - st.energy) * (1 - Math.exp(-dt / 1.2));
    const slow = Math.sin(t * 2 * Math.PI * 0.35) * 0.5 + Math.sin(t * 2 * Math.PI * 0.13) * 0.5;
    const leanZ = st.lean * amount, pitchX = (0.05 + st.energy * 0.10 + slow * 0.04) * amount, swayX = slow * 0.03 * amount;
    const set = (b, qDelta) => { const B = this._body[b]; if (!B) return; const parentQ = this._qToP(B.node.parent.getWorldQuaternion(new THREE.Quaternion())); B.node.quaternion.copy(parentQ.clone().invert().multiply(qDelta).multiply(B.q)); this.vrm.scene.updateMatrixWorld(true); };
    const rot = (ax, ay, az) => new THREE.Quaternion().setFromEuler(new THREE.Euler(ax, ay, az));
    set('spine', rot(pitchX * 0.55, 0, (leanZ + swayX) * 0.6));
    set('chest', rot(pitchX * 0.45, -leanZ * 0.15, (leanZ + swayX) * 0.4));
    const nod = clamp(this._beatOut.head, -0.5, 1.5), tilt = Math.sin(this._beatOut.cont * Math.PI / 2) * 0.03 * this.options.sway.beatHead;
    // 上書き（コメント反応など）: 頭の向き
    const ov = this._activeOverride(); const oy = ov?.head?.yaw || 0, op = ov?.head?.pitch || 0;
    set('neck', rot(nod * 0.16 - pitchX * 0.25 + op * 0.4, -hx * 0.3 * amount + oy * 0.4, -leanZ * 0.25 + tilt));
    set('head', rot(nod * 0.12 + op * 0.6, -hx * 0.3 * amount + oy * 0.6, -leanZ * 0.2 + tilt));
  }
  /** 時刻 t の口の形 [aa, ih, ou, ee, oh]（0..1）。lipsync がなければ null */
  lipAt(t) {
    const L = this.lip; if (!L) return null; const K = L.keys.length, n = L.frames.length / K;
    const x = t * L.fps; if (x < 0 || x >= n - 1) return [0, 0, 0, 0, 0];
    const i = Math.floor(x), f = x - i, out = [];
    for (let k = 0; k < K; k++) out.push((L.frames[i * K + k] * (1 - f) + L.frames[(i + 1) * K + k] * f) / 100);
    return out;
  }
  _activeOverride() { if (this._override && performance.now() / 1000 < this._overrideUntil) return this._override; this._override = null; return null; }

  // ---------- 表情 ----------
  _applyExpression(t, dt) {
    const em = this.vrm.expressionManager; if (!em || !this.driver) return; const o = this.options.expression;
    const f = featuresAt(this.analysis, t + o.lookahead);
    let w = this.driver.update(f, dt);
    const PRESETS = { none: {}, happy: { happy: 0.6 }, relaxed: { relaxed: 0.8 }, sad: { sad: 0.8 }, focus: { angry: 0.45, squint: 0.3, mouthOu: 0.25 } };
    if (o.mode !== 'auto') w = { ...Object.fromEntries(Object.keys(this.driver.w).map((k) => [k, 0])), ...PRESETS[o.mode] };
    const ov = this._activeOverride();
    if (ov?.expressions) w = { ...w, ...ov.expressions };
    const set = (name, v) => { if (em.getExpression(name)) em.setValue(name, clamp(v * this.weight, 0, 1)); };
    // 歌の口パク: 歌っている間は口の形を歌声から。笑顔は口の形とぶつかるので少し弱める
    const lo = this.options.lipsync; const lip = this.lip && lo.enabled ? this.lipAt(t + lo.lead) : null;
    const open = lip ? Math.max(...lip) : 0, sing = Math.min(1, open * 3);
    set('happy', w.happy * (1 - lo.happyDuck * sing)); set('relaxed', w.relaxed); set('sad', w.sad); set('angry', w.angry); set(em.getExpression('surprised') ? 'surprised' : 'Surprised', w.surprised); // VRM 1.0 は標準の surprised、VRM 0.x はカスタムの Surprised
    if (lip) {
      const g = lo.gain;
      set('aa', lip[0] * g + (w.mouthAa || 0) * (1 - sing)); set('ih', lip[1] * g); set('ou', lip[2] * g + (w.mouthOu || 0) * (1 - sing)); set('ee', lip[3] * g); set('oh', lip[4] * g);
    } else { set('aa', w.mouthAa); set('ou', w.mouthOu); }
    set('blink', Math.max(w.squint || 0, this.driver.blink));
    this.lastLip = lip;
    if (o.lookAtHands && this.vrm.lookAt && !ov?.head) {
      const L = this._hands.L.pos, R = this._hands.R.pos; this.lookTarget.position.set((L.x + R.x) / 2, (L.y + R.y) / 2 - 0.05, (L.z + R.z) / 2 + 0.05);
      this.vrm.lookAt.target = this.lookTarget;
    } else if (this.vrm.lookAt) this.vrm.lookAt.target = null;
    this.lastExpression = w; this.lastFeatures = f;
  }
}

// song.json を読む（相対パスは song.json の場所基準に解決）
export async function loadSongConfig(url) {
  const cfg = await (await fetch(url, { cache: 'no-cache' })).json(); // 調整後の song.json を必ず読む（ブラウザが古いものを使わない）
  const base = new URL(url, globalThis.location?.href || 'http://localhost/');
  const resolve = (p) => (p ? new URL(p, base).href : null);
  return { ...cfg, audio: resolve(cfg.audio), timeline: resolve(cfg.timeline), vocals: resolve(cfg.vocals), lipsync: resolve(cfg.lipsync), url };
}
