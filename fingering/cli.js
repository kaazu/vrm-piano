#!/usr/bin/env node
// 使い方: node cli.js input.mid output.json [--beam 300]
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseMidi } from './midi.js';
import { assignFingers, toTimeline } from './engine.js';

const [,, src, dst, ...rest] = process.argv;
if (!src || !dst) { console.error('usage: node cli.js input.mid output.json [--beam N]'); process.exit(1); }
const params = {};
for (let i = 0; i < rest.length; i += 2) params[rest[i].replace(/^--/, '')] = +rest[i + 1];

const { notes } = parseMidi(readFileSync(src));
const t0 = Date.now();
const assigned = assignFingers(notes, params);
const ms = Date.now() - t0;
writeFileSync(dst, JSON.stringify(toTimeline(assigned, { source: basename(src) }), null, 0));
const hands = { L: 0, R: 0 }, fingers = { L: {}, R: {} };
for (const n of assigned) { hands[n.hand]++; fingers[n.hand][n.finger] = (fingers[n.hand][n.finger] || 0) + 1; }
console.log(`${notes.length} notes, ${ms} ms -> ${dst}`);
console.log('hands', hands, 'fingers', fingers);
