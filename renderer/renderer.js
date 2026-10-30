const loginBtn = document.getElementById('login');
const loginLabel = document.getElementById('login-label');
const headImg = document.getElementById('head');
const playBtn = document.getElementById('play');
const playImg = document.getElementById('play-img');
const updateImg = document.getElementById('update-img');
function setPlay(name) { if (playImg) playImg.src = 'btn-' + name + '.png'; }
const statusEl = document.getElementById('status');

const settingsBtn = document.getElementById('settings-btn');
const settingsOverlay = document.getElementById('settings');
const settingsClose = document.getElementById('settings-close');
const ramInput = document.getElementById('ram');
const ramVal = document.getElementById('ram-val');
const ramAuto = document.getElementById('ram-auto');
const modsList = document.getElementById('mods-list');
const shadersList = document.getElementById('shaders-list');
const sendLogsBtn = document.getElementById('send-logs');
const shaderToggle = document.getElementById('shader-toggle');
const accountMenu = document.getElementById('account-menu');
const logoutBtn = document.getElementById('logout-btn');
const updateBtn = document.getElementById('update-btn');
const catCom = document.getElementById('cat-com');
const comToggle = document.getElementById('com-toggle');
const catBuild = document.getElementById('cat-build');
const buildMods = document.getElementById('build-mods');
const comMods = document.getElementById('com-mods');

let connected = false;
let currentName = '';      // pseudo MC connecté (pour vérifier le bypass staff en maintenance)
let maintActive = false;   // /maintenance ON (lu depuis le site)
let maintBypass = false;   // Super-Modo et + (via carte staff) OU fonda : peut lancer en maintenance
let playing = false;       // une partie est en cours

// Bloque le lancement pendant la maintenance (sauf staff). Met à jour le bouton + le statut.
function applyMaint() {
  const blocked = maintActive && !maintBypass;
  if (blocked) {
    playBtn.disabled = true;
    if (!playing) statusEl.textContent = 'Maintenance en cours — réessaie plus tard.';
  } else if (!playing) {
    // Fin de maintenance (ou staff) : on réautorise si connecté.
    playBtn.disabled = !connected;
    if (connected) statusEl.textContent = 'Prêt à jouer';
  }
}

function setConnected(name, head) {
  connected = true;
  currentName = name || '';
  loginBtn.classList.add('connected');
  loginLabel.textContent = name;
  if (head) {
    headImg.src = head;
    headImg.hidden = false;
  }
  playBtn.disabled = false;
  statusEl.textContent = 'Prêt à jouer';
  checkMaintenance(); // re-vérifie la maintenance + le bypass pour ce pseudo
}

function setDisconnected() {
  currentName = '';
  connected = false;
  loginBtn.classList.remove('connected');
  loginLabel.textContent = 'Se connecter';
  headImg.hidden = true;
  headImg.removeAttribute('src');
  playBtn.disabled = true;
  statusEl.textContent = 'Connecte-toi pour jouer';
}

// Reconnexion automatique au démarrage
window.api.onSession((s) => {
  if (s && s.name) setConnected(s.name, s.head);
});

// Clic sur la bulle : connecté → menu déconnexion, sinon → connexion
loginBtn.addEventListener('click', async (e) => {
  if (connected) {
    e.stopPropagation();
    accountMenu.hidden = !accountMenu.hidden;
    return;
  }
  loginLabel.textContent = 'Connexion…';
  try {
    const { name, head } = await window.api.login();
    setConnected(name, head);
  } catch (err) {
    loginLabel.textContent = 'Se connecter';
    statusEl.textContent = 'Échec de la connexion : ' + (err?.message || err);
  }
});

// Déconnexion
logoutBtn.addEventListener('click', async () => {
  try {
    await window.api.logout();
    accountMenu.hidden = true;
    setDisconnected();
  } catch (e) {
    // Ex: partie en cours -> déconnexion refusée
    accountMenu.hidden = true;
    statusEl.textContent = e?.message?.replace(/^Error:\s*/, '') || 'Déconnexion impossible.';
  }
});

// Fermer le menu si on clique ailleurs
document.addEventListener('click', (e) => {
  if (!accountMenu.hidden && !loginBtn.contains(e.target) && !accountMenu.contains(e.target)) {
    accountMenu.hidden = true;
  }
});

// Lancer -> JEU EN COURS
playBtn.addEventListener('click', async () => {
  if (maintActive && !maintBypass) { statusEl.textContent = 'Serveur en maintenance — réessaie plus tard.'; return; }
  playBtn.disabled = true;
  logoutBtn.disabled = true; // interdit la déconnexion tant qu'une partie tourne
  playing = true;
  setPlay('jeu-en-cours');
  statusEl.textContent = 'Démarrage…';
  try {
    await window.api.launch();
    statusEl.textContent = 'Jeu en cours 🎮';
  } catch (e) {
    statusEl.textContent = 'Erreur : ' + (e?.message || e);
    setPlay('jouer');
    playing = false;
    playBtn.disabled = false;
    logoutBtn.disabled = false; // échec du lancement -> on réautorise la déconnexion
    applyMaint();
  }
});

// Le jeu se ferme -> LANCER revient
window.api.onClosed(() => {
  statusEl.textContent = connected ? 'Prêt à jouer' : 'Connecte-toi pour jouer';
  setPlay('jouer');
  playing = false;
  playBtn.disabled = !connected;
  logoutBtn.disabled = false; // partie finie -> on peut se déconnecter à nouveau
  applyMaint();
});

// Statut / progression / maj
window.api.onStatus((s) => (statusEl.textContent = s));
// Info de maj (Mac / dispo) : on affiche mais on NE bloque PAS le lancement
window.api.onUpdateInfo((msg) => {
  statusEl.textContent = msg;
});
// Bouton "Mettre à jour" (Mac) : télécharge le bon launcher
window.api.onUpdateButton(() => {
  if (updateBtn) updateBtn.hidden = false;
});
if (updateBtn) {
  updateBtn.addEventListener('click', () => {
    window.api.downloadUpdate();
    if (updateImg) updateImg.src = 'btn-mise-a-jour.png';
  });
}
// Vraie maj en cours (Windows/Linux qui se télécharge) : on bloque le lancement
window.api.onUpdate((msg) => {
  statusEl.textContent = msg;
  playBtn.disabled = true;
  setPlay('mise-a-jour');
});
window.api.onProgress((p) => {
  if (p && p.total) {
    const pct = Math.min(100, Math.round((p.task / p.total) * 100));
    statusEl.textContent = `${p.type || 'Téléchargement'} — ${pct}%`;
  }
});

// ---- Réglages ----
async function loadSettings() {
  const s = await window.api.getSettings();
  ramInput.max = s.maxRam; // max = RAM du PC détectée
  ramInput.value = s.ram;
  ramVal.textContent = s.ram;
  if (ramAuto) {
    ramAuto.checked = !!s.ramAuto;
    ramInput.disabled = !!s.ramAuto; // en mode auto, le curseur est grisé
  }
  const hint = document.getElementById('ram-max-hint');
  if (hint) {
    hint.textContent = s.ramAuto
      ? `Auto : ${s.autoRam} Go alloués (max ${s.maxRam} Go sur ton PC)`
      : `Max détecté sur ton PC : ${s.maxRam} Go`;
  }
  shaderToggle.checked = s.shaderEnabled;
  // Com : onglet visible seulement pour les autorisés Com
  if (catCom) catCom.hidden = !s.canUseCom;
  if (comToggle) comToggle.checked = !!s.comEnabled;
  // Build : onglet visible seulement pour le staff build autorisé
  if (catBuild) catBuild.hidden = !s.canUseBuild;
  // Mods optionnels togglables (une case par mod), répartis par catégorie.
  const opt = Array.isArray(s.optionalMods) ? s.optionalMods : [];
  if (buildMods) renderOptional(buildMods, opt.filter((m) => m.category === 'build'), 'Aucun mod Build.');
  if (comMods) renderOptional(comMods, opt.filter((m) => m.category === 'com'), 'Aucun mod Com.');
  renderList(modsList, s.mods, 'Aucun mod pour l’instant.');
  renderList(shadersList, s.shaders, 'Aucun shader pour l’instant.');
}
shaderToggle.addEventListener('change', () => window.api.setShader(shaderToggle.checked));
if (comToggle) comToggle.addEventListener('change', () => window.api.setCom(comToggle.checked));
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
/** Rend une case à cocher par mod optionnel ; change -> window.api.setOptional(id, coché). */
function renderOptional(el, items, emptyMsg) {
  el.innerHTML = '';
  if (!items || items.length === 0) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = emptyMsg;
    el.appendChild(d);
    return;
  }
  for (const it of items) {
    const row = document.createElement('label');
    row.className = 'opt-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = it.enabled !== false;
    cb.addEventListener('change', () => window.api.setOptional(it.id, cb.checked));
    const span = document.createElement('span');
    span.textContent = it.name;
    row.appendChild(cb);
    row.appendChild(span);
    el.appendChild(row);
  }
}
settingsBtn.addEventListener('click', async () => {
  await loadSettings();
  settingsOverlay.classList.add('open');
});
settingsClose.addEventListener('click', () => settingsOverlay.classList.remove('open'));
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) settingsOverlay.classList.remove('open'); // clic sur le fond
});
// Catégories des réglages (liste à gauche)
document.querySelectorAll('.cat').forEach((cat) => {
  cat.addEventListener('click', () => {
    document.querySelectorAll('.cat').forEach((c) => c.classList.remove('active'));
    cat.classList.add('active');
    document.querySelectorAll('.tab-content').forEach((c) => (c.hidden = true));
    document.getElementById('tab-' + cat.dataset.tab).hidden = false;
  });
});

ramInput.addEventListener('input', () => (ramVal.textContent = ramInput.value));
ramInput.addEventListener('change', () => {
  window.api.setRam(Number(ramInput.value)); // régler à la main -> quitte le mode auto
  if (ramAuto) ramAuto.checked = false;
});
if (ramAuto) {
  ramAuto.addEventListener('change', async () => {
    const v = await window.api.setRamAuto(ramAuto.checked);
    ramInput.disabled = ramAuto.checked;
    if (ramAuto.checked) {
      ramInput.value = v;
      ramVal.textContent = v;
      const hint = document.getElementById('ram-max-hint');
      if (hint) hint.textContent = `Auto : ${v} Go alloués`;
    }
  });
}
sendLogsBtn.addEventListener('click', async () => {
  sendLogsBtn.textContent = 'Envoi…';
  const r = await window.api.sendLogs();
  sendLogsBtn.textContent = r === 'sent' ? 'Logs envoyés ✓' : 'Dossier des logs ouvert';
  setTimeout(() => (sendLogsBtn.textContent = 'Envoyer les logs (problème ?)'), 2500);
});

// Version en bas à droite (tout petit)
window.api.getVersion().then((v) => {
  const el = document.getElementById('app-version');
  if (el && v) el.textContent = 'v' + v;
}).catch(() => {});

loadSettings();

/* Maintenance : synchro avec le site (/api/status). Bandeau orange quand maintenance ON.
   Cache 30s côté site -> léger pour Vercel ; vérif au lancement + toutes les 2 min. */
function checkMaintenance() {
  var url = 'https://emeria-site.vercel.app/api/status';
  if (currentName) url += '?staff=' + encodeURIComponent(currentName);
  fetch(url, { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      maintActive = !!(d && d.maintenance);
      maintBypass = !!(d && d.staffBypass); // Super-Modo et + (carte staff) ou fonda
      var b = document.getElementById('maint-banner');
      if (b) b.hidden = !maintActive;
      applyMaint();
    })
    .catch(function () { /* hors-ligne : on n'affiche rien */ });
}
checkMaintenance();
setInterval(checkMaintenance, 120000);
