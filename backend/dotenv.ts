import 'dotenv/config'; // default cwd-based load (prod workdir is backend/, so this covers it)
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Also load backend/.env resolved relative to THIS file, so a script invoked from the repo root (or an
// editor, or anywhere) still gets the env instead of a blank one and failing on a missing key. dotenv
// never overrides an already-set var, so when cwd is backend/ this is a harmless no-op.
config({ path: join(dirname(fileURLToPath(import.meta.url)), '.env') });
