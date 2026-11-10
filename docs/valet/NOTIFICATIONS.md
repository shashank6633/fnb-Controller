# Valet — WhatsApp messages: what the owner sets up

Valet can send a guest **five** short WhatsApp messages about their car. Nothing is sent until all
of these are true:

1. The app's WhatsApp is connected (Settings → Integrations → WhatsApp — the owner pastes the
   credentials there; valet never stores its own copy).
2. The outlet's **"Send REAL WhatsApp messages from this outlet"** box is ticked (Valet Settings →
   Rules). It is **off** by default. While it is off, every message goes to the **simulator** list
   in Valet Settings → Guest messages, marked SIMULATED, and nothing leaves the building.
3. A template name is filled in for that message (Valet Settings → Rules → Guest WhatsApp messages).
4. The guest chose WhatsApp updates on their own pass and sent the short code from their phone
   (that message is the proof of their number **and** their consent). A number typed by staff is
   never messaged.

Also needed for delivery receipts and replies: the **Meta app secret** pasted in Settings →
Integrations → WhatsApp. Without it, valet ignores incoming WhatsApp events (they cannot be proven
to come from Meta), so "delivered/read" ticks and the guest's NOW reply will not arrive.

## Templates to create in WhatsApp Manager (category: **Utility**)

Create each in every language you want (e.g. `en`, `hi`); put the template's exact name and
language code in Valet Settings. `{{1}}`, `{{2}}` are filled by the app in this order:

| Valet message | When it is sent | `{{1}}` | `{{2}}` | Example body |
|---|---|---|---|---|
| Pass linked (`linked`) | right after the guest's code message is received | — | — | "You will get updates about your car here. Reply STOP to stop." |
| Car ready (`ready`) | the attendant marks the car ready at the gate | tag number, e.g. `07` | pickup point, e.g. `Main porch` | "Your car (tag {{1}}) is ready at {{2}}." |
| Moved to holding (`holding`) | the guest did not come within the gate wait; car moved near the gate | tag | pickup point | "We have moved your car (tag {{1}}) to a safe spot near {{2}}. Tell the valet when you are outside." |
| New estimate (`eta_changed`) | the Valet Head changes the estimate for a car being fetched | tag | minutes range, e.g. `10-15` | "Update for tag {{1}}: about {{2}} minutes." |
| Closing-time question (`closing_prompt`) | before closing, if "closing rush" is on, to linked guests whose car is still parked | tag | closing time, e.g. `01:00` | "We close at {{2}}. Reply NOW and we will bring your car (tag {{1}}) to the gate." |

Never put a guest name, phone number, plate or any code in a template — the app does not send them.

## What a guest can reply

| Reply | What happens |
|---|---|
| `VALET <code>` (pre-filled by the pass button) | links their number to that pass (verification + consent) |
| `NOW`, `1`, `BRING MY CAR`, `GET MY CAR`, or a quick-reply button with payload `VALET_NOW` | requests the car **only if exactly one** car is linked to that number; otherwise staff get an alert |
| `STOP`, `STOP ALL`, `UNSUBSCRIBE` | no more messages; recorded |
| anything else | ignored (staff are not spammed) |

## Status ladder (Valet Settings → Guest messages)

`queued` → `sent` (WhatsApp accepted it) → `delivered` / `read` (only from a **signed** webhook) or
`failed`. Retries after 1, 5 and 15 minutes, then `failed` and a board alert. A message that no
longer makes sense (car already handed over) is `cancelled`, not sent late. "Sent" is never shown as
"delivered".
