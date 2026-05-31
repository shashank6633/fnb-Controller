const fs = require('fs');
const pdfParse = require('pdf-parse');
const path = require('path');

// Inline the parser via tsx since the lib is .ts
const PDF_PATH = '/Users/shashankreddy/Downloads/09-04-2026_Kiran_Kumar.pdf';

(async () => {
  const buf = fs.readFileSync(PDF_PATH);
  const result = await pdfParse(buf);
  const text = result.text || '';
  const lines = text.split(/\r?\n/);

  // Recreate the booking + menu + bar parse using the same logic — minimal copy for smoke test
  const BOOKING_LABELS = new Set([
    'Booking', 'Event Date', 'Day', 'Time', 'Area', 'Min Guar.', 'Min Guar',
    'Guest', 'Phone', 'Company', 'Package', 'Reference', 'Payment',
    'Rate/Head', 'Advance', 'Est. Bill',
  ]);
  const m = new Map();
  for (let i = 0; i < lines.length; i++) {
    const label = lines[i].trim().replace(/[.:]+$/, '');
    if (!BOOKING_LABELS.has(label) && !BOOKING_LABELS.has(label + '.')) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const val = lines[j].trim();
      if (!val) continue;
      const valAsLabel = val.replace(/[.:]+$/, '');
      if (BOOKING_LABELS.has(valAsLabel) || BOOKING_LABELS.has(valAsLabel + '.')) break;
      if (/^(MENU SELECTION|DRINKS & BAR|ENTERTAINMENT|SIGN-OFF|TERMS)/i.test(val)) break;
      m.set(label === 'Min Guar.' ? 'Min Guar' : label, val);
      break;
    }
  }
  console.log('━━━ BOOKING FIELDS ━━━');
  for (const [k, v] of m) console.log(`  ${k.padEnd(14)} = ${v}`);
})();
