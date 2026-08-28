/**
 * Mechanically enforces .kiro/steering/house-style.md.
 *
 * House style that lives only in a document drifts within a month. This runs in
 * CI and fails the build, so the rules hold whether or not anyone remembers
 * them.
 *
 * Checks:
 *   1. No emoji outside the MARK/GLYPH allowlist.
 *   2. No italic markup of any kind.
 *   3. No Unicode small-caps or other font-faking.
 *
 * A line ending in or containing `style-ok` is exempt. This is for prose that
 * needs to name a banned construct in order to document it — without an escape
 * hatch the only way to explain a rule is to violate it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP = new Set(['node_modules', '.git', 'dist', '.pnpm-store', 'gen', 'proto']);
const EXTENSIONS = ['.ts', '.tsx', '.go'];

// Duplicated deliberately rather than imported: this script must run before the
// workspace is built, and must not be silenced by a change to the source it checks.
const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}]/gu;
const FAKE_FONT = /[\u1D00-\u1D7F\u{1D400}-\u{1D7FF}]/gu;
const ITALIC = /<\/?i>|<\/?em>|RichTextItalic|'italic'|"italic"/g;

/** Codepoints permitted to appear. Must match packages/ui/src/symbols.ts. */
const ALLOWED = new Set(['\u{1FA90}', '\u2696']);

/** Inline escape hatch for documentation that must name a banned construct. */
const PRAGMA = 'style-ok';

interface Finding {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

const findings: Finding[] = [];

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  // The allowlist and the detector itself necessarily contain the codepoints.
  const isAllowlist = rel.endsWith('symbols.ts') || rel.endsWith('check-style.ts');

  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (line.includes(PRAGMA)) return;

      if (!isAllowlist) {
        for (const match of line.matchAll(EMOJI)) {
          if (!ALLOWED.has(match[0])) {
            findings.push({
              file: rel,
              line: i + 1,
              rule: 'emoji-not-allowlisted',
              detail: `${JSON.stringify(match[0])} (U+${match[0]
                .codePointAt(0)!
                .toString(16)
                .toUpperCase()}) — add to MARK in packages/ui/src/symbols.ts or remove`,
            });
          }
        }
      }

      for (const match of line.matchAll(FAKE_FONT)) {
        findings.push({
          file: rel,
          line: i + 1,
          rule: 'font-faking',
          detail: `${JSON.stringify(match[0])} — use plain characters`,
        });
      }

      if (!isAllowlist) {
        for (const match of line.matchAll(ITALIC)) {
          findings.push({
            file: rel,
            line: i + 1,
            rule: 'no-italic',
            detail: `${match[0]} — use bold, code, or blockquote`,
          });
        }
      }
    });
}

if (findings.length === 0) {
  console.log('style: clean');
  process.exit(0);
}

console.error(`style: ${findings.length} violation(s)\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  [${f.rule}]\n    ${f.detail}`);
}
process.exit(1);
