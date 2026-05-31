#!/usr/bin/env python3
"""
Migrate all client-side mutation fetches to the api() helper.

For each .tsx page file under src/app/:
  1. Add `import { api } from '@/lib/api';` if not present.
  2. Replace `fetch(` → `api(` when the call uses POST/PUT/PATCH/DELETE.
  3. Strip `headers: { 'Content-Type': 'application/json' },`
  4. Replace `body: JSON.stringify(<expr>)` → `body: <expr>`

Conservative — only touches calls whose options object includes a `method:` field
matching one of the mutating verbs. GET fetches are left alone.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / 'src' / 'app'

MUTATING_METHODS = ('POST', 'PUT', 'PATCH', 'DELETE')

def find_fetch_blocks(text: str):
    """Yield (start, end) byte offsets of every `fetch(` call body that contains
    a method: '<MUTATING>' field. Naive but works for our codebase patterns."""
    out = []
    i = 0
    while True:
        idx = text.find('fetch(', i)
        if idx == -1: break
        # Find matching closing paren — track depth
        depth = 0
        j = idx + len('fetch(')
        # skip first arg (URL string or template literal), find comma at depth 0
        while j < len(text):
            ch = text[j]
            if ch == '(': depth += 1
            elif ch == ')':
                if depth == 0: break
                depth -= 1
            j += 1
        if j >= len(text):
            break
        block = text[idx:j+1]
        # Check if it looks like a mutation
        if any(f"method: '{m}'" in block or f'method: "{m}"' in block for m in MUTATING_METHODS):
            out.append((idx, j+1, block))
        i = j + 1
    return out

def migrate_file(path: Path) -> tuple[bool, str]:
    """Returns (changed, summary)."""
    src = path.read_text()
    orig = src
    notes = []

    blocks = find_fetch_blocks(src)
    if not blocks:
        return (False, '')

    # Process from end to start so offsets stay valid
    for start, end, block in reversed(blocks):
        new_block = block

        # Replace fetch( → api(
        new_block = new_block.replace('fetch(', 'api(', 1)

        # Strip Content-Type header line — handles variations
        new_block = re.sub(
            r"headers:\s*\{\s*['\"]Content-Type['\"]\s*:\s*['\"]application/json['\"]\s*,?\s*\}\s*,?\s*\n?",
            '',
            new_block,
        )

        # body: JSON.stringify(expr)  →  body: expr
        # Match balanced parens for the inner expression
        def unstringify(m):
            after = m.string[m.end():]
            # Find matching close paren
            depth = 1; k = 0
            while k < len(after) and depth > 0:
                if after[k] == '(': depth += 1
                elif after[k] == ')': depth -= 1
                k += 1
            inner = after[:k-1]
            return f'body: {inner}'
        new_block = re.sub(
            r'body:\s*JSON\.stringify\(',
            lambda m: f'body: ',  # placeholder; handled below
            new_block,
        )
        # simpler approach: regex with balanced — fall back to non-nested match
        def replace_jsonstr(s: str) -> str:
            out = []; i = 0
            while i < len(s):
                m = re.search(r'body:\s*JSON\.stringify\(', s[i:])
                if not m: out.append(s[i:]); break
                out.append(s[i:i+m.start()])
                start = i + m.end()
                depth = 1; k = start
                while k < len(s) and depth > 0:
                    if s[k] == '(': depth += 1
                    elif s[k] == ')': depth -= 1
                    k += 1
                inner = s[start:k-1]
                out.append(f'body: {inner}')
                i = k
            return ''.join(out)
        # The regex above did a partial; redo properly
        new_block = block.replace('fetch(', 'api(', 1)
        new_block = re.sub(
            r"headers:\s*\{\s*['\"]Content-Type['\"]\s*:\s*['\"]application/json['\"]\s*,?\s*\}\s*,?\s*",
            '',
            new_block,
        )
        new_block = replace_jsonstr(new_block)

        if new_block != block:
            src = src[:start] + new_block + src[end:]
            notes.append(f'  • migrated mutation at offset {start}')

    # Add import if any change happened and import not present
    if src != orig and "from '@/lib/api'" not in src:
        # Insert after the last import line
        lines = src.split('\n')
        last_import = -1
        for i, l in enumerate(lines):
            if l.startswith('import '):
                last_import = i
        if last_import >= 0:
            lines.insert(last_import + 1, "import { api } from '@/lib/api';")
            src = '\n'.join(lines)

    if src != orig:
        path.write_text(src)
        return (True, '\n'.join(notes))
    return (False, '')


def main():
    total_files = 0
    total_changes = 0
    for p in ROOT.rglob('page.tsx'):
        # Skip vendors/users/PO/login — already migrated by hand
        rel = p.relative_to(ROOT.parent.parent)
        if any(skip in str(rel) for skip in ('vendors/page', 'users/page', 'purchase-orders/page', 'login/page')):
            continue
        changed, summary = migrate_file(p)
        if changed:
            total_files += 1
            print(f'✓ {rel}')
            if summary: print(summary)
            total_changes += summary.count('\n') + 1 if summary else 0
    print(f'\nMigrated {total_files} files.')

if __name__ == '__main__':
    main()
