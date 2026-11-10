# Valet — deploy and rollback notes (for review; nothing is deployed without the owner's "Deploy")

## Before deploying

1. `git fetch` and merge the latest `origin/main` into `valet-parking-1109`; resolve nothing by
   guessing — stop and ask if a valet file and a main change overlap.
2. Run the regression gate (harness/valet/gate.sh): every repo suite on pure `origin/main` and on the
   branch against ONE database snapshot; they must match exactly, plus the valet suite and a clean
   `next build`. Known baseline failures on main today (not valet): run-tests 2 department-sentinel
   checks; report-builder-tests harness crash on `'total'`.
3. Deploy the normal way (Lightsail via the GitHub Action). No new environment variable is needed.

## What changes for people on deploy day

* Nobody sees valet: the role ticks start OFF and every outlet starts with valet OFF.
* The Cashier bill screen is unchanged for everyone without a valet tick (the valet box answers
  "nothing to show" and renders nothing).
* WhatsApp: valet sends nothing until an outlet ticks real sending AND templates are named AND a
  guest links their number. Prod has no Meta app secret today → valet ignores WhatsApp webhooks
  until it is pasted.
* RFID is OFF; NFC links only exist once the head gives a tag a link.
* On start, the valet worker begins its 20-second tick (production only). With valet off everywhere
  it finds nothing to do.

## Checks right after deploy

* App starts; logs show no `[valet] schema statement failed`.
* `/valet` opens for the owner; a normal staff login does not see Valet in the sidebar.
* Cashier screen: open a bill as a normal cashier — no valet box, and no valet request errors in the
  browser console (the valet check answers 200 "nothing to show").
* `/valet-pass?e=nonsense` opens and says "No valet pass on this phone yet" (public page works, reveals nothing).

## Rollback

* **Soft (no code change, seconds):** Valet Settings → **Switch OFF** per outlet (staff and guests
  lose access at once; data kept), and/or untick the valet role ticks.
* **Code rollback:** redeploy the previous commit. The 27 `valet_…` tables and the three `roles`
  columns stay in the database unused — they are additive and harmless. **Do not drop them** without
  the owner's say-so (they hold the custody and handover history).
* Notification kill switch: untick "Send REAL WhatsApp messages" (queued messages then go to the
  simulator, nothing is sent).
* RFID kill switch: Rules → RFID mode **Off**, or disable the reader (its token stops working).
