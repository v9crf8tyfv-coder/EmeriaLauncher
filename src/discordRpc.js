// Discord Rich Presence SANS dépendance externe (socket IPC Discord via Node `net`).
// Affiche « Joue à EmeriaMC » sur le profil quand le launcher est ouvert / en jeu.
const net = require('net');

function ipcPath(i) {
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${i}`;
  const base = (process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp').replace(/\/$/, '');
  return `${base}/discord-ipc-${i}`;
}
function encode(op, data) {
  const payload = Buffer.from(JSON.stringify(data));
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeInt32LE(op, 0);
  buf.writeInt32LE(payload.length, 4);
  payload.copy(buf, 8);
  return buf;
}

class DiscordRPC {
  constructor(clientId) { this.clientId = clientId; this.activity = null; this.socket = null; this.connected = false; this.retry = null; }

  connect() {
    let i = 0;
    const tryNext = () => {
      if (i > 9) return this.scheduleRetry();
      const s = net.connect(ipcPath(i++));
      s.on('connect', () => { this.socket = s; s.write(encode(0, { v: 1, client_id: this.clientId })); });
      s.on('error', () => { try { s.destroy(); } catch (e) {} tryNext(); });
      s.on('data', (d) => this.onData(d));
      s.on('close', () => { this.connected = false; this.socket = null; this.scheduleRetry(); });
    };
    tryNext();
  }
  onData(buf) {
    let off = 0;
    while (off + 8 <= buf.length) {
      const len = buf.readInt32LE(off + 4);
      const json = buf.slice(off + 8, off + 8 + len).toString();
      off += 8 + len;
      try { const m = JSON.parse(json); if (m.evt === 'READY') { this.connected = true; if (this.activity) this._send(this.activity); } } catch (e) {}
    }
  }
  scheduleRetry() { if (this.retry) return; this.retry = setTimeout(() => { this.retry = null; this.connect(); }, 8000); }
  _send(activity) {
    if (!this.socket || !this.connected) return;
    try { this.socket.write(encode(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity }, nonce: `${Date.now()}-${Math.random()}` })); } catch (e) {}
  }
  setActivity(activity) { this.activity = activity; this._send(activity); }
}

const SITE = 'https://emeria-site.com';
function activity(state, start) {
  return {
    details: 'EmeriaMC',
    state,
    timestamps: { start },
    assets: { large_image: 'logo', large_text: 'EmeriaMC' },
    buttons: [{ label: 'Rejoindre', url: SITE }],
    instance: false,
  };
}

let rpc = null;
let sessionStart = Math.floor(Date.now() / 1000);
function start(clientId) {
  try {
    rpc = new DiscordRPC(clientId);
    rpc.connect();
    onLauncher();
  } catch (e) { /* Discord absent → on ignore */ }
}
function onLauncher() { if (rpc) rpc.setActivity(activity('Actuellement sur le launcher', sessionStart)); }
function onInGame() { if (rpc) { sessionStart = Math.floor(Date.now() / 1000); rpc.setActivity(activity('En jeu', sessionStart)); } }

module.exports = { start, onLauncher, onInGame };
