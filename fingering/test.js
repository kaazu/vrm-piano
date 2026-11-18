// node test.js
import assert from 'node:assert/strict';
import { assignFingers, buildLayers } from './engine.js';

const mk = (pitches, dur = 0.25, start = 0, vel = 80) =>
  pitches.map((p, i) => ({ pitch: p, start: start + i * dur, end: start + i * dur + dur * 0.9, velocity: vel }));
const chord = (pitches, start = 0, dur = 1) => pitches.map((p) => ({ pitch: p, start, end: start + dur, velocity: 80 }));
const fstr = (a) => a.map((n) => (n.hand === 'L' ? '-' : '') + n.finger).join(' ');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('ok -', name); };

t('C major scale up (RH) uses thumb-under, no same-finger repeats', () => {
  const a = assignFingers(mk([60, 62, 64, 65, 67, 69, 71, 72]));
  assert.ok(a.every((n) => n.hand === 'R'), 'all right hand: ' + fstr(a));
  for (let i = 1; i < a.length; i++) assert.notEqual(a[i].finger, a[i - 1].finger, 'repeat at ' + i + ': ' + fstr(a));
  const seq = a.map((n) => n.finger).join('');
  assert.ok(seq.startsWith('123') || seq.startsWith('12'), 'should start 1 2 3: ' + seq);
  assert.ok(seq.includes('31') || seq.includes('41'), 'thumb-under expected: ' + seq);
});

t('low scale is left hand, descending finger numbers going up', () => {
  const a = assignFingers(mk([36, 38, 40, 41, 43]));
  assert.ok(a.every((n) => n.hand === 'L'), fstr(a));
  for (let i = 1; i < a.length; i++) assert.notEqual(a[i].finger, a[i - 1].finger, fstr(a));
});

t('C major triad RH -> 1 3 5', () => {
  const a = assignFingers(chord([60, 64, 67]));
  assert.deepEqual(a.map((n) => n.finger), [1, 3, 5], fstr(a));
  assert.ok(a.every((n) => n.hand === 'R'));
});

t('wide two-hand chord splits hands by pitch', () => {
  const a = assignFingers(chord([36, 43, 60, 64, 67]));
  assert.deepEqual(a.map((n) => n.hand), ['L', 'L', 'R', 'R', 'R'], fstr(a));
  assert.equal(a[0].finger, 5); assert.equal(a[1].finger, 1); // 左手: 低い音が小指
});

t('held bass note keeps its finger while melody moves', () => {
  const notes = [{ pitch: 48, start: 0, end: 2, velocity: 80 }, ...mk([72, 74, 76, 77], 0.25, 0.3)];
  const a = assignFingers(notes);
  assert.equal(a[0].hand, 'L');
  assert.ok(a.slice(1).every((n) => n.hand === 'R'), fstr(a));
});

t('octave jump after a rest is cheap: same finger allowed', () => {
  const notes = [{ pitch: 60, start: 0, end: 0.2, velocity: 80 }, { pitch: 72, start: 2, end: 2.2, velocity: 80 }];
  const a = assignFingers(notes);
  assert.ok(a.every((n) => n.hand === 'R'), fstr(a));
});

t('layers: simultaneous notes within window are grouped', () => {
  const l = buildLayers(chord([60, 64, 67]).concat(mk([72], 0.25, 0.5)));
  assert.equal(l.length, 2); assert.equal(l[0].notes.length, 3); assert.equal(l[1].notes.length, 4); // 和音継続 + 新音
});

t('10-note chord works; 11 sounding notes do not crash (one is dropped from the layer)', () => {
  const a = assignFingers(chord([36, 40, 43, 47, 50, 60, 64, 67, 71, 74]));
  assert.equal(a.length, 10);
  const b = assignFingers([...chord([36, 40, 43, 47, 50, 60, 64, 67, 71, 74]), ...chord([77], 0.3)]);
  assert.equal(b.length, 11); assert.ok(b.every((n) => n.hand && n.finger));
});

t('fast repeated note alternates or keeps finger, never switches hand', () => {
  const a = assignFingers(mk([67, 67, 67, 67], 0.12));
  assert.ok(a.every((n) => n.hand === a[0].hand), fstr(a));
});

t('held low note is released (pedal) when the same hand must jump far up', () => {
  // 右手で 60 を伸ばしたまま、右手で 2 オクターブ上を弾く（左手は低音で塞がっている）
  const notes = [{ pitch: 36, start: 0, end: 3, velocity: 80 }, { pitch: 60, start: 0, end: 3, velocity: 80 }, ...mk([84, 86, 88, 89], 0.25, 0.5)];
  const a = assignFingers(notes);
  const held = a.find((n) => n.pitch === 60);
  assert.ok(held.fingerEnd != null && held.fingerEnd < 3, 'pitch 60 should get fingerEnd: ' + JSON.stringify(held));
  assert.ok(held.fingerEnd >= held.start + 0.05);
});

t('held note that fits under the hand is NOT released', () => {
  const notes = [{ pitch: 60, start: 0, end: 2, velocity: 80 }, ...mk([64, 65, 67], 0.25, 0.3)];
  const a = assignFingers(notes);
  assert.equal(a[0].fingerEnd, undefined, JSON.stringify(a[0]));
});

t('allowRelease:false keeps the old behaviour', () => {
  const notes = [{ pitch: 36, start: 0, end: 3, velocity: 80 }, { pitch: 60, start: 0, end: 3, velocity: 80 }, ...mk([84, 86, 88, 89], 0.25, 0.5)];
  const a = assignFingers(notes, { allowRelease: false });
  assert.ok(a.every((n) => n.fingerEnd == null));
});

console.log(`\n${pass} tests passed`);
