'use client';

/**
 * Inspection Mode — P9. Management only (page-catalog mgmtOnly).
 *
 * Honest shell. This is the screen held in the hand while an outsider reads it, so
 * it is management-only (an outsider must not be handed an editable screen, and
 * admin-only would mean nobody could open it unless the owner were present). It is
 * read-only by design; it is built last because it reads everything else.
 *
 * IT PASSES ITS OWN `notice`, AND THAT IS NOT DECORATION. Every other shell opens
 * with "This screen is not built yet … it holds no records of its own", which is
 * written for the owner and is true of the SOFTWARE. On this screen — the one
 * literally handed to a visiting officer — the same words, read over a shoulder,
 * sound like an admission that the RESTAURANT keeps no records. So this page says
 * what is true without saying that. The rule outlives the shell: when P9 builds
 * the real Inspection Mode, nothing on it may describe what the restaurant lacks.
 */

import PhaseShell from '../_components/PhaseShell';

export default function FssaiInspectionModePage() {
  return (
    <PhaseShell
      href="/fssai/inspection-mode"
      notice={{
        title: 'This screen is not built yet',
        body:
          'Inspection Mode is built last, because it has to read everything the other screens record. ' +
          'Until it exists, the licence, the certificates and each set of checks are opened one screen ' +
          'at a time from the Compliance menu.',
      }}
      will={[
        'Put the whole food-safety file on one screen you can hand over: the licence and certificates, today’s and this week’s checks, the temperature records, the pest visits, and the corrective actions with proof they were closed.',
        'Stay read-only while it is open, so nothing can be changed — accidentally or otherwise — with somebody else holding the tablet.',
        'Open each section in a tap, without asking the person holding it to learn the app.',
        'Work properly on a tablet or a phone, because that is how it will be used.',
        'Note who opened it and when, so you know what was shown and on which visit.',
      ]}
      today={{
        text:
          'Nowhere. Today this means opening several screens in turn and explaining each one.',
      }}
      notes={[
        'It shows only real records. If a check was not done, this screen will say it was not done — which is the point of it. It is built last because it reads everything the other screens record.',
      ]}
    />
  );
}
