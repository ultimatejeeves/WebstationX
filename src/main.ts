import './styles.css';
import { api, UNAUTHORIZED_EVENT } from './core/api';
import { app } from './core/app';
import { initHardware } from './core/hardware';
import { store } from './core/store';
import type { DeviceId, GameMeta } from './core/types';
import type { SessionPlayers } from './emu/player';
import { BootScreen } from './screens/boot';
import { LibraryScreen, type LaunchIntent } from './screens/library';
import { LobbyScreen } from './screens/lobby';
import { LoginScreen } from './screens/login';
import { RemoteScreen } from './screens/remote';
import { installAudioTap } from './emu/audio-tap';
import { installVirtualPads } from './emu/virtual-pads';
import { ClientSession, online, stopHosting } from './net/online';
import { textEntryDialog } from './ui/components';
import { PlayScreen } from './screens/play';
import { ProfilesScreen } from './screens/profiles';

// Must run before the emulator core loads: remote controllers and stream audio hook in here.
installVirtualPads();
installAudioTap();

// Measure this device once (cached per browser) so the first game launch has its graphics preset.
void initHardware();

const root = document.getElementById('app')!;
app.init(root);

function showLibrary() {
  // Leaving to the library ends any online room we were hosting.
  if (online.host) stopHosting('The host went back to the library');
  void app.go(new LibraryScreen(onLaunch, showProfiles, joinOnline));
}

/** Remote player flow: ask for the host's code, connect, and hand over to the remote screen. */
async function joinOnline() {
  const code = await textEntryDialog('Enter the session code', '', 4);
  if (!code) return;
  app.toast('Connecting…', 'info', 1500);
  try {
    const client = await ClientSession.join(code, store.profile?.name ?? store.session.name ?? 'Player');
    online.client = client;
    void app.go(
      new RemoteScreen(client, () => {
        online.client = null;
        showLibrary();
      }),
    );
  } catch (e) {
    app.toast(e instanceof Error ? e.message : 'Could not join', 'warn', 3200);
  }
}

function showProfiles() {
  void app.go(new ProfilesScreen(() => showLibrary()));
}

function onLaunch(intent: LaunchIntent) {
  if (intent.mode === 'single') {
    startGame(intent.game, [intent.device], intent.resumeSlot);
  } else {
    showLobby(intent.game, intent.device, intent.resumeSlot);
  }
}

function showLobby(game: GameMeta, first: DeviceId, resumeSlot: string | null, keep: SessionPlayers = []) {
  void app.go(
    new LobbyScreen(
      game,
      first,
      (players) => startGame(game, players, resumeSlot),
      () => showLibrary(),
      keep,
    ),
  );
}

function startGame(game: GameMeta, players: SessionPlayers, resumeSlot: string | null) {
  void app.go(
    new PlayScreen(
      game,
      players,
      resumeSlot,
      () => showLibrary(),
      () => showLobby(game, players[0] ?? 'kb', 'suspend', players),
      () => startGame(game, players, 'suspend'),
    ),
  );
}

let signedIn = false;

/** Invite gate: ask for a code until the server accepts one, then continue into the console. */
async function ensureSignedIn(): Promise<void> {
  try {
    const s = await api.session();
    store.session = s;
    if (s.signedIn) {
      signedIn = true;
      return;
    }
  } catch (e) {
    console.error(e);
  }
  await new Promise<void>((resolve) => {
    void app.go(
      new LoginScreen(async (name) => {
        signedIn = true;
        store.session = await api.session().catch(() => ({ signedIn: true, name, owner: false, gated: true, ice: [] }));
        resolve();
      }),
      { transition: store.bootedThisSession ? 'fade' : 'none' },
    );
  });
}

async function enterConsole() {
  try {
    await store.loadCatalog();
  } catch (e) {
    console.error(e);
  }
  const restored = await store.restoreProfile();
  restored ? showLibrary() : showProfiles();
}

async function boot() {
  if (!store.bootedThisSession) {
    store.bootedThisSession = true;
    await new Promise<void>((done) => void app.go(new BootScreen(done), { transition: 'none' }));
  }
  await ensureSignedIn();
  await enterConsole();
}

// A revoked invite (or an expired cookie) bounces straight back to the sign-in screen.
window.addEventListener(UNAUTHORIZED_EVENT, () => {
  if (!signedIn) return;
  signedIn = false;
  store.setProfile(null, false);
  void ensureSignedIn().then(enterConsole);
});

void boot();
