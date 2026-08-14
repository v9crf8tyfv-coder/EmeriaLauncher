const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const { installFabric } = require('./src/fabric');

// ---- Config EmeriaMC ----
const MC_VERSION = '1.21.1';
const MC_ROOT = path.join(app.getPath('appData'), '.emeria');
// Serveur : à remplir avec l'IP OMGserv plus tard, ex { host: 'mc.emeria.fr', port: 25565 }
const SERVER = null;

let mainWindow;
let mcToken = null; // token msmc formaté pour minecraft-launcher-core

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 560,
    resizable: false,
    title: 'EmeriaMC',
    backgroundColor: '#000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

// ---- Connexion Microsoft (compte possédant Minecraft) ----
ipcMain.handle('login', async () => {
  const authManager = new Auth('select_account');
  const xbox = await authManager.launch('electron'); // ouvre la fenêtre de login Microsoft
  const mc = await xbox.getMinecraft();
  mcToken = mc.mclc(); // format attendu par minecraft-launcher-core
  return { name: mcToken.name };
});

// ---- Lancer le jeu (Fabric 1.21.1) ----
ipcMain.handle('launch', async (_evt, { ram } = {}) => {
  if (!mcToken) throw new Error('Non connecté');

  send('status', 'Installation de Fabric…');
  const versionId = await installFabric(MC_ROOT, MC_VERSION);

  send('status', 'Téléchargement du jeu…');
  const launcher = new Client();
  launcher.on('debug', (m) => send('log', String(m)));
  launcher.on('data', (m) => send('log', String(m)));
  launcher.on('progress', (p) => send('progress', p));
  launcher.on('close', (code) => send('closed', code)); // le jeu s'est fermé

  const opts = {
    authorization: mcToken,
    root: MC_ROOT,
    version: { number: MC_VERSION, type: 'release', custom: versionId },
    memory: { max: `${ram || 4}G`, min: '2G' },
  };
  if (SERVER) {
    opts.quickPlay = { type: 'multiplayer', identifier: `${SERVER.host}:${SERVER.port}` };
  }

  await launcher.launch(opts);
  send('status', 'Jeu lancé ! 🎮');
  return true;
});
