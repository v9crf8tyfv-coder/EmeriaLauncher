const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const tar = require('tar');

// Minecraft 1.21.1 nécessite Java 21. On le télécharge (Adoptium Temurin) si absent.
const JRE_DIR = path.join(app.getPath('userData'), 'jre');
const EXE = process.platform === 'win32' ? 'java.exe' : 'java';

function findJava() {
  if (!fs.existsSync(JRE_DIR)) return null;
  for (const entry of fs.readdirSync(JRE_DIR)) {
    const base = path.join(JRE_DIR, entry);
    for (const c of [
      path.join(base, 'bin', EXE),
      path.join(base, 'Contents', 'Home', 'bin', EXE), // structure macOS
    ]) {
      if (fs.existsSync(c)) return c;
    }
  }
  return null;
}

/** Renvoie le chemin d'un Java 21 (le télécharge la 1re fois). */
async function ensureJava(onLog) {
  let java = findJava();
  if (java) return java;

  onLog?.('Téléchargement de Java (1re fois)…');
  fs.mkdirSync(JRE_DIR, { recursive: true });

  const os =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const url = `https://api.adoptium.net/v3/binary/latest/21/ga/${os}/${arch}/jre/hotspot/normal/eclipse`;

  const buf = Buffer.from(await fetch(url, { redirect: 'follow' }).then((r) => r.arrayBuffer()));

  if (os === 'windows') {
    const zip = path.join(JRE_DIR, 'jre.zip');
    fs.writeFileSync(zip, buf);
    new AdmZip(zip).extractAllTo(JRE_DIR, true);
    fs.unlinkSync(zip);
  } else {
    const tgz = path.join(JRE_DIR, 'jre.tar.gz');
    fs.writeFileSync(tgz, buf);
    await tar.x({ file: tgz, cwd: JRE_DIR });
    fs.unlinkSync(tgz);
  }

  java = findJava();
  if (!java) throw new Error('Java introuvable après extraction');
  if (os !== 'windows') {
    try {
      fs.chmodSync(java, 0o755);
    } catch {
      /* ignore */
    }
  }
  return java;
}

module.exports = { ensureJava };
