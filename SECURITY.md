# Security

Report vulnerabilities privately through the repository's GitHub Security advisory page if private reporting is enabled. Otherwise contact the maintainer privately through their GitHub profile before disclosing exploit details. Do not include credentials or private game files in public issues.

The hosted app is designed for trusted groups. Invites do not isolate profiles or saves from other invited users. Use HTTPS, restrict the backend port, and back up saves before upgrades. A new installation is open until an invite is created.

The desktop app listens only on loopback, disables Node integration in the renderer, and uses Electron's sandbox and context isolation. Keep Electron and server dependencies current. Windows releases are unsigned until maintainer code signing is configured.
