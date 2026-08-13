/**
 * SQL SANDBOX — run one read-only SELECT in a throwaway child process.
 *
 * ── WHY A CHILD PROCESS AND NOT getDb() ───────────────────────────────────
 * better-sqlite3 is SYNCHRONOUS and exposes no statement timeout. A query runs
 * to completion inside the Node main thread, and while it runs NOTHING else in
 * this process moves: no captain-tablet order POST, no KOT SSE frame, no
 * cashier settle, no print-agent heartbeat. On this database that is not a
 * theoretical risk — the reservation tables measured 85,558 bookings and
 * 70,342 guests, so one careless `FROM ct_bookings a, ct_bookings b` is 7.3
 * billion row pairs and the POS is frozen until it finishes or the box OOMs.
 * There is no way to cancel it from inside: the event loop cannot run, so a
 * setTimeout that would call db.interrupt() never fires.
 *
 * So the query is executed by a SEPARATE node process that opens the database
 * file read-only and prints one JSON line. The parent stays fully async: it
 * writes the job to the child's stdin, waits on 'close', and holds a
 * wall-clock timer. When the timer fires the child is SIGKILLed.
 *
 * SIGKILL, not SIGTERM, deliberately: the child is blocked inside SQLite's C
 * loop for the whole query, so it cannot service a catchable signal until the
 * query returns — SIGTERM would just sit queued behind the runaway query it is
 * meant to stop. SIGKILL is delivered by the kernel and needs no cooperation.
 * The runaway dies with the child; the server never stalls.
 *
 * ── WHY THE WORKER IS AN EMBEDDED STRING, NOT scripts/*.cjs ───────────────
 * deploy/push-prebuilt.sh ships exactly `.next public src package.json
 * package-lock.json next.config.ts` — scripts/ is not in that tarball, so a
 * loose worker file would be missing on the GCP testing VM while working fine
 * locally. Keeping the worker as a string inside src/ means it travels with
 * every deploy path, and `node -e` needs no file on disk at all.
 *
 * ── FOUR INDEPENDENT LAYERS STOP A WRITE ──────────────────────────────────
 *   1. validateSelect() below — one statement, must start with SELECT/WITH,
 *      no write verb / PRAGMA / ATTACH, checked after comments and quoted
 *      text have been stripped so `'; DROP` inside a literal is not a false
 *      positive and `--` cannot hide a second statement.
 *   2. The child opens the file with { readonly: true }.
 *   3. It also sets `PRAGMA query_only = ON`, which SQLite enforces per
 *      connection and which still holds on the read-write fallback handle
 *      (needed because a WAL database cannot be opened read-only when the
 *      -shm file does not already exist).
 *   4. better-sqlite3's prepare() itself refuses a source string containing
 *      more than one statement — which is why the ORIGINAL sql is handed to
 *      the child verbatim, not some rewritten form of it.
 * Even so, a caller must still be an admin: an ad-hoc SELECT reads every table
 * in the file, password hashes and all.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';

/** Mirrors db.ts's DB_PATH. Kept in sync by hand — db.ts does not export it. */
const DB_PATH = path.join(process.cwd(), 'fnb-controller.db');

export const MAX_ROWS = 5000;
/** ~8 MB of JSON. A 5,000-row result of wide text columns can still be huge. */
export const MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 5000;
export const MAX_TIMEOUT_MS = 30_000;
/** Long enough for a real reporting query, short enough that nobody pastes a dump. */
export const MAX_SQL_LENGTH = 20_000;
/** Each in-flight query is a whole node process; two at a time is plenty for one admin. */
const MAX_CONCURRENT = 2;

let inFlight = 0;

// Whole-word tokens that must never appear outside a string literal. The
// readonly handle already blocks the writes; this list exists so the user gets
// "write statements are not allowed" instead of SQLite's "attempt to write a
// readonly database", and so ATTACH/PRAGMA (which are NOT writes and would
// otherwise succeed) cannot reach into other files or flip connection state.
const FORBIDDEN = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'TRUNCATE',
  'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'REINDEX', 'ANALYZE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE',
  'TRIGGER', 'GRANT', 'REVOKE', 'RETURNING',
  'LOAD_EXTENSION', 'WRITEFILE', 'READFILE',
]);
// NOT forbidden on purpose: END (CASE … END), VALUES (legal inside SELECT),
// and REPLACE, which is both a write statement and the string function every
// reporting query uses — it is allowed only in the function form, see below.

type Strip = { ok: true; stripped: string } | { ok: false; error: string };

/**
 * Blank out comments and quoted text, preserving length so token offsets still
 * line up with the original. Everything the validator inspects runs on this
 * form, so a `--` comment cannot hide a second statement and a literal cannot
 * trip a keyword.
 */
function stripLiteralsAndComments(sql: string): Strip {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];

    if (c === '-' && c2 === '-') {
      while (i < n && sql[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && c2 === '*') {
      const close = sql.indexOf('*/', i + 2);
      if (close === -1) return { ok: false, error: 'Unterminated /* comment.' };
      out += ' '.repeat(close + 2 - i);
      i = close + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      // SQLite escapes the delimiter by doubling it ('' "" ``); there is no
      // backslash escape, so doubling is the only case to handle.
      let j = i + 1;
      for (;;) {
        if (j >= n) return { ok: false, error: `Unterminated ${c} quote.` };
        if (sql[j] === c) {
          if (sql[j + 1] === c) { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    if (c === '[') {
      const close = sql.indexOf(']', i + 1);
      if (close === -1) return { ok: false, error: 'Unterminated [ identifier.' };
      out += ' '.repeat(close + 1 - i);
      i = close + 1;
      continue;
    }
    out += c;
    i++;
  }
  return { ok: true, stripped: out };
}

export type Validation = { ok: true; sql: string } | { ok: false; error: string };

export function validateSelect(raw: string): Validation {
  const sql = String(raw ?? '').trim();
  if (!sql) return { ok: false, error: 'Enter a query.' };
  if (sql.length > MAX_SQL_LENGTH) {
    return { ok: false, error: `Query is too long (${sql.length} chars, max ${MAX_SQL_LENGTH}).` };
  }

  const s = stripLiteralsAndComments(sql);
  if (!s.ok) return s;

  // Trailing semicolons and whitespace are fine; anything after them is a
  // second statement.
  const core = s.stripped.replace(/[\s;]+$/, '');
  if (!core.trim()) return { ok: false, error: 'Enter a query.' };
  if (core.includes(';')) {
    return { ok: false, error: 'Only one statement is allowed — remove the extra ";".' };
  }

  const first = core.trim().match(/^[A-Za-z_][A-Za-z_0-9]*/);
  const head = (first?.[0] || '').toUpperCase();
  if (head !== 'SELECT' && head !== 'WITH') {
    return { ok: false, error: 'Only SELECT (or WITH … SELECT) queries are allowed.' };
  }

  const tokenRe = /[A-Za-z_][A-Za-z_0-9]*/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(core)) !== null) {
    const word = m[0].toUpperCase();
    if (word === 'REPLACE') {
      // replace(x,'a','b') is a function; REPLACE INTO is a write.
      const rest = core.slice(m.index + m[0].length);
      if (/^\s*\(/.test(rest)) continue;
      return { ok: false, error: 'REPLACE is only allowed as the replace(…) function.' };
    }
    if (FORBIDDEN.has(word)) {
      return { ok: false, error: `"${m[0]}" is not allowed — this box is read-only.` };
    }
  }

  // Nothing binds parameters here, so an unbound "?" would surface as
  // better-sqlite3's "too few parameter values" — unhelpful. Say it plainly.
  if (/(\?\d*|[:@][A-Za-z_][A-Za-z_0-9]*)/.test(core)) {
    return { ok: false, error: 'Bind parameters are not supported — write the values inline.' };
  }

  // The ORIGINAL string, untouched: prepare() is the last line of defence and
  // it must judge exactly what the user typed.
  return { ok: true, sql };
}

/**
 * Child program, run via `node -e`. Plain CommonJS ES2017: it is executed by
 * the same binary serving the app (process.execPath), never transpiled.
 * No backticks or ${…} in here — it lives inside a template literal.
 */
const WORKER_SRC = `
'use strict';
var chunks = [];
process.stdin.on('data', function (c) { chunks.push(c); });
process.stdin.on('end', function () {
  var out;
  try { out = run(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch (e) { out = { ok: false, error: String((e && e.message) || e) }; }
  process.stdout.write(JSON.stringify(out));
});

function cell(v) {
  if (v === null || v === undefined) return null;
  var t = typeof v;
  if (t === 'number' || t === 'string' || t === 'boolean') return v;
  if (t === 'bigint') return v.toString();
  if (Buffer.isBuffer(v)) return '<BLOB ' + v.length + ' bytes>';
  return String(v);
}

function run(job) {
  var Database = require('better-sqlite3');
  var db;
  try {
    db = new Database(job.dbPath, { readonly: true });
  } catch (e) {
    // A WAL database cannot be opened read-only unless the -shm file already
    // exists, because a readonly connection may not create it. The server
    // normally holds it open so this is rare, but falling back to a plain
    // handle clamped by query_only keeps the box usable when it happens.
    db = new Database(job.dbPath);
  }
  db.pragma('query_only = ON');
  db.pragma('busy_timeout = ' + Number(job.busyMs));

  var stmt = db.prepare(job.sql);
  if (!stmt.reader) throw new Error('That statement does not return any rows.');
  // Column names are read BEFORE iterating: the statement is busy mid-scan.
  var cols = stmt.columns().map(function (c, i) { return c.name || ('col' + (i + 1)); });
  // raw(true) yields arrays, not objects — objects would silently collapse
  // duplicate names, and "SELECT a.id, b.id FROM x a JOIN x b" is normal here.
  stmt.raw(true);

  var t0 = Date.now();
  var rows = [];
  var bytes = 0;
  var truncated = null;
  // iterate(), not all(): all() would materialise every matching row in memory
  // before either cap could apply.
  var it = stmt.iterate();
  for (var r of it) {
    if (rows.length >= job.maxRows) { truncated = 'rows'; break; }
    var row = new Array(r.length);
    for (var i = 0; i < r.length; i++) row[i] = cell(r[i]);
    bytes += JSON.stringify(row).length;
    if (bytes > job.maxBytes) { truncated = 'bytes'; break; }
    rows.push(row);
  }
  var elapsedMs = Date.now() - t0;
  try { db.close(); } catch (e) {}
  return {
    ok: true, columns: cols, rows: rows, rowCount: rows.length,
    truncated: truncated, elapsedMs: elapsedMs,
  };
}
`;

export type SandboxResult =
  | {
      ok: true;
      columns: string[];
      rows: unknown[][];
      rowCount: number;
      truncated: 'rows' | 'bytes' | null;
      elapsedMs: number;
    }
  | { ok: false; kind: 'timeout' | 'query' | 'sandbox' | 'busy'; error: string };

export type SandboxOptions = { timeoutMs?: number; maxRows?: number };

export function runSandboxedQuery(sql: string, opts: SandboxOptions = {}): Promise<SandboxResult> {
  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1000, Math.floor(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
  );
  const maxRows = Math.min(MAX_ROWS, Math.max(1, Math.floor(opts.maxRows ?? MAX_ROWS)));

  if (inFlight >= MAX_CONCURRENT) {
    return Promise.resolve({
      ok: false as const,
      kind: 'busy' as const,
      error: `Another query is already running (limit ${MAX_CONCURRENT}). Wait for it to finish.`,
    });
  }
  inFlight++;

  return new Promise<SandboxResult>((resolve) => {
    let settled = false;
    const done = (r: SandboxResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      inFlight--;
      resolve(r);
    };

    // Explicitly the non-null-streams variant: stdio is all 'pipe', so stdin /
    // stdout / stderr are guaranteed present.
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        process.execPath,
        // Cap the child heap: the byte cap bounds the row set, but one pathological
        // group_concat() cell can still blow past it, and it must not be the box's
        // memory that pays for that.
        ['--max-old-space-size=512', '-e', WORKER_SRC],
        {
          // node -e resolves require() from cwd, which is where node_modules and
          // the .db file live.
          cwd: process.cwd(),
          // Deliberately minimal: the child needs nothing from our environment,
          // and API keys / session secrets have no business being readable in a
          // process that runs user-supplied SQL. (NODE_ENV only because Next's
          // ProcessEnv type declares it required; it is not a secret.)
          env: { PATH: process.env.PATH ?? '', NODE_ENV: process.env.NODE_ENV },
          stdio: ['pipe', 'pipe', 'pipe'] as const,
        },
      );
    } catch (e) {
      // A synchronous spawn throw (EMFILE, EAGAIN under fork pressure) happens
      // BEFORE any handler exists, so nothing else would ever decrement
      // inFlight — and a leaked slot permanently wedges the box at "another
      // query is already running".
      inFlight--;
      settled = true;
      return resolve({
        ok: false,
        kind: 'sandbox',
        error: `Could not start the query sandbox: ${(e as Error).message}`,
      });
    }

    let timedOut = false;
    let overflowed = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    let out = '';
    let outBytes = 0;
    let err = '';
    // Headroom over MAX_BYTES: the child self-caps, so exceeding this means the
    // child is misbehaving, not that the result is merely large.
    const STDOUT_CAP = MAX_BYTES * 2;

    child.stdout.on('data', (d: Buffer) => {
      outBytes += d.length;
      if (outBytes > STDOUT_CAP) { overflowed = true; child.kill('SIGKILL'); return; }
      out += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => { if (err.length < 4000) err += d.toString('utf8'); });

    // EPIPE if the child died before reading the job (e.g. the binding failed
    // to load); the 'close' handler reports the real reason.
    child.stdin.on('error', () => {});
    child.on('error', (e) => done({ ok: false, kind: 'sandbox', error: `Could not start the query sandbox: ${e.message}` }));

    child.on('close', () => {
      if (timedOut) {
        return done({
          ok: false,
          kind: 'timeout',
          error: `Query stopped after ${(timeoutMs / 1000).toFixed(1)}s — it was taking too long, so it was killed to keep the POS responsive. Add a WHERE clause or a LIMIT and try again.`,
        });
      }
      if (overflowed) {
        // Killed mid-JSON, so `out` is a truncated fragment. Say what happened
        // rather than letting it fall through to "malformed output", which
        // reads like a bug in the sandbox instead of an oversized result.
        return done({
          ok: false,
          kind: 'query',
          error: 'The result was too large to return. Add a LIMIT or select fewer columns.',
        });
      }
      if (!out.trim()) {
        const detail = err.trim().split('\n').slice(-3).join(' ').slice(0, 500);
        return done({
          ok: false,
          kind: 'sandbox',
          error: detail || 'The query sandbox exited without a result.',
        });
      }
      let parsed: unknown;
      try { parsed = JSON.parse(out); }
      catch { return done({ ok: false, kind: 'sandbox', error: 'The query sandbox returned malformed output.' }); }

      const p = parsed as Record<string, unknown>;
      if (p?.ok !== true) {
        return done({ ok: false, kind: 'query', error: String(p?.error || 'Query failed.') });
      }
      done({
        ok: true,
        columns: (p.columns as string[]) ?? [],
        rows: (p.rows as unknown[][]) ?? [],
        rowCount: Number(p.rowCount ?? 0),
        truncated: (p.truncated as 'rows' | 'bytes' | null) ?? null,
        elapsedMs: Number(p.elapsedMs ?? 0),
      });
    });

    const job = {
      dbPath: DB_PATH,
      sql,
      maxRows,
      maxBytes: MAX_BYTES,
      // Under the wall clock so a lock wait reports itself as SQLITE_BUSY
      // instead of being mistaken for a runaway query.
      busyMs: Math.max(500, timeoutMs - 1000),
    };
    // Over stdin, never argv: argv is world-readable in `ps`, and these queries
    // filter on guest phone numbers.
    child.stdin.end(JSON.stringify(job));
  });
}
