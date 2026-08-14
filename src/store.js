const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const file = path.join(app.getPath('userData'), 'config.json');

function read() {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}
function write(obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  } catch {
    /* ignore */
  }
}

module.exports = {
  get(key, def) {
    const o = read();
    return key in o ? o[key] : def;
  },
  set(key, val) {
    const o = read();
    o[key] = val;
    write(o);
  },
};
