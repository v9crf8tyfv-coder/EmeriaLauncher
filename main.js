const { app, BrowserWindow, ipcMain, clipboard, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// RAM totale détectée, arrondie au Go supérieur (évite qu'un PC 16 Go lu 15.7 tombe à 15).
function detectedRamGB() {
  return Math.ceil(os.totalmem() / 1024 ** 3);
}
// RAM max qu'on autorise à allouer au jeu = RAM totale du PC - 2 Go (marge OS), borné [2, 16]
function maxRamGB() {
  return Math.max(2, Math.min(16, detectedRamGB() - 2));
}
// RAM conseillée automatiquement selon le PC (table EmeriaMC). Les seuils sont
// LÉGÈREMENT sous les paliers nominaux car un PC sous-détecte souvent sa RAM
// (un 16 Go peut être lu 15). Bornée par le max autorisé.
function recommendedRamGB() {
  const t = detectedRamGB();
  let ideal;
  if (t >= 60) ideal = 16;      // 64 Go -> 12+ (on donne 16)
  else if (t >= 30) ideal = 12; // 32 Go -> 12
  else if (t >= 22) ideal = 8;  // 24 Go -> 8
  else if (t >= 15) ideal = 6;  // 16 Go -> 6
  else if (t >= 11) ideal = 4;  // 12 Go -> 4
  else if (t >= 7) ideal = 3;   // 8 Go  -> 3
  else ideal = 2;               // < 8 Go
  return Math.min(maxRamGB(), ideal);
}
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const { autoUpdater } = require('electron-updater');
const { installFabric } = require('./src/fabric');
const {
  syncModsFromManifest,
  syncResourcepacksFromManifest,
  getAxiomAllowed,
  getManifestDisplayLists,
  installConfigs,
  ensureResourcePackEnabled,
  setShaderEnabled,
  setAxiomInstalled,
} = require('./src/install');
const { ensureJava } = require('./src/java');
const store = require('./src/store');
const logger = require('./src/logger');
const content = require('./src/content');
const discordRpc = require('./src/discordRpc');
const DISCORD_APP_ID = '1547631011469463603';

// ---- Config EmeriaMC ----
const MC_VERSION = '1.21.1';
const MC_ROOT = path.join(app.getPath('appData'), '.emeria');
const SERVER = { host: 'emeriamc.mine.gg', port: 10006 };
const SERVER_IP = `${SERVER.host}:${SERVER.port}`;
// Webhook Discord pour « Envoyer les logs » (à remplir plus tard). Vide = ouvre le dossier.
const LOG_WEBHOOK = '';

let mainWindow;
let tray = null; // icône barre système (Windows)
let gameRunning = false; // une seule partie à la fois (empêche 2 comptes lancés en même temps)
let mcToken = null; // token pour minecraft-launcher-core
const authManager = new Auth('select_account');

// Comptes autorisés à voir/activer Axiom (staff build). Insensible à la casse.
// Liste par défaut (repli). Mise à jour depuis le manifeste (éditable via le panel).
let AXIOM_ALLOWED = ['ixtazzking', 'xtazzking', 'orionyx84'];
async function refreshAxiomAllowed() {
  try {
    const list = await getAxiomAllowed();
    if (list && list.length) AXIOM_ALLOWED = list;
  } catch { /* garde la liste par défaut */ }
}
function canUseAxiom() {
  return !!(mcToken && AXIOM_ALLOWED.includes(String(mcToken.name).toLowerCase()));
}

// Liste des mods affichée dans le launcher. Par défaut = liste embarquée (content.js),
// remplacée au démarrage par le manifeste en ligne (noms propres) -> reflète le panel.
let displayMods = content.mods;
async function refreshDisplayMods() {
  try {
    const lists = await getManifestDisplayLists();
    if (lists && lists.mods && lists.mods.length) displayMods = lists.mods;
  } catch { /* garde la liste embarquée */ }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 560,
    resizable: false,
    title: 'EmeriaMC',
    backgroundColor: '#0b0b10',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// Icône dans la barre système Windows (à côté de l'horloge). Clic = afficher le launcher.
function createTray() {
  if (process.platform !== 'win32' || tray) return;
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
    tray = new Tray(img.isEmpty() ? path.join(__dirname, 'build', 'icon.png') : img);
    tray.setToolTip('EmeriaMC');
    const showWindow = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return createWindow();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    };
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Ouvrir EmeriaMC', click: showWindow },
        { type: 'separator' },
        { label: 'Quitter', click: () => app.quit() },
      ]),
    );
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
  } catch (e) {
    logger.log('tray init failed', String(e));
  }
}

app.whenReady().then(() => {
  logger.init();
  logger.log('launcher start', app.getVersion());
  createWindow();
  createTray(); // barre système Windows
  discordRpc.start(DISCORD_APP_ID); // « Joue à EmeriaMC » sur Discord (Rich Presence)
  if (app.isPackaged) setupAutoUpdate(); // auto-update seulement en version installée
  void refreshAxiomAllowed(); // met à jour la liste Axiom depuis le manifeste (panel)
  void refreshDisplayMods();  // met à jour la liste des mods affichée depuis le manifeste (panel)
  mainWindow.webContents.once('did-finish-load', trySilentLogin);
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

// ---- Auto-update ----
const RELEASES_URL = 'https://github.com/v9crf8tyfv-coder/EmeriaLauncher/releases/latest';
function setupAutoUpdate() {
  const isMac = process.platform === 'darwin';
  // macOS non signé : l'auto-install ne marche pas -> on renvoie vers le téléchargement.
  autoUpdater.autoDownload = !isMac;
  autoUpdater.on('update-available', () => {
    if (isMac) {
      // Mac non signé : on NE bloque PAS LANCER. On affiche un bouton "Mettre à jour"
      // qui télécharge le bon launcher automatiquement (plus besoin du Drive/GitHub).
      send('updateInfo', 'Nouvelle version dispo');
      send('updateButton', true);
    } else {
      // Windows/Linux : la maj se télécharge et s'installe -> on bloque LANCER le temps du dl.
      send('update', 'Mise à jour disponible, téléchargement…');
    }
  });
  autoUpdater.on('download-progress', (p) =>
    send('update', `Mise à jour du launcher… ${Math.round(p.percent)}%`),
  );
  autoUpdater.on('update-downloaded', () => {
    send('update', 'Mise à jour prête — redémarrage…');
    setTimeout(() => autoUpdater.quitAndInstall(), 2500);
  });
  autoUpdater.on('error', (e) => logger.log('updater error', e?.message));
  autoUpdater.checkForUpdates().catch(() => {});
  // Revérifie toutes les 10 min : si une maj sort pendant que le launcher est déjà ouvert,
  // le bouton "Mettre à jour" apparaît tout seul (plus besoin de fermer/rouvrir).
  setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 10 * 60 * 1000);
}

// ---- Tête Minecraft (data URL, pour respecter le CSP) ----
async function fetchHead(uuid) {
  try {
    const res = await fetch(`https://mc-heads.net/avatar/${uuid}/64.png`);
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

// ---- Connexion Microsoft ----
ipcMain.handle('login', async () => {
  const xbox = await authManager.launch('electron');
  store.set('session', xbox.save()); // pour rester connecté
  const mc = await xbox.getMinecraft();
  mcToken = mc.mclc();
  logger.log('login ok', mcToken.name);
  return { name: mcToken.name, head: await fetchHead(mcToken.uuid) };
});

// Reconnexion silencieuse au démarrage (plus besoin de se reco à chaque fois)
async function trySilentLogin() {
  const token = store.get('session');
  if (!token) return;
  try {
    const xbox = await authManager.refresh(token);
    store.set('session', xbox.save());
    const mc = await xbox.getMinecraft();
    mcToken = mc.mclc();
    logger.log('silent login ok', mcToken.name);
    send('session', { name: mcToken.name, head: await fetchHead(mcToken.uuid) });
  } catch (e) {
    logger.log('silent login failed', e?.message || e);
    store.set('session', null);
  }
}

ipcMain.handle('logout', () => {
  // On NE laisse PAS se déconnecter/changer de compte pendant qu'une partie tourne
  // (sinon on pourrait relancer avec un 2e compte). Il faut fermer le jeu d'abord.
  if (gameRunning) throw new Error('Ferme d’abord ton jeu avant de te déconnecter.');
  mcToken = null;
  store.set('session', null);
  logger.log('logout');
});

// ---- Réglages ----
ipcMain.handle('getSettings', () => {
  const max = maxRamGB();
  const auto = store.get('ramAuto', true);
  return {
    ram: auto ? recommendedRamGB() : Math.min(store.get('ram', 4), max),
    maxRam: max,
    ramAuto: auto,
    autoRam: recommendedRamGB(),
    mods: displayMods,
    shaders: content.shaders,
    shaderEnabled: store.get('shaderEnabled', true),
    canUseAxiom: canUseAxiom(),               // toggle Axiom visible seulement pour le staff build
    axiomEnabled: store.get('axiomEnabled', true),
    ip: SERVER_IP,
  };
});
ipcMain.handle('setShader', (_e, v) => store.set('shaderEnabled', !!v));
ipcMain.handle('setAxiom', (_e, v) => store.set('axiomEnabled', !!v));
// Bouton "Mettre à jour" (Mac non signé) : télécharge le bon installeur
ipcMain.handle('downloadUpdate', () => {
  const asset = process.platform === 'darwin' ? 'EmeriaMC-mac.dmg' : 'EmeriaMC-windows.exe';
  shell.openExternal(`https://github.com/v9crf8tyfv-coder/EmeriaLauncher/releases/latest/download/${asset}`);
  // Mac (non signé) : le .dmg ne s'auto-installe pas. On ouvre le téléchargement puis on FERME
  // le launcher tout seul quelques secondes après -> le joueur installe la nouvelle version
  // sans avoir l'ancien launcher qui traîne. (Windows/Linux : maj auto, ne passe pas ici.)
  if (process.platform === 'darwin') {
    send('status', 'Téléchargement ouvert — fermeture du launcher…');
    setTimeout(() => app.quit(), 4000);
  }
});
ipcMain.handle('setRam', (_e, v) => {
  const n = Math.max(2, Math.min(maxRamGB(), Number(v) || 4));
  store.set('ram', n);
  store.set('ramAuto', false); // régler manuellement -> on quitte le mode auto
  return n;
});
ipcMain.handle('setRamAuto', (_e, v) => {
  store.set('ramAuto', !!v);
  return recommendedRamGB();
});
ipcMain.handle('copyIp', () => clipboard.writeText(SERVER_IP));
ipcMain.handle('getVersion', () => app.getVersion());

// ---- Logs ----
ipcMain.handle('sendLogs', async () => {
  try {
    if (!LOG_WEBHOOK) {
      shell.showItemInFolder(logger.file);
      return 'reveal';
    }
    const data = fs.readFileSync(logger.file);
    const form = new FormData();
    form.append('content', `Logs de **${mcToken?.name || 'inconnu'}**`);
    form.append('file', new Blob([data]), 'latest.log');
    await fetch(LOG_WEBHOOK, { method: 'POST', body: form });
    return 'sent';
  } catch (e) {
    logger.log('sendLogs error', e?.message || e);
    shell.showItemInFolder(logger.file);
    return 'reveal';
  }
});

// ---- Lancer le jeu (connexion directe au serveur) ----
ipcMain.handle('launch', async () => {
  if (!mcToken) throw new Error('Non connecté');
  if (gameRunning) throw new Error('Une partie est déjà lancée (un seul jeu à la fois).');
  gameRunning = true; // verrou : réinitialisé à la fermeture du jeu (ou en cas d'erreur)
  try {
  const ram = store.get('ramAuto', true)
    ? recommendedRamGB()
    : Math.min(store.get('ram', 4), maxRamGB());
  logger.log('launch start ram=' + ram + (store.get('ramAuto', true) ? ' (auto)' : ''));

  send('status', 'Vérification de Java…');
  const javaPath = await ensureJava((m) => {
    logger.log(m);
    send('status', m);
  });
  logger.log('java=' + javaPath);

  send('status', 'Installation de Fabric…');
  const versionId = await installFabric(MC_ROOT, MC_VERSION);

  send('status', 'Vérification des mods…');
  const bundled = path.join(__dirname, 'content');
  // Mods téléchargés depuis le manifeste : seuls les mods modifiés sont récupérés.
  await syncModsFromManifest(MC_ROOT, (name) => send('status', 'Téléchargement du mod : ' + name));
  installConfigs(bundled, MC_ROOT);
  await syncResourcepacksFromManifest(MC_ROOT, (name) => send('status', 'Téléchargement du pack : ' + name));
  // Badges de grade : forcé actif à chaque lancement (réactivé si le joueur l'a retiré).
  ensureResourcePackEnabled(MC_ROOT, 'EmeriaBadges.zip');
  // Pancarte Emeria : modèle 3D de l'item (custom_model_data) — forcé actif à chaque lancement.
  ensureResourcePackEnabled(MC_ROOT, 'EmeriaPancarte.zip');
  // Axiom : installé seulement si compte autorisé ET activé dans les réglages
  await setAxiomInstalled(MC_ROOT, canUseAxiom() && store.get('axiomEnabled', true), () =>
    send('status', 'Téléchargement d\'Axiom…'),
  );
  setShaderEnabled(MC_ROOT, store.get('shaderEnabled', true)); // toggle shaders
  logger.log('mods synced');

  send('status', 'Téléchargement du jeu…');
  const launcher = new Client();
  launcher.on('debug', (m) => logger.log('mclc', String(m)));
  launcher.on('data', (m) => logger.log('mclc', String(m)));
  launcher.on('progress', (p) => send('progress', p));
  launcher.on('close', (code) => {
    logger.log('game closed code=' + code);
    gameRunning = false; // partie terminée -> on peut relancer
    // Jeu fermé -> on remet le launcher au premier plan
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    send('closed', code);
    discordRpc.onLauncher(); // retour « sur le launcher »
  });

  await launcher.launch({
    authorization: mcToken,
    root: MC_ROOT,
    version: { number: MC_VERSION, type: 'release', custom: versionId },
    memory: { max: `${ram}G`, min: '2G' },
    javaPath, // Java du launcher (ignore celui du système -> aucun conflit)
    quickPlay: { type: 'multiplayer', identifier: SERVER_IP }, // connexion directe
  });
  logger.log('launch spawned');
  discordRpc.onInGame(); // « En jeu » sur Discord
  send('status', 'Jeu en cours 🎮');
  // Corrige le bug « curseur bloqué dans le launcher » : on rend la main au jeu.
  // Petit délai le temps que la fenêtre Minecraft apparaisse, puis on minimise le launcher.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  }, 3000);
  return true;
  } catch (e) {
    gameRunning = false; // échec du lancement -> on libère le verrou pour pouvoir réessayer
    throw e;
  }
});
