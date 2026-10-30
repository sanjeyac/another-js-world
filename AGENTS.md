# AGENTS.md

Guidance for AI coding agents (and humans) working on this repo.

## What this is

A browser/mobile port of the **Another World** bytecode VM, in plain JavaScript (ES modules). No bundler, no npm
dependencies, no framework. Derived from Gregory Montoir's *Raw* and Fabien Sanglard's C++ interpreter, so the
code is **GPL-2.0-or-later**. The original game data is copyrighted and must **never** be committed or published.

## Layout

| Path | Role |
| --- | --- |
| `src/bank.js` | Unpacker for compressed resources |
| `src/resource.js` | `memlist.bin` directory, resource/part loading |
| `src/vm.js` | Bytecode VM (64 threads, opcodes, polygon draw opcodes) |
| `src/video.js` | 4 pages of 320×200 4bpp, polygon rasteriser, font, palette |
| `src/mixer.js` | 4-channel mixer + music sequencer (driven by the audio callback) |
| `src/engine.js` | Glue + save states (`snapshot()` / `restore()`) |
| `src/web.js` | Browser layer: canvas, input, Web Audio, storage, menus, pause |
| `src/i18n.js`, `i18n/*.json` | Translations (see below) |
| `src/zip.js`, `src/storage.js` | Zip reader for the user's game files, IndexedDB wrapper |
| `kenney/` | CC0 font and bitmap sprites used by the UI |
| `assets/splash.jpg` | Splash artwork |
| `tools/` | `headless.mjs` (Node smoke test), `check-i18n.mjs`, `build.mjs` |
| `game/` | Local game data for development. **git-ignored** (only `.gitkeep` is tracked) |

## Commands

```sh
./run.sh                               # dev server on :8000 (prints the LAN address for phone testing)
node tools/headless.mjs game /tmp/f 3000 500   # run the VM under Node, dump PNG frames
BUTTON_FROM=3500 node tools/headless.mjs ...   # press the action button periodically from that frame
node tools/check-i18n.mjs              # all languages have the same keys/placeholders as English
node tools/build.mjs                   # builds dist/ (what GitHub Pages publishes)
```

There is no test suite. Verify VM/rendering changes with `headless.mjs` and look at the PNGs; verify UI changes in
a real or headless Chromium with mobile emulation (touch, 844×390 landscape and 390×780 portrait).

## Things that are easy to get wrong

- **The VM yields at every blit.** `VirtualMachine.runFrame()` returns when the script asks to display a frame;
  `completeBlit()` then draws it. The browser loop (`loop()` in `web.js`) paces frames with `vars[0xFF] * 20 ms`.
  Never add blocking sleeps. Thread state lives in fields (`tid`, `inThread`, `pc`, `sp`) so it can resume mid-thread.
- **Save states are only consistent at a frame start** (`onFrameStart` → `Engine.processInput`). Don't snapshot
  from arbitrary points; set `input.save` / `engine.pendingLoad` and let the VM pick it up. Mixer channels are not saved.
- **Music timing is sample-accurate** and lives inside `Mixer.render()` (called from the ScriptProcessor callback),
  not in timers. The music "mark" variable (`0xF4`) is written from there.
- Port faithfully: integer widths matter (`Int16Array` for VM vars, `uint16` wrap in video code, `>> 16` sign
  extension in the polygon fill). Compare against Sanglard's C++ before "simplifying".
- The copy-protection is bypassed by starting at part `0x3E81` with the usual variables preset (`vm.init`).
- The VM needs the files `memlist.bin` and `bank01`…`bank0d` (case-insensitive when provided by the user).
  The page loads them from IndexedDB, else `game/` (dev), else asks for a `.zip`.

## Conventions

- Code and docs in English. The project owner talks Italian; reply in the user's language.
- Match the surrounding style: small modules, few comments (explain *why*), no dependencies.
- ES modules need `http(s)`; `file://` does not work.
- **UI text goes through i18n.** Add the key to `i18n/en.json` and every other language file, use `t('key', {params})`
  in JS or `data-i18n` / `data-i18n-html` / `data-i18n-aria` in HTML, then run `node tools/check-i18n.mjs`.
  To add a language: new `i18n/<code>.json` + one line in `i18n/languages.json`. English is the fallback.
- The pixel font (`kenney/fonts/kenney-pixel.ttf`) is Latin only; ru/ja/ko/zh use the system font via
  `html:lang(...)` in `style.css`.
- UI look: pixel borders via `--px` and the `--notch` clip-path, Kenney 1-bit sprites rendered with
  `image-rendering: pixelated`. Reuse these instead of inventing new styles.
- Touch layout: in landscape the screen takes 80% of the height and the controls sit on the black side bands (CSS grid
  on `#app.touch`): four separate 40 px d-pad buttons (`kenney/input/c_*.png`, `--btn`) and the A button, placed like the
  reference mock-up (lower part of the bands). On narrow phones `--btn` shrinks before the screen does. In portrait the
  controls go below the screen with larger buttons. Keep the top-left pause button and top-right menu button on the bands.
- **New runtime file ⇒ update `sw.js`** (`SHELL` list, bump the cache name only if needed: the build stamps it) and,
  for a new top-level folder, the `INCLUDE` list in `tools/build.mjs`.

## Deployment

GitHub Pages with **Source: GitHub Actions**. `.github/workflows/pages.yml` runs `node tools/build.mjs` and
publishes `dist/` (git-ignored, generated). The build fails if `memlist.bin` / `bank*` end up in `dist/`.

## Git

Commit and push only when asked. End commit messages with the `Co-Authored-By` attribution line requested by the
harness. Check `git status` before committing: no game data, no `dist/`.
