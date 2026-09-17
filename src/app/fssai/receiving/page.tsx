'use client';

/**
 * Receiving/Receivables Quality Check — Phase 4.
 *
 * Honest shell. The goods-receipt screen ALREADY carries a quality check that can
 * hold a delivery until the kitchen or the store signs for it (src/lib/grn-qc.ts),
 * and Phase 4's job is to extend that, not to build a second receiving screen —
 * so this page points at the real one rather than pretending to replace it.
 */

import PhaseShell from '../_components/PhaseShell';

export default function FssaiReceivingPage() {
  return (
    <PhaseShell
      href="/fssai/receiving"
      will={[
        'Check a delivery while the supplier is still at the door: temperature of the chilled and frozen items, the state of the packaging, how it looks and smells, the weight against the bill, and the expiry dates.',
        'Accept, part-accept or reject line by line, with the reason recorded against the line — not a single tick for the whole van.',
        'Take a photograph of anything you reject, so there is proof when the supplier argues about it later.',
        'A rejected line raises a corrective action by itself, and the delivery stays held until somebody signs it off.',
        'Show the whole month of deliveries with their results, for the day an inspector asks how you check what comes in.',
      ]}
      today={{
        text:
          'Deliveries are already entered as Goods Receipt Notes, and that screen already has a quality check on it — a delivery can be held as awaiting quality check until the kitchen or the store signs. The new receiving check builds on that same one. It will not ask anyone to type a delivery twice.',
        links: [
          { href: '/grn', label: 'Goods Receipt (GRN)' },
          { href: '/grn/qc', label: 'Pending Quality Checks' },
        ],
      }}
      notes={[
        'One thing measured in the existing data, worth knowing before the receiving check is built: the six quality tick-boxes on the goods-receipt screen are unticked on every delivery recorded so far. The thing that actually stops bad goods is the hold, not another tick-box — so the new check will lead with the hold.',
        'The chilled-goods temperature is currently stored only as a pass or a fail. There is nowhere to write the actual reading. The new check gives it one.',
      ]}
    />
  );
}
