# Valet — hardware notes

Valet needs **no special hardware**: ordinary phones with a browser, and paper. Everything below
is optional. Nothing here was bought, and **no physical NFC or RFID device has been tested** — the
software paths were tested in a desktop browser and with the built-in simulators only.

## Phones (attendants, desk, Valet Head)

* Any recent Android or iPhone with Chrome/Safari. The attendant screen is built for one hand at
  375 px wide. Camera scanning of key-tag QR/barcodes uses the same scanner as the kitchen screens.
* Keep the attendant page open during the shift (the board shows "device quiet" otherwise).

## QR standee / table cards

* Print the **venue check-in QR** from Valet Settings → Guest check-in QR (Print). Paper outlets
  also get a **table / bill-folder** link (Settings → Paper ticket books).
* "New link" in Settings changes the link: every old standee/card stops working — reprint.

## NFC cards and key-tag stickers (optional)

* Any **NFC Forum Type 2** tag that stores an **NDEF URL** works — e.g. NXP NTAG213 (144 bytes, enough
  for these links), NTAG215/216. Use on-metal stickers for metal key fobs.
* What goes on them: ONE URL record and nothing else (see docs/valet/DESIGN.md §6b) —
  venue card `/valet-pass?e=…`, table card `/valet-pass?e=…&paper=1`, key-tag sticker
  `/valet/attendant?nfc=…` (copy each link from Valet Settings → NFC cards and key-tag stickers;
  "All links (CSV)" exports every key-tag link for bulk writing).
* **Writing**: Chrome on Android can write straight from Valet Settings ("Write to NFC" appears only
  where the browser supports it). Anywhere else use a writer app (NXP TagWriter, NFC Tools) → add a
  URL record → write → **lock** the tag so nobody can overwrite it.
* **Reading**: a phone's ordinary NFC tap opens the link — iPhone (XS and later, screen on, unlocked)
  and Android (NFC on). No app, no Web NFC. Attendants on Chrome/Android also get a **Tap key tag
  (NFC)** button that reads the sticker in the page and checks the chip serial (copy detection).
* **Attendant tap cards**: one NTAG213 card per attendant (badge or lanyard). Copy the attendant's
  link from Valet Settings → NFC panel → Attendant tap cards, write it once, lock it. Guests tap it
  with their phone; the attendant confirms the number shown on both phones. A phone cannot be read
  as a card, and a website cannot make a phone act as one — that is why the card is needed.
* Not supported: Web NFC on iPhone/Safari, desktop browsers, Firefox. The QR and typed-number paths
  always remain.
* Security: an NFC link is an address, not a key. Stickers can be copied; a key-tag sticker opens only
  for signed-in valet staff of that outlet, and a car is released only with the guest's code, claim
  receipt or the head's recorded recovery.

## Printer for claim receipts (optional)

* "Print claim receipt" uses the browser's print dialog — any printer the phone/PC can print to,
  including 80 mm receipt printers set up as a system printer. The receipt shows the tag and the
  8-character claim code as text (no QR); printing a new receipt cancels the old code. Treat printed
  receipts like cash tickets.

## UHF RFID readers (optional, later)

Normal phones **cannot** read UHF RFID. This is a fixed-reader add-on and stays **OFF** until the
owner has chosen a reader, placed it and field-tested it (Valet Settings → Rules → RFID mode).

* **What the software expects**: a reader (or its middleware/edge box) that can make an **HTTPS
  POST** per read or per batch to `https://<your domain>/api/valet-rfid/ingest` with header
  `Authorization: Bearer <reader token>` and body
  `{"events":[{"event_id":"<unique per reader>","epc":"<hex EPC>","antenna":"1","observed_at":"<ISO time, UTC>"}]}`.
  An empty `events` list is a heartbeat (keeps the reader "healthy"; send one at least every 5 min).
  Up to 200 reads per request. The reader's clock must be within 2 minutes (NTP on).
* Readers that only speak LLRP or a vendor SDK need a small bridge on site that converts to the
  above — not built; budget for it when choosing hardware.
* Register each reader in Valet Settings → RFID readers (owner/admin) to get its token (shown once).
  Record the EPC of each key-tag inlay against the tag (NFC panel → RFID EPC).
* What it does: shows "keys seen near <reader/zone>, N reads, unconfirmed" on the car's drawer.
  What it never does: move a car, release a car, identify an owner, or claim an exact spot.
  Gate/barrier control is out of scope.
* Before switching to **Live**: confirm reader model + protocol, antenna placement (key cabinet /
  gate), read range on real fobs, duplicate behaviour, clock sync, and a week on **Simulator** for
  staff practice.
