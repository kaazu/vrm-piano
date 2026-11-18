// 運指エンジン（自前実装）
//
// 考え方:
//  1. ノート列を「同時に鳴っている音の集合」(レイヤー) の列にする。新しい音が始まるたびに1レイヤー。
//  2. 各レイヤーの状態 = 音(低→高)に対する指の割り当て。指スロットは
//       左手: L5 L4 L3 L2 L1   右手: R1 R2 R3 R4 R5   を低い側からこの順に並べた10個。
//     音は低い順、スロットも左→右で増加させる（同一和音内で指が交差しない）。
//  3. レイヤー間の遷移コスト = 手ごとに「前の音/指 → 今の音/指」の移動コスト + 和音の広がりコスト
//     + 左右の手の位置関係コスト。押しっぱなしの音は同じ指のまま（違えば禁止）。
//  4. Viterbi（動的計画法）で総コスト最小の割り当てを求める。状態数はビームで制限。
//
// 入力: notes [{pitch, start, end, velocity}]  (秒)
// 出力: notes に hand('L'|'R'), finger(1..5) を付けたもの。指を先に離す音には fingerEnd（秒）

const SLOTS = [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5]; // 負=左手, 正=右手

// 指と指の「自然な間隔」(半音)。同じ手で f1 < f2 のとき、f2 の鍵は f1 より これくらい上が楽
const SPAN = {
  '1,2': 2, '1,3': 4, '1,4': 5, '1,5': 7,
  '2,3': 2, '2,4': 4, '2,5': 6,
  '3,4': 2, '3,5': 4,
  '4,5': 2,
};
// 最大限広げられる間隔（これを超えると急に苦しい）
const MAX_SPAN = {
  '1,2': 7, '1,3': 9, '1,4': 10, '1,5': 12,
  '2,3': 5, '2,4': 7, '2,5': 9,
  '3,4': 4, '3,5': 7,
  '4,5': 4,
};
const isBlack = (p) => [1, 3, 6, 8, 10].includes(p % 12);

export const DEFAULT_PARAMS = {
  sameFingerMove: 3.0,     // 同じ指で別の鍵へ（手ごと移動）
  spanMiss: 0.6,           // 自然な間隔からのずれ 1半音あたり
  overMax: 2.5,            // 最大間隔を超えた 1半音あたり
  crossOver: 2.0,          // 指の交差（親指くぐり以外）
  thumbUnder: 1.5,         // 親指くぐり/かぶせ
  thumbOnBlack: 0.6,       // 親指で黒鍵
  pinkyOnBlackMelody: 0.2, // 小指で黒鍵（軽い）
  handOverlap: 4.0,        // 左手が右手より上にある 1半音あたり
  handFar: 0.05,           // 両手が離れすぎ（1半音あたり、14半音超）
  shiftPerSemitone: 0.35,  // 手の位置の移動 1半音あたり（時間が空くほど割引）
  weakFinger: { 1: 0, 2: 0, 3: 0.05, 4: 0.15, 5: 0.1 }, // 指の強さ（4は弱い）
  homeBias: 0.15,          // 左手は中央ド(60)より下、右手は上が楽。1半音あたり
  handSwitch: 1.2,         // 直前まで弾いていなかった手に切り替える（メロディの手の入れ替わり）
  heldFingerChange: 25,    // 押しっぱなしの音の指を替える（ほぼ禁止）
  release: 1.5,            // 押さえている音から指を離す（音はペダルで残す）1音あたり
  releaseEarly: 3.0,       // 押してすぐ（0.3秒以内）に離す追加コスト（スタッカートに見える）
  allowRelease: true,      // false で以前の動き（押さえている音は離さない）
  beam: 300,
  chordWindow: 0.03,       // 同時打鍵とみなす時間(秒)
};

// ---- レイヤー化 ----
export function buildLayers(notes, params = DEFAULT_PARAMS) {
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const layers = [];
  let i = 0;
  while (i < sorted.length) {
    const t0 = sorted[i].start;
    const group = [];
    while (i < sorted.length && sorted[i].start - t0 <= params.chordWindow) group.push(sorted[i++]);
    // この時点で押さえている音（前のレイヤーから継続）
    const held = layers.length ? layers[layers.length - 1].notes.filter((n) => n.end > t0 + 0.02 && !group.includes(n)) : [];
    const all = [...held, ...group].sort((a, b) => a.pitch - b.pitch);
    // 同じ音高が重なったら新しい方だけ
    let uniq = []; for (const n of all) { if (uniq.length && uniq[uniq.length - 1].pitch === n.pitch) uniq.pop(); uniq.push(n); }
    // 10音を超えたら、継続音のうち弱い/古いものから落とす（指は10本）
    while (uniq.length > 10) {
      const heldOnly = uniq.filter((n) => !group.includes(n));
      const victim = heldOnly.length ? heldOnly.reduce((a, b) => (a.velocity * (1 + a.start) <= b.velocity * (1 + b.start) ? a : b)) : uniq[0];
      uniq = uniq.filter((n) => n !== victim);
    }
    layers.push({ time: t0, notes: uniq, newNotes: group.filter((n) => uniq.includes(n)) });
  }
  return layers;
}

// ---- 状態（指の割り当て）の列挙: k 個の音に 10 スロットから増加列を選ぶ ----
const combosCache = new Map();
function combos(k) {
  if (combosCache.has(k)) return combosCache.get(k);
  const out = [];
  const rec = (start, cur) => {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let s = start; s < SLOTS.length; s++) { cur.push(SLOTS[s]); rec(s + 1, cur); cur.pop(); }
  };
  rec(0, []);
  combosCache.set(k, out);
  return out;
}

// ---- コスト ----
function spanCost(pLow, pHigh, fLow, fHigh, P) {
  // 同じ手、fLow と fHigh が押さえる2音（pLow < pHigh）。右手は fLow<fHigh が自然、左手は逆。
  const d = pHigh - pLow;
  const key = fLow < fHigh ? `${fLow},${fHigh}` : `${fHigh},${fLow}`;
  const natural = SPAN[key], max = MAX_SPAN[key];
  let c = Math.abs(d - natural) * P.spanMiss;
  if (d > max) c += (d - max) * P.overMax;
  return c;
}

// 手ごとの「前の割り当て → 今の割り当て」コスト
function handTransition(prev, cur, dt, P, hand) {
  // prev/cur: [{pitch, finger, note}] 音高昇順。finger は 1..5（左手も 1=親指）
  let c = 0;
  if (cur.length === 0) return 0;
  // 和音内の広がり
  for (let i = 1; i < cur.length; i++) {
    const a = cur[i - 1], b = cur[i];
    // 右手: 低い音ほど小さい番号。左手: 低い音ほど大きい番号（スロット順でそうなっている）
    c += spanCost(a.pitch, b.pitch, a.finger, b.finger, P);
  }
  for (const n of cur) {
    c += P.weakFinger[n.finger];
    c += (hand === 'L' ? Math.max(0, n.pitch - 57) : Math.max(0, 60 - n.pitch)) * P.homeBias;
    if (n.finger === 1 && isBlack(n.pitch)) c += P.thumbOnBlack;
    if (n.finger === 5 && isBlack(n.pitch)) c += P.pinkyOnBlackMelody;
  }
  if (prev.length === 0) return c;
  // 押しっぱなしの音は同じ指でなければ禁止
  for (const n of cur) {
    const p = prev.find((q) => q.note === n.note);
    if (p && p.finger !== n.finger) c += P.heldFingerChange; // 原則禁止だが、行き詰まり回避のため大きなコストにする
  }
  // 移動コスト: 今の各音について、前の音の中で一番近い関係を見る
  const discount = Math.pow(1 + 4 * Math.max(0, dt - 0.15), -1.5); // 時間が空けば移動は安い
  for (const n of cur) {
    if (prev.find((q) => q.note === n.note)) continue; // 継続音
    let best = Infinity;
    for (const p of prev) {
      let m = 0;
      const d = n.pitch - p.pitch; // 右手: 上へ行くなら指番号も増えるのが自然。左手は逆
      const up = hand === 'R' ? d > 0 : d < 0; // 「手の外側へ」
      const ad = Math.abs(d);
      if (p.finger === n.finger) {
        m = ad === 0 ? 0 : P.sameFingerMove + ad * P.shiftPerSemitone;
      } else {
        const fingerUp = n.finger > p.finger; // 指番号が増える = 手の外側
        if (ad === 0) m = 0.5; // 同じ鍵を指替え
        else if (up === fingerUp) {
          m = spanCost(Math.min(p.pitch, n.pitch), Math.max(p.pitch, n.pitch), p.finger, n.finger, P);
        } else {
          // 交差。親指が関わるなら「くぐり/かぶせ」
          const thumb = p.finger === 1 || n.finger === 1;
          m = (thumb ? P.thumbUnder : P.crossOver) + Math.max(0, ad - 3) * P.shiftPerSemitone;
        }
      }
      best = Math.min(best, m);
    }
    c += best * discount;
  }
  // 手全体の移動（中心の移動）
  const center = (xs) => xs.reduce((s, x) => s + x.pitch, 0) / xs.length;
  c += Math.abs(center(cur) - center(prev)) * P.shiftPerSemitone * 0.5 * discount;
  return c;
}

function split(layer, assign) {
  const L = [], R = [];
  layer.notes.forEach((note, i) => {
    const s = assign[i];
    (s < 0 ? L : R).push({ pitch: note.pitch, finger: Math.abs(s), note });
  });
  return { L, R };
}

function handsCost(L, R, P) {
  if (!L.length || !R.length) return 0;
  const lMax = L[L.length - 1].pitch, rMin = R[0].pitch;
  let c = 0;
  if (lMax > rMin) c += (lMax - rMin) * P.handOverlap;
  const gap = rMin - lMax;
  if (gap > 14) c += (gap - 14) * P.handFar;
  return c;
}

// ---- Viterbi ----
// 押さえている音（継続音）は「指で押さえ続ける」か「指を離す（音はペダルで残る）」かを選べる。
// 離した音は以後そのレイヤーでは指を使わない。離した時刻は fingerEnd として出力する（鍵もそこで戻る）。
function releaseSubsets(held, P) {
  if (!P.allowRelease || !held.length) return [[]];
  if (held.length <= 3) { const out = []; for (let m = 0; m < 1 << held.length; m++) out.push(held.filter((_, i) => m & (1 << i))); return out; }
  return [[], held.slice(), ...held.map((h) => [h])];
}

export function assignFingers(notes, params = {}) {
  const P = { ...DEFAULT_PARAMS, ...params };
  const layers = buildLayers(notes, P);
  if (!layers.length) return [];
  let prevStates = null; // [{assign, L, R, cost, back, notes, released:Set, rel:[]}]
  const history = [];
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];
    if (layer.notes.length > 10) throw new Error(`layer ${li}: ${layer.notes.length} notes > 10`);
    const dt = li ? layer.time - layers[li - 1].time : 1;
    const held = layer.notes.filter((n) => !layer.newNotes.includes(n));
    const states = [];
    // 前の状態で離してある音の組（D）ごとに、残りの継続音から今回離すものを選ぶ。relNow = このレイヤーで指を使わない継続音
    const priors = new Map(); for (const ps of prevStates || []) { const D = held.filter((n) => ps.released.has(n)); const key = D.map((n) => layer.notes.indexOf(n)).join(','); if (!priors.has(key)) priors.set(key, D); }
    if (!priors.size) priors.set('', []);
    const relSets = []; const seen = new Set();
    for (const D of priors.values()) for (const extra of releaseSubsets(held.filter((n) => !D.includes(n)), P)) { const r = [...D, ...extra]; const key = r.map((n) => layer.notes.indexOf(n)).sort((x, y) => x - y).join(','); if (!seen.has(key)) { seen.add(key); relSets.push(r); } }
    for (const relNow of relSets) {
      const sub = { notes: layer.notes.filter((n) => !relNow.includes(n)), newNotes: layer.newNotes };
      let relCost = 0;
      for (const n of relNow) relCost += P.release + P.releaseEarly * Math.max(0, 0.3 - (layer.time - n.start)) / 0.3;
      for (const assign of combos(sub.notes.length)) {
        const { L, R } = split(sub, assign);
        const hc = handsCost(L, R, P);
        if (hc === Infinity) continue;
        if (!prevStates) {
          if (relNow.length) continue;
          const c = handTransition([], L, dt, P, 'L') + handTransition([], R, dt, P, 'R') + hc;
          states.push({ assign, notes: sub.notes, L, R, cost: c, back: -1, lastL: L.length ? L : [], lastR: R.length ? R : [], playedL: L.length > 0, playedR: R.length > 0, released: new Set(), rel: [] });
          continue;
        }
        let best = Infinity, bi = -1, bl = null, br = null;
        for (let pi = 0; pi < prevStates.length; pi++) {
          const ps = prevStates[pi];
          // 前に離した音は、押さえ直さない（離したまま）
          let ok = true; for (const n of ps.released) if (sub.notes.includes(n)) { ok = false; break; }
          if (!ok) continue;
          // 今回「離す」とした音は、前の状態で指が付いていたもの（すでに離していたら二重に数えない）
          let rc = relCost; for (const n of relNow) if (ps.released.has(n)) rc -= P.release + P.releaseEarly * Math.max(0, 0.3 - (layer.time - n.start)) / 0.3;
          const tl = handTransition(ps.lastL, L, dt, P, 'L');
          if (tl === Infinity) continue;
          const tr = handTransition(ps.lastR, R, dt, P, 'R');
          if (tr === Infinity) continue;
          const newL = L.some((n) => layer.newNotes.includes(n.note)), newR = R.some((n) => layer.newNotes.includes(n.note));
          const sw = (newL && !ps.playedL && ps.playedR ? 1 : 0) + (newR && !ps.playedR && ps.playedL ? 1 : 0);
          const c = ps.cost + tl + tr + hc + rc + sw * P.handSwitch * Math.pow(1 + 4 * Math.max(0, dt - 0.15), -1.5);
          if (c < best) { best = c; bi = pi; bl = L.length ? L : ps.lastL; br = R.length ? R : ps.lastR; }
        }
        if (bi >= 0) {
          const ps = prevStates[bi];
          const released = new Set([...ps.released].filter((n) => n.end > layer.time + 0.02)); relNow.forEach((n) => released.add(n));
          states.push({ assign, notes: sub.notes, L, R, cost: best, back: bi, lastL: bl, lastR: br, playedL: L.length > 0, playedR: R.length > 0, released, rel: relNow.filter((n) => !ps.released.has(n)) });
        }
      }
    }
    states.sort((a, b) => a.cost - b.cost);
    const kept = states.slice(0, P.beam);
    history.push(kept);
    prevStates = kept;
  }
  // バックトラック
  let si = 0;
  const result = new Map(), fingerEnd = new Map();
  for (let li = history.length - 1; li >= 0; li--) {
    const st = history[li][si];
    const prevCost = li > 0 ? history[li - 1][st.back].cost : 0;
    const diff = +(st.cost - prevCost).toFixed(3); // このレイヤーに入るためのコスト = 難しさ
    st.notes.forEach((note, i) => {
      if (!result.has(note)) { const s = st.assign[i]; result.set(note, { hand: s < 0 ? 'L' : 'R', finger: Math.abs(s), difficulty: diff }); }
    });
    for (const n of st.rel) fingerEnd.set(n, Math.max(n.start + 0.05, layers[li].time - 0.03)); // 次の音の少し前に指を上げる
    si = st.back;
  }
  return notes.map((n) => {
    const r = { ...n, ...(result.get(n) || { hand: n.pitch < 60 ? 'L' : 'R', finger: 2, difficulty: 0 }) };
    if (fingerEnd.has(n) && fingerEnd.get(n) < n.end - 0.01) r.fingerEnd = fingerEnd.get(n);
    return r;
  });
}

// 出力をタイムライン JSON にまとめる
export function toTimeline(assigned, meta = {}) {
  return {
    version: 1,
    ...meta,
    notes: assigned.map((n) => ({
      pitch: n.pitch, start: +n.start.toFixed(4), end: +n.end.toFixed(4),
      velocity: n.velocity, hand: n.hand, finger: n.finger, difficulty: n.difficulty ?? 0,
      ...(n.fingerEnd != null ? { fingerEnd: +n.fingerEnd.toFixed(4) } : {}), // 指（と鍵）が上がる時刻。音は end までペダルで残る
    })),
  };
}
