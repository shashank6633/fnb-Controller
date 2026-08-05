/**
 * sql-guard.ts — the SQL allowlist for the Admin → Database page.
 *
 * PURE. No imports, no I/O, no database handle. Everything here is a string
 * decision, which is the point: this file can be read, reasoned about and
 * tested on its own, and it is the ONLY place the "is this SQL a read?"
 * question is answered.
 *
 * ---------------------------------------------------------------------------
 * TO THE ENGINEER WHO IS ABOUT TO SIMPLIFY THIS FILE
 * ---------------------------------------------------------------------------
 * The obvious simplification is "the connection is opened readonly, so SQLite
 * refuses writes anyway — why parse at all?". That was measured against this
 * app's own database, and it is wrong. On a handle opened with
 * { readonly: true, fileMustExist: true } the following all SUCCEED:
 *
 *   CREATE TEMP TABLE t AS SELECT ...   the temp database is a separate file
 *                                       and is writable even in readonly mode
 *   PRAGMA writable_schema = ON         a pragma, not a write, at the API level
 *   ATTACH DATABASE '<path>' AS z       attaching another readable file is not
 *                                       a write — and there is a second, stale
 *                                       fnbcontroller.db sitting in the repo
 *                                       root, plus nightly backups on the box
 *
 * That last one is the one that matters commercially: ATTACH lets a query read
 * a database file this page's masking does not know about, including a backup
 * taken before a credential was rotated. The readonly driver will not stop it.
 * This parser is what stops it.
 *
 * Conversely, the parser is NOT the last line of defence and must not be
 * treated as one. The driver-level readonly handle in db-explorer.ts is control
 * A and stays; this file is control C. Neither replaces the other.
 *
 * ---------------------------------------------------------------------------
 * SHAPE OF THE CHECK
 * ---------------------------------------------------------------------------
 * Order is part of the security property, not an accident. Steps run strictly
 * in sequence and the first failure wins:
 *
 *   0  length cap
 *   1  skeletonise      blank every comment and every literal
 *   2  one statement    a ';' with anything after it is two statements
 *   3  leading keyword  SELECT / WITH / EXPLAIN only
 *   4  write verbs      anywhere, at any paren depth
 *   5  banned constructs
 *   6  EXPLAIN operand  EXPLAIN [QUERY PLAN] must be followed by a read
 *
 * Step 1 has to come before steps 2-6 in BOTH directions. Without it,
 *   SELECT note FROM x WHERE note LIKE '%delete from%'
 * is falsely refused (the verb is inside a string), and
 *   SELECT 1 <slash-star> ; DELETE FROM users
 * sneaks a second statement past a naive scanner (the ';' is inside a comment
 * that never closes). We reject the unterminated form outright rather than
 * guessing where it was meant to end — hiding a payload behind an unclosed
 * block comment is the classic bypass for this exact kind of guard.
 */

export type GuardCode =
  | 'TOO_LONG'
  | 'UNTERMINATED'
  | 'MULTI_STATEMENT'
  | 'BAD_START'
  | 'WRITE_VERB'
  | 'BANNED_DDL'
  | 'BANNED_ATTACH'
  | 'BANNED_PRAGMA'
  | 'BANNED_TXN'
  | 'BANNED_FUNCTION';

/**
 * `offset` is a 0-BASED index into the ORIGINAL sql string, so a caller can do
 * sql.slice(offset) or drive a textarea selection with it directly. Every
 * human-facing message quotes the same position 1-BASED ("at character 34"),
 * because that is how an editor's cursor readout counts.
 */
export type GuardResult =
  | { ok: true }
  | { ok: false; code: GuardCode; message: string; offset?: number };

/**
 * A console query is a human typing at a keyboard, not a generated payload.
 * 4000 characters is far more than he will ever type by hand, and capping it
 * bounds the work every subsequent step does on attacker-controlled input.
 */
export const MAX_SQL_LENGTH = 4000;

/* --------------------------------------------------------------------------
 * Step 1 — the skeletoniser
 * ----------------------------------------------------------------------- */

export type SkeletonResult =
  | { ok: true; skeleton: string }
  | { ok: false; code: 'UNTERMINATED'; message: string; offset: number };

/**
 * Produce an analysis-only copy of the SQL in which every comment and every
 * quoted run has been blanked to spaces. The ORIGINAL text is what executes;
 * the skeleton is only ever used to make decisions.
 *
 * Blanking is CHARACTER-FOR-CHARACTER, not "collapse to one space". The
 * skeleton is therefore exactly as long as the input and every index in it is
 * the same index in the original — which is the only reason the offsets in our
 * refusal messages can be trusted. For tokenising purposes a run of spaces and
 * a single space are identical, so nothing is lost. Do not "optimise" this into
 * a shorter string; the offsets go silently wrong and the error messages start
 * pointing at the wrong character.
 *
 * Handles the four quoting forms SQLite accepts — '...' (string, '' escapes a
 * quote), "..." (identifier, "" escapes), [...] (MS-style identifier, no escape
 * mechanism, ends at the first ]), and backtick-delimited identifiers (MySQL
 * style, doubling escapes) — plus -- to end of line and non-nesting block
 * comments.
 *
 * Exported so the guard's own behaviour can be exercised directly in a test.
 */
export function skeletonizeSql(sql: string): SkeletonResult {
  const n = sql.length;
  const out: string[] = new Array(n);
  const BACKTICK = String.fromCharCode(96);
  let i = 0;

  while (i < n) {
    const c = sql[i];

    /* -- line comment: runs to the newline, or to the end of the input. */
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }

    /* Block comment. SQLite does NOT nest these, so the first close wins. */
    if (c === '/' && sql[i + 1] === '*') {
      const start = i;
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      let closed = false;
      while (i < n) {
        if (sql[i] === '*' && sql[i + 1] === '/') {
          out[i] = ' '; out[i + 1] = ' '; i += 2; closed = true; break;
        }
        out[i] = ' '; i++;
      }
      if (!closed) {
        return {
          ok: false,
          code: 'UNTERMINATED',
          message:
            'Unterminated block comment: the /* at character ' + (start + 1) +
            ' is never closed with */. Close it, or delete it. ' +
            'A query is refused rather than guessed at, because an unclosed comment ' +
            'can hide a second statement from the safety checks.',
          offset: start,
        };
      }
      continue;
    }

    /* Quoted runs: string literals and the three identifier-quoting styles.
       All four are blanked, which is what lets a column genuinely named after
       a SQL verb be used as "update" — the guard never sees the word. */
    if (c === "'" || c === '"' || c === BACKTICK) {
      const start = i;
      const q = c;
      out[i] = ' '; i++;
      let closed = false;
      while (i < n) {
        if (sql[i] === q) {
          /* A doubled delimiter is an escaped delimiter, not the end. */
          if (sql[i + 1] === q) { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
          out[i] = ' '; i++; closed = true; break;
        }
        out[i] = ' '; i++;
      }
      if (!closed) {
        const kind = q === "'" ? 'string literal' : 'quoted identifier';
        return {
          ok: false,
          code: 'UNTERMINATED',
          message:
            'Unterminated ' + kind + ': the ' + q + ' at character ' + (start + 1) +
            ' is never closed. Add the closing ' + q + '. ' +
            'A query is refused rather than guessed at, because an unclosed quote ' +
            'can hide the rest of the statement from the safety checks.',
          offset: start,
        };
      }
      continue;
    }

    /* [bracketed identifier] — no escape mechanism in SQLite; first ] ends it. */
    if (c === '[') {
      const start = i;
      out[i] = ' '; i++;
      let closed = false;
      while (i < n) {
        if (sql[i] === ']') { out[i] = ' '; i++; closed = true; break; }
        out[i] = ' '; i++;
      }
      if (!closed) {
        return {
          ok: false,
          code: 'UNTERMINATED',
          message:
            'Unterminated bracketed identifier: the [ at character ' + (start + 1) +
            ' is never closed with ]. Add the closing bracket.',
          offset: start,
        };
      }
      continue;
    }

    out[i] = c;
    i++;
  }

  return { ok: true, skeleton: out.join('') };
}

/* --------------------------------------------------------------------------
 * Tokenising
 * ----------------------------------------------------------------------- */

interface Tok { readonly upper: string; readonly text: string; readonly start: number }

/**
 * Word tokens only — everything the guard cares about is a bare keyword or a
 * bare function name. Matching whole TOKENS rather than running \b regexes over
 * raw text is what makes `pragma_table_info(...)` safe to allow while `PRAGMA`
 * stays banned: the underscore is a word character, so the two never collide.
 * `$` is included because SQLite accepts it in identifiers.
 */
function tokenize(skeleton: string): Tok[] {
  const out: Tok[] = [];
  const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(skeleton)) !== null) {
    out.push({ upper: m[0].toUpperCase(), text: m[0], start: m.index });
  }
  return out;
}

/** True when this token is immediately used as a function call: name ( ... */
function isCallForm(skeleton: string, t: Tok): boolean {
  let j = t.start + t.text.length;
  while (j < skeleton.length && /\s/.test(skeleton[j])) j++;
  return skeleton[j] === '(';
}

/* --------------------------------------------------------------------------
 * The banned vocabulary
 * ----------------------------------------------------------------------- */

const READ_STARTERS = new Set(['SELECT', 'WITH', 'EXPLAIN']);

/**
 * Write verbs, rejected as whole words ANYWHERE in the skeleton — deliberately
 * at any paren depth, not just at depth 0.
 *
 * The precise rule would be "reject a write verb in statement position", and it
 * would let through slightly more legitimate SQL. It is not worth it. SQLite's
 * grammar puts the verb AFTER the CTE list:
 *
 *     WITH x AS (SELECT id FROM users) DELETE FROM users WHERE id IN (...)
 *
 * so a leading WITH proves nothing, and whether SQLite also supports DML inside
 * a CTE (WITH x AS (DELETE ... RETURNING *) SELECT * FROM x, which PostgreSQL
 * does) is a grammar detail that changes between versions. A security control
 * must not rest on anyone's recollection of a grammar footnote, so the rule is
 * the crude one: the word is not allowed to appear at all.
 *
 * The cost is a column literally named after a verb, and the fix for that is in
 * the error message: quote it. Step 1 blanks quoted identifiers, so "update"
 * genuinely works.
 */
const WRITE_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'UPSERT']);

const BANNED: ReadonlyArray<{ words: string[]; code: GuardCode; why: string; instead: string }> = [
  {
    words: ['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME'],
    code: 'BANNED_DDL',
    why: 'changes the shape of the database',
    /* CREATE is the one that actually bites: CREATE TEMP TABLE succeeds on a
       readonly handle, because the temp database is a separate writable file. */
    instead: 'The Database page only reads. Use a SELECT, or the table browser.',
  },
  {
    words: ['VACUUM', 'REINDEX', 'ANALYZE'],
    code: 'BANNED_DDL',
    why: 'rewrites storage or statistics',
    instead: 'The Database page only reads. Use a SELECT, or the table browser.',
  },
  {
    words: ['ATTACH', 'DETACH'],
    code: 'BANNED_ATTACH',
    why: 'can open another database file and step around this page masking',
    instead:
      'Only the live database is readable here. There are older copies of this database ' +
      'on disk (backups, and a stale file in the app folder) whose contents this page ' +
      'cannot mask, which is why attaching is refused outright.',
  },
  {
    words: ['PRAGMA'],
    code: 'BANNED_PRAGMA',
    why: 'includes settings that mutate the file even on a read-only connection',
    /* Verified on this app's own database: PRAGMA writable_schema = ON is
       accepted by a readonly handle. Splitting pragmas into a safe list and an
       unsafe list is a list that has to stay correct forever across SQLite
       upgrades, so all of them are refused and schema is exposed the other way
       — via the table-valued functions, which are SELECTs and therefore fine. */
    instead:
      "For schema, use the table browser, or query the table-valued form instead: " +
      "SELECT * FROM pragma_table_info('your_table') " +
      "(also pragma_foreign_key_list and pragma_index_list). Those are SELECTs, so they are allowed.",
  },
  {
    words: ['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'],
    code: 'BANNED_TXN',
    why: 'controls a transaction, and this page runs one read at a time',
    instead: 'Remove it — a single SELECT needs no transaction.',
  },
];

/**
 * Refused only in CALL form (name followed by an open paren), so an ordinary
 * column named `edit` or `readfile_path` is unaffected.
 *
 * On the build measured here load_extension answers "not authorized" and
 * readfile "no such function" — but the production box is a different machine
 * with a differently compiled SQLite, and "the library happens to be built
 * without it" is not a control. These are refused in the parser so the answer
 * does not depend on which SQLite the box was built with.
 */
const BANNED_FUNCTIONS = new Set([
  'LOAD_EXTENSION',
  'READFILE',
  'WRITEFILE',
  'EDIT',
  'FSDIR',
  'SQLITE_DBPAGE',
]);

/**
 * Refused as a BARE WORD as well, because these are virtual TABLES, not
 * functions: they are used as `FROM sqlite_dbpage`, with no parentheses
 * anywhere, so the call-form test above never sees them.
 *
 * sqlite_dbpage is the one that matters and it is not a theoretical concern: it
 * hands back the raw bytes of every database page. That is every row of every
 * table — including the settings rows this page masks — delivered as a blob,
 * underneath the masking layer entirely, because the masker inspects column
 * names and cell values and a page image is neither. Whether the vtab exists
 * depends on how SQLite was compiled (SQLITE_ENABLE_DBPAGE_VTAB), which is a
 * property of the production box, not of this laptop. Refuse it here so the
 * answer is the same on both.
 */
const BANNED_BARE_TABLES = new Set(['SQLITE_DBPAGE']);

/**
 * Leading tokens that get their own explanation instead of the generic
 * "must start with SELECT" message.
 *
 * Only PRAGMA and ATTACH/DETACH are here, and the reason is honesty about what
 * the user was probably trying to do. Someone typing UPDATE or CREATE or VACUUM
 * knows perfectly well they are not reading, and "this page only runs reads" is
 * the whole answer. Someone typing PRAGMA table_info or ATTACH genuinely
 * believes they are reading — they need to be told why it is refused anyway and
 * what to type instead. Do not extend this map to the rest of the banned
 * vocabulary; the generic message is better for those.
 */
const LEADING_SPECIFIC: ReadonlyArray<{ words: string[]; code: GuardCode }> = [
  { words: ['PRAGMA'], code: 'BANNED_PRAGMA' },
  { words: ['ATTACH', 'DETACH'], code: 'BANNED_ATTACH' },
];

function bannedEntryFor(upper: string) {
  for (const e of BANNED) if (e.words.includes(upper)) return e;
  return null;
}

/* --------------------------------------------------------------------------
 * guardSql
 * ----------------------------------------------------------------------- */

/**
 * Decide whether a user-typed statement may be handed to the read-only handle.
 *
 * Returns { ok: true } or a refusal carrying a machine code, a plain-English
 * reason that says WHY (never just "invalid"), and the character offset of the
 * offending token. The message is shown to the owner verbatim, so it is written
 * for someone who can read SQL but does not know this codebase.
 */
export function guardSql(sql: unknown): GuardResult {
  const raw = typeof sql === 'string' ? sql : '';

  /* Step 0 — length. */
  if (raw.length > MAX_SQL_LENGTH) {
    return {
      ok: false,
      code: 'TOO_LONG',
      message:
        'That query is ' + raw.length + ' characters; the limit is ' + MAX_SQL_LENGTH +
        '. Shorten it, or build it up in smaller pieces.',
      offset: MAX_SQL_LENGTH,
    };
  }

  /* Step 1 — skeletonise. Comments and quoted runs become spaces. */
  const skel = skeletonizeSql(raw);
  if (!skel.ok) {
    return { ok: false, code: skel.code, message: skel.message, offset: skel.offset };
  }
  const s = skel.skeleton;

  /* Step 2 — exactly one statement. A bare trailing ';' is fine; a ';' with
     anything after it means a second statement was smuggled in. better-sqlite3's
     prepare() refuses multi-statement strings on its own, but that error reads
     like a driver complaint; catching it here lets us say what actually
     happened. */
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ';') continue;
    if (s.slice(i + 1).trim().length > 0) {
      return {
        ok: false,
        code: 'MULTI_STATEMENT',
        message:
          'Only one statement can be run at a time. There is a ; at character ' + (i + 1) +
          ' with more SQL after it. Run the statements one at a time.',
        offset: i,
      };
    }
  }

  const toks = tokenize(s);

  /* Step 3 — leading keyword. */
  const firstNonWs = s.search(/\S/);
  if (firstNonWs < 0 || toks.length === 0) {
    return {
      ok: false,
      code: 'BAD_START',
      message: 'Nothing to run. Type a SELECT, or pick a table from the list.',
      offset: 0,
    };
  }
  const first = toks[0];
  if (first.start !== firstNonWs) {
    return {
      ok: false,
      code: 'BAD_START',
      message:
        'Statements must start with SELECT, WITH or EXPLAIN. Yours starts with "' +
        s[firstNonWs] + '" at character ' + (firstNonWs + 1) + '.',
      offset: firstNonWs,
    };
  }
  if (!READ_STARTERS.has(first.upper)) {
    for (const e of LEADING_SPECIFIC) {
      if (e.words.includes(first.upper)) {
        const b = bannedEntryFor(first.upper)!;
        return {
          ok: false,
          code: e.code,
          message:
            first.upper + ' is not allowed at character ' + (first.start + 1) +
            ' — it ' + b.why + '. ' + b.instead,
          offset: first.start,
        };
      }
    }
    return {
      ok: false,
      code: 'BAD_START',
      message:
        'Statements must start with SELECT, WITH or EXPLAIN. Yours starts with "' +
        first.text + '" at character ' + (first.start + 1) +
        '. The Database page is read-only — it can show you anything and change nothing.',
      offset: first.start,
    };
  }

  /* Step 4 — write verbs, whole word, any depth. See WRITE_VERBS above for why
     this is not depth-aware. */
  for (const t of toks) {
    if (!WRITE_VERBS.has(t.upper)) continue;

    /* NO CARVE-OUTS HERE, deliberately — not even for replace().
       replace(x, y, z) is SQLite's ordinary read-only string function, and an
       earlier draft of this file let it through in call form on the reasoning
       that the REPLACE *statement* is always REPLACE INTO, so a following '('
       proves it is the function. That reasoning is probably correct — and
       "probably correct recollection of a grammar footnote" is exactly what
       this rule refuses to stand on, for the same reason WITH ... DELETE is
       handled by banning the verb at any depth rather than by modelling where
       SQLite permits it. A guard whose exceptions each need a grammar argument
       is a guard nobody can review.
       The cost is bounded and the message below states it: the console cannot
       call replace(). substr()/instr() cover most cases, and the saved queries
       never needed it. If the owner does hit this, reinstating the call-form
       exception is one line — but it should be a decision he makes, not one
       this file makes quietly on his behalf. */
    return {
      ok: false,
      code: 'WRITE_VERB',
      message:
        'This looks like a write: "' + t.text + '" at character ' + (t.start + 1) +
        '. The Database page is read-only, so write words are refused wherever they appear. ' +
        'Note that a query starting with WITH is not automatically a read — SQLite allows ' +
        'WITH ... DELETE, where the write verb sits after the CTE list — which is why the ' +
        'whole statement is checked, not just its first word. ' +
        'If you have a column actually named ' + t.text.toLowerCase() +
        ', quote it as a double-quoted identifier and it will be accepted. ' +
        'This also catches the replace() text function, which is read-only but shares its ' +
        'name with the REPLACE INTO statement — use substr()/instr() instead, or ask for it ' +
        'to be allowed.',
      offset: t.start,
    };
  }

  /* Step 5 — banned constructs, whole word, any depth. */
  for (const t of toks) {
    const e = bannedEntryFor(t.upper);
    if (e) {
      return {
        ok: false,
        code: e.code,
        message:
          t.text + ' is not allowed (character ' + (t.start + 1) + ') — it ' + e.why + '. ' + e.instead,
        offset: t.start,
      };
    }
    if (BANNED_BARE_TABLES.has(t.upper)) {
      return {
        ok: false,
        code: 'BANNED_FUNCTION',
        message:
          t.text + ' is not allowed (character ' + (t.start + 1) +
          ') — it exposes the raw storage pages of the database, which would hand back the ' +
          'contents of every table underneath the masking this page applies to stored ' +
          'credentials. Query the tables themselves instead.',
        offset: t.start,
      };
    }
    if (BANNED_FUNCTIONS.has(t.upper) && isCallForm(s, t)) {
      return {
        ok: false,
        code: 'BANNED_FUNCTION',
        message:
          t.text + '() is not allowed (character ' + (t.start + 1) +
          ') — it reaches outside the database, to the server file system or to loadable code. ' +
          'Nothing on this page needs it.',
        offset: t.start,
      };
    }
  }

  /* Step 6 — EXPLAIN must be explaining a read.
     This runs LAST on purpose. EXPLAIN does not execute its operand, but it
     does prepare it, and there is no reason to allow it; running after steps 4
     and 5 means EXPLAIN DELETE ... is reported as the write it is rather than
     as a vague "bad start", and only genuinely unclassifiable operands
     (EXPLAIN with nothing useful after it) fall through to here. */
  if (first.upper === 'EXPLAIN') {
    let k = 1;
    if (toks[k] && toks[k].upper === 'QUERY' && toks[k + 1] && toks[k + 1].upper === 'PLAN') k += 2;
    const operand = toks[k];
    if (!operand || !READ_STARTERS.has(operand.upper) || operand.upper === 'EXPLAIN') {
      return {
        ok: false,
        code: 'BAD_START',
        message:
          operand
            ? 'EXPLAIN must be followed by SELECT or WITH (optionally EXPLAIN QUERY PLAN SELECT ...). ' +
              'Yours is followed by "' + operand.text + '" at character ' + (operand.start + 1) + '.'
            : 'EXPLAIN needs something to explain: EXPLAIN QUERY PLAN SELECT ...',
        offset: operand ? operand.start : first.start,
      };
    }
  }

  return { ok: true };
}
