// Two invariants that only exist if they fail the gate the loop and CI actually run (L-020). `web`'s
// eslint baseline is red and nobody runs it, so this sits next to `bunx tsc --noEmit` instead.
//
//   1. src/admin/** never mounts the device. One stray `three` import drags the whole 3D console into
//      the admin chunk and the encapsulation becomes decorative.
//   2. The web twins of SPECIAL_ROLES and the event catalog match the backend source of truth (A2).
//
// The ban is on the DEVICE, not on the design system. Admin shares the app's palette, HeroUI wrappers,
// hardware keys and icons on purpose, so it looks like the same product rather than a scaffold.
//
// Run: cd web && bun run check:admin

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ADMIN_DIR = 'src/admin';

// Bare specifiers and path prefixes the admin surface must never reach for: WebGL, the timeline engine,
// the console shell, the game screens, and game audio. All of them either mount a renderer or pull a
// megabyte of scene code onto a page made of tables.
const BANNED = [
  'three',
  '@react-three/',
  'gsap',
  '@/components/console',
  '@/components/game',
  '@/lib/sound',
];

const failures: string[] = [];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

// Only real import/export specifiers count, so a banned word inside a comment or a string is not a false
// positive. This file's own BANNED list is the obvious example.
function specifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out.filter(Boolean);
}

for (const file of walk(ADMIN_DIR)) {
  const source = readFileSync(file, 'utf8');
  for (const spec of specifiers(source)) {
    const hit = BANNED.find((b) => spec === b || spec.startsWith(b));
    if (hit) failures.push(`${file}: imports "${spec}" (device-shell dependency "${hit}" is banned in ${ADMIN_DIR}/)`);
  }
}

// --- shared const drift (Addendum A2) ---

function arrayLiteral(source: string, name: string): string[] | null {
  const m = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source);
  if (!m) return null;
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
}

function compare(label: string, backendFile: string, backendName: string, webFile: string, webName: string): void {
  let backendSrc: string;
  let webSrc: string;
  try {
    backendSrc = readFileSync(backendFile, 'utf8');
    webSrc = readFileSync(webFile, 'utf8');
  } catch {
    // The catalog lands with the analytics ingest; until then there is nothing to compare.
    return;
  }
  const a = arrayLiteral(backendSrc, backendName);
  const b = arrayLiteral(webSrc, webName);
  if (!a || !b) {
    failures.push(`${label}: could not parse ${!a ? backendFile : webFile}, so drift cannot be checked`);
    return;
  }
  const missing = a.filter((x) => !b.includes(x));
  const extra = b.filter((x) => !a.includes(x));
  if (missing.length || extra.length) {
    failures.push(
      `${label}: web twin has drifted from the backend source of truth` +
        (missing.length ? `\n    missing in web: ${missing.join(', ')}` : '') +
        (extra.length ? `\n    not in backend: ${extra.join(', ')}` : ''),
    );
  }
}

compare('SPECIAL_ROLES', '../backend/src/config/roles.ts', 'SPECIAL_ROLES', 'src/admin/types.ts', 'SPECIAL_ROLES');
compare('EVENT_NAMES', '../backend/src/config/analytics-catalog.ts', 'EVENT_NAMES', 'src/lib/track.ts', 'EVENT_NAMES');

if (failures.length) {
  console.error(`check:admin failed with ${failures.length} problem${failures.length === 1 ? '' : 's'}:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('check:admin passed: no device-shell imports in src/admin/, shared consts in sync');
