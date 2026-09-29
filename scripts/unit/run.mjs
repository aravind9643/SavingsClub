// Runs every scripts/unit/*.test.ts with Node's built-in TypeScript
// stripping. No test framework: each file exits non-zero on failure.
//
//   npm run test:unit
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
let failed = 0;
for (const f of readdirSync(dir).filter((n) => n.endsWith('.test.ts')).sort()) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', `${dir}${f}`], { encoding: 'utf8' });
  const last = (r.stdout.trim().split('\n').pop() ?? '').trim();
  console.log(`${r.status === 0 ? 'ok  ' : 'FAIL'}  ${f.padEnd(24)} ${last}`);
  if (r.status !== 0) { failed++; process.stdout.write(r.stdout + r.stderr); }
}
process.exit(failed ? 1 : 0);
