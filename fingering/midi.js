// 依存なしの SMF(Standard MIDI File) パーサ。Node / ブラウザ共通（Uint8Array を受け取る）
// 出力: { ticksPerBeat, tempo(us/beat), notes: [{ pitch, start, end, velocity }] } start/end は秒

function readVlq(d, i) {
  let v = 0;
  for (;;) {
    const b = d[i++];
    v = (v << 7) | (b & 0x7f);
    if (!(b & 0x80)) return [v, i];
  }
}

export function parseMidi(bytes) {
  const d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const tag = (i) => String.fromCharCode(d[i], d[i + 1], d[i + 2], d[i + 3]);
  if (tag(0) !== 'MThd') throw new Error('not a MIDI file');
  const ntr = dv.getUint16(10), tpq = dv.getUint16(12);
  let i = 14;
  const events = []; // {tick, type, ...}
  for (let t = 0; t < ntr; t++) {
    if (tag(i) !== 'MTrk') throw new Error('bad track');
    const len = dv.getUint32(i + 4); i += 8;
    const end = i + len; let tick = 0, status = 0;
    while (i < end) {
      let dt; [dt, i] = readVlq(d, i); tick += dt;
      const b = d[i];
      if (b === 0xff) {
        const typ = d[i + 1]; let ln; [ln, i] = readVlq(d, i + 2);
        if (typ === 0x51) events.push({ tick, type: 'tempo', tempo: (d[i] << 16) | (d[i + 1] << 8) | d[i + 2] });
        i += ln;
      } else if (b === 0xf0 || b === 0xf7) {
        let ln; [ln, i] = readVlq(d, i + 1); i += ln;
      } else {
        if (b & 0x80) { status = b; i++; }
        const hi = status & 0xf0;
        if (hi === 0xc0 || hi === 0xd0) { i += 1; continue; }
        const a = d[i], c = d[i + 1]; i += 2;
        if (hi === 0x90 && c > 0) events.push({ tick, type: 'on', pitch: a, vel: c });
        else if (hi === 0x80 || (hi === 0x90 && c === 0)) events.push({ tick, type: 'off', pitch: a });
      }
    }
    i = end;
  }
  events.sort((x, y) => x.tick - y.tick || (x.type === 'off' ? -1 : 1));
  // tick → 秒（テンポ変化対応）
  let tempo = 500000, lastTick = 0, lastSec = 0;
  const tickToSec = [];
  for (const e of events) {
    const sec = lastSec + (e.tick - lastTick) / tpq * tempo / 1e6;
    e.sec = sec;
    if (e.type === 'tempo') { tempo = e.tempo; }
    lastTick = e.tick; lastSec = sec;
  }
  const open = new Map(), notes = [];
  for (const e of events) {
    if (e.type === 'on') { (open.get(e.pitch) || open.set(e.pitch, []).get(e.pitch)).push(e); }
    else if (e.type === 'off') {
      const q = open.get(e.pitch); if (!q || !q.length) continue;
      const on = q.shift();
      notes.push({ pitch: e.pitch, start: on.sec, end: Math.max(e.sec, on.sec + 0.01), velocity: on.vel });
    }
  }
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return { ticksPerBeat: tpq, notes };
}
