# vrm-piano

[English](README.md)

MIDI ファイルから、VRM のキャラクターにピアノを弾かせます。ブラウザ（three.js ＋ three-vrm）で動きます。

- **運指**: どの音をどちらの手のどの指で弾くかを自動で決めます（指の位置を Viterbi で探索。親指くぐり、和音の広がり、押さえている音から指を離してペダルで残す、など）
- **演奏**: 88 鍵の鍵盤を作り、腕の IK と指 1 本ずつの IK で鍵を押します。手首の動き、鍵の沈みも付きます
- **体と表情**: 手の方向へ上体を傾ける、拍（音から推定）に合わせた首と膝の動き、曲（長調／短調・音の密度・強さ）と運指の難しさから表情を作ります
- **音**: MIDI をサンプル音源のグランドピアノ（Salamander Grand Piano）で鳴らします。自分の音声ファイルに合わせることもできます
- **自動調整**: キャラクターの体格に合わせて、指が正しい鍵に届くよう鍵盤の位置・大きさと手の値を探します
- ビルド不要。three.js と three-vrm 以外の依存はありません

## はじめかた

Node.js 18 以上が必要です（ローカルサーバーとツールを動かすためだけ）。

```sh
git clone https://github.com/kaazu/vrm-piano.git
cd vrm-piano
npm run serve
```

http://localhost:8001/viewer/ を開くと、サンプルのキャラクターが読み込まれます。曲を選んで ▶ 演奏。最初の 1 回は、ピアノの音源（約 60 ファイル）を jsDelivr から読み込みます。

自分のキャラクターを使うときは、`.vrm` ファイルをページにドロップし（または「ファイルを選ぶ」）、「指の位置を自動調整」を押してください。VRM 0.x と VRM 1.0 のどちらも使えます。[VRoid Studio](https://vroid.com/studio) で作ることもできます。

ビューアとツールは Web サーバー経由で開いてください（`file://` では ES モジュールと `fetch` が動きません）。`tools/serve.mjs` は依存なしの小さなサーバーです。ほかの静的サーバーでもかまいません。

### ビューアの URL パラメータ

| パラメータ | 意味 |
|---|---|
| `?vrm=<URL>` | 開いたときにこの VRM を読む（既定は同梱のサンプル） |
| `?songsDir=<URL>` | `index.json` がある曲フォルダ（既定 `../songs/`） |
| `?lang=ja` / `?lang=en` | 画面の言語（既定はブラウザの言語） |

キー: Space 再生／一時停止、← → 1 コマ送り、`,` `.` 前／次の音、`T` タップテンポ、`h` パネルを隠す。

## ライブラリとして使う

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

// vrm: GLTFLoader + VRMLoaderPlugin で読み、VRMUtils.rotateVRM0(vrm) を済ませたもの
const perf = new PianoPerformer({ THREE });   // 使う側の THREE を渡す（二重に読み込まない）
perf.attach(vrm, scene);                       // 鍵盤をシーンに追加
await perf.loadSong(await loadSongConfig('vrm-piano/songs/bach_polonaise_f/song.json'));
perf.play();                                   // 手を鍵盤へ（約 1 秒）→ 演奏

// 毎フレーム: 自分のアニメーションのあと、vrm.update(dt) の前に
perf.update(dt);
</script>
```

おもな API:

| | |
|---|---|
| `play()` `pause()` `resume()` `seek(秒)` `stop()` | 再生の操作。`stop()` は手を下ろして待機へ |
| `update(dt)` | 毎フレーム呼ぶ |
| `setOptions(partial)` | 設定の変更（深いマージ）。一覧は `lib/performer.js` の `DEFAULT_OPTIONS` |
| `frame` | ピアノの置き場所の `THREE.Group`（`+Z` が奏者の正面）。動かす・回すと部屋のどこでも弾ける |
| `getStand()` | `{ pos, look, yaw }`: キャラが立つ位置と向き（歩いて行かせる用） |
| `glance(yaw, pitch, 秒, 表情)` | 手を止めずに、少しのあいだ顔の向きと表情だけ変える |
| `weight` | 使う側のポーズと演奏ポーズのブレンド 0〜1（play / stop で自動） |
| `getState()` | `{ state, song, time, duration, progress, bpm, difficulty, isHard, mood }` |
| `on(イベント, fn)` | `start` `end` `songEnd` `note` `samplerProgress` |
| `exportOptions()` | いまの曲ごとの設定（`song.json` に保存する用） |
| `dispose()` | 鍵盤を外して切り離す |

よく使う設定: 待機中の腕を使う側で付けるなら `idlePose: 'none'`、座って弾くなら `seated: true` と `keyboard.range: 'song'`、体の位置を使う側のままにするなら `placeBody: false`。

## 曲

```
songs/
  index.json                 { "songs": [ { "id", "name", "nameJa", "config": "<id>/song.json", "composer" } ] }
  <id>/song.json             曲の設定（下）
  <id>/timeline.json         手と指つきの音（運指ツールが作る）
  <id>/source.mid            元の MIDI
```

`song.json`:

```jsonc
{
  "name": "曲名",
  "nameJa": "日本語の曲名（任意。画面が日本語のときに使う）",
  "composer": "作曲者",
  "audio": null,               // null: タイムラインをピアノ音源で鳴らす。.mp3 / .ogg を指定すると、その音声に合わせる
  "timeline": "timeline.json",
  "credit": { "midi": "...", "license": "...", "screen": "画面に出すクレジット" },
  "options": { ... },          // 曲ごとの値: keyboard, play, sway, beat, expression（ない項目は既定値）
  "synth": { "type": "salamander", "layers": [6, 12], "sustain": 0.45, "release": 0.25, "gain": 1, "dynamics": true }
}
```

`timeline.json`: `{ "version": 1, "notes": [ { "pitch", "start", "end", "velocity", "hand": "L"|"R", "finger": 1〜5, "difficulty", "fingerEnd"? } ] }`（秒。指 1 = 親指。`fingerEnd` は、指を先に離して音をペダルで残すときに付く）

### 曲を追加する

```sh
npm run add-song -- path/to/piece.mid my_piece --name "My Piece" --composer "作曲者" --license "Public Domain"
```

MIDI をコピーし、運指を計算して（数秒〜1 分）、`song.json` を作り、`songs/index.json` に追加します。そのあと、次の「体格に合わせる」をしてください。

MIDI のコツ: ピアノ独奏が向いています。同時に鳴らせるのは 10 音まで（それ以上は押さえている音を間引く）。小柄なキャラは手も小さいので、ゆっくりで跳躍の少ない曲が自然に見えます。

運指だけ計算: `node fingering/cli.js in.mid out.json`。目で確かめる: http://localhost:8001/fingering/roll.html

### 体格に合わせる（自動調整）

腕や指の長さはキャラごとに違います。デモ曲の値は同梱のサンプルに合わせたものなので、自分のキャラで自動調整してください。

- 1 曲だけ: ビューアで「指の位置を自動調整」→「設定を書き出す (song.json)」→ `songs/<id>/song.json` に上書き
- 全曲: `http://localhost:8001/tools/autofit.html?vrm=<.vrm の URL>` を開く（またはページでファイルを選ぶ）→ ▶ →「song.json を書き出す」。`&songs=id1,id2` で曲をしぼれます

自動調整は、曲を音なしでコマ送りして、指が「違う鍵」「鍵から浮いている」「届かない」になる割合を測り、鍵盤の左右・高さ・前後・大きさと `play.reach` / `wristHeight` / `wristBack` を探します。1 曲 30 秒ほど。

自動化するときは `&auto=1` で開き、`window.fitCompact()` の結果をファイルに保存して `node tools/apply_fit.mjs fit.json` を実行します。

## 構成

| 場所 | |
|---|---|
| `lib/performer.js` | `PianoPerformer` 本体（DOM に依存しない） |
| `lib/sampler.js` | ピアノ音源（Web Audio）と、強弱が平らな MIDI への強弱づけ |
| `lib/autofit.js` | 自動調整（評価と探索） |
| `fingering/` | MIDI パーサー、運指エンジン、CLI、テスト、ピアノロール |
| `expression/mood.js` | 曲の特徴 → 気分 → 表情、拍の推定 |
| `viewer/` | デモ兼調整ツール |
| `tools/` | ローカルサーバー、add_song、自動調整ページ、apply_fit |
| `songs/` | デモ曲 |
| `models/` | サンプルのキャラクター（100Avatars、Polygonal Mind、CC BY 4.0。`models/README.md`） |

`npm test` で運指と表情のテストを実行します。

## 注意と制限

- Chrome で、VRM 0.x のモデル（同梱の 100Avatars のサンプル、VRoid Studio のモデル）と、VRM 1.0 のモデル（VRM 仕様のサンプルの VRM1_Constraint_Twist_Sample と Seed-san）で確認しています
- 表情は VRM の標準プリセット（`happy` `relaxed` `sad` `angry` `surprised` `blink` `aa` `ou`）を使います。VRM 0.x では、カスタムの `Surprised` があればそれを使います
- スカートや髪と、腕・鍵盤との当たり判定はありません
- MIDI キーボードからのリアルタイム演奏には対応していません（曲は前もって計算します）
- ブラウザは、ページを操作するまで音を止めます。必要ならクリックで `perf.clock.ctx.resume()` を呼んでください

## クレジットとライセンス

- コード: [MIT License](LICENSE) © kaazu
- サンプルのキャラクター `models/100Avatars_001_Crimsom.vrm`: [100Avatars](https://github.com/polygonalmind/100avatars)（Polygonal Mind）の「Crimson」、[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)（VRM ファイルの中の設定は CC0）。無改変で同梱。MIT ライセンスの対象外です。詳しくは [models/README.md](models/README.md)
- デモ曲の MIDI: [Mutopia Project](https://www.mutopiaproject.org/)、パブリックドメイン
  - J. S. バッハ「ポロネーズ ヘ長調」（アンナ・マグダレーナ・バッハのための音楽帳）— [piece 1013](https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1013)
  - J. S. バッハ コラール「心のおくそこから」BWV 269 — [piece 378](https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=378)
- ピアノの音: Salamander Grand Piano V3 by Alexander Holm（CC BY 3.0）。実行時に jsDelivr から読み込みます（[@audio-samples/piano-velocity*](https://www.npmjs.com/package/@audio-samples/piano-velocity6)）。このリポジトリには含みません。**この音を使った音声・動画を公開するときはクレジットを書いてください**（例: 「Piano: Salamander Grand Piano by Alexander Holm (CC BY 3.0)」）
- [three.js](https://threejs.org/)（MIT）と [@pixiv/three-vrm](https://github.com/pixiv/three-vrm)（MIT）。jsDelivr から読み込みます
- 曲を追加するときは、MIDI ファイルと曲そのもの（作曲）の両方のライセンスを確かめてください
