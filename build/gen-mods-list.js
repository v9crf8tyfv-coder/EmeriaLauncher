// Hook electron-builder (beforePack) : génère content/mods.json (noms des mods)
// AVANT de packager, pour qu'on puisse EXCLURE les .jar (93 Mo) de l'installeur.
// Les mods eux-mêmes sont téléchargés au runtime depuis le manifeste, pas depuis le bundle.
const fs = require('fs');
const path = require('path');

/** "sodium-fabric-0.8.12+mc1.21.1.jar" -> "Sodium" (identique à src/content.js) */
function pretty(file) {
  let n = file.replace(/\.(jar|zip)$/i, '');
  n = n.replace(/[-_](fabric|forge|mc|v)?\d.*$/i, '');
  n = n.replace(/[-_](fabric|forge)$/i, '');
  n = n.replace(/[-_]+/g, ' ').trim();
  n = n.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return n || file;
}

module.exports = async function () {
  const root = path.join(__dirname, '..');
  const modsDir = path.join(root, 'content', 'mods');
  const out = path.join(root, 'content', 'mods.json');
  let list = [];
  try {
    list = fs
      .readdirSync(modsDir)
      .filter((f) => f.toLowerCase().endsWith('.jar'))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map((f) => ({ name: pretty(f) }));
  } catch {
    /* pas de dossier mods -> liste vide */
  }
  fs.writeFileSync(out, JSON.stringify(list, null, 2) + '\n');
  console.log(`[gen-mods-list] ${list.length} mods -> content/mods.json`);
};
