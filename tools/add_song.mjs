#!/usr/bin/env node
// Add a song from a MIDI file: songs/<id>/source.mid, timeline.json (fingering) and song.json, and append it to songs/index.json.
//   node tools/add_song.mjs <file.mid> <id> [--name "Title"] [--composer "Name"] [--license "Public Domain"] [--source URL] [--songsDir dir]
// MIDI から曲を追加します（運指の計算 → song.json → index.json に追記）。
// After adding, open tools/autofit.html?songs=<id> to fit the fingers to your avatar.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMidi } from '../fingering/midi.js';
import { assignFingers, toTimeline } from '../fingering/engine.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < args.length; i++) { if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[++i]; else pos.push(args[i]); }
const [src, id] = pos;
if (!src || !id || !/^[a-z0-9_-]+$/i.test(id)) {
  console.error('usage: node tools/add_song.mjs <file.mid> <id> [--name "Title"] [--composer "Name"] [--license "..."] [--source URL] [--songsDir dir]');
  console.error('  id: letters, digits, _ and - only');
  process.exit(1);
}
const songsDir = path.resolve(flags.songsDir || path.join(root, 'songs'));
const indexPath = path.join(songsDir, 'index.json');
const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : { songs: [] };
if (index.songs.some((s) => s.id === id)) { console.error(`"${id}" is already in ${indexPath}`); process.exit(1); }

const dir = path.join(songsDir, id);
fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(src, path.join(dir, 'source.mid'));
const { notes } = parseMidi(fs.readFileSync(src));
const t0 = Date.now();
const tl = toTimeline(assignFingers(notes, {}), { source: 'source.mid' });
fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl));
console.log(`fingering: ${notes.length} notes, ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const name = flags.name || id;
const song = {
  name,
  composer: flags.composer || '',
  audio: null,                 // null = play the MIDI with the built-in piano sampler
  timeline: 'timeline.json',
  credit: {
    midi: flags.source || '',
    license: flags.license || '',
    screen: 'Piano: Salamander Grand Piano (CC BY 3.0)',
    samples: 'Salamander Grand Piano by Alexander Holm (CC BY 3.0), via @audio-samples/piano-velocity* on jsDelivr',
  },
  options: {},                 // empty = library defaults. Run auto-fit / the viewer to tune for your avatar
  synth: { type: 'salamander', layers: [6, 12], sustain: 0.45, release: 0.25, gain: 1, velCurve: 1, dynamics: true },
};
fs.writeFileSync(path.join(dir, 'song.json'), JSON.stringify(song, null, 2) + '\n');
index.songs.push({ id, name, config: `${id}/song.json`, composer: song.composer });
fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
console.log(`added ${id} → ${path.relative(process.cwd(), dir)}`);
console.log(`next: fit the fingers → http://localhost:8001/tools/autofit.html?songs=${id}`);
