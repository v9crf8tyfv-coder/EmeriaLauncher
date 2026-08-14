const loginBtn = document.getElementById('login');
const loginLabel = document.getElementById('login-label');
const playBtn = document.getElementById('play');
const statusEl = document.getElementById('status');
const barFill = document.getElementById('bar-fill');

let connected = false;

// --- Connexion Microsoft ---
loginBtn.addEventListener('click', async () => {
  if (connected) return;
  loginLabel.textContent = 'Connexion…';
  try {
    const { name } = await window.api.login();
    connected = true;
    loginBtn.classList.add('connected');
    loginLabel.textContent = name;
    playBtn.disabled = false;
    statusEl.textContent = 'Prêt à jouer';
  } catch (e) {
    loginLabel.textContent = 'Se connecter';
    statusEl.textContent = 'Échec de la connexion : ' + (e?.message || e);
  }
});

// --- Lancer le jeu ---
playBtn.addEventListener('click', async () => {
  playBtn.disabled = true;
  statusEl.textContent = 'Démarrage…';
  try {
    await window.api.launch({ ram: 4 });
    statusEl.textContent = 'Jeu lancé ! 🎮';
    barFill.style.width = '0%';
    playBtn.disabled = false; // on peut relancer
  } catch (e) {
    statusEl.textContent = 'Erreur : ' + (e?.message || e);
    playBtn.disabled = false;
  }
});

// Le jeu s'est fermé -> on remet l'état prêt
window.api.onClosed(() => {
  statusEl.textContent = 'Prêt à jouer';
  barFill.style.width = '0%';
  playBtn.disabled = false;
});

// --- Retours du processus principal ---
window.api.onStatus((s) => (statusEl.textContent = s));
window.api.onProgress((p) => {
  if (p && p.total) {
    const pct = Math.min(100, Math.round((p.task / p.total) * 100));
    barFill.style.width = pct + '%';
    statusEl.textContent = `${p.type || 'Téléchargement'} — ${pct}%`;
  }
});
