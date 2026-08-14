// Signature ad-hoc de l'app macOS (gratuit, sans certificat Apple).
// Sans ça, une app arm64 non signée s'affiche comme « endommagée » et refuse de s'ouvrir.
// Avec, elle s'ouvre via clic droit -> Ouvrir (avertissement « éditeur inconnu » normal).
const { execSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  try {
    execSync(`codesign --deep --force -s - "${appPath}"`, { stdio: 'inherit' });
    console.log('✅ Signature ad-hoc appliquée : ' + appPath);
  } catch (e) {
    console.warn('⚠️ Signature ad-hoc échouée : ' + e.message);
  }
};
