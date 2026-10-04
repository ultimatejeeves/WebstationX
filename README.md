# WebStationX

Play PS1 and PS2 games in a browser, or run the portable Windows app. WebStationX provides the game library, profiles, controller setup, saves, and online play. Emulation is handled by PCSX-ReARMed and Play!, compiled to WebAssembly.

The server delivers files and stores saves. The computer running the game does the emulation. PS2 support is experimental: compatibility and performance vary, and a fast computer does not guarantee that every game will work.

No games or console BIOS files are included.

## Windows: download and play

1. Download `WebStationX-<version>-windows-x64.exe` from [Releases](https://github.com/ultimatejeeves/WebstationX/releases).
2. Put it in a writable folder, such as `Documents\WebStationX`, and double-click it.
3. Use **Games → Open PS1 folder** or **Open PS2 folder**, then copy your disc images there.
4. Pick a profile and a game. New files appear in the library within a few seconds.

There is no installer, Node.js setup, or separate browser to install. The app includes its browser runtime and emulator cores. First launch extracts the application into a temporary directory, so allow a little time for it to open. Local play works offline.

```text
WebStationX-0.1.1-windows-x64.exe
Games/
  psx/                 PS1 games
  ps2/                 PS2 games
  bios/                optional PS1 BIOS
  .webstationx/        saves, profiles, preferences, and browser cache
```

| System | Supported files |
| --- | --- |
| PS1 | `.chd`, `.iso`, `.pbp`, or `.cue` with its `.bin` tracks |
| PS2 | `.chd` or `.iso` |

Extract ZIP and 7z archives first. Keep each CUE and all of its BIN tracks together, preferably in a separate game folder. A BIN file by itself is not listed. CHD is convenient for multi-track PS1 games. Renaming or moving a disc changes its library ID; keep filenames stable if you want existing saves to remain associated with it.

PS1 works best with a BIOS dumped from your console. Choose **Games → Add PS1 BIOS** to select a 512 KB BIN file; the app stores it as `Games/bios/SCPH1001.BIN`. Without it, the PS1 core uses its built-in replacement, which is less compatible. PS2 uses Play!'s BIOS replacement and does not need a BIOS file.

Press a button on a connected controller to activate it. The keyboard also works, and bindings can be changed in Settings. **Esc**, the controller's **Guide** button, or **Select + Start** opens the game menu. Save or return to the library before closing the app.

To update, close the app and replace the executable. Keep the `Games` folder. To move your installation, move both together. Back up `Games/.webstationx/data` to keep your saves and profiles.

The Windows build is unsigned. Windows may display an unknown-publisher warning. Code signing is not configured in this repository.

## Docker: host it yourself

Install Docker with the Compose plugin, then:

```sh
git clone https://github.com/ultimatejeeves/WebstationX.git
cd WebstationX
mkdir -p Games/psx Games/ps2 library bios
docker compose up -d --build
```

Open **http://localhost:8090**. Copy games into `Games/psx` or `Games/ps2`; the library refreshes automatically. Put an optional PS1 BIOS at `bios/SCPH1001.BIN`.

The image runs as the unprivileged `node` user. Mounted folders must be readable by UID 1000; the `Games/psx` and `Games/ps2` folders must exist. Saves use the named `wsx-data` volume. Do not run `docker compose down -v` unless you intend to delete that data.

Compose binds to localhost by default. For access from other computers, copy `.env.example` to `.env`, set `WSX_LISTEN_ADDRESS=0.0.0.0`, and use an HTTPS reverse proxy. PS2 needs cross-origin isolation on a secure origin: **HTTPS or localhost**. Plain HTTP to a LAN IP is not enough.

Before making the server reachable outside your trusted network, create an invite:

```sh
docker compose exec webstationx node tools/invite.mjs add "Your name" --owner
docker compose exec webstationx node tools/invite.mjs add "Friend"
```

A new server is open until an invites file is created. Once configured, it stays locked even if every invite is revoked. Signed-in users share access to the library and profiles; invites are an access gate, not isolated user accounts.

For updates, run `git pull` and `docker compose up -d --build`. Your mounted games and saved data stay in place. See [hosting and Unraid](docs/hosting.md) for proxy setup, backups, TURN relays, and deployment.

## Build from source

Use Node.js **22.12 or newer** and npm.

```sh
npm ci
npm run dev
```

The development UI is at **http://localhost:5173**. For a production server:

```sh
npm run build
npm start
```

To build the portable executable on Windows:

```sh
npm ci
npm run build:desktop
```

The executable is written to `release/`. `npm run desktop` runs the desktop shell from source. Both builds use the checked-in WebAssembly cores; rebuilding the C++ emulator is a separate step.

## Features and limits

- Per-profile memory cards, save states, controller bindings, favorites, and play history.
- PS1 local multiplayer with up to four controllers and multitap for supported games. PS2 supports two controller ports.
- Online play through a hosted server: the host streams picture and sound over WebRTC; guests send controller input. This is streaming, not deterministic emulator netplay. The portable app is intended for local play and binds only to your own computer.
- PS2 disc streaming through HTTP range requests, avoiding a full DVD download before launch.
- Controller, keyboard, and mouse navigation. There is no on-screen touch gamepad.

Automatically discovered games default to two players. For covers, descriptions, and explicit multitap settings, use the [managed library tools](docs/library.md).

## Project structure

| Directory | Purpose |
| --- | --- |
| `src/` | TypeScript UI, input, rendering, and emulator integration |
| `server/` | Express API, game files, profiles, saves, and WebSocket signaling |
| `desktop/` | Electron launcher and local folder management |
| `engine/play/` | Play! and CodeGen patches, build scripts, and regression tests |
| `public/cores/` | WebAssembly emulator binaries loaded locally |
| `tools/` | Library maintenance, deployment, and browser tests |
| `tests/` | Automated discovery and access-control regression tests |

The PS2 work includes changes to Wasm block linking, disc streaming, graphics transfers, frame pacing, and save-state restoration. The [core documentation](engine/play/README.md) explains the patches and their limitations.

## Testing and contributing

```sh
npm test
npm run build
```

These checks do not require game files. Browser gameplay tests use your own local library; see [contributing](CONTRIBUTING.md). Report the game, region, file format, browser or app version, hardware, and steps to reproduce a problem. Do not attach game images, BIOS files, credentials, or private saves to an issue.

## License and credits

WebStationX's original application code is MIT licensed. Third-party components keep their own licenses, including GPL components in the PS1 runtime. See [third-party notices](THIRD_PARTY_NOTICES.md) for licenses, source references, and binary provenance.

Use your own game and BIOS dumps. PlayStation is a trademark of Sony Interactive Entertainment. This project is not affiliated with or endorsed by Sony.
