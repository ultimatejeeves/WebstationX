const { app, BrowserWindow, Menu, dialog, shell, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let window;
const home = process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged ? path.dirname(app.getPath('exe')) : path.resolve(__dirname, '..', 'work', 'desktop'));
const games = path.join(home, 'Games');
const storage = path.join(games, '.webstationx');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  try {
    for (const dir of ['psx', 'ps2', 'bios', '.webstationx']) fs.mkdirSync(path.join(games, dir), { recursive: true });
    fs.accessSync(storage, fs.constants.W_OK);
    app.setPath('userData', path.join(storage, 'browser'));
    app.setPath('sessionData', path.join(storage, 'browser'));
  } catch {
    dialog.showErrorBox('Move WebStationX to a writable folder', 'Put WebStationX.exe in a folder you own, such as Desktop or Documents, then open it again. The app keeps your games and saves beside the executable.');
    app.exit(1);
  }
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('WebStationX could not start', `${error.message}\n\nTry moving the executable to a writable folder and opening it again.`);
    app.exit(1);
  });
}

async function start() {
  const content = app.isPackaged ? path.join(process.resourcesPath, 'app-content') : path.resolve(__dirname, '..');
  const portFile = path.join(storage, 'port.txt');
  const savedPort = fs.existsSync(portFile) ? Number(fs.readFileSync(portFile, 'utf8')) : 0;
  Object.assign(process.env, {
    WSX_BIND: '127.0.0.1', WSX_PORT: String(Number.isInteger(savedPort) && savedPort >= 1024 && savedPort <= 65535 ? savedPort : 0), WSX_TRUST_PROXY: '0',
    WSX_DATA_DIR: path.join(storage, 'data'), WSX_LIBRARY_DIR: path.join(storage, 'library'),
    WSX_GAMES_DIR: games, WSX_BIOS_DIR: path.join(games, 'bios'), WSX_DIST_DIR: path.join(content, 'dist'),
    WSX_ICE_SERVERS: '[]',
  });
  const moduleUrl = pathToFileURL(path.join(app.getAppPath(), 'dist', 'server.js')).href;
  let url;
  try { url = await (await import(moduleUrl)).ready; }
  catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    process.env.WSX_PORT = '0';
    url = await (await import(`${moduleUrl}?fallback=1`)).ready;
  }
  fs.writeFileSync(portFile, new URL(url).port);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'fullscreen'));
  window = new BrowserWindow({
    width: 1280, height: 800, minWidth: 800, minHeight: 540, title: 'WebStationX',
    backgroundColor: '#080d1a', show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== url) event.preventDefault(); });
  window.once('ready-to-show', () => window.show());
  window.webContents.on('render-process-gone', () => {
    dialog.showErrorBox('The game window stopped responding', 'Close WebStationX and open it again. Your saved memory cards are kept in Games/.webstationx/data.');
    app.quit();
  });
  const openFolder = dir => () => shell.openPath(path.join(games, dir));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Games', submenu: [
      { label: 'Open PS1 folder', click: openFolder('psx') },
      { label: 'Open PS2 folder', click: openFolder('ps2') },
      { label: 'Add PS1 BIOS…', click: async () => {
        const result = await dialog.showOpenDialog(window, { title: 'Select your PS1 BIOS dump', properties: ['openFile'], filters: [{ name: 'PS1 BIOS', extensions: ['bin'] }] });
        if (result.canceled) return;
        try {
          const source = result.filePaths[0];
          if (fs.statSync(source).size !== 512 * 1024) throw new Error('A PS1 BIOS dump should be 512 KB. Choose an uncompressed BIOS file.');
          fs.copyFileSync(source, path.join(games, 'bios', 'SCPH1001.BIN'));
          await dialog.showMessageBox(window, { message: 'PS1 BIOS added', detail: 'Your library will detect it automatically.', type: 'info' });
        } catch (error) { dialog.showErrorBox('Could not add BIOS', error.message); }
      } },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    { label: 'Help', submenu: [
      { label: 'Getting started', click: () => dialog.showMessageBox(window, { type: 'info', message: 'Add games. Pick a profile. Play.', detail: 'Use the Games menu to open a folder, then copy your disc images into it.\n\nPS1: CHD, ISO, PBP, or CUE with its BIN tracks in the same folder.\nPS2: CHD or ISO. Extract ZIP/7z archives first.\n\nGames appear within a few seconds. PS1 works best with your own BIOS dump (Games → Add PS1 BIOS). PS2 does not need a BIOS.\n\nPress a controller button to connect it, or use the keyboard. Esc opens the game menu. Save or return to the library before closing the app.\n\nKeep the Games folder with the executable when moving the app. It contains your saves too. PS2 compatibility and speed vary by game and computer.' }) },
      { label: 'Open saves folder', click: () => shell.openPath(path.join(storage, 'data')) },
      { label: 'Licenses and credits', click: () => shell.openPath(path.join(content, 'THIRD_PARTY_NOTICES.md')) },
      { label: 'About WebStationX', click: () => dialog.showMessageBox(window, { message: `WebStationX ${app.getVersion()}`, detail: 'A browser-based PlayStation frontend, packaged for local play.\nPS1: PCSX-ReARMed / RetroArch\nPS2: Play! with WebStationX patches\n\nNot affiliated with Sony Interactive Entertainment.' }) },
    ] },
  ]));
  await window.loadURL(url);
}
app.on('window-all-closed', () => app.quit());
