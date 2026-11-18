// autoFit: 曲ごとに「指が正しい鍵に届く」鍵盤の位置・大きさと手の値を自動で探す（DOM 非依存）
//
// 使い方（VRM を attach 済み・曲を loadSong 済みの PianoPerformer に対して）:
//   import { autoFit, evaluateFit } from '../lib/autofit.js';
//   const r = await autoFit(perf, { onProgress: (m) => console.log(m) });
//   r.options   … 見つけた値（keyboard / play の一部）。perf.setOptions(r.options) で反映、song.json の options に入れる
//   r.before / r.after … { miss, float, reach, err, score, notes }（miss = 違う鍵に落ちた割合など）
//
// しくみ: 演奏を音なしでコマ送り（30fps）して、打鍵した瞬間の指先と鍵の位置を比べる。
//   miss  : 指先が鍵の幅から外れた（隣の鍵を押している）
//   float : 指先が鍵の上面まで下りていない（8mm 以上浮いている）
//   reach : 腕が伸びきって手首が目標に届いていない（1cm 以上）
// これを小さくするように、鍵盤の 左右/高さ/前後/大きさ と 指の届き/手首の高さ を座標降下法で探す。
// 時間短縮のため、曲の中から「手が大きく動く・端の音域・密度が高い」区間を選んで評価し、最後に全曲で確かめる。

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const isBlack = (p) => [1, 3, 6, 8, 10].includes(p % 12);

// 探す値と範囲・最初の刻み。見た目を大きく変えすぎないよう、基準値 ref からの離れ具合に小さな罰を付ける
// （ref は固定。今の値を基準にすると、回すたびに鍵盤が少しずつ小さくなっていく）
export const FIT_PARAMS = [
  { path: 'keyboard.x', min: -0.2, max: 0.2, step: 0.04, cost: 0.4, ref: 0 },
  { path: 'keyboard.height', min: 0.6, max: 0.95, step: 0.03, cost: 0.6, ref: 0.76 },
  { path: 'keyboard.z', min: 0.18, max: 0.45, step: 0.03, cost: 0.6, ref: 0.28 },
  { path: 'keyboard.scale', min: 0.55, max: 0.8, step: 0.04, cost: 2.0, ref: 0.65 },   // 見た目の大きさの基準（小柄なアバターの手に合わせた値）
  { path: 'play.reach', min: 0.8, max: 1.08, step: 0.04, cost: 0.3 },
  { path: 'play.wristHeight', min: 0.03, max: 0.09, step: 0.01, cost: 0.3 },   // 下限 0.03（ユーザー希望、2026-10-27）
  { path: 'play.wristBack', min: 0.2, max: 1.0, step: 0.1, cost: 0.3 },     // 手首を鍵からどれだけ手前に置くか（指の長さの何倍）
];

const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
const toPartial = (vals) => { const o = {}; for (const [p, v] of Object.entries(vals)) { const [a, b] = p.split('.'); (o[a] = o[a] || {})[b] = v; } return o; };
// 画面を固まらせないための一休み。裏タブでは setTimeout が 1 秒単位に間引かれるので MessageChannel を使う
const yieldUI = () => new Promise((r) => { if (typeof MessageChannel === 'undefined') return setTimeout(r, 0); const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });

// 評価に使う区間を選ぶ（[t0, t1] の配列）
export function pickWindows(tl, { count = 6, len = 5 } = {}) {
  const notes = tl.notes, dur = Math.max(...notes.map((n) => n.end));
  if (dur <= count * len * 0.8) return [[0, dur]];
  const step = 1; const cands = [];
  for (let t = 0; t + len <= dur + step; t += step) {
    const ns = notes.filter((n) => n.start >= t && n.start < t + len); if (!ns.length) continue;
    const ps = ns.map((n) => n.pitch);
    const spanL = ns.filter((n) => n.hand === 'L').map((n) => n.pitch), spanR = ns.filter((n) => n.hand === 'R').map((n) => n.pitch);
    const sp = (a) => (a.length ? Math.max(...a) - Math.min(...a) : 0);
    cands.push({ t, low: Math.min(...ps), high: Math.max(...ps), jump: sp(spanL) + sp(spanR), dens: ns.length / len });
  }
  const chosen = [];
  const take = (c) => { if (c && !chosen.some((x) => Math.abs(x.t - c.t) < len)) chosen.push(c); };
  take([...cands].sort((a, b) => a.low - b.low)[0]);      // いちばん低い音域
  take([...cands].sort((a, b) => b.high - a.high)[0]);    // いちばん高い音域
  for (const c of [...cands].sort((a, b) => b.jump - a.jump)) { if (chosen.length >= Math.ceil(count / 2)) break; take(c); } // 手が大きく動く
  take([...cands].sort((a, b) => b.dens - a.dens)[0]);    // 密度が高い
  for (let i = 0; chosen.length < count && i < count * 3; i++) take(cands[Math.floor((i * 0.618 % 1) * cands.length)]); // 残りは散らす
  return chosen.sort((a, b) => a.t - b.t).map((c) => [c.t, Math.min(dur, c.t + len)]);
}

// 今の options で演奏を再現して、打鍵ごとの指先のずれを測る
export function evaluateFit(perf, { windows = null, fps = 30 } = {}) {
  const { THREE } = perf; const tl = perf.tl; const dt = 1 / fps;
  const ks = perf.options.keyboard.scale, WW = 0.0235 * ks, BW = 0.0135 * ks, WL = 0.15 * ks, BL = 0.095 * ks;
  const segs = windows || [[0, tl.duration]];
  const notes = [...tl.notes].sort((a, b) => a.start - b.start);
  const st = { notes: 0, miss: 0, float: 0, reach: 0, err: 0 };
  const tip = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), hw = new THREE.Vector3();
  // 状態を保存して、評価のあとに戻す
  const saved = { w: perf.weight, wt: perf._weightTarget, s: perf._state };
  perf.weight = 1; perf._weightTarget = 1; perf._state = 'playing';
  for (const [t0, t1] of segs) {
    perf._resetDynamics();
    for (const s of ['L', 'R']) perf._hands[s].lastActive = -10;
    let t = Math.max(0, t0 - 0.6);
    // 区間の頭までは手を寄せるだけ（測らない）
    while (t < t0) { perf._apply(t, dt); t += dt; }
    let i = notes.findIndex((n) => n.start >= t0); if (i < 0) continue;
    while (t <= t1 + 0.05) {
      perf._apply(t, dt);
      perf.vrm.scene.updateMatrixWorld(true);
      // 打鍵から 30ms たった最初のコマで測る
      while (i < notes.length && notes[i].start + 0.03 <= t && notes[i].start < t1) {
        const n = notes[i++]; const H = perf._hands[n.hand]; const fg = H.fingers[n.finger - 1]; if (!fg) continue;
        const T = perf._keyWorld(n.pitch); if (!T) continue;
        // 指先 = 末節の位置 + 末節の向き × 末節の長さ
        fg.nodes[1].getWorldPosition(a); fg.nodes[2].getWorldPosition(b);
        tip.copy(b).add(b.clone().sub(a).normalize().multiplyScalar(fg.l3));
        const p = perf._toP(tip);
        const black = isBlack(n.pitch), half = (black ? BW : WW * 0.94) / 2;
        const dx = Math.abs(p.x - T.x), dy = p.y - (T.y - perf.options.play.press * 0.8), dz = Math.abs(p.z - T.z);
        const zTol = black ? BL * 0.45 : WL * 0.4;
        st.notes++;
        if (dx > half || dz > zTol) st.miss++;
        if (dy > 0.008) st.float++;
        const hand = perf._toP(perf._arm[n.hand].h.getWorldPosition(hw));
        if (hand.distanceTo(H.pos) > 0.01) st.reach++;
        st.err += Math.hypot(dx / half, Math.max(0, dy) / 0.008);
      }
      t += dt;
    }
  }
  perf.weight = saved.w; perf._weightTarget = saved.wt; perf._state = saved.s;
  const N = Math.max(1, st.notes);
  const r = { notes: st.notes, miss: st.miss / N, float: st.float / N, reach: st.reach / N, err: st.err / N };
  // 違う鍵を押すのがいちばん目立つので重く、浮き・届かないが次
  r.score = r.miss * 10 + r.float * 4 + r.reach * 3 + r.err * 0.5;
  return r;
}

export async function autoFit(perf, { params = FIT_PARAMS, rounds = 2, windows = null, onProgress = () => {} } = {}) {
  if (!perf.tl || !perf.vrm) throw new Error('attach a VRM and load a song first');
  const win = windows || pickWindows(perf.tl);
  // 範囲外の値（下限より低い手首など）から始めると、良くならないとき元の値がそのまま残るので、先に範囲へ入れる
  const start = Object.fromEntries(params.map((p) => [p.path, +clamp(getPath(perf.options, p.path), p.min, p.max).toFixed(3)]));
  const cur = { ...start };
  const evalAt = (vals) => {
    perf.setOptions(toPartial(vals));
    const r = evaluateFit(perf, { windows: win });
    let pen = 0; for (const p of params) pen += p.cost * Math.abs(vals[p.path] - (p.ref ?? start[p.path])) / (p.max - p.min);
    return { ...r, total: r.score + pen };
  };
  const pc = (v) => (v * 100).toFixed(1) + '%';
  const before = evalAt(cur); let best = before;
  onProgress(`start: wrong key ${pc(before.miss)}, floating ${pc(before.float)}, out of reach ${pc(before.reach)} (${win.length} windows)`);
  const steps = Object.fromEntries(params.map((p) => [p.path, p.step]));
  for (let r = 0; r < rounds; r++) {
    for (const p of params) {
      for (const dir of [1, -1]) {
        for (let k = 0; k < 4; k++) { // よくなる間は同じ向きに進む
          const v = +clamp(cur[p.path] + dir * steps[p.path], p.min, p.max).toFixed(3);
          if (v === cur[p.path]) break;
          const res = evalAt({ ...cur, [p.path]: v });
          await yieldUI();
          if (res.total < best.total - 1e-4) { best = res; cur[p.path] = v; } else break;
        }
      }
    }
    for (const k in steps) steps[k] /= 2;
    onProgress(`round ${r + 1}/${rounds}: wrong key ${pc(best.miss)}, floating ${pc(best.float)}, out of reach ${pc(best.reach)}`);
  }
  // 全曲で確かめる（区間に入らなかった所で悪くなっていないか）。original = 元の値・指先合わせなし（今までの動き）
  const offNew = { tipSolve: false, wristWeighted: false };
  perf.setOptions({ ...toPartial(start), play: { ...toPartial(start).play, ...offNew } }); const original = evaluateFit(perf);
  perf.setOptions({ play: { tipSolve: true, wristWeighted: true } }); const startFull = evaluateFit(perf);
  perf.setOptions(toPartial(cur)); let afterFull = evaluateFit(perf);
  let options = toPartial(cur), changed = true;
  if (afterFull.score >= startFull.score) { options = toPartial(start); afterFull = startFull; changed = false; perf.setOptions(options); onProgress('the original keyboard/hand values were best (keeping them)'); }
  options.play.tipSolve = true; options.play.wristWeighted = true;
  onProgress(`whole song: wrong key ${pc(original.miss)} → ${pc(afterFull.miss)}, floating ${pc(original.float)} → ${pc(afterFull.float)}, out of reach ${pc(original.reach)} → ${pc(afterFull.reach)}`);
  return { options, before: original, after: afterFull, changed, windows: win };
}
