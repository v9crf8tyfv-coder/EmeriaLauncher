// Contenu affiché dans les Réglages (lecture seule pour les joueurs).
// La liste des mods est lue AUTOMATIQUEMENT depuis content/mods/ :
// dès que tu ajoutes/retires un .jar, la liste du launcher se met à jour toute seule.

const fs = require('fs');
const path = require('path');

const MODS_DIR = path.join(__dirname, '..', 'content', 'mods');
// Liste pré-générée au build (les .jar sont exclus de l'installeur pour l'alléger).
const MODS_JSON = path.join(__dirname, '..', 'content', 'mods.json');

/** Transforme "sodium-fabric-0.8.12+mc1.21.1.jar" -> "sodium" (nom propre) */
function pretty(file) {
  let n = file.replace(/\.(jar|zip)$/i, '');
  n = n.replace(/[-_](fabric|forge|mc|v)?\d.*$/i, ''); // coupe la version
  n = n.replace(/[-_](fabric|forge)$/i, ''); // enlève un "-fabric" en trop
  n = n.replace(/[-_]+/g, ' ').trim();
  // Jolie casse : première lettre de chaque mot en majuscule (garde le camelCase existant)
  n = n.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return n || file;
}

function listMods() {
  // 1) Liste pré-générée (installeur allégé, sans les .jar)
  try {
    if (fs.existsSync(MODS_JSON)) {
      const arr = JSON.parse(fs.readFileSync(MODS_JSON, 'utf8'));
      if (Array.isArray(arr)) return arr;
    }
  } catch {
    /* json absent/invalide -> on scanne le dossier */
  }
  // 2) Repli : scan direct du dossier mods (dev, ou si les .jar sont présents)
  try {
    return fs
      .readdirSync(MODS_DIR)
      .filter((f) => f.toLowerCase().endsWith('.jar'))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map((f) => ({ name: pretty(f) }));
  } catch {
    return [];
  }
}

const mods = listMods();

// Shaders disponibles en jeu.
const shaders = [{ name: 'Complementary Reimagined' }];

module.exports = { mods, shaders };
