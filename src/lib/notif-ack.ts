'use client';

/**
 * Notification acknowledgement — lets a user "clear" the bell badge.
 *
 * The bell counts are LIVE pending-work counts (unresolved recoveries, approvals,
 * app errors, tasks, plus the captain's live table alerts) — there's no
 * "mark-as-read" table. So "clearing" = acknowledging the CURRENT state per item:
 *   - inbox buckets are acked at their current COUNT → they stop counting until
 *     the count GROWS again (genuinely new activity re-surfaces them),
 *   - live table alerts are acked by their unique ID → a NEW order/request (new
 *     id) re-alerts.
 * Stored in localStorage (per device). Best-effort; every function is safe on the
 * server (no window) and never throws.
 */
export interface AckState {
  inbox: Record<string, number>;  // bucket key → acknowledged count
  alerts: string[];               // acknowledged live-alert ids
}

const KEY = 'akan_notif_ack';
const EMPTY: AckState = { inbox: {}, alerts: [] };

export function loadAck(): AckState {
  try {
    if (typeof localStorage === 'undefined') return { inbox: {}, alerts: [] };
    const a = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {
      inbox: a && typeof a.inbox === 'object' && a.inbox ? a.inbox : {},
      alerts: Array.isArray(a?.alerts) ? a.alerts : [],
    };
  } catch { return { inbox: {}, alerts: [] }; }
}

export function saveAck(a: AckState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
    // The native 'storage' event only fires in OTHER tabs, so broadcast a custom
    // event too — this lets a second bell mounted in THE SAME tab resync at once.
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('akan-notif-ack'));
  } catch { /* ignore */ }
}

/**
 * Drop acks so genuinely-new work re-surfaces. Given the previous and current
 * per-bucket counts, remove the ack for any bucket whose count ROSE (incl.
 * reappearing after resolving to 0) and for any bucket that has VANISHED from the
 * live set. Returns the same object if nothing changed (so callers can skip a
 * state update). The counts model has no per-item ids, so "count went up since
 * last poll" is our signal for "there's something new here".
 */
export function refreshInboxAcks(
  a: AckState,
  prevCounts: Record<string, number>,
  liveItems: Array<{ key: string; count: number }>,
): AckState {
  const liveKeys = new Set(liveItems.map((i) => i.key));
  let changed = false;
  const inbox = { ...a.inbox };
  for (const it of liveItems) {
    if ((Number(it.count) || 0) > (prevCounts[it.key] ?? 0) && it.key in inbox) { delete inbox[it.key]; changed = true; }
  }
  for (const k of Object.keys(inbox)) if (!liveKeys.has(k)) { delete inbox[k]; changed = true; }
  return changed ? { ...a, inbox } : a;
}

/** An inbox bucket still "counts" only when its live count exceeds what was acked. */
export function isInboxAcked(a: AckState, key: string, count: number): boolean {
  return (Number(count) || 0) <= (a.inbox[key] || 0);
}
export function isAlertAcked(a: AckState, id: string): boolean {
  return a.alerts.includes(id);
}

export function ackInboxItem(a: AckState, key: string, count: number): AckState {
  return { ...a, inbox: { ...a.inbox, [key]: Number(count) || 0 } };
}
export function ackAlertId(a: AckState, id: string): AckState {
  return a.alerts.includes(id) ? a : { ...a, alerts: [...a.alerts, id] };
}

/** Acknowledge EVERYTHING currently showing (the "Clear all" action). */
export function ackEverything(
  a: AckState,
  inboxItems: Array<{ key: string; count: number }>,
  alertItems: Array<{ id: string }>,
): AckState {
  const inbox = { ...a.inbox };
  for (const it of inboxItems) inbox[it.key] = Number(it.count) || 0;
  const alerts = Array.from(new Set([...a.alerts, ...alertItems.map((x) => x.id)]));
  return { inbox, alerts };
}

/** Drop ack entries for items that no longer exist, so the store can't grow. */
export function pruneAck(a: AckState, liveInboxKeys: string[], liveAlertIds: string[]): AckState {
  const inbox: Record<string, number> = {};
  for (const k of liveInboxKeys) if (k in a.inbox) inbox[k] = a.inbox[k];
  const alerts = a.alerts.filter((id) => liveAlertIds.includes(id));
  return { inbox, alerts };
}
