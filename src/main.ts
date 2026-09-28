import './styles.css';
import { app } from './core/app';
import { store } from './core/store';
import type { DeviceId, GameMeta } from './core/types';
import type { SessionPlayers } from './emu/player';
import { BootScreen } from './screens/boot';
import { LibraryScreen, type LaunchIntent } from './screens/library';
import { LobbyScreen } from './screens/lobby';
import { PlayScreen } from './screens/play';
import { ProfilesScreen } from './screens/profiles';

const root = document.getElementById('app')!;
app.init(root);

function showLibrary() {
  void app.go(new LibraryScreen(onLaunch, showProfiles));
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

function showLobby(game: GameMeta, first: DeviceId, resumeSlot: string | null) {
  void app.go(
    new LobbyScreen(
      game,
      first,
      (players) => startGame(game, players, resumeSlot),
      () => showLibrary(),
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
      () => showLobby(game, players[0] ?? 'kb', 'suspend'),
      () => startGame(game, players, 'suspend'),
    ),
  );
}

async function boot() {
  try {
    await store.loadCatalog();
  } catch (e) {
    console.error(e);
  }
  const restored = await store.restoreProfile();
  const afterBoot = () => (restored ? showLibrary() : showProfiles());
  if (store.bootedThisSession) afterBoot();
  else {
    store.bootedThisSession = true;
    await app.go(new BootScreen(afterBoot), { transition: 'none' });
  }
}

void boot();
