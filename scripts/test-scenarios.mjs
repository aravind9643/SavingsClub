#!/usr/bin/env node
/**
 * Drive the app as real members, in whole scenarios.
 *
 *   node scripts/test-scenarios.mjs                    # all, against local
 *   node scripts/test-scenarios.mjs --only=loans       # one scenario
 *   node scripts/test-scenarios.mjs --target=remote    # the real project
 *   node scripts/test-scenarios.mjs --list
 *
 * LOCAL is the default, and deliberately so: a careless run should not be
 * able to write to a live ledger. --target=remote is an explicit choice.
 *
 * Every step goes through the app's own RPCs as a signed-in member, because
 * that is the only way to write here -- all 21 tables refuse direct
 * INSERT/UPDATE/DELETE. So a scenario that passes has satisfied every role
 * check, every cap and every RLS policy on the way through.
 */

import { readFileSync, existsSync } from 'node:fs';
import { Club, rupees, asRupees, today, monthStart } from './lib/club.mjs';
import { SCENARIOS } from './scenarios/index.mjs';

/* ------------------------------------------------------------------ setup */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

if (args.list) {
  console.log('\nScenarios:\n');
  for (const s of SCENARIOS) console.log(`  ${s.name.padEnd(22)} ${s.describe}`);
  console.log();
  process.exit(0);
}

const target = args.target === 'remote' ? 'remote' : 'local';

// .env.local is the app's own config; reuse it rather than inventing another.
function env() {
  const out = { ...process.env };
  if (existsSync('.env.local')) {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

const E = env();
const driverOpts = target === 'remote'
  ? {
      url: E.VITE_SUPABASE_URL,
      anonKey: E.VITE_SUPABASE_ANON_KEY,
      serviceKey: E.SUPABASE_SERVICE_ROLE_KEY,
    }
  : { db: args.db ?? 'sanchay_test', password: E.PGPASSWORD ?? '1122' };

/* ------------------------------------------------------------------ report */

const C = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m' }
  : { g: '', r: '', y: '', d: '', x: '' };

let checks = 0;
let failed = 0;

/** An assertion that says what it expected, in money the reader recognises. */
export function expect(label, got, want) {
  checks += 1;
  const ok = got === want;
  if (!ok) failed += 1;
  const fmt = (v) =>
    typeof v === 'bigint' || (typeof v === 'number' && Math.abs(v) >= 1000)
      ? `Rs.${asRupees(v)}`
      : String(v);
  console.log(
    `      ${ok ? C.g + 'ok  ' : C.r + 'FAIL'}${C.x} ${label}` +
    (ok ? '' : `\n           expected ${C.y}${fmt(want)}${C.x}, got ${C.r}${fmt(got)}${C.x}`),
  );
}

export function note(msg) {
  console.log(`      ${C.d}${msg}${C.x}`);
}

/* -------------------------------------------------------------------- run */

const chosen = args.only
  ? SCENARIOS.filter((s) => s.name === args.only)
  : SCENARIOS;

if (!chosen.length) {
  console.error(`No scenario called "${args.only}". Try --list.`);
  process.exit(2);
}

console.log(`\n  target: ${C.y}${target}${C.x}` +
  (target === 'local' ? ` ${C.d}(${driverOpts.db})${C.x}` : ` ${C.d}${E.VITE_SUPABASE_URL}${C.x}`));

const started = Date.now();

for (const scenario of chosen) {
  console.log(`\n  ${scenario.name} ${C.d}-- ${scenario.describe}${C.x}`);
  const before = failed;
  let club;
  try {
    club = await Club.open(target, driverOpts);
    await scenario.run({ club, expect, note, rupees, asRupees, today, monthStart, target });
  } catch (e) {
    failed += 1;
    console.log(`      ${C.r}THREW${C.x} ${e.message}`);
    if (args.trace) console.log(C.d + (e.stack ?? '') + C.x);
  } finally {
    await club?.close().catch(() => {});
  }
  if (failed === before) console.log(`      ${C.d}passed${C.x}`);
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `\n  ${failed ? C.r + failed + ' of ' + checks + ' checks failed' : C.g + checks + ' checks passed'}${C.x}` +
  ` ${C.d}in ${secs}s${C.x}\n`,
);
process.exit(failed ? 1 : 0);
