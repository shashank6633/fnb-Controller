/**
 * HRMS — pure geofence math (Phase 2).
 *
 * PURE MODULE — no DB import, no server-only import, no side effects. Safe to
 * import from both server routes and 'use client' components (mirrors the
 * purity contract of ./hr.ts). Contract: docs/HRMS_DECISIONS.md D3 —
 * "Haversine in src/lib/hr-geo.ts (pure, no DB). Radius is data, not code."
 *
 * The geofence itself (lat/lng/radius_m/accuracy_threshold_m) is a row of
 * hr_geofences; this module only does the arithmetic. grace_seconds is
 * deliberately NOT evaluated here — grace is a policy about how long an
 * 'outside' verdict must persist before it matters, which needs a clock and
 * event history, i.e. the attendance engine's business, not geometry's.
 */

/** A device fix. accuracy_m is the GPS-reported 68%-confidence radius. */
export interface GeoPoint {
  lat: number;
  lng: number;
  /** Metres of GPS uncertainty; null/undefined = the device didn't say. */
  accuracy_m?: number | null;
}

/** The subset of an hr_geofences row the evaluation reads. A full row fits. */
export interface GeofenceLike {
  lat: number;
  lng: number;
  /** Fence radius in metres (> 0; hr_geofences defaults 100). */
  radius_m: number;
  /** Fixes less accurate than this are unusable (hr_geofences defaults 50). */
  accuracy_threshold_m: number;
}

/** Matches the hr_attendance_events.geofence_status vocabulary exactly. */
export type GeofenceStatus = 'inside' | 'outside' | 'unknown';

export interface GeofenceEval {
  status: GeofenceStatus;
  /**
   * Great-circle distance from the fix to the fence centre, in metres
   * (rounded to 0.1 m). null when either coordinate pair is not finite —
   * there is nothing to measure. Note a status of 'unknown' does NOT imply
   * null distance: a low-accuracy fix still has a measurable distance, it
   * just cannot be trusted to place the person inside or outside.
   */
  distance_m: number | null;
}

/** Mean Earth radius in metres (IUGG). */
const EARTH_RADIUS_M = 6371000;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Great-circle distance between two WGS-84 points in metres (haversine).
 * Symmetric, non-negative; ~0.5% worst-case error from Earth's ellipticity,
 * which is noise at geofence scales (tens to hundreds of metres).
 * Returns NaN if any input is not a finite number.
 */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  if (!isFiniteNum(lat1) || !isFiniteNum(lng1) || !isFiniteNum(lat2) || !isFiniteNum(lng2)) {
    return NaN;
  }
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const a =
    sinLat * sinLat +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * sinLng * sinLng;
  // clamp against floating-point drift pushing `a` a hair past 1
  const c = 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
  return EARTH_RADIUS_M * c;
}

/**
 * Judge a device fix against one geofence.
 *
 *  - Either coordinate pair not finite            → 'unknown', distance null.
 *  - Fix accuracy exceeds the fence's threshold   → 'unknown' (the fix's own
 *    error circle is wider than we tolerate — it cannot place the person),
 *    but distance_m is still reported for display.
 *  - Otherwise inside ⇔ distance ≤ radius_m.
 *
 * A fix with NO reported accuracy is treated as usable (manual/import punches
 * never reach this function — they carry no coordinates at all; a GPS caller
 * that omits accuracy has decided to trust its fix).
 */
export function evalGeofence(point: GeoPoint, fence: GeofenceLike): GeofenceEval {
  const distRaw = haversineMeters(point?.lat, point?.lng, fence?.lat, fence?.lng);
  if (!Number.isFinite(distRaw)) return { status: 'unknown', distance_m: null };

  const distance_m = Math.round(distRaw * 10) / 10;

  const accuracy = point?.accuracy_m;
  const threshold = fence?.accuracy_threshold_m;
  if (isFiniteNum(accuracy) && accuracy > 0 && isFiniteNum(threshold) && threshold > 0 && accuracy > threshold) {
    return { status: 'unknown', distance_m };
  }

  const radius = isFiniteNum(fence?.radius_m) && fence.radius_m > 0 ? fence.radius_m : 0;
  return { status: distance_m <= radius ? 'inside' : 'outside', distance_m };
}
