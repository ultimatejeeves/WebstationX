# Contributing

Use Node.js 22.12+ and run `npm ci`, `npm test`, and `npm run build`. Keep changes focused and explain the user-visible problem, implementation, and verification in the pull request.

The normal test suite needs no ROMs. `tools/smoke-test.mjs`, `tools/keybind-test.mjs`, `tools/online-test.mjs`, and `tools/ps2-test.mjs` exercise a running development server with a private game library and a Chromium installation. Read their headers for parameters; some default fixtures are games from the original development library and are not included here. Do not interpret a passing unit test as a gameplay compatibility claim.

For PS2 core changes, follow `engine/play/README.md` and run the applicable component regressions. Include the upstream base, patches, and exact test conditions. Do not commit generated builds from unreviewed upstream revisions.

Never commit game images, BIOS dumps, personal catalogs/artwork, saves, `.env` files, signing keys, invite codes, logs, or local editor/agent state. Release packaging uses explicit file lists. Run a secret scanner before publishing; `.gitignore` alone does not remove a file from Git history.
