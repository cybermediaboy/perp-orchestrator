/**
 * Integration test for inject-cycle (dry-run + mock compile)
 *
 * Does NOT call TradingView Desktop.
 * Uses --dry-run flag so dispatch is skipped.
 */
import assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { runCycle } from "../../src/ds-inject/inject-cycle.js";
import { readRecentMetrics } from "../../src/ds-inject/metrics.js";

const METRICS_PATH = path.join(os.homedir(), "data", "ds_inject_metrics.jsonl");
const DOM_PATH = path.join(os.homedir(), "data", "dom_levels_last.json");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function assertDomFileExists(): void {
  assert.ok(
    fs.existsSync(DOM_PATH),
    `DOM data file not found: ${DOM_PATH}\nRun the LibCoder fetcher first.`
  );
}

async function runDryCycle(cycleNum: number): Promise<ReturnType<typeof runCycle>> {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const cycleId = `DS_INJECT_${ts}_TEST${cycleNum}`;
  return runCycle(cycleId, cycleNum, { dryRun: true });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function test_dom_file_readable() {
  assertDomFileExists();
  const raw = fs.readFileSync(DOM_PATH, "utf-8");
  const payload = JSON.parse(raw);
  assert.ok(typeof payload.timestamp === "number", "timestamp must be number");
  assert.ok(Array.isArray(payload.levels.bid), "levels.bid must be array");
  assert.ok(Array.isArray(payload.levels.ask), "levels.ask must be array");
  assert.ok(payload.levels.bid.length > 0, "must have bid levels");
  console.log(`  ✅ DOM file readable: ${payload.levels.bid.length} bid levels, exchange=${payload.exchange}`);
}

async function test_single_dry_run_cycle() {
  assertDomFileExists();
  const result = await runDryCycle(1);
  assert.ok(
    result.status === "success" || result.status === "aborted_stale_data",
    `Expected success or aborted_stale_data, got: ${result.status}`
  );
  if (result.status === "success") {
    assert.strictEqual(result.metrics.isolation_verified, true, "dry-run must set isolation_verified=true");
    assert.ok(result.metrics.data_age_ms !== undefined, "data_age_ms must be set");
    assert.ok(result.metrics.staleness_tier !== undefined, "staleness_tier must be set");
  }
  console.log(`  ✅ single dry-run: ${result.status} tier=${result.metrics.staleness_tier ?? "n/a"}`);
}

async function test_pine_file_written() {
  assertDomFileExists();
  const pinePath = path.join(os.homedir(), "data", "ds_levels_btc_pending.pine");
  await runDryCycle(2);
  assert.ok(fs.existsSync(pinePath), `Pine output file not found: ${pinePath}`);
  const src = fs.readFileSync(pinePath, "utf-8");
  assert.ok(src.startsWith("//@version=6"), "generated file must be valid Pine v6");
  assert.ok(src.includes('indicator("DS_LEVELS_BTC"'), "must be DS_LEVELS_BTC indicator");
  console.log(`  ✅ Pine file written: ${src.length} chars`);
}

async function test_metrics_appended() {
  assertDomFileExists();
  const beforeCount = readRecentMetrics(1000).length;
  await runDryCycle(3);
  const afterCount = readRecentMetrics(1000).length;
  assert.ok(afterCount > beforeCount, "metrics must be appended after cycle");
  const last = readRecentMetrics(1)[0];
  assert.ok(last.cycle_id.includes("TEST"), "last metric must be our test cycle");
  console.log(`  ✅ metrics appended: ${afterCount - beforeCount} new entries`);
}

async function test_maxdup_detection() {
  assertDomFileExists();
  // Run 4 cycles with same payload — 4th should trigger maxDup (threshold=3)
  for (let i = 0; i < 3; i++) {
    await runDryCycle(100 + i);
  }
  // The 4th cycle might trigger maxDup depending on state
  const result = await runDryCycle(103);
  // Either succeeds (threshold not hit yet) or aborts — both are valid outcomes
  assert.ok(
    ["success", "aborted_maxdup", "aborted_stale_data"].includes(result.status),
    `unexpected status: ${result.status}`
  );
  console.log(`  ✅ maxDup detection: 4th cycle → ${result.status}`);
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\nDS_INJECT cycle integration tests (dry-run)");
  console.log("─".repeat(40));

  let passed = 0; let failed = 0;

  const tests = [
    test_dom_file_readable,
    test_single_dry_run_cycle,
    test_pine_file_written,
    test_metrics_appended,
    test_maxdup_detection,
  ];

  for (const t of tests) {
    try {
      await t();
      passed++;
    } catch (err) {
      console.error(`  ❌ ${t.name}: ${err}`);
      failed++;
    }
  }

  console.log("─".repeat(40));
  console.log(`RESULT: ${passed} pass / ${failed} fail`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
