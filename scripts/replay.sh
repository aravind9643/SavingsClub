#!/usr/bin/env bash
# Rebuild sanchay_test from nothing, then run both SQL suites.
#   PGPASSWORD=... bash scripts/replay.sh            # replay + assertions + isolation
#   PGPASSWORD=... bash scripts/replay.sh --no-tests # replay only (before test-scenarios.mjs)
# Each migration runs in its own transaction, as the Supabase CLI does.
export PATH="/c/Program Files/PostgreSQL/18/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
P="psql -h 127.0.0.1 -U postgres"
$P -q -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='sanchay_test' and pid<>pg_backend_pid()" >/dev/null
$P -q -c "drop database if exists sanchay_test" -c "create database sanchay_test" || exit 1
$P -d sanchay_test -q -v ON_ERROR_STOP=1 -f supabase/tests/shim.sql 2>&1 | grep -v NOTICE
n=0
for f in supabase/migrations/*.sql; do
  out=$($P -d sanchay_test -q -v ON_ERROR_STOP=1 --single-transaction -f "$f" 2>&1)
  if [ $? -ne 0 ]; then echo "FAILED at $f"; echo "$out" | grep -v NOTICE | tail -8; exit 1; fi
  n=$((n+1))
done
echo "replayed $n migrations OK"
[ "$1" = "--no-tests" ] && exit 0
for t in assertions isolation; do
  echo "=== $t.sql"
  $P -d sanchay_test -v ON_ERROR_STOP=1 -f supabase/tests/$t.sql 2>&1 \
    | grep -E "PASS|FAIL|WARNING|ERROR|PASSED|checks passed|CONTEXT|LINE" | sed 's/^psql:[^:]*:[0-9]*: //' | tail -40
done
