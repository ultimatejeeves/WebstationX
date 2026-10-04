# Third-party notices

WebStationX's MIT license applies to its original application code. It does not replace the licenses of bundled emulators, libraries, fonts, or Electron/Chromium. Preserve these notices when redistributing the app or image.

## PS1: PCSX-ReARMed and RetroArch

The checked-in `pcsx_rearmed_libretro.js` and `.wasm` are unmodified files from [RetroArch Emscripten build v1.22.2](https://github.com/arianrhodsandlot/retroarch-emscripten-build/tree/d03a5b0d642ea638d4d8447960e9796a45fb074e). They match the contents of that tag's `retroarch/pcsx_rearmed_libretro.zip` byte-for-byte. That distribution takes its binaries from the Libretro buildbot.

The Wasm contains RetroArch version `1.22.2`, Git revision `a609b70`, and PCSX-ReARMed version `r25 228c14e`.

- [RetroArch source at a609b70](https://github.com/libretro/RetroArch/tree/a609b70), GPL-3.0: [license](licenses/RetroArch.txt).
- [PCSX-ReARMed source at 228c14e](https://github.com/libretro/pcsx_rearmed/tree/228c14e), GPL-2.0-or-later with component-specific notices: [license](licenses/PCSX-ReARMed.txt).
- [Build tooling](https://github.com/libretro/libretro-super) and upstream `pkg/emscripten` build instructions in RetroArch.

Binary releases must be accompanied by the corresponding source archives. `node tools/fetch-core-sources.mjs` downloads the pinned source archives into `release/core-sources`; the release workflow includes them as separate downloads. These archives retain upstream build scripts and component notices. No upstream binary modifications are made by WebStationX. Hashes and provenance are recorded in `engine/cores.json`.

## PS2: Play! and CodeGen

[Play!](https://github.com/jpd002/Play-) and [CodeGen](https://github.com/jpd002/Play--CodeGen) are BSD-2-Clause licensed. See [Play! license](licenses/Play.txt) and [CodeGen license](licenses/CodeGen.txt). WebStationX distributes modified builds. The pinned base revisions, all application patches, build instructions, and tests are in `engine/play/`. Upstream dependencies retain the notices in their source directories; the release source bundle includes the recursive Play! source tree with its dependencies.

Copies of upstream dependency notices are also included under `licenses/play-dependencies/` in the binary packages.

## JavaScript and desktop runtime

Nostalgist.js, Three.js, Express, ws, and their runtime dependencies retain their original licenses and copyrights. Full license text from installed runtime dependencies is collected in [npm dependency notices](licenses/npm-dependencies.md). Run `node tools/generate-notices.mjs` after dependency upgrades.

Electron is MIT licensed and incorporates Chromium, Node.js, and other third-party software. Electron's `LICENSE.electron.txt` and `LICENSES.chromium.html` are included in the portable application payload by electron-builder; their original notices apply. Electron source and licensing are available at [electron/electron](https://github.com/electron/electron).

## Fonts and artwork

Audiowide, Exo 2, Orbitron, Press Start 2P, and VT323 are distributed under the SIL Open Font License. Their notices are in `licenses/`.

The application backgrounds, avatars, and decorative graphics were generated for this project. Personal catalogs, scraped game covers, screenshots, trailers, game images, and BIOS files are not part of the public source or release packages. Artwork added to a private library remains subject to its original owner's terms.

PlayStation names and marks belong to their respective owners. No Sony game software or BIOS is supplied.
