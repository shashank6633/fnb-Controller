#!/usr/bin/env node
/**
 * Generate PWA icons (PNG) from a brand-coloured SVG.
 * Run once after editing colors / logo:
 *   node scripts/generate-pwa-icons.js
 *
 * Outputs:
 *   public/icon-192.png         (Android home screen, default)
 *   public/icon-512.png         (Android splash + Play Store TWA)
 *   public/icon-maskable-512.png (Android adaptive icon — safe zone padded)
 *   public/apple-touch-icon.png (iOS home screen, 180x180)
 */
const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');

const OUT = path.join(__dirname, '..', 'public');
fs.mkdirSync(OUT, { recursive: true });

// Brand-coloured SVG: orange round-corner square with a white "F&B" wordmark
// + a chef-hat-ish glyph. Matches sidebar UtensilsCrossed visual language.
const baseSvg = ({ size, padded }) => {
  const inset = padded ? size * 0.18 : 0; // safe zone for maskable
  const r = (size - 2 * inset) * 0.18;
  const tx = size / 2;
  const fs1 = (size - 2 * inset) * 0.32;
  const fs2 = (size - 2 * inset) * 0.16;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#1C0F05"/>
  <rect x="${inset}" y="${inset}" width="${size - 2 * inset}" height="${size - 2 * inset}"
        rx="${r}" ry="${r}" fill="#af4408"/>
  <text x="${tx}" y="${size / 2 - fs2 * 0.25}"
        font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
        font-weight="900" font-size="${fs1}"
        text-anchor="middle" dominant-baseline="middle"
        fill="#FFF8F0" letter-spacing="-2">F&amp;B</text>
  <text x="${tx}" y="${size / 2 + fs1 * 0.55}"
        font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
        font-weight="600" font-size="${fs2}"
        text-anchor="middle" dominant-baseline="middle"
        fill="#FFE8D8" letter-spacing="2">CONTROLLER</text>
</svg>`;
};

async function generate() {
  const targets = [
    { name: 'icon-192.png',          size: 192, padded: false },
    { name: 'icon-512.png',          size: 512, padded: false },
    { name: 'icon-maskable-512.png', size: 512, padded: true  },
    { name: 'apple-touch-icon.png',  size: 180, padded: false },
    { name: 'favicon-32.png',        size: 32,  padded: false },
  ];
  for (const t of targets) {
    const svg = Buffer.from(baseSvg({ size: t.size, padded: t.padded }));
    await sharp(svg).png().toFile(path.join(OUT, t.name));
    console.log(`✓ ${t.name} (${t.size}×${t.size})`);
  }
  console.log('\nIcons generated. Push to VM with: bash deploy/push-code.sh');
}

generate().catch(err => { console.error(err); process.exit(1); });
