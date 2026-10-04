# Maintaining releases

1. Update the version in `package.json` and run `npm install --package-lock-only`.
2. Run `npm test`, `npm run build`, and a secret scan of the publishable history. Check that no personal data is tracked.
3. Run `node tools/generate-notices.mjs` and review license changes. Update `engine/cores.json` and matching source references whenever cores change. Keep all dependency notices.
4. On Windows, run `npm run build:desktop`, then `node tools/desktop-smoke.mjs` against the unpacked build. Also test the portable EXE from a clean writable folder, including a real PS1 and PS2 game from your own collection. Never add those games to the package.
5. Commit the changes and push a version tag matching the package, such as `v0.1.0`. The release workflow builds the Windows EXE, collects core sources, and creates a draft GitHub release. Review it before publishing.

Include the Windows EXE, its SHA-256 checksum, the WebStationX source archive, and all emulator source archives in the release. Source archives must accompany binary distribution. The portable EXE contains Electron/Chromium license notices. Docker images include `LICENSE`, `THIRD_PARTY_NOTICES.md`, and `licenses/` under `/app`.

The initial Windows release is unsigned. Signing requires a publisher certificate or signing service configured by the maintainer; never put signing material in Git. Test SmartScreen behavior on a separate Windows machine before describing any build as warning-free.

Release notes should name tested configurations and known limits. PS2 is experimental. A game reaching its menu is not proof that gameplay, audio, saves, or multiplayer work correctly.
