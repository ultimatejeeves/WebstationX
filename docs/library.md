# Managed game libraries

The drop folders work without a catalog or extra tools. A managed library adds covers, descriptions, release years, player counts, controller modes, and compatibility notes.

`tools/ingest-game.mjs` can extract archives and convert discs to CHD. It needs 7-Zip and MAME's `chdman` locally; these are not bundled with the desktop app or Docker image. See the tool's header for paths and flags. Run ingestion outside the production container, then copy the resulting library folder to the server.

```sh
npm run ingest -- "path/to/game.chd" --id example --title "Example" --players 2 --no-scrape
npm run ingest -- "path/to/ps2-game.chd" --system ps2 --id example-ps2 --title "Example PS2" --players 2 --no-scrape
```

Managed games live at `library/<id>/` and are listed in `library/catalog.json`. For PS1 games with more than two players, specify `--players 4 --multitap port1` where the game supports it. Use `--pad analog` for games requiring a DualShock. All discovered drop-folder games default to two players with analog controllers.

`npm run scrape` fetches game art from libretro-thumbnails. Optional ScreenScraper access uses `SS_DEV_ID`, `SS_DEV_PASSWORD`, `SS_USER`, and `SS_PASSWORD` from your private `.env`. Scraped media belongs to its respective owners and must not be included in public releases. `node tools/set-meta.mjs <id> --demand heavy` and `--compat issues --note "Description"` record per-game compatibility observations.

A game present in both a drop folder and the managed catalog appears twice. Choose one approach per game. Game IDs determine save locations; changing IDs does not migrate saves automatically.
