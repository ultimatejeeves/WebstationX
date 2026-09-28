# WebStationX

A private, browser-based PlayStation 1 console for you and your friends. Pick a game, pick single or multiplayer, play. Saves and settings follow each player's profile.

- **Emulation**: PCSX-ReARMed (libretro) compiled to WebAssembly, driven by [Nostalgist.js](https://nostalgist.js.org). Everything runs on the player's own machine; the server only hands out files and stores saves.
- **Multiplayer**: up to 4 controllers and/or the keyboard on one machine. With 3-4 players the emulated multitap is switched on automatically, so the game sees real local co-op.
- **Saves**: memory cards and save states are stored per profile on the server. Quitting a game suspends it; the library offers "Continue" next time.
- **Input**: the whole UI is navigable with a controller, keyboard, or mouse. Keyboard players can rebind every button to any key, mouse button, or wheel direction.

## Requirements

- Node.js 22+
- A modern desktop browser (Chrome/Edge recommended). Controllers use the browser Gamepad API; press a button once so the browser exposes the pad.
- To publish games: 7-Zip (`C:\Program Files\7-Zip\7z.exe`) and MAME's `chdman.exe` in `work/tools/` (or on PATH).

## Run it

```bash
npm install
npm run dev        # UI on http://localhost:5173, API on :8090 (hot reload)
```

Production (single server on port 8090 serving the built UI, library, and saves):

```bash
npm run build
npm start
```

Set `WSX_PORT` in `.env` to change the port. Share the machine's LAN address (or put it behind a reverse proxy / VPN like Tailscale) with your friends.

## Publish a game

Drop a BIOS at `bios/SCPH1001.BIN` (already done), then:

```bash
npm run ingest -- "Games/Crash Bash (USA).7z" --id crash-bash --title "Crash Bash" --players 4 --year 2000 --publisher "Sony Computer Entertainment" --genre Party --multitap port1 --blurb "..."
```

The tool extracts the archive, compresses the disc to CHD (Crash Bash: 178 MB → 58 MB), copies a cover from `public/assets/cover-<id>.jpg` if one exists, and updates `library/catalog.json`. Replace `library/<id>/cover.jpg` with any 5:7 image you prefer. Multi-track discs (CD audio) are supported by `chdman` as long as the `.cue` is in the archive.

Options: `--multitap port1|port2|none` (default `port1` for games with more than 2 players), `--pad standard|analog` (use `analog` for DualShock titles).

## Art

`npm run assets` regenerates the UI art through the Leonardo API (key in `.env` as `LEONARDO_API_KEY`). Existing files are skipped unless `--force`; use `--only <id>` for one asset.

## Tests

Headless end-to-end checks (need the dev server running):

```bash
node tools/smoke-test.mjs      # boot → profile → launch → frames drawn → save/load → suspend → lobby
node tools/keybind-test.mjs    # rebinding keys / mouse buttons and the generated RetroArch config
```

Screenshots land in `work/shots/`.

## Layout

```
server/index.ts      Express: catalog, library files, profiles, memory cards, save states (data/)
src/core            app shell, focus navigation, unified input (keyboard + gamepads + mouse), store
src/emu             Nostalgist wrapper + RetroArch/core config builder, keymap, disc cache
src/screens         boot, profiles, library, lobby, play (pause menu), settings
src/ui              buttons, dialogs, on-screen keyboard, binding editor
library/<game>/     game.chd, cover.jpg, meta.json   (catalog.json lists them)
public/cores        pcsx_rearmed_libretro.{js,wasm}  (self-hosted, no CDN at runtime)
public/assets       generated art
tools/              ingest-game, gen-assets, smoke-test, keybind-test
```

## How input routing works

Each player slot chosen in the lobby is pinned to a RetroArch port. Gamepads are pinned by their Gamepad API index; the keyboard/mouse player gets that port's key and mouse-button binds while every other port is set to `nul`. The pause menu opens with Esc, the Home/Guide button, or Select+Start. Changing bindings mid-game suspends to a save state and relaunches with the new config.
