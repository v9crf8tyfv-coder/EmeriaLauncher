const fs = require('fs');
const path = require('path');

/**
 * Installe le profil Fabric pour la version Minecraft donnée (via l'API meta de Fabric)
 * et renvoie l'identifiant de version à passer à minecraft-launcher-core.
 */
async function installFabric(root, mcVersion) {
  const loaders = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`).then((r) =>
    r.json(),
  );
  if (!Array.isArray(loaders) || loaders.length === 0) {
    throw new Error(`Aucun loader Fabric trouvé pour Minecraft ${mcVersion}`);
  }
  const loader = loaders[0].loader.version; // dernier loader stable
  const versionId = `fabric-loader-${loader}-${mcVersion}`;
  const dir = path.join(root, 'versions', versionId);
  const file = path.join(dir, `${versionId}.json`);

  if (!fs.existsSync(file)) {
    const profile = await fetch(
      `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loader}/profile/json`,
    ).then((r) => r.json());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(profile, null, 2));
  }
  return versionId;
}

module.exports = { installFabric };
