/**
 * Canonical home for "is this settings key a credential?" — lifted VERBATIM out
 * of src/app/api/settings/route.ts, which was the only place it lived while it
 * was the only door onto the `settings` table.
 *
 * It is here because the admin Database page (/api/admin/database) is a SECOND
 * door onto that same table, and a raw `SELECT * FROM settings` walks straight
 * around the redaction the settings route does. Two doors need one list. This
 * file is that list; the settings route imports it back rather than keeping a
 * private copy, so there is exactly ONE pattern in the tree.
 *
 * DO NOT COPY THE REGEX SOMEWHERE ELSE. That is the drift the settings route's
 * own KEY_POLICY comment was written to stop ("listed on one side and forgotten
 * on the other"), and a copy that falls behind does not fail loudly — it just
 * quietly stops masking one credential on one surface.
 *
 * Pure module on purpose: no imports, no db, no `next/*`. It has to be safe to
 * import from an API route, from a lib that runs inside a short-lived child
 * process, and from a plain `node -e` release check.
 */

/**
 * RELEASE GATE — READ BEFORE "SIMPLIFYING" THIS INTO A LIST.
 *
 * This is a pattern, not a roster, and that is the whole security property:
 * DEFAULT-DENY. A credential added to `settings` next month — `stripe_secret`,
 * `zomato_api_key`, `foo_webhook` — is masked from the moment the row exists,
 * not from the moment somebody remembers to add it to an array. Swap this for
 * `const SECRET_KEYS = [...]` and every future integration leaks by default
 * until a human notices; the failure mode is silent and the blast radius is a
 * live third-party credential that can spend money or message guests.
 *
 * Each fragment earns its place against a key that is really in this database:
 *   token       → wa_access_token, wa_webhook_verify_token, telecmi_user_tokens
 *   api[_-]?key → wa_interakt_api_key, gemini_api_key, gemini-api-key
 *   _keys       → plural key bundles (gemini_api_keys and friends)
 *   secret      → telecmi_secret, telecmi_app_secret
 *   password    → SMTP / printer credentials
 *   passwd      → the same thing spelled the other way
 *   webhook     → slack_webhook_url (a webhook URL IS the credential)
 *   credential  → generic *_credentials blobs
 *   sa_json     → google_sa_json, the Google service-account private key
 *   private     → any *_private_key
 *
 * Widening it is cheap (one more thing masked). Narrowing it is a security
 * change: prove the key it stops matching is not a credential before you do it.
 */
export const SECRET_KEY_RE =
  /(token|api[_-]?key|_keys|secret|password|passwd|webhook|credential|sa_json|private|aadhaar|account_number|ifsc|doc_number|salary|(^|_)uan(_|$)|(^|_)esic(_|$))/i;
// uan/esic are SEGMENT-anchored: bare 'uan' substring-matches 'quantity' and
// masked 32 operational columns across purchases/sales/recipes in the admin
// SQL console (found by the verify fleet). (^|_)uan(_|$) matches uan, uan_no,
// employee_uan — never q-uan-tity.
// The second half of the pattern (aadhaar onward) exists for the HRMS module
// (docs/HRMS_DECISIONS.md §2.9): hr_bank_accounts.account_number/ifsc and
// hr_documents.doc_number (PAN/Aadhaar numbers land there) must not render in
// the /admin/database SQL console, and any settings key naming salary becomes
// admin-only by shape. Deliberately NOT matched: bare 'basic'/'gross' — they
// would mask legitimate operational columns (butchering's gross_weight), and
// the salary AMOUNT columns are visible to the admin console's admin-only
// audience anyway; identity numbers are the boundary here, not figures.

/**
 * Keys that are admin-read-only but whose NAME does not give them away, so the
 * pattern above cannot catch them. Mirrors the `read: 'admin'` rows of
 * KEY_POLICY in src/app/api/settings/route.ts — keep the two in step.
 *
 * `error_alert_phone` is a personal mobile number: it decides who gets
 * production crash alerts, and it is PII belonging to a real person. Not a
 * secret by shape, still not something to hand to every signed-in captain — or
 * to print in a SQL console result that gets screenshotted.
 *
 * Add a key here ONLY when the name is genuinely uninformative. If a rename
 * would make the pattern catch it, prefer the rename: one rule beats two.
 */
export const ADMIN_READ_KEYS: ReadonlySet<string> = new Set<string>([
  'error_alert_phone',
]);

/**
 * True when this settings key must never be shown in the clear to a non-admin,
 * and must be masked even for an admin on the Database page (see maskSecretValue).
 *
 * Matching is on the KEY NAME, deliberately case-insensitive and substring-based:
 * `SELECT value AS access_token …` is caught by the same rule as the stored key,
 * which is the point — the alias is the obvious way around a name check.
 */
export function isSecretKey(k: string): boolean {
  if (!k) return false;
  return SECRET_KEY_RE.test(k) || ADMIN_READ_KEYS.has(k);
}

/** The fixed prefix. Fixed-width on purpose: the length must not leak either. */
const MASK = '••••••••';

/**
 * '' stays '' (an unset key reads as unset, not as a masked something), and any
 * real value becomes ••••••••<last 4>.
 *
 * The last 4 are kept so the owner can TELL WHICH TOKEN HE IS LOOKING AT —
 * "…7f2a is the one in Meta" — without the value being usable. Showing that a
 * value is masked, rather than silently blanking it, is a stated requirement of
 * the Database page: a blank cell reads as "this setting is empty", which sends
 * someone off to re-paste a credential that was never missing.
 *
 * A value of 4 chars or fewer returns the bare mask: appending its last 4 would
 * print the entire thing. Do not "tidy" that branch away.
 *
 * Accepts `unknown` because SQLite hands back numbers, NULLs and Buffers as well
 * as strings, and this is called on raw result cells.
 */
export function maskSecretValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : String(v);
  if (s === '') return '';
  return s.length <= 4 ? MASK : MASK + s.slice(-4);
}
