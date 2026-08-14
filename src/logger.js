const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const dir = path.join(app.getPath('userData'), 'logs');
const file = path.join(dir, 'latest.log');

function init() {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `=== EmeriaMC launcher — ${new Date().toISOString()} ===\n`);
  } catch {
    /* ignore */
  }
}
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try {
    fs.appendFileSync(file, line);
  } catch {
    /* ignore */
  }
}

module.exports = { init, log, file };
