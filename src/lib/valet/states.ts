/**
 * VALET — the explicit state model. Pure data + pure functions, no imports, so
 * client components, the server and the test suite all read ONE table.
 * docs/valet/DESIGN.md §3 is the prose version of what is enforced here.
 *
 * Two machines, never one ambiguous status:
 *   - the VEHICLE (where the car physically is, and who holds it)
 *   - the PICKUP  (a guest's request to have it brought out; many per stay)
 */

export const VEHICLE_STATES = [
  'CHECKED_IN', 'PARKING', 'PARKED', 'RETRIEVING', 'READY_AT_GATE',
  'RELOCATING', 'HOLDING_NEAR_GATE', 'HANDED_OVER', 'VOIDED',
] as const;
export type VehicleState = typeof VEHICLE_STATES[number];

export const PICKUP_STATES = [
  'SCHEDULED', 'QUEUED', 'ASSIGNED', 'IN_PROGRESS', 'READY',
  'COMPLETED', 'CANCELLED', 'NO_SHOW',
] as const;
export type PickupState = typeof PICKUP_STATES[number];

/** States in which the venue still physically holds the car. */
export const HELD_STATES: readonly VehicleState[] = [
  'CHECKED_IN', 'PARKING', 'PARKED', 'RETRIEVING', 'READY_AT_GATE', 'RELOCATING', 'HOLDING_NEAR_GATE',
];
export const FINAL_VEHICLE: readonly VehicleState[] = ['HANDED_OVER', 'VOIDED'];
export const ACTIVE_PICKUP: readonly PickupState[] = ['SCHEDULED', 'QUEUED', 'ASSIGNED', 'IN_PROGRESS', 'READY'];
/** Pickup states in which an attendant has claimed the physical work. */
export const CLAIMED_PICKUP: readonly PickupState[] = ['ASSIGNED', 'IN_PROGRESS', 'READY'];

/** Allowed vehicle transitions. Anything not listed is refused by the server. */
export const VEHICLE_TRANSITIONS: Record<VehicleState, readonly VehicleState[]> = {
  CHECKED_IN:        ['PARKING', 'PARKED', 'VOIDED'],
  PARKING:           ['PARKED', 'VOIDED'],
  PARKED:            ['PARKING', 'RETRIEVING', 'VOIDED'],
  RETRIEVING:        ['READY_AT_GATE', 'PARKING', 'VOIDED'],
  READY_AT_GATE:     ['HANDED_OVER', 'RELOCATING', 'PARKING', 'VOIDED'],
  RELOCATING:        ['HOLDING_NEAR_GATE', 'PARKED', 'VOIDED'],
  HOLDING_NEAR_GATE: ['RETRIEVING', 'PARKING', 'VOIDED'],
  HANDED_OVER:       [],
  VOIDED:            [],
};

export const PICKUP_TRANSITIONS: Record<PickupState, readonly PickupState[]> = {
  SCHEDULED:   ['QUEUED', 'CANCELLED', 'SCHEDULED'],
  QUEUED:      ['ASSIGNED', 'CANCELLED', 'SCHEDULED'],
  ASSIGNED:    ['IN_PROGRESS', 'QUEUED', 'ASSIGNED', 'CANCELLED'],
  IN_PROGRESS: ['READY', 'IN_PROGRESS', 'CANCELLED'],
  READY:       ['COMPLETED', 'NO_SHOW', 'CANCELLED'],
  COMPLETED:   [],
  CANCELLED:   [],
  NO_SHOW:     [],
};

export function canVehicle(from: string, to: VehicleState): boolean {
  return (VEHICLE_TRANSITIONS as Record<string, readonly string[]>)[from]?.includes(to) ?? false;
}
export function canPickup(from: string, to: PickupState): boolean {
  return (PICKUP_TRANSITIONS as Record<string, readonly string[]>)[from]?.includes(to) ?? false;
}
export const isHeld = (s: string) => (HELD_STATES as readonly string[]).includes(s);
export const isActivePickup = (s: string) => (ACTIVE_PICKUP as readonly string[]).includes(s);

/** Board lanes, in the order the spec lists them (§6). */
export const BOARD_LANES = [
  'pending', 'parking', 'parked', 'scheduled', 'requested', 'fetching', 'ready', 'holding', 'completed',
] as const;
export type BoardLane = typeof BOARD_LANES[number];

/** Which lane a car sits in. The pickup wins when it says more than the car. */
export function laneFor(vehicle: string, pickup: string | null): BoardLane {
  if (vehicle === 'HANDED_OVER' || vehicle === 'VOIDED') return 'completed';
  if (vehicle === 'READY_AT_GATE') return 'ready';
  if (vehicle === 'RELOCATING' || vehicle === 'HOLDING_NEAR_GATE') {
    if (pickup === 'ASSIGNED' || pickup === 'IN_PROGRESS') return 'fetching';
    if (pickup === 'QUEUED') return 'requested';
    if (pickup === 'SCHEDULED') return 'scheduled';
    return 'holding';
  }
  if (vehicle === 'RETRIEVING') return 'fetching';
  if (pickup === 'ASSIGNED' || pickup === 'IN_PROGRESS') return 'fetching';
  if (pickup === 'QUEUED') return 'requested';
  if (pickup === 'SCHEDULED') return 'scheduled';
  if (vehicle === 'CHECKED_IN' || vehicle === 'PARKING') return 'parking';
  return 'parked';
}

/** Tag lifecycle. Only 'available' tags can be put on a new car. */
export const TAG_STATUSES = ['available', 'in_use', 'disabled', 'lost', 'retired'] as const;
export type TagStatus = typeof TAG_STATUSES[number];

export const ZONE_KINDS = ['parking', 'gate', 'holding'] as const;
export type ZoneKind = typeof ZONE_KINDS[number];

export const KEY_LOCATIONS = ['attendant', 'rack', 'desk', 'guest'] as const;
export type KeyLocation = typeof KEY_LOCATIONS[number];

export const INCIDENT_KINDS = ['damage', 'complaint', 'lost_key', 'dispute', 'delay', 'other'] as const;

export const HANDOVER_METHODS = ['guest_code', 'claim_code', 'head_recovery'] as const;
export type HandoverMethod = typeof HANDOVER_METHODS[number];

/** Verification methods a Valet Head may record for a recovery handover.
 *  Government-ID images are deliberately NOT a method (spec §7). */
export const RECOVERY_METHODS = [
  'known_guest_vouched_by_manager', 'bill_or_reservation_match', 'vehicle_documents_shown',
  'ownership_questions_answered', 'other_documented',
] as const;
