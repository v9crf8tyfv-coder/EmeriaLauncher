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
  playBtn.textContent = 'JEU EN COURS';
  statusEl.textContent = 'Démarrage…';
  try {
    await window.api.launch({ ram: 4 });
    statusEl.textContent = 'Jeu en cours 🎮';
    barFill.style.width = '0%';
    // Le bouton reste « JEU EN COURS » + désactivé tant que le jeu tourne.
  } catch (e) {
    statusEl.textContent = 'Erreur : ' + (e?.message || e);
    playBtn.textContent = 'LANCER';
    playBtn.disabled = false;
  }
});

// Le jeu s'est fermé -> on redonne « LANCER » (si toujours connecté)
window.api.onClosed(() => {
  statusEl.textContent = connected ? 'Prêt à jouer' : 'Connecte-toi pour jouer';
  barFill.style.width = '0%';
  playBtn.textContent = 'LANCER';
  playBtn.disabled = !connected;
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
