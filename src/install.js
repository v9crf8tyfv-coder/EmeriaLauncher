const fs = require('fs');
const path = require('path');

// Mods client requis pour les shaders + perfs (téléchargés depuis Modrinth).
const MOD_SLUGS = ['fabric-api', 'sodium', 'iris', 'sodium-extra'];

/** Télécharge les mods client dans <root>/mods (skip si déjà présents). */
async function downloadMods(root, mcVersion, onLog) {
  const modsDir = path.join(root, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const marker = path.join(modsDir, `.emeria-${mcVersion}`);
  for (const slug of MOD_SLUGS) {
    try {
      const api =
        `https://api.modrinth.com/v2/project/${slug}/version` +
        `?loaders=%5B%22fabric%22%5D&game_versions=%5B%22${mcVersion}%22%5D`;
      const versions = await fetch(api, {
        headers: { 'User-Agent': 'EmeriaLauncher/1.0' },
      }).then((r) => r.json());
      if (!Array.isArray(versions) || versions.length === 0) {
        onLog?.(`Aucune version de ${slug} pour ${mcVersion}`);
        continue;
      }
      const v = versions[0];
      const file = v.files.find((f) => f.primary) || v.files[0];
      const dest = path.join(modsDir, file.filename);
      if (fs.existsSync(dest)) continue;
      onLog?.(`Téléchargement du mod ${slug}…`);
      const buf = Buffer.from(await fetch(file.url).then((r) => r.arrayBuffer()));
      fs.writeFileSync(dest, buf);
    } catch (e) {
      onLog?.(`Erreur mod ${slug} : ${e.message}`);
    }
  }
  fs.writeFileSync(marker, new Date().toISOString());
}

/** Copie le shader + les configs fournis (skip si déjà présents pour garder les réglages joueur). */
function installBundledContent(bundledDir, root) {
  for (const sub of ['config', 'shaderpacks']) {
    const from = path.join(bundledDir, sub);
    if (!fs.existsSync(from)) continue;
    const to = path.join(root, sub);
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      const dst = path.join(to, name);
      if (fs.existsSync(dst)) continue; // ne pas écraser
      fs.copyFileSync(path.join(from, name), dst);
    }
  }
}

module.exports = { downloadMods, installBundledContent };
