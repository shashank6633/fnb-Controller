# Valet Parking — final checklist for the owner (10 Nov 2026)

Branch `valet-parking-1109` (local only — not pushed, not merged, not deployed). Nothing reaches
fnb.akanhyd.com until you say **"Deploy"**.

## 1. What works

✅ = tried end to end in a browser on a copy of the live database (WhatsApp credentials blanked in
that copy). 🧪 = proven by the automated valet tests only.

**Guests**
- ✅ Scan the venue QR → fill car details → pairing code → valet confirms → the pass appears on the phone.
- ✅ Pass: Now / 5 / 10 min / a later time (only times the valet is open), honest estimate range,
  "I'm outside", cancel / change time, ready-at-gate countdown, rotating handover code, Hindi.
- ✅ No-phone guests: printed claim receipt with a private code.
- ✅ Paper tickets: a ticket number alone gives nothing; staff must check the paper stub.
- ✅ WhatsApp updates by the guest's own choice ("VALET <code>" from their phone), NOW reply requests
  the car, "car ready" message — all in the **simulator** (nothing sent).

**Staff**
- ✅ Attendant phone screen: shifts, check-in (code / staff / paper ticket), photos (shrunk on the
  phone, type-checked on the server), parking + key custody, Take next car (no two people get the
  same car), ready, holding, handover only with the guest's code / receipt / head recovery.
- ✅ Valet Head Dashboard: live board, "Needs attention" (unclaimed, late, waiting at gate, not
  parked, failed messages), assign / priority / estimate with reasons, team, shift handover note.
- ✅ Desk: find a car by tag, ticket, table number or last 4 of the plate; request only with the
  guest's confirmation.
- ✅ Cashier bill screen: valet staff see the guest's car and can request it after ticking "Guest
  asked"; **ordinary cashiers see no change**.
- ✅ Reports with definitions + CSV; Settings (zones, tags, rules, staff, paper books, messages).
- ✅ NFC: venue / table / key-tag links; a key-tag sticker opens that car for valet staff only;
  strangers get the sign-in page; copied-sticker alert 🧪; re-issue kills an old sticker 🧪.
- ✅ RFID (simulator): register a reader (token shown once), map key-tag EPCs, pretend reads judged
  accepted / repeat / too old / clock ahead / duplicate / unknown 🧪; drawer shows "keys seen near
  …, unconfirmed". It never moves or releases a car.
- 🧪 Escalation timing, closing-time questions, retention clean-up with incident holds, business day
  across midnight, signed-webhook delivery receipts, retries, two-phone race for the same car.

## 2. Checks actually run

- Valet automated tests: **423 passed, 0 failed** (sections A–Z) on a fresh copy of the database.
- Regression gate (every app test suite, live-data copy): the valet branch gives **exactly the same
  results as the current live code** (origin/main 1b8b290). Two failures exist on the live code
  already and are not valet's: run-tests "kitchen/liquor department sentinel" (2), report-builder
  test crash on `'total'`. Production build: compiles. Final re-run on the finished branch: §6.
- Browser passes: increment 1 (9 Nov), increment 2 and 3 (10 Nov) — the ✅ items above.
- Type check clean. Lint: 11 findings remain across all valet code, all of the app-wide "state set
  in an effect" pattern (load-on-open screens); none added or hidden in this round.

## 3. What you need to set up before using it

1. Settings → Roles: tick Valet Head / Valet Attendant / Valet Desk on the right roles (all start off).
2. Valet Settings per outlet: switch ON, zones, key tags, rules, staff, print the QR standee.
3. WhatsApp (optional): create the 5 Utility templates (docs/valet/NOTIFICATIONS.md), name them in
   Valet Settings, paste the **Meta app secret** in Settings → Integrations → WhatsApp (needed for
   delivery ticks and guest replies), test on the simulator, then tick "Send REAL WhatsApp".
4. Paper tickets (optional): register each ticket book before use.
5. NFC (optional): buy NTAG213 stickers/cards; write the links (docs/valet/HARDWARE.md).
6. RFID (optional, later): choose a reader that can POST over HTTPS (or plan a bridge), field-test,
   practise on Simulator, then Live.

## 4. Limitations — please read

- **No physical NFC or RFID device has been tested.** Web NFC read/write (Android Chrome) and the
  RFID intake are tested in code and with the simulator only.
- **Real WhatsApp sending has never been run** — only the simulator. First real send should be to
  your own number.
- Live updates use one server process; on several processes screens still refresh every few seconds.
- A table **merge** in the POS does not record where the bill went: the valet link shows "bill
  merged — re-link".
- A table with **more than one open bill** (your data has table "1" with 4 open, empty orders):
  valet refuses to guess and asks staff to link from the bill itself.
- The guest pass lives in that phone's browser; another browser (e.g. WhatsApp's in-app browser)
  needs the desk's help.
- The retention clean-up is a setting, not automatic legal compliance.
- Gate/barrier control is not part of this.

## 5. Things noticed in the existing app (not changed — your call)

- The sidebar highlights two links at once (e.g. Valet Head Dashboard + Valet Desk).
- The floating captain-alerts bell shows for every signed-in user.
- Cashier lists a table once per open order (table "1" appears 4 times; browser shows a duplicate-key
  warning).

## 6. Final gate on the finished branch

Run 10 Nov 2026 10:11–10:2x IST on commit `af7b7f1` (everything after it is documents and one code
comment). Against the same database copy, every app suite gave **exactly the same result as the
live code** (origin/main `1b8b290`): hr-payroll 73/0, fssai 778/0, broadcast 201/0, templates
530/0, WhatsApp attachments 104/0, reviews 619/0, WhatsApp report schedule 198/0, purchase charges
127/0, feedback scope 526/0, desk rule 744,117/0, routed requisitions 74/0, boot / unit / rate
checks clean; the same 2 run-tests failures and the same report-builder crash as live (not valet).
Valet tests **423/0**. Production build: **compiled successfully**.
