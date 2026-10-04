# Hosting and Unraid

## Reverse proxy

Terminate HTTPS at a trusted reverse proxy and forward HTTP and WebSockets to port 8090. Preserve the Host header and set X-Forwarded-Proto. Set `WSX_TRUST_PROXY=1` only for this arrangement; it trusts one proxy hop. Restrict direct access to the backend port. Keep the server's Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy response headers intact. PS2 threads need both.

`deploy/webstationx.subdomain.conf` is a SWAG example. Connect SWAG and WebStationX to the same Docker network. Allow WebSocket upgrades on `/ws`, HTTP range requests, and request bodies of at least 64 MB for save states. Disable buffering for disc streaming.

A reverse proxy does not make an open library private. Create invite codes before exposing the service. Invite holders can access all profiles and game files. This app is intended for a trusted group, not a public multi-tenant hosting service.

## Unraid deployment

The deploy script needs Bash, Git, tar, and an existing SSH login to the Unraid host. Git Bash works on Windows. Commit the changes you want to deploy first; the script uploads only committed source.

```sh
WSX_HOST=user@your-server WSX_KEY="$HOME/.ssh/your-key" bash tools/deploy-unraid.sh
```

`WSX_APPDATA` defaults to `/mnt/user/appdata/webstationx`. Source snapshots are retained under `releases/`. The image is built on Unraid. A replacement container must pass its health check before the old container is removed; on failure the old container is restarted. The script does not prune unrelated Docker images or copy/delete games, BIOS files, or saves.

Volumes are `Games`, `library`, `bios`, and `data` under the appdata directory. Existing managed libraries keep working. New games can go into `Games/psx` or `Games/ps2`. The container joins `wsxnet` and exposes port 8090. The run script assumes an HTTPS proxy by default.

For compatibility with existing root-owned Unraid appdata, `tools/unraid-run.sh` defaults to UID/GID 0 with all Linux capabilities dropped. To use a different account, make `Games` and `data` writable by it, then run the script on the host with `WSX_UID` and `WSX_GID` set. Other mounted folders only need read access. Generic Docker builds default to UID 1000.

To change the published port, run the host's `tools/unraid-run.sh` with `WSX_PORT` set. Record custom run settings outside Git and reapply them on upgrades.

## Invites

```sh
docker exec webstationx node tools/invite.mjs add "Friend"
docker exec webstationx node tools/invite.mjs list
docker exec webstationx node tools/invite.mjs revoke "Friend"
```

Codes and the generated cookie-signing key are stored in `data`. Treat that folder as private. Revoking the last invite keeps access locked; create a new invite with the CLI to regain access.

## Online play

The host selects a game and Multiplayer. Guests choose Join online and enter the room code. Controller slots are shared between local and remote players. The host's computer runs the emulator and encodes the stream; upstream bandwidth and latency matter.

For connections that cannot establish direct WebRTC, supply `WSX_ICE_SERVERS` as a JSON array of STUN/TURN server configurations. On generic Compose installations, add it to a private compose override. TURN credentials are delivered to signed-in browsers and must be intended for client use. Keep private configuration out of Git. The portable app is for local play; use the hosted build for online sessions.

## Backups

Stop the container before copying `data` or exporting the `wsx-data` volume, then restart it. Back up games separately. Restore data to the same mount or volume with suitable ownership. Avoid downgrading emulator cores without a backup: save-state compatibility can change between versions. In-game memory cards are generally more portable than save states.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `WSX_PORT` | `8090` | HTTP port; Compose uses this as the host port |
| `WSX_BIND` | `0.0.0.0` | Server bind address; desktop forces loopback |
| `WSX_TRUST_PROXY` | `0` | Trust one proxy hop when set to `1` |
| `WSX_DATA_DIR` | `data` under app root | Profiles, saves, invites, and signing key |
| `WSX_GAMES_DIR` | `Games` under app root | Automatically discovered discs |
| `WSX_LIBRARY_DIR` | `library` under app root | Managed catalog and assets |
| `WSX_BIOS_DIR` | `bios` under app root | PS1 BIOS |
| `WSX_ICE_SERVERS` | Public Google STUN | WebRTC connection configuration |

Use absolute paths for directory overrides. `.env` is consumed by Docker Compose; `npm start` reads shell environment variables.
