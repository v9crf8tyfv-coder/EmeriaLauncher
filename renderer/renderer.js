const loginBtn = document.getElementById('login');
const loginLabel = document.getElementById('login-label');
const headImg = document.getElementById('head');
const playBtn = document.getElementById('play');
const statusEl = document.getElementById('status');
const barFill = document.getElementById('bar-fill');
const ipBox = document.getElementById('ip-box');
const ipText = document.getElementById('ip-text');

const settingsBtn = document.getElementById('settings-btn');
const settingsOverlay = document.getElementById('settings');
const settingsClose = document.getElementById('settings-close');
const ramInput = document.getElementById('ram');
const ramVal = document.getElementById('ram-val');
const modsList = document.getElementById('mods-list');
const shadersList = document.getElementById('shaders-list');
const sendLogsBtn = document.getElementById('send-logs');

let connected = false;

function setConnected(name, head) {
  connected = true;
  loginBtn.classList.add('connected');
  loginLabel.textContent = name;
  if (head) {
    headImg.src = head;
    headImg.hidden = false;
  }
  playBtn.disabled = false;
  statusEl.textContent = 'Prêt à jouer';
}

// Reconnexion automatique au démarrage
window.api.onSession((s) => {
  if (s && s.name) setConnected(s.name, s.head);
});

// Connexion manuelle
loginBtn.addEventListener('click', async () => {
  if (connected) return;
  loginLabel.textContent = 'Connexion…';
  try {
    const { name, head } = await window.api.login();
    setConnected(name, head);
  } catch (e) {
    loginLabel.textContent = 'Se connecter';
    statusEl.textContent = 'Échec de la connexion : ' + (e?.message || e);
  }
});

// Lancer -> JEU EN COURS
playBtn.addEventListener('click', async () => {
  playBtn.disabled = true;
  playBtn.textContent = 'JEU EN COURS';
  statusEl.textContent = 'Démarrage…';
  try {
    await window.api.launch();
    statusEl.textContent = 'Jeu en cours 🎮';
    barFill.style.width = '0%';
  } catch (e) {
    statusEl.textContent = 'Erreur : ' + (e?.message || e);
    playBtn.textContent = 'LANCER';
    playBtn.disabled = false;
  }
});

// Le jeu se ferme -> LANCER revient
window.api.onClosed(() => {
  statusEl.textContent = connected ? 'Prêt à jouer' : 'Connecte-toi pour jouer';
  barFill.style.width = '0%';
  playBtn.textContent = 'LANCER';
  playBtn.disabled = !connected;
});

// Copier l'IP
ipBox.addEventListener('click', async () => {
  await window.api.copyIp();
  const old = ipText.textContent;
  ipText.textContent = 'IP copiée ✓';
  setTimeout(() => (ipText.textContent = old), 1200);
});

// Statut / progression / maj
window.api.onStatus((s) => (statusEl.textContent = s));
window.api.onUpdate((msg) => (statusEl.textContent = msg));
window.api.onProgress((p) => {
  if (p && p.total) {
    const pct = Math.min(100, Math.round((p.task / p.total) * 100));
    barFill.style.width = pct + '%';
    statusEl.textContent = `${p.type || 'Téléchargement'} — ${pct}%`;
  }
});

// ---- Réglages ----
async function loadSettings() {
  const s = await window.api.getSettings();
  ramInput.value = s.ram;
  ramVal.textContent = s.ram;
  ipText.textContent = s.ip;
  renderList(modsList, s.mods, 'Aucun mod pour l’instant.');
  renderList(shadersList, s.shaders, 'Aucun shader pour l’instant.');
}
function renderList(el, items, emptyMsg) {
  el.innerHTML = '';
  if (!items || items.length === 0) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = emptyMsg;
    el.appendChild(d);
    return;
  }
  for (const it of items) {
    const d = document.createElement('div');
    d.className = 'item';
    d.textContent = it.name;
    el.appendChild(d);
  }
}
settingsBtn.addEventListener('click', async () => {
  await loadSettings();
  settingsOverlay.hidden = false;
});
settingsClose.addEventListener('click', () => (settingsOverlay.hidden = true));
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) settingsOverlay.hidden = true;
});
// Onglets des réglages
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.tab-content').forEach((c) => (c.hidden = true));
    document.getElementById('tab-' + tab.dataset.tab).hidden = false;
  });
});

ramInput.addEventListener('input', () => (ramVal.textContent = ramInput.value));
ramInput.addEventListener('change', () => window.api.setRam(Number(ramInput.value)));
sendLogsBtn.addEventListener('click', async () => {
  sendLogsBtn.textContent = 'Envoi…';
  const r = await window.api.sendLogs();
  sendLogsBtn.textContent = r === 'sent' ? 'Logs envoyés ✓' : 'Dossier des logs ouvert';
  setTimeout(() => (sendLogsBtn.textContent = 'Envoyer les logs (problème ?)'), 2500);
});

loadSettings();
