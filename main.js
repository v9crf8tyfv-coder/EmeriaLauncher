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
  getComAllowed,
  getBuildAllowed,
  getManifestDisplayLists,
  getOptionalList,
  installConfigs,
  ensureResourcePackEnabled,
  enforceEmeriaPackOrder,
  setShaderEnabled,
  setOptionalInstalled,
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

// Comptes autorisés à la catégorie Com du launcher. Xtazzking + Orionyx84 par défaut (hardcodés),
// + les ajouts du panel (manifeste comAllowed). Insensible à la casse.
const COM_DEFAULT = ['xtazzking', 'orionyx84'];
let COM_ALLOWED = [...COM_DEFAULT];
async function refreshComAllowed() {
  try {
    const list = await getComAllowed();
    if (list) COM_ALLOWED = [...new Set([...COM_DEFAULT, ...list])];
  } catch { /* garde les défauts */ }
}
function canUseCom() {
  return !!(mcToken && COM_ALLOWED.includes(String(mcToken.name).toLowerCase()));
}

// Comptes autorisés aux mods Build du launcher (ajouts du panel, manifeste buildAllowed).
let BUILD_ALLOWED = [];
async function refreshBuildAllowed() {
  try {
    const list = await getBuildAllowed();
    if (list) BUILD_ALLOWED = list;
  } catch { /* garde la liste courante */ }
}
function canUseBuild() {
  return !!(mcToken && BUILD_ALLOWED.includes(String(mcToken.name).toLowerCase()));
}

// Liste des mods optionnels togglables (depuis le manifeste) : [{ id, name, category }].
let optionalList = [];
async function refreshOptionalList() {
  try {
    const list = await getOptionalList();
    if (list) optionalList = list;
  } catch { /* garde la liste courante */ }
}

// Activation par mod optionnel (case à cocher du launcher), persistée. Défaut : activé.
function optEnabled(id) {
  const map = store.get('optEnabled', {});
  return map[id] !== false;
}
function setOptEnabled(id, v) {
  const map = store.get('optEnabled', {});
  map[id] = !!v;
  store.set('optEnabled', map);
}
// Un mod optionnel doit-il être installé pour ce compte ? (catégorie autorisée ET activé)
// L'Axiom legacy (category absente/'axiom') est traité comme un mod Build.
function wantOptional(o) {
  const cat = (o && o.category) || 'build';
  if (cat === 'com') return canUseCom() && optEnabled(o.id);
  return canUseBuild() && optEnabled(o.id); // build + axiom/legacy
}
// Mods optionnels visibles pour ce compte (pour l'UI), avec leur état activé.
// Axiom/legacy est normalisé en 'build' pour s'afficher dans l'onglet Build.
function visibleOptional() {
  return optionalList
    .filter((o) => (o.category === 'com' ? canUseCom() : canUseBuild()))
    .map((o) => ({ id: o.id, name: o.name, category: o.category === 'com' ? 'com' : 'build', enabled: optEnabled(o.id) }));
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
    minWidth: 820,
    minHeight: 520,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
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
  void refreshComAllowed();   // met à jour la liste Com depuis le manifeste (panel)
  void refreshBuildAllowed(); // met à jour la liste Build depuis le manifeste (panel)
  void refreshOptionalList(); // met à jour la liste des mods optionnels togglables (panel)
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
// Compare deux versions "x.y.z" -> true si b est plus récente que a.
function isNewer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (y > x) return true;
    if (y < x) return false;
  }
  return false;
}

// macOS non signé : electron-updater ne peut PAS vérifier la signature de code -> il échoue
// en silence et ne détecte jamais les maj. On vérifie donc nous-mêmes via l'API GitHub.
async function checkMacUpdate() {
  try {
    const res = await fetch(
      'https://api.github.com/repos/v9crf8tyfv-coder/EmeriaLauncher/releases/latest',
      { headers: { Accept: 'application/vnd.github+json' } },
    );
    if (!res.ok) { logger.log('mac update check http', res.status); return; }
    const data = await res.json();
    const latest = String(data.tag_name || '').replace(/^v/, '');
    const current = app.getVersion();
    logger.log('mac update check', 'current', current, 'latest', latest);
    if (latest && isNewer(current, latest)) {
      // On affiche le bouton "Mettre à jour" ET on bloque LANCER (on ne joue pas sur une
      // version périmée). Le clic lance macInPlaceUpdate : télécharge + remplace + relance,
      // le joueur n'a rien d'autre à faire (aucune réinstallation).
      send('updateInfo', `Nouvelle version dispo (v${latest}) — clique sur Mettre à jour`);
      send('updateButton', true);
    }
  } catch (e) {
    logger.log('mac update check error', e?.message);
  }
}

function setupAutoUpdate() {
  const isMac = process.platform === 'darwin';
  if (isMac) {
    // Mac : on NE bloque PAS LANCER. Vérification manuelle -> bouton "Mettre à jour".
    checkMacUpdate();
    setInterval(checkMacUpdate, 10 * 60 * 1000);
    return;
  }
  // Windows/Linux : electron-updater fonctionne -> maj auto téléchargée + installée.
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-available', () => {
    // La maj se télécharge et s'installe -> on bloque LANCER le temps du dl.
    send('update', 'Mise à jour disponible, téléchargement…');
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
  // Revérifie toutes les 10 min : si une maj sort pendant que le launcher est déjà ouvert.
  setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 10 * 60 * 1000);
}

// Mise à jour EN PLACE sur macOS (app NON signée, donc electron-updater ne marche pas) :
// on télécharge le .zip (= EmeriaMC.app), on remplace le bundle existant et on relance.
// Plus AUCUNE réinstallation manuelle. On strip le quarantine pour que Gatekeeper n'empêche
// pas l'app non signée de redémarrer. Lance une erreur si impossible (-> repli .dmg).
async function macInPlaceUpdate() {
  const cp = require('child_process');
  send('update', 'Mise à jour… téléchargement');
  const api = await fetch(
    'https://api.github.com/repos/v9crf8tyfv-coder/EmeriaLauncher/releases/latest',
    { headers: { Accept: 'application/vnd.github+json' } },
  );
  if (!api.ok) throw new Error('release api ' + api.status);
  const rel = await api.json();
  const asset = (rel.assets || []).find((a) => a.name === 'EmeriaMC-mac.zip');
  if (!asset) throw new Error('zip mac introuvable dans la release');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emeria-upd-'));
  const zipPath = path.join(tmp, 'EmeriaMC-mac.zip');
  const res = await fetch(asset.browser_download_url);
  if (!res.ok) throw new Error('download ' + res.status);
  const total = Number(res.headers.get('content-length')) || 0;
  const chunks = [];
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    got += value.length;
    if (total) send('update', `Mise à jour… ${Math.round((got / total) * 100)}%`);
  }
  fs.writeFileSync(zipPath, Buffer.concat(chunks));

  send('update', 'Mise à jour… installation');
  cp.execFileSync('ditto', ['-x', '-k', zipPath, tmp]); // ditto préserve le bundle .app
  const newApp = path.join(tmp, 'EmeriaMC.app');
  if (!fs.existsSync(newApp)) throw new Error('.app absente après extraction');

  // Chemin de l'app en cours : /Applications/EmeriaMC.app
  const appPath = app.getPath('exe').replace(/\/Contents\/MacOS\/[^/]+$/, '');
  if (!appPath.endsWith('.app')) throw new Error('chemin app inattendu: ' + appPath);
  // Vérifie qu'on peut écrire à cet emplacement (sinon -> repli .dmg).
  fs.accessSync(path.dirname(appPath), fs.constants.W_OK);

  // Script détaché : attend la fermeture, remplace le bundle, strip quarantine, relance.
  const sh = path.join(tmp, 'swap.sh');
  fs.writeFileSync(
    sh,
    `#!/bin/bash
sleep 1
for i in $(seq 1 60); do pgrep -f "${appPath}/Contents/MacOS/" >/dev/null || break; sleep 0.5; done
rm -rf "${appPath}"
mv "${newApp}" "${appPath}"
xattr -cr "${appPath}" 2>/dev/null || true
open "${appPath}"
`,
    { mode: 0o755 },
  );
  const child = cp.spawn('/bin/bash', [sh], { detached: true, stdio: 'ignore' });
  child.unref();
  send('update', 'Mise à jour prête — redémarrage…');
  setTimeout(() => app.quit(), 1200);
}

// ---- Tête Minecraft (data URL, pour respecter le CSP) ----
async function fetchHead(uuid) {
  // crafthead = fiable (vrai skin) ; repli mc-heads / minotar si indispo.
  const sources = [
    `https://crafthead.net/avatar/${uuid}/64`,
    `https://mc-heads.net/avatar/${uuid}/64.png`,
    `https://minotar.net/avatar/${uuid}/64.png`,
  ];
  for (const url of sources) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) continue; // réponse vide/placeholder -> source suivante
      return `data:image/png;base64,${buf.toString('base64')}`;
    } catch { /* source suivante */ }
  }
  return null;
}

// ---- Connexion Microsoft ----
ipcMain.handle('login', async () => {
  try {
    const xbox = await authManager.launch('electron');
    store.set('session', xbox.save()); // pour rester connecté
    const mc = await xbox.getMinecraft();
    mcToken = mc.mclc();
    logger.log('login ok', mcToken.name);
    return { name: mcToken.name, head: await fetchHead(mcToken.uuid) };
  } catch (e) {
    // msmc renvoie souvent un objet (pas une Error) -> l'IPC afficherait « [object Object] ».
    // On journalise le détail et on renvoie un message propre et réessayable.
    try { logger.log('login failed', typeof e === 'object' ? JSON.stringify(e) : String(e)); } catch { logger.log('login failed'); }
    const raw = e && (e.message || e.reason || e.error || e.description);
    const txt = typeof raw === 'string' && raw.trim() ? raw : 'Connexion Microsoft échouée. Réessaie.';
    throw new Error(txt);
  }
});

// Reconnexion silencieuse au démarrage (plus besoin de se reco à chaque fois).
// IMPORTANT : on N'EFFACE PLUS la session en cas d'échec. Le refresh-token Microsoft est à usage
// unique ; si on ouvre/ferme vite le launcher, deux reconnexions se chevauchent et l'une échoue
// (l'autre a déjà consommé/rotaté le token). Effacer ici déconnectait le joueur à tort. On garde
// donc la session (celle rafraîchie par l'autre lancement reste valide) et on réessaiera.
async function trySilentLogin() {
  const token = store.get('session');
  if (!token) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const xbox = await authManager.refresh(token);
      store.set('session', xbox.save());
      const mc = await xbox.getMinecraft();
      mcToken = mc.mclc();
      logger.log('silent login ok', mcToken.name);
      send('session', { name: mcToken.name, head: await fetchHead(mcToken.uuid) });
      return;
    } catch (e) {
      logger.log('silent login failed (try ' + (attempt + 1) + ')', e?.message || e);
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1500)); // 2e essai après un court délai
    }
  }
  // Échec après 2 essais : on NE touche PAS à la session (évite le logout forcé sur erreur transitoire).
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
    canUseCom: canUseCom(),                   // catégorie Com visible seulement pour les autorisés
    comEnabled: store.get('comEnabled', true),
    canUseBuild: canUseBuild(),               // onglet Build visible seulement pour le staff build autorisé
    optionalMods: visibleOptional(),          // mods togglables (Build/Com) visibles pour ce compte
    ip: SERVER_IP,
  };
});
ipcMain.handle('setShader', (_e, v) => store.set('shaderEnabled', !!v));
ipcMain.handle('setAxiom', (_e, v) => store.set('axiomEnabled', !!v));
ipcMain.handle('setCom', (_e, v) => store.set('comEnabled', !!v));
// Active/désactive un mod optionnel (Build/Com) par son id (case à cocher du launcher).
ipcMain.handle('setOptional', (_e, id, v) => { if (id) setOptEnabled(String(id), !!v); });
// Bouton "Mettre à jour" (Mac non signé) : télécharge le bon installeur
ipcMain.handle('downloadUpdate', async () => {
  if (process.platform === 'darwin') {
    // On tente la MAJ en place (télécharge + remplace + relance, rien à réinstaller).
    try {
      await macInPlaceUpdate();
      return;
    } catch (e) {
      logger.log('mac in-place update failed -> dmg', e?.message);
      // Repli seulement si l'auto échoue : on ouvre le .dmg puis on ferme.
      shell.openExternal('https://github.com/v9crf8tyfv-coder/EmeriaLauncher/releases/latest/download/EmeriaMC-mac.dmg');
      send('status', 'Mise à jour auto impossible — téléchargement ouvert.');
      setTimeout(() => app.quit(), 4000);
      return;
    }
  }
  // Windows/Linux : electron-updater gère tout seul, mais au cas où -> on ouvre l'installeur.
  shell.openExternal('https://github.com/v9crf8tyfv-coder/EmeriaLauncher/releases/latest/download/EmeriaMC-windows.exe');
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
      // On ouvre les logs DU JEU (latest.log + crash-reports) qui contiennent l'info utile,
      // sinon le dossier .emeria, sinon le log du launcher. (Avant : dossier launcher ~vide.)
      const gameLatest = path.join(MC_ROOT, 'logs', 'latest.log');
      const gameLogs = path.join(MC_ROOT, 'logs');
      if (fs.existsSync(gameLatest)) shell.showItemInFolder(gameLatest);
      else if (fs.existsSync(gameLogs)) shell.openPath(gameLogs);
      else if (fs.existsSync(MC_ROOT)) shell.openPath(MC_ROOT);
      else shell.showItemInFolder(logger.file);
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
  // Ordre imposé : EmeriaItems au-dessus (sinon la Pancarte écrase ses items -> papier nu).
  enforceEmeriaPackOrder(MC_ROOT);
  // Mods optionnels togglables (Axiom legacy + Build + Com) : installés seulement si la
  // catégorie est autorisée pour ce compte ET que le joueur les a activés (case cochée).
  await refreshOptionalList(); // s'assure que l'UI reflète le manifeste au prochain getState
  await setOptionalInstalled(MC_ROOT, wantOptional, (label) =>
    send('status', 'Téléchargement du mod : ' + label),
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
    // Catégorie Com : active la caméra (/cam) côté mod via une propriété JVM, seulement si
    // le compte est autorisé Com ET que le toggle est activé.
    customArgs: (canUseCom() && store.get('comEnabled', true)) ? ['-Demeriacore.cam=true'] : [],
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
