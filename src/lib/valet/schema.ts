/**
 * VALET PARKING — schema (prefix `valet_`). Called once from initializeSchema()
 * in src/lib/db.ts. Rulebook: docs/valet/DESIGN.md.
 *
 * PER-STATEMENT, NOT ONE db.exec(`...`). SQLite abandons every statement after
 * the first throw in a multi-statement exec, silently, and initializeSchema
 * swallows errors — so one bad index could make the tables after it vanish with
 * no visible failure (the FSSAI block in db.ts measured exactly that). Here each
 * statement has its own try and a failure names itself.
 *
 * NO FOREIGN KEYS, house style (see the Guest Feedback block in db.ts): masters
 * (users, outlets, orders) are referenced as indexed TEXT + a denormalised name
 * so a renamed or deleted user never rewrites who parked a car. Valet history is
 * never deleted — it is voided or, after retention, redacted.
 *
 * NO CHECK CONSTRAINTS: vocabularies live in src/lib/valet/states.ts, so a later
 * state never needs a table rebuild.
 *
 * TIMES are ISO-8601 UTC strings written by one helper (nowIso() in
 * src/lib/valet/config.ts) — never mixed with datetime('now'), whose
 * 'YYYY-MM-DD HH:MM:SS' sorts wrong against ISO text (proxy.ts ruling 53).
 */
import type Database from 'better-sqlite3';

const TABLES: string[] = [
  // Per-outlet switch + configuration. enabled defaults OFF: the owner turns the
  // module on per outlet. entry_token is the PUBLIC venue QR / NFC-card token —
  // it opens the check-in entry point and nothing else, and it can be rotated.
  `CREATE TABLE IF NOT EXISTS valet_outlet_config (
    outlet_id     TEXT PRIMARY KEY,
    enabled       INTEGER NOT NULL DEFAULT 0,
    config_json   TEXT NOT NULL DEFAULT '{}',
    entry_token   TEXT NOT NULL DEFAULT '',
    updated_at    TEXT NOT NULL DEFAULT '',
    updated_by    TEXT NOT NULL DEFAULT ''
  )`,
  // Parking zones, gate spaces and near-gate holding areas.
  `CREATE TABLE IF NOT EXISTS valet_zones (
    id            TEXT PRIMARY KEY,
    outlet_id     TEXT NOT NULL,
    name          TEXT NOT NULL,
    kind          TEXT NOT NULL DEFAULT 'parking',
    capacity      INTEGER,
    retrieval_minutes INTEGER,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT '',
    created_by    TEXT NOT NULL DEFAULT ''
  )`,
  // Which outlets a valet user may operate. Admin needs no row.
  `CREATE TABLE IF NOT EXISTS valet_staff_outlets (
    user_id       TEXT NOT NULL,
    outlet_id     TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT '',
    created_by    TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, outlet_id)
  )`,
  `CREATE TABLE IF NOT EXISTS valet_shifts (
    id              TEXT PRIMARY KEY,
    outlet_id       TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    user_name       TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'on',
    started_at      TEXT NOT NULL,
    break_started_at TEXT,
    break_seconds   INTEGER NOT NULL DEFAULT 0,
    last_seen_at    TEXT,
    ended_at        TEXT,
    ended_by        TEXT NOT NULL DEFAULT '',
    end_note        TEXT NOT NULL DEFAULT ''
  )`,
  // Reusable key tags (and, later, NFC cards). code is the VISIBLE number — an
  // identifier, never a credential. nfc_ref is an opaque random reference that
  // an NFC tag may carry inside a staff lookup URL; it identifies the tag only.
  `CREATE TABLE IF NOT EXISTS valet_tags (
    id            TEXT PRIMARY KEY,
    outlet_id     TEXT NOT NULL,
    code          TEXT NOT NULL,
    code_norm     TEXT NOT NULL,
    kind          TEXT NOT NULL DEFAULT 'key_tag',
    status        TEXT NOT NULL DEFAULT 'available',
    nfc_ref       TEXT,
    replaced_by   TEXT,
    notes         TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT '',
    updated_at    TEXT NOT NULL DEFAULT ''
  )`,
  // Guest-led check-in: a SHORT-LIVED pending request. The venue does not hold
  // the car yet, so this is not a vehicle session — an attendant confirming the
  // guest, the vehicle and the physical key tag is what creates one.
  `CREATE TABLE IF NOT EXISTS valet_checkin_requests (
    id            TEXT PRIMARY KEY,
    outlet_id     TEXT NOT NULL,
    source        TEXT NOT NULL DEFAULT 'guest_qr',
    pairing_code  TEXT NOT NULL,
    device_id     TEXT,
    plate         TEXT NOT NULL DEFAULT '',
    plate_norm    TEXT NOT NULL DEFAULT '',
    make          TEXT NOT NULL DEFAULT '',
    model         TEXT NOT NULL DEFAULT '',
    colour        TEXT NOT NULL DEFAULT '',
    guest_name    TEXT NOT NULL DEFAULT '',
    guest_mobile  TEXT NOT NULL DEFAULT '',
    ticket_no     TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'pending',
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    resolved_at   TEXT,
    resolved_by   TEXT NOT NULL DEFAULT '',
    session_id    TEXT
  )`,
  // The car's stay. `state` is the VEHICLE state (states.ts VEHICLE_STATES);
  // pickups have their own table and their own state. version is the optimistic
  // concurrency counter every write bumps.
  `CREATE TABLE IF NOT EXISTS valet_vehicle_sessions (
    id                  TEXT PRIMARY KEY,
    outlet_id           TEXT NOT NULL,
    business_date       TEXT NOT NULL,
    state               TEXT NOT NULL,
    version             INTEGER NOT NULL DEFAULT 1,
    checkin_source      TEXT NOT NULL DEFAULT 'staff',
    tag_id              TEXT,
    tag_code            TEXT NOT NULL DEFAULT '',
    ticket_no           TEXT NOT NULL DEFAULT '',
    plate               TEXT NOT NULL DEFAULT '',
    plate_norm          TEXT NOT NULL DEFAULT '',
    make                TEXT NOT NULL DEFAULT '',
    model               TEXT NOT NULL DEFAULT '',
    colour              TEXT NOT NULL DEFAULT '',
    guest_name          TEXT NOT NULL DEFAULT '',
    guest_mobile        TEXT NOT NULL DEFAULT '',
    notes               TEXT NOT NULL DEFAULT '',
    duplicate_plate_note TEXT NOT NULL DEFAULT '',
    checked_in_at       TEXT NOT NULL,
    checked_in_by       TEXT NOT NULL DEFAULT '',
    checked_in_by_name  TEXT NOT NULL DEFAULT '',
    parking_started_at  TEXT,
    parking_by          TEXT,
    parking_by_name     TEXT NOT NULL DEFAULT '',
    parked_at           TEXT,
    parked_by           TEXT NOT NULL DEFAULT '',
    parked_by_name      TEXT NOT NULL DEFAULT '',
    zone_id             TEXT,
    spot                TEXT NOT NULL DEFAULT '',
    key_location        TEXT NOT NULL DEFAULT 'attendant',
    key_rack            TEXT NOT NULL DEFAULT '',
    key_hook            TEXT NOT NULL DEFAULT '',
    key_custodian_id    TEXT,
    key_custodian_name  TEXT NOT NULL DEFAULT '',
    photo_exception     TEXT NOT NULL DEFAULT '',
    photo_exception_by  TEXT NOT NULL DEFAULT '',
    retrieving_started_at TEXT,
    fetched_by          TEXT NOT NULL DEFAULT '',
    fetched_by_name     TEXT NOT NULL DEFAULT '',
    ready_at            TEXT,
    gate_zone_id        TEXT,
    dwell_deadline_at   TEXT,
    guest_inside_at     TEXT,
    relocating_at       TEXT,
    relocating_by       TEXT,
    holding_at          TEXT,
    handed_over_at      TEXT,
    handed_over_by      TEXT NOT NULL DEFAULT '',
    handed_over_by_name TEXT NOT NULL DEFAULT '',
    handover_method     TEXT NOT NULL DEFAULT '',
    handover_note       TEXT NOT NULL DEFAULT '',
    verify_failures     INTEGER NOT NULL DEFAULT 0,
    voided_at           TEXT,
    voided_by           TEXT NOT NULL DEFAULT '',
    void_reason         TEXT NOT NULL DEFAULT '',
    is_test             INTEGER NOT NULL DEFAULT 0,
    order_id            TEXT,
    table_id            TEXT,
    booking_id          TEXT,
    customer_key        TEXT NOT NULL DEFAULT '',
    redacted_at         TEXT,
    updated_at          TEXT NOT NULL
  )`,
  // Pickup attempts. A vehicle may have many over its stay (cancelled, no-show,
  // completed) but only ONE active (partial unique index below). seq is the
  // stable FIFO tie-breaker, assigned inside the creating transaction.
  `CREATE TABLE IF NOT EXISTS valet_pickups (
    id                TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL,
    outlet_id         TEXT NOT NULL,
    state             TEXT NOT NULL,
    version           INTEGER NOT NULL DEFAULT 1,
    seq               INTEGER NOT NULL,
    source            TEXT NOT NULL DEFAULT 'guest',
    requested_by      TEXT NOT NULL DEFAULT '',
    requested_by_name TEXT NOT NULL DEFAULT '',
    requested_at      TEXT NOT NULL,
    target_at         TEXT NOT NULL,
    release_at        TEXT NOT NULL,
    queued_at         TEXT,
    lead_minutes      REAL NOT NULL DEFAULT 0,
    priority          INTEGER NOT NULL DEFAULT 0,
    priority_reason   TEXT NOT NULL DEFAULT '',
    eta_override_low  TEXT,
    eta_override_high TEXT,
    eta_override_reason TEXT NOT NULL DEFAULT '',
    assigned_user_id  TEXT,
    assigned_name     TEXT NOT NULL DEFAULT '',
    assigned_at       TEXT,
    assigned_how      TEXT NOT NULL DEFAULT '',
    handoff_from_id   TEXT,
    handoff_from_name TEXT NOT NULL DEFAULT '',
    handoff_ack_at    TEXT,
    started_at        TEXT,
    ready_at          TEXT,
    completed_at      TEXT,
    cancelled_at      TEXT,
    cancel_reason     TEXT NOT NULL DEFAULT '',
    no_show_at        TEXT,
    outcome_note      TEXT NOT NULL DEFAULT '',
    guest_outside_at  TEXT,
    change_request    TEXT NOT NULL DEFAULT '',
    change_request_at TEXT,
    change_ack_at     TEXT,
    change_ack_by     TEXT NOT NULL DEFAULT '',
    idempotency_key   TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  )`,
  // APPEND-ONLY timeline of every transition and staff action. Never updated,
  // never deleted; retention redacts personal fields in data_json only.
  `CREATE TABLE IF NOT EXISTS valet_events (
    id            TEXT PRIMARY KEY,
    outlet_id     TEXT NOT NULL,
    session_id    TEXT,
    pickup_id     TEXT,
    event_type    TEXT NOT NULL,
    from_state    TEXT NOT NULL DEFAULT '',
    to_state      TEXT NOT NULL DEFAULT '',
    actor_type    TEXT NOT NULL DEFAULT 'staff',
    actor_id      TEXT NOT NULL DEFAULT '',
    actor_name    TEXT NOT NULL DEFAULT '',
    reason        TEXT NOT NULL DEFAULT '',
    data_json     TEXT NOT NULL DEFAULT '{}',
    created_at    TEXT NOT NULL
  )`,
  // APPEND-ONLY custody + movement log: every key handoff and every physical
  // move of the car. Separate from valet_events so "where are the keys / who had
  // them" is one indexed read, not a JSON scan.
  `CREATE TABLE IF NOT EXISTS valet_custody (
    id            TEXT PRIMARY KEY,
    outlet_id     TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    kind          TEXT NOT NULL,
    from_desc     TEXT NOT NULL DEFAULT '',
    to_desc       TEXT NOT NULL DEFAULT '',
    from_user_id  TEXT,
    to_user_id    TEXT,
    zone_id       TEXT,
    spot          TEXT NOT NULL DEFAULT '',
    key_rack      TEXT NOT NULL DEFAULT '',
    key_hook      TEXT NOT NULL DEFAULT '',
    actor_id      TEXT NOT NULL DEFAULT '',
    actor_name    TEXT NOT NULL DEFAULT '',
    note          TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL
  )`,
  // A guest's browser. token_hash = sha256 of the httpOnly fnb_vp cookie value.
  `CREATE TABLE IF NOT EXISTS valet_guest_devices (
    id            TEXT PRIMARY KEY,
    token_hash    TEXT NOT NULL,
    lang          TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    last_seen_at  TEXT,
    revoked_at    TEXT
  )`,
  // Which vehicle sessions a device may see and operate.
  `CREATE TABLE IF NOT EXISTS valet_pass_grants (
    id            TEXT PRIMARY KEY,
    device_id     TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    granted_how   TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    revoked_at    TEXT,
    revoke_reason TEXT NOT NULL DEFAULT ''
  )`,
  // Staff-shown one-time activation link (QR) that binds a guest browser.
  `CREATE TABLE IF NOT EXISTS valet_activation_links (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL,
    token_hash    TEXT NOT NULL,
    purpose       TEXT NOT NULL DEFAULT 'activate',
    created_at    TEXT NOT NULL,
    created_by    TEXT NOT NULL DEFAULT '',
    expires_at    TEXT NOT NULL,
    consumed_at   TEXT,
    device_id     TEXT
  )`,
  // Rotating, short-lived, single-use handover codes shown on the guest pass.
  `CREATE TABLE IF NOT EXISTS valet_handover_codes (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL,
    code_hash     TEXT NOT NULL,
    issued_at     TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    consumed_at   TEXT,
    superseded_at TEXT
  )`,
  // Printed / staff-assisted claim credential for guests without a usable phone.
  `CREATE TABLE IF NOT EXISTS valet_claim_codes (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL,
    code_hash     TEXT NOT NULL,
    issued_at     TEXT NOT NULL,
    issued_by     TEXT NOT NULL DEFAULT '',
    revoked_at    TEXT,
    consumed_at   TEXT
  )`,
  // Fixed-window counters for pairing / lookup / recovery / verification and
  // guest endpoints. In the DATABASE so the limit holds across pm2 workers.
  `CREATE TABLE IF NOT EXISTS valet_rate_limits (
    bucket        TEXT PRIMARY KEY,
    window_start  INTEGER NOT NULL,
    count         INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS valet_incidents (
    id            TEXT PRIMARY KEY,
    outlet_id     TEXT NOT NULL,
    session_id    TEXT,
    kind          TEXT NOT NULL DEFAULT 'other',
    description   TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'open',
    retention_hold INTEGER NOT NULL DEFAULT 0,
    reported_by   TEXT NOT NULL DEFAULT '',
    reported_by_name TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    resolved_at   TEXT,
    resolved_by   TEXT NOT NULL DEFAULT '',
    resolution    TEXT NOT NULL DEFAULT ''
  )`,
  // Guest "help" taps and other staff-attention flags the board must clear.
  `CREATE TABLE IF NOT EXISTS valet_alerts (
    id            TEXT PRIMARY KEY,
    outlet_id     TEXT NOT NULL,
    session_id    TEXT,
    pickup_id     TEXT,
    kind          TEXT NOT NULL,
    message       TEXT NOT NULL DEFAULT '',
    dedupe_key    TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    acknowledged_at TEXT,
    acknowledged_by TEXT NOT NULL DEFAULT '',
    resolved_at   TEXT,
    resolved_by   TEXT NOT NULL DEFAULT ''
  )`,
  // Shift-handover reconciliation records (head to head).
  `CREATE TABLE IF NOT EXISTS valet_handover_notes (
    id            TEXT PRIMARY KEY,
    outlet_id     TEXT NOT NULL,
    business_date TEXT NOT NULL,
    from_user_id  TEXT NOT NULL DEFAULT '',
    from_name     TEXT NOT NULL DEFAULT '',
    snapshot_json TEXT NOT NULL DEFAULT '{}',
    note          TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    acknowledged_by TEXT NOT NULL DEFAULT '',
    acknowledged_name TEXT NOT NULL DEFAULT '',
    acknowledged_at TEXT
  )`,
  // ── increment 2 ──────────────────────────────────────────────────────────
  // Notification OUTBOX: one row per message we intend to send. status is a
  // ladder that only a provider can climb past 'sent': queued → sending → sent
  // → delivered → read, or failed / cancelled / simulated. Holds NO phone
  // number — identity_id points at the verified identity.
  `CREATE TABLE IF NOT EXISTS valet_notifications (
    id                  TEXT PRIMARY KEY,
    outlet_id           TEXT NOT NULL,
    session_id          TEXT,
    pickup_id           TEXT,
    identity_id         TEXT,
    channel             TEXT NOT NULL DEFAULT 'whatsapp',
    kind                TEXT NOT NULL,
    dedupe_key          TEXT NOT NULL,
    params_json         TEXT NOT NULL DEFAULT '[]',
    template_name       TEXT NOT NULL DEFAULT '',
    status              TEXT NOT NULL DEFAULT 'queued',
    attempts            INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     TEXT,
    lease_until         TEXT,
    last_error          TEXT NOT NULL DEFAULT '',
    provider_message_id TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    sent_at             TEXT,
    delivered_at        TEXT,
    read_at             TEXT,
    failed_at           TEXT
  )`,
  // A VERIFIED messaging identity linked to a pass. "Verified" means the
  // provider told us a message came FROM this number carrying the pass's link
  // code — a number typed into a form is never verified (spec §8).
  `CREATE TABLE IF NOT EXISTS valet_msg_identities (
    id              TEXT PRIMARY KEY,
    outlet_id       TEXT NOT NULL,
    session_id      TEXT NOT NULL,
    channel         TEXT NOT NULL DEFAULT 'whatsapp',
    link_code       TEXT NOT NULL,
    link_expires_at TEXT NOT NULL,
    phone           TEXT NOT NULL DEFAULT '',
    verified_at     TEXT,
    verified_how    TEXT NOT NULL DEFAULT '',
    consent_at      TEXT,
    opted_out_at    TEXT,
    last_inbound_at TEXT,
    simulated       INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL
  )`,
  // Provider events already applied (delivery statuses, inbound message ids):
  // the dedupe + replay guard. A repeated or replayed event is a no-op.
  `CREATE TABLE IF NOT EXISTS valet_provider_events (
    event_key   TEXT PRIMARY KEY,
    received_at TEXT NOT NULL
  )`,
  // Condition photos — PRIVATE BLOBs, served only through an authorised route.
  `CREATE TABLE IF NOT EXISTS valet_media (
    id            TEXT PRIMARY KEY,
    outlet_id     TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    position      TEXT NOT NULL DEFAULT 'other',
    annotation    TEXT NOT NULL DEFAULT '',
    mime          TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL,
    sha256        TEXT NOT NULL,
    data          BLOB,
    captured_by   TEXT NOT NULL DEFAULT '',
    captured_by_name TEXT NOT NULL DEFAULT '',
    captured_at   TEXT NOT NULL,
    deleted_at    TEXT,
    deleted_reason TEXT NOT NULL DEFAULT ''
  )`,
  // Paper mode: ticket books issued to the desk, and each ticket's use.
  `CREATE TABLE IF NOT EXISTS valet_ticket_books (
    id          TEXT PRIMARY KEY,
    outlet_id   TEXT NOT NULL,
    prefix      TEXT NOT NULL DEFAULT '',
    first_no    INTEGER NOT NULL,
    last_no     INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active',
    issued_at   TEXT NOT NULL,
    issued_by   TEXT NOT NULL DEFAULT '',
    note        TEXT NOT NULL DEFAULT ''
  )`,
  // Retention sweeps — one row per run, so "did the cleanup run, and what did it
  // touch" is answerable without reading logs.
  `CREATE TABLE IF NOT EXISTS valet_retention_runs (
    id            TEXT PRIMARY KEY,
    outlet_id     TEXT NOT NULL,
    run_date      TEXT NOT NULL,
    cutoff        TEXT NOT NULL,
    sessions_redacted INTEGER NOT NULL DEFAULT 0,
    photos_removed    INTEGER NOT NULL DEFAULT 0,
    held_skipped      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
  )`,
];

const INDEXES: string[] = [
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_valet_notif_dedupe ON valet_notifications(dedupe_key)`,
  `CREATE INDEX IF NOT EXISTS idx_valet_notif_due ON valet_notifications(status, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS idx_valet_notif_session ON valet_notifications(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_valet_notif_provider ON valet_notifications(provider_message_id) WHERE provider_message_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_valet_link_code ON valet_msg_identities(outlet_id, link_code) WHERE verified_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_valet_ident_session ON valet_msg_identities(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_valet_ident_phone ON valet_msg_identities(phone) WHERE phone <> ''`,
  `CREATE INDEX IF NOT EXISTS idx_valet_media_session ON valet_media(session_id, deleted_at)`,
  `CREATE INDEX IF NOT EXISTS idx_valet_ticket_books ON valet_ticket_books(outlet_id, status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_valet_retention_day ON valet_retention_runs(outlet_id, run_date)`,
  `CREATE INDEX IF NOT EXISTS idx_valet_zones_outlet ON valet_zones(outlet_id, kind, is_active)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_valet_tags_code ON valet_tags(outlet_id, code_norm)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_valet_tags_nfc ON valet_tags(nfc_ref) WHERE nfc_ref IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_valet_shift_open ON valet_shifts(user_id) WHERE ended_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_valet_shifts_outlet ON valet_shifts(outlet_id, started_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_valet_pairing ON valet_checkin_requests(outlet_id, pairing_code) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_valet_checkin_req ON valet_checkin_requests(outlet_id, status, expires_at)`,
  // ONE ACTIVE SESSION PER TAG — the storage-layer guarantee behind "prevent
  // duplicate active tag assignments". A second insert with the same tag while
  // the first car is still held throws, whatever the API layer believed.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_valet_active_tag ON valet_vehicle_sessions(tag_id)
     WHERE tag_id IS NOT NULL AND state NOT IN ('HANDED_OVER','VOIDED')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_valet_active_ticket ON valet_vehicle_sessions(outlet_id, ticket_no)
     WHERE ticket_no <> '' AND state NOT IN ('HANDED_OVER','VOIDED')`,
  `CREATE INDEX IF NOT EXISTS idx_valet_vs_outlet_state ON valet_vehicle_sessions(outlet_id, state)`,
  `CREATE INDEX IF NOT EXISTS idx_valet_vs_outlet_date ON valet_vehicle_sessions(outlet_id, business_date)`,
  `CREATE INDEX IF NOT EXISTS idx_valet_vs_plate ON valet_vehicle_sessions(outlet_id, plate_norm)`,
  `CREATE INDEX IF NOT EXISTS idx_valet_vs_order ON valet_vehicle_sessions(order_id) WHERE order_id IS NOT NULL`,
  // ONE ACTIVE PICKUP PER VEHICLE — the guarantee behind "repeated taps and
  // retries must return the same active request".
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_valet_active_pickup ON valet_pickups(session_id)
     WHERE state IN ('SCHEDULED','QUEUED','ASSIGNED','IN_PROGRESS','READY')`,
  `CREATE INDEX IF NOT EXISTS idx_valet_pickups_queue ON valet_pickups(outlet_id, state, priority, queued_at, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_valet_pickups_assignee ON valet_pickups(assigned_user_id, state)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_valet_pickup_idem ON valet_pickups(session_id, idempotency_key) WHERE idempotency_key <> ''`,
  `CREATE INDEX IF NOT EXISTS idx_valet_events_session ON valet_events(session_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_valet_events_outlet ON valet_events(outlet_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_valet_custody_session ON valet_custody(session_id, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_valet_device_token ON valet_guest_devices(token_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_valet_grants_device ON valet_pass_grants(device_id, revoked_at)`,
  `CREATE INDEX IF NOT EXISTS idx_valet_grants_session ON valet_pass_grants(session_id, revoked_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_valet_activation_token ON valet_activation_links(token_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_valet_handover_codes ON valet_handover_codes(session_id, consumed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_valet_claim_codes ON valet_claim_codes(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_valet_incidents ON valet_incidents(outlet_id, status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_valet_alert_open ON valet_alerts(dedupe_key) WHERE resolved_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_valet_alerts_outlet ON valet_alerts(outlet_id, resolved_at)`,
  `CREATE INDEX IF NOT EXISTS idx_valet_handover_notes ON valet_handover_notes(outlet_id, created_at)`,
];

/** Role-only capability columns, DEFAULT 0 with NO backfill: roles are the
 *  owner's to set in Settings → Roles. Resolved fail-closed (valet/access.ts). */
export const VALET_ROLE_COLUMNS = ['valet_head', 'valet_attendant', 'valet_host'] as const;

/** Apply every valet statement; each failure is logged by name and never stops
 *  the rest. Safe to call on every boot (IF NOT EXISTS / column probe). */
export function applyValetSchema(db: Database.Database): void {
  for (const sql of [...TABLES, ...INDEXES]) {
    try { db.exec(sql); }
    catch (e) {
      const name = /(?:TABLE|INDEX) IF NOT EXISTS (\w+)/.exec(sql)?.[1] || sql.slice(0, 60);
      console.error(`[valet] schema statement failed (${name}):`, e);
    }
  }
  try {
    const cols = new Set((db.prepare('PRAGMA table_info(roles)').all() as { name: string }[]).map(c => c.name));
    if (cols.size > 0) {
      for (const c of VALET_ROLE_COLUMNS) {
        if (!cols.has(c)) db.exec(`ALTER TABLE roles ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);
      }
    }
  } catch (e) { console.error('[valet] roles capability columns failed:', e); }
}
