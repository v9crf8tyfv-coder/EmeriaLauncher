const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Manifeste des mods hébergé à part (GitHub Release) : liste + empreinte de chaque mod.
// Permet de télécharger UNIQUEMENT les mods modifiés au lancement (au lieu de tout embarquer
// dans le launcher). Mettre à jour un mod = mettre à jour ce manifeste, sans rebuild du launcher.
const MANIFEST_URL =
  'https://github.com/v9crf8tyfv-coder/EmeriaLauncher/releases/download/mods/manifest.json';

function sha256File(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

// Cache court en mémoire : le manifeste était re-téléchargé 5-8 fois PAR lancement (chaque sync
// le refetchait) -> autant d'allers-retours réseau inutiles. On le récupère UNE fois et on le
// réutilise pendant 20 s. Un nouveau lancement = nouveau process = cache vide -> toujours frais.
let _manifestCache = null;
let _manifestAt = 0;
async function fetchManifest() {
  const now = Date.now();
  if (_manifestCache && now - _manifestAt < 20000) return _manifestCache;
  const res = await fetch(MANIFEST_URL + '?t=' + now);
  if (!res.ok) throw new Error('manifest HTTP ' + res.status);
  const j = await res.json();
  _manifestCache = j;
  _manifestAt = now;
  return j;
}

// Exécute `fn` sur chaque élément avec au plus `limit` en parallèle (téléchargements simultanés).
async function parallelLimit(items, limit, fn) {
  const queue = [...items];
  const n = Math.min(Math.max(1, limit), queue.length || 1);
  const workers = Array.from({ length: n }, async () => {
    for (;;) {
      const it = queue.shift();
      if (it === undefined) return;
      await fn(it);
    }
  });
  await Promise.all(workers);
}

/**
 * Télécharge url -> dest de façon ROBUSTE : timeout d'INACTIVITÉ (abandonne si aucune donnée
 * reçue pendant idleMs, pour ne JAMAIS pendre à l'infini sur un CDN qui stalle) + retries.
 * On lit le corps par morceaux et on réarme le timeout à chaque morceau : un download lent mais
 * qui progresse n'est pas coupé, seul un vrai blocage l'est. Écrit le fichier seulement si complet.
 */
async function downloadTo(url, dest, { idleMs = 30000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    let timer = setTimeout(() => ctrl.abort(), idleMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error('download HTTP ' + res.status + ' ' + url);
      const chunks = [];
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        clearTimeout(timer);
        timer = setTimeout(() => ctrl.abort(), idleMs); // réarme à chaque morceau reçu
      }
      clearTimeout(timer);
      fs.writeFileSync(dest, Buffer.concat(chunks));
      return;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1500)); // petite pause puis on réessaie
    }
  }
  throw lastErr || new Error('download failed ' + url);
}

/**
 * Synchronise les mods depuis le manifeste : télécharge SEULEMENT les nouveaux/modifiés,
 * retire ceux qui ont été supprimés du manifeste. Ne touche pas à Axiom (géré à part).
 * Si le réseau/manifeste est indispo → garde les mods déjà présents (jeu jouable hors-ligne).
 * onProgress(nomDuMod, index, total) — appelé pour chaque mod téléchargé.
 */
async function syncModsFromManifest(root, onProgress) {
  const to = path.join(root, 'mods');
  fs.mkdirSync(to, { recursive: true });

  let manifest;
  try {
    manifest = await fetchManifest();
  } catch {
    return; // pas de réseau -> on garde l'existant
  }
  const wanted = Array.isArray(manifest.mods) ? manifest.mods : [];
  const wantedNames = new Set(wanted.map((m) => m.name));

  // On ne supprime QUE les mods qu'Emeria a installés lui-même AVANT et qui ont été retirés
  // du manifeste. Les mods ajoutés par le joueur/staff (WorldEdit, WorldEditCUI…) ne sont
  // JAMAIS supprimés (avant, tout mod hors manifeste était effacé -> ils disparaissaient).
  const managedMarker = path.join(root, '.emeria-managed-mods');
  let prevManaged = [];
  try { prevManaged = JSON.parse(fs.readFileSync(managedMarker, 'utf8')); } catch { /* 1re fois */ }
  const prevSet = new Set(Array.isArray(prevManaged) ? prevManaged : []);
  for (const f of fs.readdirSync(to)) {
    if (!f.endsWith('.jar') || /axiom|worldedit/i.test(f)) continue; // WorldEdit/CUI = outils staff, jamais supprimés
    if (!wantedNames.has(f) && prevSet.has(f)) { // Emeria le gérait, plus au manifeste -> retire
      try { fs.unlinkSync(path.join(to, f)); } catch { /* ignore */ }
    }
  }

  // Télécharge uniquement ce qui a changé, et EN PARALLÈLE (jusqu'à 4 à la fois) -> lancement
  // bien plus rapide quand plusieurs mods ont changé.
  const toDl = wanted.filter((m) => sha256File(path.join(to, m.name)) !== m.sha256);
  let done = 0;
  await parallelLimit(toDl, 4, async (m) => {
    if (onProgress) onProgress(m.name, done, toDl.length);
    await downloadTo(m.url, path.join(to, m.name));
    done++;
  });

  // Mémorise la liste des mods GÉRÉS par Emeria (pour ne supprimer QUE ceux-là à l'avenir).
  try { fs.writeFileSync(managedMarker, JSON.stringify([...wantedNames])); } catch { /* ignore */ }
}

/** Endpoint panel : renvoie les pseudos Axiom = staff Responsable+ (auto) ∪ ajouts manuels. */
const AXIOM_PANEL_URL = 'https://x-o-web.vercel.app/api/launcher/axiom';

/**
 * Liste des pseudos autorisés à Axiom (staff build), en minuscules. null si indispo.
 *  1) panel (dynamique : staff resp+ auto + ajouts manuels via le xo-panel)
 *  2) repli : axiomAllowed du manifeste
 */
async function getAxiomAllowed() {
  // 1) Panel (source de vérité : resp+ automatiquement, + ajouts manuels).
  try {
    const r = await fetch(AXIOM_PANEL_URL + '?t=' + Date.now());
    if (r.ok) {
      const d = await r.json();
      const list = Array.isArray(d.allowed) ? d.allowed : null;
      if (list && list.length) return list.map((s) => String(s).toLowerCase());
    }
  } catch { /* panel indispo -> repli manifeste */ }
  // 2) Repli : manifeste.
  try {
    const manifest = await fetchManifest();
    const list = Array.isArray(manifest.axiomAllowed) ? manifest.axiomAllowed : null;
    return list && list.length ? list.map((s) => String(s).toLowerCase()) : null;
  } catch {
    return null; // repli sur la liste par défaut du launcher
  }
}

/** Pseudos (minuscules) autorisés à la catégorie Com du launcher. null si indispo.
 *  Même source que Axiom (endpoint du panel), champ `com` ; repli manifeste comAllowed. */
async function getComAllowed() {
  try {
    const r = await fetch(AXIOM_PANEL_URL + '?t=' + Date.now());
    if (r.ok) {
      const d = await r.json();
      if (Array.isArray(d.com)) return d.com.map((s) => String(s).toLowerCase());
    }
  } catch { /* panel indispo -> repli manifeste */ }
  try {
    const manifest = await fetchManifest();
    const list = Array.isArray(manifest.comAllowed) ? manifest.comAllowed : null;
    return list ? list.map((s) => String(s).toLowerCase()) : null;
  } catch {
    return null;
  }
}

/** Pseudos (minuscules) autorisés aux mods Build du launcher. null si indispo.
 *  Même source que Axiom (endpoint du panel), champ `build` ; repli manifeste buildAllowed. */
async function getBuildAllowed() {
  try {
    const r = await fetch(AXIOM_PANEL_URL + '?t=' + Date.now());
    if (r.ok) {
      const d = await r.json();
      if (Array.isArray(d.build)) return d.build.map((s) => String(s).toLowerCase());
    }
  } catch { /* panel indispo -> repli manifeste */ }
  try {
    const manifest = await fetchManifest();
    const list = Array.isArray(manifest.buildAllowed) ? manifest.buildAllowed : null;
    return list ? list.map((s) => String(s).toLowerCase()) : null;
  } catch {
    return null;
  }
}

/**
 * Synchronise les resourcepacks depuis le manifeste (ajout / mise à jour seulement).
 * Ne supprime PAS les packs fournis avec le launcher (ex : Better Leaves).
 */
async function syncResourcepacksFromManifest(root, onProgress) {
  const to = path.join(root, 'resourcepacks');
  fs.mkdirSync(to, { recursive: true });
  let manifest;
  try {
    manifest = await fetchManifest();
  } catch {
    return; // pas de réseau -> on garde l'existant
  }
  const wanted = Array.isArray(manifest.resourcepacks) ? manifest.resourcepacks : [];
  // Téléchargements EN PARALLÈLE (jusqu'à 4) de ce qui a changé.
  const toDl = wanted.filter((m) => sha256File(path.join(to, m.name)) !== m.sha256);
  let done = 0;
  await parallelLimit(toDl, 4, async (m) => {
    if (onProgress) onProgress(m.name, done, toDl.length);
    await downloadTo(m.url, path.join(to, m.name));
    done++;
  });
  // Activation dans options.txt : SÉQUENTIEL (on écrit le même fichier, pas de parallèle).
  // Évite qu'un nouveau pack (ex. EmeriaItems) soit téléchargé mais pas appliqué.
  for (const m of wanted) ensureResourcePackEnabled(root, m.name);
}

/**
 * Synchronise le dossier mods du jeu avec les mods fournis par le launcher.
 * Retire les anciens .jar et copie ceux du launcher → ajout/retrait reflété chez tous.
 * (Ancienne méthode "mods embarqués" — conservée en secours.)
 */
function syncMods(bundledDir, root) {
  const from = path.join(bundledDir, 'mods');
  const to = path.join(root, 'mods');
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(to)) {
    if (f.endsWith('.jar')) {
      try {
        fs.unlinkSync(path.join(to, f));
      } catch {
        /* ignore */
      }
    }
  }
  if (fs.existsSync(from)) {
    for (const f of fs.readdirSync(from)) {
      if (f.endsWith('.jar')) fs.copyFileSync(path.join(from, f), path.join(to, f));
    }
  }
}

/** Copie configs + shaderpacks fournis (sans écraser, pour garder les réglages joueur). */
/**
 * Copie récursive from -> to. overwrite=false : garde les réglages perso du joueur.
 * `preserve` (Set de chemins relatifs, séparés par "/") = fichiers "possédés par le joueur"
 * (réglages graphiques/shaders) : copiés au 1er install, mais JAMAIS réécrasés ensuite,
 * même quand une nouvelle config est poussée -> le joueur garde ses réglages.
 */
function copyRecursive(from, to, overwrite, preserve = null, rel = '') {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    const r = rel ? rel + '/' + name : name;
    if (fs.statSync(src).isDirectory()) {
      copyRecursive(src, dst, overwrite, preserve, r);
    } else {
      const owned = preserve && preserve.has(r); // fichier graphique -> ne jamais écraser
      if ((overwrite && !owned) || !fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
      }
    }
  }
}

/** Réglages graphiques/shaders possédés par le joueur (jamais écrasés après le 1er install). */
const GRAPHICS_PRESERVE = new Set([
  'iris.properties',            // shader activé + pack sélectionné + réglages
  'sodium-options.json',        // qualité graphique / perf
  'sodium-extra-options.json',
]);

/** Empreinte d'un dossier (chemins + contenus triés) pour détecter un changement de config. */
function hashDir(dir) {
  const h = crypto.createHash('sha1');
  const walk = (d, rel) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const r = rel ? rel + '/' + name : name;
      if (fs.statSync(p).isDirectory()) walk(p, r);
      else { h.update(r); h.update(fs.readFileSync(p)); }
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return h.digest('hex');
}

/** Standardise UNIQUEMENT les touches (lignes key_*) sans toucher aux réglages perso (son, fov, sensi…). */
function mergeKeybinds(optSrc, optDst) {
  try {
    if (!fs.existsSync(optSrc) || !fs.existsSync(optDst)) return;
    const keys = {};
    for (const l of fs.readFileSync(optSrc, 'utf8').split('\n')) {
      const m = l.match(/^(key_[^:]+):/);
      if (m) keys[m[1]] = l;
    }
    let out = fs.readFileSync(optDst, 'utf8').split('\n');
    const seen = new Set();
    out = out.map((l) => {
      const m = l.match(/^(key_[^:]+):/);
      if (m && keys[m[1]] !== undefined) { seen.add(m[1]); return keys[m[1]]; }
      return l;
    });
    for (const k in keys) if (!seen.has(k)) out.push(keys[k]);
    fs.writeFileSync(optDst, out.join('\n'));
  } catch {
    /* ignore */
  }
}

/** Empreinte du SCHÉMA de touches (seulement les lignes key_*) du fichier fourni. */
function keybindsHash(optSrc) {
  try {
    const lines = fs
      .readFileSync(optSrc, 'utf8')
      .split('\n')
      .filter((l) => /^key_[^:]+:/.test(l))
      .sort();
    return crypto.createHash('sha1').update(lines.join('\n')).digest('hex');
  } catch {
    return '';
  }
}

function installConfigs(bundledDir, root) {
  const optSrc = path.join(bundledDir, 'options.txt');
  const optDst = path.join(root, 'options.txt');

  // Empreinte des configs fournies. Si elle change (nouvelle config poussée) OU 1er lancement,
  // on FORCE l'application des configs (minimap, shaders, mods…). Entre deux mises à jour, on
  // ne touche à rien -> le joueur garde ses réglages perso.
  const h = crypto.createHash('sha1');
  const cfgFrom = path.join(bundledDir, 'config');
  if (fs.existsSync(cfgFrom)) h.update(hashDir(cfgFrom));
  if (fs.existsSync(optSrc)) h.update(fs.readFileSync(optSrc));
  const version = h.digest('hex');
  const marker = path.join(root, '.emeria-config-version');
  const applied = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
  const force = version !== applied;

  for (const sub of ['config', 'shaderpacks', 'resourcepacks']) {
    const from = path.join(bundledDir, sub);
    if (!fs.existsSync(from)) continue;
    // Sur config/, on protège les fichiers graphiques/shaders du joueur (jamais réécrasés).
    const preserve = sub === 'config' ? GRAPHICS_PRESERVE : null;
    // shaderpacks : on n'ÉCRASE JAMAIS ceux du joueur (copie seulement si absent) -> shaders perso gardés.
    const doForce = sub === 'shaderpacks' ? false : force;
    copyRecursive(from, path.join(root, sub), doForce, preserve);
  }
  // Le pack de badges est TOUJOURS rafraîchi (écrase l'ancien).
  const badgeSrc = path.join(bundledDir, 'resourcepacks', 'EmeriaBadges.zip');
  const badgeDst = path.join(root, 'resourcepacks', 'EmeriaBadges.zip');
  if (fs.existsSync(badgeSrc)) {
    fs.mkdirSync(path.dirname(badgeDst), { recursive: true });
    try { fs.copyFileSync(badgeSrc, badgeDst); } catch { /* ignore */ }
  }
  // options.txt :
  //  - 1er lancement (aucun options.txt) -> on copie les défauts Emeria (touches + réglages).
  //  - ensuite -> on ne TOUCHE PLUS JAMAIS au fichier : le joueur garde SES touches perso,
  //    même après une mise à jour. Le schéma Emeria n'est posé qu'une seule fois.
  if (fs.existsSync(optSrc) && !fs.existsSync(optDst)) {
    fs.copyFileSync(optSrc, optDst);
  }

  try { fs.writeFileSync(marker, version); } catch { /* ignore */ }
}

/**
 * Force un resourcepack à être ACTIF dans options.txt (le rajoute s'il manque).
 * Appelé à CHAQUE lancement → si le joueur l'a désactivé, il est réactivé au prochain lancement.
 * Ne throw jamais (options.txt peut être absent au tout premier lancement).
 */
function ensureResourcePackEnabled(root, packFile) {
  const file = path.join(root, 'options.txt');
  const entry = 'file/' + packFile;
  try {
    if (!fs.existsSync(file)) return;
    const txt = fs.readFileSync(file, 'utf8');
    const m = txt.match(/^resourcePacks:(.*)$/m);
    if (!m) return;
    let list;
    try {
      list = JSON.parse(m[1]);
    } catch {
      return;
    }
    if (!Array.isArray(list) || list.includes(entry)) return;
    list.push(entry); // ajouté en fin = priorité haute
    const out = txt.replace(/^resourcePacks:.*$/m, 'resourcePacks:' + JSON.stringify(list));
    fs.writeFileSync(file, out);
  } catch {
    /* ignore */
  }
}

/**
 * Force l'ORDRE des resource packs Emeria dans options.txt (appelé à chaque lancement).
 * Dans options.txt, l'ordre du tableau = ordre d'application : le DERNIER gagne (priorité max,
 * en haut de la liste en jeu). On place les packs connus À LA FIN, dans l'ordre voulu, avec
 * EmeriaItems EN DERNIER -> son paper.json (qui contient AUSSI les overrides de la Pancarte)
 * l'emporte, sinon la Pancarte écraserait les items (papier nu). Les autres packs (base, ajouts
 * du joueur) restent devant, inchangés.
 */
function enforceEmeriaPackOrder(root) {
  const file = path.join(root, 'options.txt');
  try {
    if (!fs.existsSync(file)) return;
    const txt = fs.readFileSync(file, 'utf8');
    const m = txt.match(/^resourcePacks:(.*)$/m);
    if (!m) return;
    let list;
    try { list = JSON.parse(m[1]); } catch { return; }
    if (!Array.isArray(list)) return;
    // Ordre voulu (du bas vers le HAUT de la liste en jeu) -> EmeriaItems en priorité max.
    const ORDER = [
      'file/Better Leaves.zip',
      'file/EvenBetterEnchants_v2_r1.zip',
      'file/Better-Leaves-9.6.zip',
      'file/EmeriaBadges.zip',
      'file/EmeriaPancarte.zip',
      'file/EmeriaItems.zip',
    ];
    const present = ORDER.filter((e) => list.includes(e));
    if (present.length < 2) return;
    const rest = list.filter((e) => !present.includes(e));
    const next = [...rest, ...present];
    if (JSON.stringify(next) === JSON.stringify(list)) return;
    const out = txt.replace(/^resourcePacks:.*$/m, 'resourcePacks:' + JSON.stringify(next));
    fs.writeFileSync(file, out);
  } catch {
    /* ignore */
  }
}

/**
 * macOS : désactive « Colored Lighting » du shader (les drivers Apple ne le supportent pas).
 * Le shader reste actif, seule cette option est coupée -> plus d'« Important Error ».
 */
function patchShaderForMac(root) {
  if (process.platform !== 'darwin') return;
  const dir = path.join(root, 'shaderpacks');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.txt')) continue;
    const file = path.join(dir, f);
    try {
      let txt = fs.readFileSync(file, 'utf8');
      txt = /COLORED_LIGHTING=/.test(txt)
        ? txt.replace(/COLORED_LIGHTING=.*/g, 'COLORED_LIGHTING=0')
        : txt + '\nCOLORED_LIGHTING=0\n';
      fs.writeFileSync(file, txt);
    } catch {
      /* ignore */
    }
  }
}

/** Active ou désactive les shaders (édite config/iris.properties). */
function setShaderEnabled(root, enabled) {
  const file = path.join(root, 'config', 'iris.properties');
  try {
    let txt = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    txt = /enableShaders=/.test(txt)
      ? txt.replace(/enableShaders=.*/g, `enableShaders=${enabled}`)
      : txt + `\nenableShaders=${enabled}\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, txt);
  } catch {
    /* ignore */
  }
}

/**
 * Axiom (mod optionnel du staff build) : présent dans content/optional/axiom mais PAS
 * synchronisé automatiquement. Installé dans mods/ seulement si `enabled`, sinon retiré.
 */
async function setAxiomInstalled(root, enabled, onProgress) {
  const to = path.join(root, 'mods');
  fs.mkdirSync(to, { recursive: true });

  const removeAxiom = () => {
    for (const f of fs.readdirSync(to)) {
      if (/axiom/i.test(f) && f.endsWith('.jar')) {
        try { fs.unlinkSync(path.join(to, f)); } catch { /* ignore */ }
      }
    }
  };

  // Désactivé : on retire toute version d'Axiom et on s'arrête.
  if (!enabled) { removeAxiom(); return; }

  // Activé : on ne re-télécharge QUE si Axiom manque ou n'est pas à jour (bon hash).
  try {
    const manifest = await fetchManifest();
    const ax = (manifest.optional || []).find((o) => o.id === 'axiom');
    if (!ax) return;
    const dest = path.join(to, ax.name);

    // Déjà présent avec le bon hash → rien à faire (lancement instantané).
    if (fs.existsSync(dest) && sha256File(dest) === ax.sha256) return;

    // Sinon : on nettoie les anciennes versions puis on télécharge la bonne.
    removeAxiom();
    if (onProgress) onProgress('Axiom');
    await downloadTo(ax.url, dest);
  } catch {
    /* réseau indispo -> Axiom non installé cette fois */
  }
}

/** Retire de mods/ le fichier `name` et ses variantes de version (même base avant le -<num>). */
function removeModByBase(dir, name) {
  const base = (String(name).match(/^(.*?)-v?\d/i) || [])[1] || String(name).replace(/\.jar$/i, '');
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + esc + '(-v?\\d.*)?\\.jar$', 'i');
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.jar') && re.test(f)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
    }
  }
}

/**
 * Mods OPTIONNELS togglables (Axiom / Build / Com). Pour CHAQUE mod optionnel du manifeste,
 * `decide(entry)` dit s'il doit être présent (catégorie autorisée pour ce compte ET activé par
 * le joueur). Présent = téléchargé dans mods/ (si manquant ou hash différent) ; sinon retiré.
 */
async function setOptionalInstalled(root, decide, onProgress) {
  const to = path.join(root, 'mods');
  fs.mkdirSync(to, { recursive: true });
  let manifest;
  try { manifest = await fetchManifest(); } catch { return; }
  const optional = Array.isArray(manifest.optional) ? manifest.optional : [];
  for (const o of optional) {
    if (!o || !o.name) continue;
    const dest = path.join(to, o.name);
    let want = false;
    try { want = !!decide(o); } catch { want = false; }
    if (!want) { removeModByBase(to, o.name); continue; }
    try {
      if (fs.existsSync(dest) && sha256File(dest) === o.sha256) continue; // déjà à jour
      removeModByBase(to, o.name); // nettoie les anciennes versions
      if (onProgress) onProgress(prettyModName(o.name));
      await downloadTo(o.url, dest);
    } catch { /* réseau indispo -> ce mod non installé cette fois */ }
  }
}

/**
 * Transforme un nom de fichier de mod en nom propre pour l'affichage.
 * Ex : "votelistener-1.1.0+1.21.jar" -> "Votelistener"
 *      "xaerominimap-fabric-1.21.1-26.4.2.jar" -> "Xaerominimap"
 *      "yet_another_config_lib_v3-3.8.2+1.21.1.jar" -> "Yet Another Config Lib"
 */
function prettyModName(file) {
  let s = String(file || '').replace(/\.(jar|zip)$/i, '');
  const parts = s.split(/[-_+ ]+/).filter(Boolean);
  // On coupe sur une version (toujours) ou sur un tag de loader (sauf s'il est le 1er mot,
  // pour garder les mods réellement nommés "fabric-api", "fabric-language-kotlin"…).
  const versionTok = /^(v?\d|mc\d|mc$|beta|alpha|snapshot|build)/i;
  const loaderTok = /^(fabric|forge|quilt|neoforge)$/i;
  const kept = [];
  for (const p of parts) {
    if (versionTok.test(p)) break;
    if (loaderTok.test(p) && kept.length) break;
    kept.push(p);
  }
  const words = (kept.length ? kept : parts.slice(0, 1));
  const name = words.join(' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  return name || file;
}

/**
 * Listes à afficher dans le launcher (mods + resourcepacks), depuis le manifeste,
 * avec des noms propres et triées. Renvoie null si le manifeste est indisponible
 * (le launcher retombe alors sur sa liste par défaut embarquée).
 */
async function getManifestDisplayLists() {
  try {
    const manifest = await fetchManifest();
    const toList = (arr) => {
      const seen = new Set();
      return (Array.isArray(arr) ? arr : [])
        .map((e) => ({ name: prettyModName(e.name) }))
        .filter((e) => { const k = e.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
    };
    return { mods: toList(manifest.mods), resourcepacks: toList(manifest.resourcepacks) };
  } catch {
    return null;
  }
}

/**
 * Liste des mods OPTIONNELS togglables depuis le manifeste : [{ id, name (joli), category }].
 * Sert au launcher à afficher une case à cocher par mod. null si manifeste indisponible.
 */
async function getOptionalList() {
  try {
    const manifest = await fetchManifest();
    const arr = Array.isArray(manifest.optional) ? manifest.optional : [];
    return arr
      .filter((o) => o && o.id && o.name)
      .map((o) => ({ id: o.id, name: prettyModName(o.name), category: o.category || 'axiom' }));
  } catch {
    return null;
  }
}

module.exports = {
  syncMods,
  syncModsFromManifest,
  syncResourcepacksFromManifest,
  getAxiomAllowed,
  getComAllowed,
  getBuildAllowed,
  getManifestDisplayLists,
  getOptionalList,
  prettyModName,
  installConfigs,
  ensureResourcePackEnabled,
  enforceEmeriaPackOrder,
  patchShaderForMac,
  setShaderEnabled,
  setAxiomInstalled,
  setOptionalInstalled,
};
