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

async function fetchManifest() {
  const res = await fetch(MANIFEST_URL + '?t=' + Date.now());
  if (!res.ok) throw new Error('manifest HTTP ' + res.status);
  return res.json();
}

async function downloadTo(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('download HTTP ' + res.status + ' ' + url);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
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

  // Retire les mods qui ne sont plus dans le manifeste (sauf Axiom, géré séparément)
  for (const f of fs.readdirSync(to)) {
    if (!f.endsWith('.jar') || /axiom/i.test(f)) continue;
    if (!wantedNames.has(f)) {
      try { fs.unlinkSync(path.join(to, f)); } catch { /* ignore */ }
    }
  }

  // Télécharge uniquement ce qui a changé
  let i = 0;
  for (const m of wanted) {
    const dest = path.join(to, m.name);
    if (sha256File(dest) !== m.sha256) {
      if (onProgress) onProgress(m.name, i, wanted.length);
      await downloadTo(m.url, dest);
    }
    i++;
  }
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
/** Copie récursive from -> to. overwrite=false : garde les réglages perso du joueur. */
function copyRecursive(from, to, overwrite) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    if (fs.statSync(src).isDirectory()) {
      copyRecursive(src, dst, overwrite);
    } else if (overwrite || !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
    }
  }
}

function installConfigs(bundledDir, root) {
  for (const sub of ['config', 'shaderpacks']) {
    const from = path.join(bundledDir, sub);
    if (!fs.existsSync(from)) continue;
    copyRecursive(from, path.join(root, sub), false); // sous-dossiers gérés (ex: config/xaero/...)
  }
  // options.txt (touches + réglages par défaut) — copié au 1er lancement seulement.
  const optSrc = path.join(bundledDir, 'options.txt');
  const optDst = path.join(root, 'options.txt');
  if (fs.existsSync(optSrc) && !fs.existsSync(optDst)) {
    fs.copyFileSync(optSrc, optDst);
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
  // Retire toute version d'Axiom déjà présente
  for (const f of fs.readdirSync(to)) {
    if (/axiom/i.test(f) && f.endsWith('.jar')) {
      try { fs.unlinkSync(path.join(to, f)); } catch { /* ignore */ }
    }
  }
  if (!enabled) return;
  // Télécharge Axiom depuis le manifeste (entrée optionnelle "axiom")
  try {
    const manifest = await fetchManifest();
    const ax = (manifest.optional || []).find((o) => o.id === 'axiom');
    if (!ax) return;
    const dest = path.join(to, ax.name);
    if (sha256File(dest) !== ax.sha256) {
      if (onProgress) onProgress('Axiom');
      await downloadTo(ax.url, dest);
    }
  } catch {
    /* réseau indispo -> Axiom non installé cette fois */
  }
}

module.exports = {
  syncMods,
  syncModsFromManifest,
  installConfigs,
  patchShaderForMac,
  setShaderEnabled,
  setAxiomInstalled,
};
