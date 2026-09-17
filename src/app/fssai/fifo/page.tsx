'use client';

/**
 * FIFO & Expiry Management — Phase 5.
 *
 * Honest shell. Kitchen Production already tracks produced batches with a barcode
 * and an expiry, and the ordering maths lives in src/lib/production-batch.ts
 * (computeFifo) — Phase 5 reads that, and must never write a second ranking or
 * move any stock. Bought-in goods carry no batch or expiry anywhere today; that is
 * stated here rather than papered over, because it is one of the open questions.
 */

import PhaseShell from '../_components/PhaseShell';

export default function FssaiFifoPage() {
  return (
    <PhaseShell
      href="/fssai/fifo"
      will={[
        'List what is closest to its expiry first, so the kitchen uses the older stock before the newer stock.',
        'Warn on what expires in the next few days, and flag what has already gone past its date.',
        'Record a disposal properly — what was thrown, how much, why, and who authorised it.',
        'Read the batch labels the kitchen already prints, by scanning the barcode, instead of keeping a second list of stock.',
        'Give you the daily shelf walk as a checklist, so "we check the dates" becomes a signed record.',
      ]}
      today={{
        text:
          'Kitchen Production already gives every batch it makes a barcode, a production date and an expiry, and already sorts them oldest-first. Phase 5 reads those batches. It will not create a second stock list, and it will never move material.',
        links: [{ href: '/kitchen-production', label: 'Kitchen Production' }],
      }}
      notes={[
        'A real gap, measured: bought-in goods have no batch number and no expiry date anywhere in the system — not on the purchase, not on the goods receipt, and the shelf-life field on all 952 items in the Item Master is empty. So today this screen can only be honest about kitchen-made batches.',
        'That leaves you a decision: either we capture batch and expiry at the door when goods are received (more typing for the storekeeper, full traceability), or we stay with produced batches only for now. It is on the list of questions waiting for you.',
      ]}
    />
  );
}
