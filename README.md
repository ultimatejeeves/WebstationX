# WebStationX

A private, browser-based PlayStation 1 and PlayStation 2 console for you and your friends. Pick a game, pick single or multiplayer, play. Saves and settings follow each player's profile.

- **Emulation**: PS1 games run on PCSX-ReARMed (libretro) compiled to WebAssembly, driven by [Nostalgist.js](https://nostalgist.js.org). PS2 games run on our build of [Play!](https://github.com/jpd002/Play-) with a WebAssembly JIT, multithreaded, with patches that take Tony Hawk's Pro Skater 4 from 30–50 fps to a locked 60 on a fast desktop (see [engine/play](engine/play/README.md)). Everything runs on the player's own machine; the server only hands out files and stores saves.
- **PS2 discs stream**: a multi-GB DVD image is never downloaded up front; the core reads it from the server in 1 MB range requests as the game needs it (cached in the browser for next time), so a PS2 game boots in about two seconds.
- **Multiplayer**: up to 4 controllers and/or the keyboard on one machine. With 3-4 players the emulated multitap is switched on automatically, so the game sees real local co-op.
- **Saves**: memory cards and save states are stored per profile on the server. Quitting a game suspends it; the library offers "Continue" next time.
- **Input**: the whole UI is navigable with a controller, keyboard, or mouse. Keyboard players can rebind every button to any key, mouse button, or wheel direction.
- **Online play**: whoever opens a multiplayer lobby becomes the host. Friends enter the four-letter room code from their own library screen, take a port, and play the host's game live: the host streams its picture and sound over WebRTC and receives their controller state back. Remote controllers show up in the emulator as ordinary gamepads, so multitap and per-port binds work unchanged.
- **Access**: gated by invite codes you hand out. Each friend signs in once per device.

## Requirements

- Node.js 22+
- A modern desktop browser (Chrome/Edge recommended). Controllers use the browser Gamepad API; press a button once so the browser exposes the pad.
- PS2 games additionally need a strong desktop (8 fast cores, a discrete GPU) and a secure page: the public `https://` address or `localhost`. Plain `http://192.168.x.x` LAN access can't run them (browsers only allow the shared memory the PS2 core's threads need on isolated, secure pages); PS1 games work everywhere.
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

Set `WSX_PORT` to change the port. `npm run dev:alt` runs a second copy on 5174/8091 when 5173/8090 are busy.

## Invite codes

Until the first code exists the server runs open (handy on a LAN). Once you add one, everything except the sign-in screen requires it:

```bash
npm run invite -- add "Mike"           # prints a code like WUQM-46CS
npm run invite -- list
npm run invite -- revoke Mike           # signs Mike out everywhere
```

Codes live in `data/invites.json`; the cookie secret is generated into `data/secret.key`. Sessions last a year or until the code is revoked. Sign out from Settings.

## Hosting it for friends (Unraid / Docker)

The server is light: it hands out files, stores saves and brokers online sessions. All emulation and video encoding happen in the players' browsers, so a small container is plenty.

```bash
tools/deploy-unraid.sh                 # from this PC: upload, build on the box, (re)create the container
docker exec webstationx node tools/invite.mjs add "Mike"   # on the box
```

`tools/deploy-unraid.sh` talks to `user@your-server` with `~/.ssh/id_webstationx` (override with `WSX_HOST` / `WSX_KEY`). It never touches `data/`, so re-running it is a safe upgrade. Unraid has no compose plugin; `tools/unraid-run.sh` is the plain `docker run` equivalent of the compose file and lives on the box as `/mnt/user/appdata/webstationx/run.sh`. If you prefer compose elsewhere: `docker compose up -d --build`.

`docker-compose.yml` maps `library/`, `bios/` and `data/` to `/mnt/user/appdata/webstationx/…`. Publish games on your PC with `npm run ingest` and copy the `library/<game>/` folder (plus `catalog.json`) into the share, or run the ingest inside the container.

**HTTPS is required.** Browsers only expose gamepads, WebRTC and audio capture on secure origins, so put the container behind a reverse proxy that terminates TLS: Nginx Proxy Manager or SWAG on Unraid, or a Cloudflare Tunnel (no port forwarding at all). WebSockets must be allowed through (`/ws`). The server trusts `X-Forwarded-Proto` from the proxy by default (`WSX_TRUST_PROXY=0` to disable).

**NAT traversal.** Video goes browser to browser. Public STUN is used by default and works for most home connections. If a friend's connection sits behind a strict NAT (some carrier-grade setups, campus networks), add a TURN relay through `WSX_ICE_SERVERS` (see the compose file); a `coturn` container on the same box, or a hosted TURN service, both work.

## Playing online

1. Host: pick a game → **Multiplayer**. The lobby shows a four-letter code and lists friends as they connect.
2. Friend: library → **Join online** → enter the code → press any button on a controller or the keyboard to take a port. Several people on one remote machine can each take a port.
3. Host presses **Start**. Remote players see the game full screen; Esc or Select+Start opens their menu (ping, leave).

The emulator sees four controller slots in total, shared between the host's own pads and remote players (the host keyboard is separate), so plug in local controllers before friends join. Latency is one network round trip plus encode/decode, typically 40-90 ms for friends in the same region. The host's machine does the streaming (about 3-5 Mbps upstream per remote player), and the host's tab keeps running while in the background.

## Publish a game

Drop a BIOS at `bios/SCPH1001.BIN` (already done), then:

```bash
npm run ingest -- "Games/Crash Bash (USA).7z" --id crash-bash --title "Crash Bash" --players 4 --year 2000 --publisher "Sony Computer Entertainment" --genre Party --multitap port1 --blurb "..."
```

The tool extracts the archive, compresses the disc to CHD (Crash Bash: 178 MB → 58 MB), copies a cover from `public/assets/cover-<id>.jpg` if one exists, and updates `library/catalog.json`. Replace `library/<id>/cover.jpg` with any 5:7 image you prefer. Multi-track discs (CD audio) are supported by `chdman` as long as the `.cue` is in the archive.

Options: `--multitap port1|port2|none` (default `port1` for games with more than 2 players), `--pad standard|analog` (use `analog` for DualShock titles).

**PS2 games**: add `--system ps2`. The source can be a `.chd` (hard-linked into the library when it's on the same drive, since PS2 discs are gigabytes), an `.iso` (compressed with `chdman createdvd`), or an archive holding either. PS2 games get two controller ports (Play! has no multitap) and a DualShock 2; no BIOS is needed.

```bash
npm run ingest -- "PS2/Tony Hawks Pro Skater 4 (USA) (v1.02).chd" --system ps2 --id thps4 --title "Tony Hawk's Pro Skater 4" --players 2 --year 2002 --publisher Activision --genre Sports --name "Tony Hawk's Pro Skater 4 (USA) (v1.02)"
```

Ingest records the source file's name as `sourceName` (e.g. `Ape Escape (USA)`, override with `--name`) and then scrapes game art for the new game (see [Game art](#game-art); skip with `--no-scrape`). Keep the Redump-style filename, since art is looked up by it.

## Art

`npm run assets` regenerates the UI art through the Leonardo API (key in `.env` as `LEONARDO_API_KEY`). Existing files are skipped unless `--force`; use `--only <id>` for one asset.

## Game art

`npm run scrape` fetches box art, back cover, disc label, logo, title screen, in-game screenshot, fan art and a gameplay clip into `library/<id>/art/`, records them (plus an accent colour taken from the box) in `meta.json` and `catalog.json`, and points the game's cover at `art/box.jpg`. Games are looked up by their Redump-style `sourceName`.

- **libretro-thumbnails** works out of the box, no account needed: box, title screen and screenshot.
- **ScreenScraper** adds everything else (back, disc, logo, fan art, video) and fills an empty blurb, genre, players, year and publisher. It needs a free account at [screenscraper.fr](https://www.screenscraper.fr) plus developer credentials, which you request on their forum. Put them in `.env`:

  ```
  SS_DEV_ID=...
  SS_DEV_PASSWORD=...
  SS_USER=...
  SS_PASSWORD=...
  ```

  Without all four the scraper silently uses libretro only, and if ScreenScraper rejects the request (bad login, quota) it says so and carries on with libretro.

Refresh one game with `npm run scrape -- --id <id> --force`. Other flags: `--source all|libretro|screenscraper` and `--dry`. Existing art files are skipped unless `--force`.

## Library filters

The shelf has system tabs (All / PS1 / PS2; L1 and R1 on a controller, Q and E on a keyboard) and chips for player count, favorites (Square or F on the selected game) and sort order (A-Z, recently played, release year, newest added). Favorites, play time and the chosen view are kept per profile in the browser.

## Device check

Before a game starts, the library estimates whether it will run well on the device in front of it (`src/core/compat.ts`) and flags or blocks it with a "Play anyway" override:

- the device: the hardware tier from `src/core/hardware.ts` (GPU class, threads, CPU benchmark, memory), plus the hard requirements of the PS2 core (https, cross-origin isolation);
- the game: `demand` (`light` / `medium` / `heavy`, PS2 only, default medium) and `compat` (`issues` / `broken` with a note, from our own testing) in its `meta.json`;
- experience: every PS2 session records how fast the game really ran on that device, and that replaces the estimate the next time.

Set the per-game fields with `node tools/set-meta.mjs <id> --demand heavy` or `--compat issues --note "..."`. Players can turn the check off in Settings (Device check).

## Phones and tablets

Menus have a landscape-phone layout (anything under 540 px tall): cases on the left, details on the right, dialogs that scroll. Touch works throughout: swipe the shelf, tap the front case or the Play button, and use the corner button in a game for the menu. "Add to Home Screen" installs it as a fullscreen landscape app (`public/manifest.webmanifest`). Playing still needs a controller (Bluetooth or USB); there is no on-screen gamepad.

Look at it without a phone: `node tools/ui-shots.mjs --viewport 844x390 --mobile --shots work/shots/ui-phone`.

## Tests

Headless end-to-end checks (need the dev server running):

```bash
node tools/smoke-test.mjs      # boot → sign in → profile → launch → frames drawn → save/load → suspend → lobby
node tools/keybind-test.mjs    # rebinding keys / mouse buttons and the generated RetroArch config
node tools/online-test.mjs     # host + remote in one Chrome: join by code, stream, remote input, pause, end
node tools/pad-probe.mjs       # proves RetroArch itself reads a virtual (remote) gamepad, no network involved
node tools/ps2-test.mjs        # PS2 on the real GPU: boot THPS4, audio + memory card, play into Career mode
                               # measuring fps, save/load, suspend, continue (--quick for a short run)
node tools/online-test.mjs --game thps4 --gpu   # online play with a PS2 host
```

Pass `--url http://localhost:5174` to test the alternate dev server. The tests sign in with the first active invite (or `--code`).

Screenshots land in `work/shots/`.

## Layout

```
server/index.ts      Express: catalog, library files, profiles, memory cards, save states (data/)
server/auth.ts       invite codes + signed session cookie
server/signaling.ts  WebSocket rooms relaying WebRTC offers/answers between host and friends
src/core            app shell, focus navigation, unified input (keyboard + gamepads + mouse), store
src/emu             Nostalgist wrapper + RetroArch/core config builder, keymap, disc cache,
                    virtual gamepads for remote players, audio tap, background keep-alive
src/emu/ps2*        PS2 session on the Play! core: runtime, streamed disc, pads, memory card
engine/play         Play! patches, build script, bench tools (see its README)
src/net             online sessions: host (stream + virtual pads) and remote client, wire protocol
src/screens         boot, login, profiles, library, lobby, play (pause menu), remote, settings
src/ui              buttons, dialogs, on-screen keyboard, binding editor
Dockerfile           production image (node dist/server.js); docker-compose.yml for Unraid
library/<game>/     game.chd, cover.jpg, meta.json   (catalog.json lists them)
public/cores        pcsx_rearmed_libretro.{js,wasm}, play/Play.{js,wasm}  (self-hosted, no CDN at runtime)
public/assets       generated art
tools/              ingest-game, gen-assets, smoke-test, keybind-test
```

## How input routing works

Each player slot chosen in the lobby is pinned to a RetroArch port. Gamepads are pinned by their Gamepad API index; the keyboard/mouse player gets that port's key and mouse-button binds while every other port is set to `nul`. Remote players are pinned the same way: each remote device is a virtual gamepad occupying a free index 0-3 in `navigator.getGamepads()` (RetroArch's web joypad driver only reads those four), fed by 8-byte state packets arriving 60 times a second on an unreliable data channel. The pause menu opens with Esc, the Home/Guide button, or Select+Start. Changing bindings mid-game suspends to a save state and relaunches with the new config.
