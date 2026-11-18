import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyze, majorness, ExpressionDriver, featuresAt, paramsFromStats } from './mood.js';

let pass = 0; const t = (n, fn) => { fn(); pass++; console.log('ok -', n); };
t('C major chord tones -> positive majorness; C minor -> negative', () => {
  const maj = new Array(12).fill(0); for (const p of [0, 4, 7, 0, 4, 7, 2, 5, 9, 11]) maj[p] += 1;
  const min = new Array(12).fill(0); for (const p of [0, 3, 7, 0, 3, 7, 2, 5, 8, 10]) min[p] += 1;
  assert.ok(majorness(maj) > 0.3, 'maj ' + majorness(maj)); assert.ok(majorness(min) < -0.3, 'min ' + majorness(min));
});
t('analyze on a demo timeline gives sane ranges', () => {
  const tl = JSON.parse(readFileSync(new URL('../songs/bach_chorale_bwv269/timeline.json', import.meta.url)));
  const an = analyze(tl);
  const f = an.frames; assert.ok(f.length > 500); console.log('   stats', JSON.stringify(an.stats), JSON.stringify(paramsFromStats(an.stats)));
  const mean = (k) => f.reduce((s, x) => s + x[k], 0) / f.length;
  console.log('   mean density %s loud %s majorness %s difficulty %s', mean('density').toFixed(2), mean('loudness').toFixed(2), mean('majorness').toFixed(2), mean('difficulty').toFixed(1));
  assert.ok(f.every((x) => x.majorness >= -1 && x.majorness <= 1));
});
t('driver: difficult passage raises angry/squint, lowers happy', () => {
  const d = new ExpressionDriver();
  const easy = { density: 4, loudness: 0.6, majorness: 0.8, register: 70, difficulty: 2, stretch: 4, rest: 0.1 };
  const hard = { ...easy, difficulty: 40, stretch: 13 };
  for (let i = 0; i < 120; i++) d.update(easy, 1 / 30); const wE = { ...d.w };
  for (let i = 0; i < 120; i++) d.update(hard, 1 / 30); const wH = { ...d.w };
  assert.ok(wE.happy > 0.3, 'happy easy ' + wE.happy); assert.ok(wH.happy < wE.happy * 0.5, 'happy hard ' + wH.happy);
  assert.ok(wH.angry > 0.25 && wH.squint > 0.15, JSON.stringify(wH));
});
t('driver: minor + quiet -> sad', () => {
  const d = new ExpressionDriver();
  const f = { density: 1, loudness: 0.3, majorness: -0.8, register: 55, difficulty: 2, stretch: 3, rest: 0.3 };
  for (let i = 0; i < 150; i++) d.update(f, 1 / 30);
  assert.ok(d.w.sad > 0.3 && d.w.happy < 0.05, JSON.stringify(d.w));
});
console.log(`\n${pass} tests passed`);
