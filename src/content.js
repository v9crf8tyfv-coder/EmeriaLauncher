// Contenu affiché dans les Réglages (lecture seule pour les joueurs).
// Reflète ce qui est réellement installé / actif en jeu.

// Mods installés par le launcher (perfs + support shaders).
const mods = [
  { name: 'Fabric API' },
  { name: 'Sodium' },
  { name: 'Iris (shaders)' },
  { name: 'Sodium Extra' },
  // TODO : tes mods custom plus tard
];

// Shaders disponibles en jeu.
const shaders = [
  { name: 'Complementary Reimagined' },
];

module.exports = { mods, shaders };
