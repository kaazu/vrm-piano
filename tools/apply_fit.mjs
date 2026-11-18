#!/usr/bin/env node
// Write auto-fit results (from tools/autofit.html, window.fitCompact()) into songs/<id>/song.json.
// 指の位置の自動調整の結果を songs/<id>/song.json に書き込む。
//   node tools/apply_fit.mjs fit.json [--songsDir dir]   … fit.json = { "<id>": { options: {keyboard, play}, after: {miss, float, reach} }, ... }
//   node tools/apply_fit.mjs --unfit [--songsDir dir]    … list ids not fitted yet (no "fit" in song.json) / まだ調整していない曲
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIT_PARAMS } from "../lib/autofit.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2); const di = argv.indexOf("--songsDir");
const songsDir = path.resolve(di >= 0 ? argv.splice(di, 2)[1] : path.join(root, "songs"));
const index = JSON.parse(fs.readFileSync(path.join(songsDir, "index.json"), "utf8"));
const songPath = (id) => path.join(songsDir, id, "song.json");

if (argv[0] === "--unfit") {
  const ids = index.songs.map((s) => s.id).filter((id) => fs.existsSync(songPath(id)) && !JSON.parse(fs.readFileSync(songPath(id), "utf8")).fit);
  console.log(ids.join(","));
  process.exit(0);
}
const src = argv[0];
if (!src) { console.error("usage: node tools/apply_fit.mjs fit.json | --unfit [--songsDir dir]"); process.exit(1); }
const res = JSON.parse(fs.readFileSync(src, "utf8"));
const pc = (v) => (v * 100).toFixed(1) + "%";
for (const [id, r] of Object.entries(res)) {
  const p = songPath(id); if (!fs.existsSync(p)) { console.log(`- ${id}: no song.json (skipped)`); continue; }
  const song = JSON.parse(fs.readFileSync(p, "utf8"));
  song.options = song.options || {};
  for (const [g, v] of Object.entries(r.options || {})) song.options[g] = { ...(song.options[g] || {}), ...v };
  song.options.play = { ...(song.options.play || {}), tipSolve: true, wristWeighted: true };
  // Clamp to the auto-fit ranges (FIT_PARAMS in lib/autofit.js) even if the browser used an old autofit.js
  for (const fp of FIT_PARAMS) {
    const [g, k] = fp.path.split("."); const v = song.options[g]?.[k];
    if (typeof v === "number" && (v < fp.min || v > fp.max)) { const c = Math.min(fp.max, Math.max(fp.min, v)); console.log(`  ${id}: ${fp.path} ${v} → ${c} (range ${fp.min}–${fp.max})`); song.options[g][k] = c; }
  }
  if (r.after) song.fit = { at: new Date().toISOString().slice(0, 10), miss: +r.after.miss.toFixed(3), float: +r.after.float.toFixed(3), reach: +r.after.reach.toFixed(3) };
  fs.writeFileSync(p, JSON.stringify(song, null, 2) + "\n");
  console.log(`+ ${id}: keyboard ${JSON.stringify(song.options.keyboard)}${r.after ? `, wrong key ${pc(r.after.miss)}, floating ${pc(r.after.float)}` : ""}`);
}
