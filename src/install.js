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
function installConfigs(bundledDir, root) {
  for (const sub of ['config', 'shaderpacks']) {
    const from = path.join(bundledDir, sub);
    if (!fs.existsSync(from)) continue;
    const to = path.join(root, sub);
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      const dst = path.join(to, name);
      if (fs.existsSync(dst)) continue;
      fs.copyFileSync(path.join(from, name), dst);
    }
  }
}

module.exports = { syncMods, installConfigs };
