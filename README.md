# vrm-piano

[日本語](README.ja.md)

Make a VRM avatar play the piano from a MIDI file, in the browser with three.js and three-vrm.

- **Fingering**: works out which hand and finger plays each note (Viterbi search over finger positions; thumb crossings, chord spans, releasing held notes onto the pedal)
- **Performance**: arm IK and per-finger IK onto a generated 88-key keyboard, wrist motion, key presses
- **Body and face**: leaning toward the hands, head and knee motion on the beat (estimated from the notes), and facial expressions driven by the music (major/minor, density, loudness) and the difficulty of the fingering
- **Sound**: plays the MIDI through a sampled grand piano (Salamander Grand Piano), or syncs to your own audio file
- **Auto-fit**: tunes the keyboard position/scale and hand values so the fingers land on the right keys for your avatar
- No build step and no runtime dependencies besides three.js and three-vrm

## Quick start

Requires Node.js 18 or later (only to run the local server and the tools).

```sh
git clone https://github.com/kaazu/vrm-piano.git
cd vrm-piano
npm run serve
```

Open http://localhost:8001/viewer/ and drop a `.vrm` file onto the page (or press "Open file"). Pick a song and press ▶ Play. The piano samples (about 60 files) load from jsDelivr the first time.

No VRM is included. You can make one with [VRoid Studio](https://vroid.com/en/studio) or use any VRM whose license allows it.

The viewer and tools need a web server (ES modules and `fetch` do not work from `file://`). `tools/serve.mjs` is a small dependency-free server; any static server works.

### Viewer URL parameters

| Parameter | Meaning |
|---|---|
| `?vrm=<url>` | Load this VRM on start |
| `?songsDir=<url>` | Folder that contains `index.json` (default `../songs/`) |
| `?lang=en` / `?lang=ja` | UI language (default: from the browser) |

Keys: Space play/pause, ← → step one frame, `,` `.` previous/next note, `T` tap tempo, `h` hide the panel.

## Using the library

```html
<script type="importmap">
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/",
  "@pixiv/three-vrm": "https://cdn.jsdelivr.net/npm/@pixiv/three-vrm@3.3.0/lib/three-vrm.module.js"
} }
</script>
<script type="module">
import * as THREE from 'three';
import { PianoPerformer, loadSongConfig } from './vrm-piano/lib/performer.js';

// vrm: loaded with GLTFLoader + VRMLoaderPlugin, after VRMUtils.rotateVRM0(vrm)
const perf = new PianoPerformer({ THREE });   // pass your own THREE (no second copy is loaded)
perf.attach(vrm, scene);                       // adds the keyboard to the scene
await perf.loadSong(await loadSongConfig('vrm-piano/songs/bach_polonaise_f/song.json'));
perf.play();                                   // hands move to the keys (~1 s), then it plays

// every frame: after your own animation, before vrm.update(dt)
perf.update(dt);
</script>
```

Main API:

| | |
|---|---|
| `play()` `pause()` `resume()` `seek(sec)` `stop()` | Transport. `stop()` lowers the hands and returns to idle |
| `update(dt)` | Call every frame |
| `setOptions(partial)` | Change options (deep-merged). See `DEFAULT_OPTIONS` in `lib/performer.js` |
| `frame` | A `THREE.Group`: where the piano stands (`+Z` is the player's front). Move/rotate it to place the piano in your scene |
| `getStand()` | `{ pos, look, yaw }`: where the character should stand, to walk it there |
| `glance(yaw, pitch, sec, expressions)` | Turn the head and change the face for a moment without stopping the hands |
| `weight` | 0–1 blend between your pose and the playing pose (handled automatically on play/stop) |
| `getState()` | `{ state, song, time, duration, progress, bpm, difficulty, isHard, mood }` |
| `on(event, fn)` | Events: `start`, `end`, `songEnd`, `note`, `samplerProgress` |
| `exportOptions()` | The current per-song options, for saving to `song.json` |
| `dispose()` | Remove the keyboard and detach |

Useful options: `idlePose: 'none'` if your app poses the arms while not playing, `seated: true` with `keyboard.range: 'song'` for playing while seated, `placeBody: false` to keep the body where your app put it.

## Songs

```
songs/
  index.json                 { "songs": [ { "id", "name", "nameJa"?, "config": "<id>/song.json", "composer" } ] }
  <id>/song.json             song settings (below)
  <id>/timeline.json         notes with hand and finger (made by the fingering tool)
  <id>/source.mid            the original MIDI
```

`song.json`:

```jsonc
{
  "name": "Title",
  "composer": "Composer",
  "audio": null,               // null: play the timeline with the piano sampler. Or a .mp3/.ogg file to sync to
  "timeline": "timeline.json",
  "credit": { "midi": "...", "license": "...", "screen": "text to show on screen" },
  "options": { ... },          // per-song values: keyboard, play, sway, beat, expression (missing = defaults)
  "synth": { "type": "salamander", "layers": [6, 12], "sustain": 0.45, "release": 0.25, "gain": 1, "dynamics": true }
}
```

`timeline.json`: `{ "version": 1, "notes": [ { "pitch", "start", "end", "velocity", "hand": "L"|"R", "finger": 1-5, "difficulty", "fingerEnd"? } ] }` (seconds; finger 1 = thumb; `fingerEnd` is set when the finger leaves a note early and the pedal holds the sound).

### Adding a song

```sh
npm run add-song -- path/to/piece.mid my_piece --name "My Piece" --composer "Someone" --license "Public Domain"
```

This copies the MIDI, computes the fingering (a few seconds to a minute), writes `song.json` and adds it to `songs/index.json`. Then fit it to your avatar (next section).

Tips for MIDI files: piano solo works best. Up to 10 simultaneous notes are played (extra held notes are dropped). Small avatars have small hands: slower pieces with fewer large jumps look most natural.

To only compute the fingering: `node fingering/cli.js in.mid out.json`. To check it visually: http://localhost:8001/fingering/roll.html

### Fitting to your avatar

Every avatar has different arm and finger lengths. The values in the demo songs were tuned for one avatar, so run auto-fit for yours:

- One song: in the viewer, press "Auto-fit fingers", then "Export settings (song.json)" and overwrite `songs/<id>/song.json`.
- All songs: open `http://localhost:8001/tools/autofit.html?vrm=<url of your .vrm>` (or pick the file on the page), press ▶, then "Export song.json". Add `&songs=id1,id2` to limit the songs.

Auto-fit plays the song silently frame by frame, measures how often a finger lands on the wrong key, floats above it or cannot reach it, and searches the keyboard x/height/depth/scale and `play.reach` / `wristHeight` / `wristBack`. About 30 seconds per song.

For automation, open it with `&auto=1`, save the result of `window.fitCompact()` to a file and run `node tools/apply_fit.mjs fit.json`.

## Project layout

| Path | |
|---|---|
| `lib/performer.js` | `PianoPerformer`: the runtime (no DOM dependency) |
| `lib/sampler.js` | Piano sampler (Web Audio) and automatic dynamics for flat-velocity MIDI |
| `lib/autofit.js` | Auto-fit (evaluation and search) |
| `fingering/` | MIDI parser, fingering engine, CLI, tests, piano-roll viewer |
| `expression/mood.js` | Musical features → mood → expressions, beat estimation |
| `viewer/` | Demo and tuning tool |
| `tools/` | Local server, add_song, autofit page, apply_fit |
| `songs/` | Demo songs |

`npm test` runs the fingering and expression tests.

Code comments are mostly in Japanese.

## Notes and limitations

- Tested with a VRM 0.x model in Chrome. VRM 1.0 models should work through three-vrm, but have not been tested much yet.
- Expressions use the standard VRM presets (`happy`, `relaxed`, `sad`, `angry`, `blink`, `aa`, `ou`) and an optional custom `Surprised`.
- Skirts and hair have no collision with the arms or keyboard.
- Real-time playing from a MIDI keyboard is not supported (songs are computed in advance).
- Browsers block audio until the user interacts with the page. Call `perf.clock.ctx.resume()` from a click if needed.

## Credits and licenses

- Code: [MIT License](LICENSE) © kaazu
- Demo MIDI files: [Mutopia Project](https://www.mutopiaproject.org/), Public Domain
  - J. S. Bach, Polonaise in F major (Notebook for Anna Magdalena Bach) — [piece 1013](https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1013)
  - J. S. Bach, Chorale "Aus meines Herzens Grunde" BWV 269 — [piece 378](https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=378)
- Piano sound: Salamander Grand Piano V3 by Alexander Holm, CC BY 3.0, loaded at runtime from jsDelivr ([@audio-samples/piano-velocity*](https://www.npmjs.com/package/@audio-samples/piano-velocity6)). It is not included in this repository. **If you publish audio or video made with it, credit it** (for example: "Piano: Salamander Grand Piano by Alexander Holm (CC BY 3.0)").
- [three.js](https://threejs.org/) (MIT) and [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) (MIT), loaded from jsDelivr
- When you add songs, check the license of each MIDI file and of the composition itself.
