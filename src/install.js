const fs = require('fs');
const path = require('path');

/**
 * Synchronise le dossier mods du jeu avec les mods fournis par le launcher.
 * Retire les anciens .jar et copie ceux du launcher → ajout/retrait reflété chez tous.
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

module.exports = { syncMods, installConfigs, patchShaderForMac, setShaderEnabled };
