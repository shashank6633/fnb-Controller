'use client';

/**
 * Food Quality Checks (owner §6).
 *
 * The record for this area IS a checklist — FSSAI-BUILD-STATE.md §2, from the
 * owner's §24: *"keep the checklist engine configurable so management can update
 * requirements whenever regulations or internal SOPs change"*. So this screen
 * lists the checklists that cover food quality, shows when each was last
 * recorded, and leads to the runner or the builder. It owns no table of its own
 * and writes nothing.
 *
 * It replaces the PhaseShell that stood here. The shell's promises are kept by
 * the two ready-made checklists in src/lib/fssai-checklist-pack.ts — the
 * per-shift pre-service check and the cooked-and-held check — including the
 * thing the shell said it would do that only the engine can do: refuse to close
 * a failed item until the corrective action has been raised against it.
 */

import SeededModuleScreen from '../_components/SeededModuleScreen';

export default function FssaiFoodQualityPage() {
  return (
    <SeededModuleScreen
      href="/fssai/food-quality"
      moduleKey="food-quality"
      covers={[
        'Look, smell, taste and texture of each prepared dish, judged before anything is plated for a guest.',
        'The counter temperatures at the pass — hot food at 65 °C or above, cold food at 5 °C or below, cooked from raw to a 75 °C core.',
        'How long cooked food has been held, and whether anything was reheated more than once.',
        'What was rejected, remade or thrown, with a photograph of anything you were not happy with.',
        'A failed answer raises a corrective action, so the record shows what was done about it and not only that it happened.',
      ]}
    />
  );
}
