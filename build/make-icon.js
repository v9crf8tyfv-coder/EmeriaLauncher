// Génère build/icon.png (1024x1024) : fond violet arrondi + « E » blanc. Sans dépendance.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const SIZE = 1024;
const BG = [124, 58, 237, 255]; // violet #7C3AED
const FG = [255, 255, 255, 255]; // blanc
const RADIUS = 190; // coins arrondis

const data = Buffer.alloc(SIZE * SIZE * 4);
const set = (x, y, c) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  data[i] = c[0];
  data[i + 1] = c[1];
  data[i + 2] = c[2];
  data[i + 3] = c[3];
};
const rect = (x0, y0, x1, y1, c) => {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, c);
};

// Fond violet + coins arrondis (transparent hors du rayon)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let inside = true;
    const cx = x < RADIUS ? RADIUS : x >= SIZE - RADIUS ? SIZE - RADIUS - 1 : x;
    const cy = y < RADIUS ? RADIUS : y >= SIZE - RADIUS ? SIZE - RADIUS - 1 : y;
    if ((x < RADIUS || x >= SIZE - RADIUS) && (y < RADIUS || y >= SIZE - RADIUS)) {
      inside = (x - cx) ** 2 + (y - cy) ** 2 <= RADIUS ** 2;
    }
    set(x, y, inside ? BG : [0, 0, 0, 0]);
  }
}

// Lettre « E »
const top = 250,
  bottom = 774,
  left = 340,
  thick = 130,
  rightFull = 700,
  rightMid = 640;
rect(left, top, left + thick, bottom, FG); // barre verticale
rect(left, top, rightFull, top + thick, FG); // barre haut
const midY = Math.floor((top + bottom) / 2 - thick / 2);
rect(left, midY, rightMid, midY + thick, FG); // barre milieu
rect(left, bottom - thick, rightFull, bottom, FG); // barre bas

// --- Encodage PNG (RGBA) ---
const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, body) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, body])), 0);
  return Buffer.concat([len, typeBuf, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
// scanlines avec filtre 0
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  data.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
console.log('icon.png généré (' + png.length + ' octets)');
