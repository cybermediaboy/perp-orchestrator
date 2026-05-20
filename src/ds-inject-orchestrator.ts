#!/usr/bin/env node
/**
 * DS_INJECT Orchestrator — 15-min continuous cycle daemon
 *
 * Usage:
 *   node dist/ds-inject-orchestrator.js           # production (dispatches to tw-mcp)
 *   node dist/ds-inject-orchestrator.js --dry-run  # dry-run (skips compile)
 *   node dist/ds-inject-orchestrator.js --once     # single cycle then exit
 *   node dist/ds-inject-orchestrator.js --dry-run --once  # single dry-run cycle
 */
import "dotenv/config";
import { randomUUID } from "crypto";
import { runCycle } from "./ds-inject/inject-cycle.js";
import { readRecentMetrics } from "./ds-inject/metrics.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const CYCLE_INTERVAL_MS = parseInt(
  process.env.DS_CYCLE_INTERVAL_MS ?? String(15 * 60 * 1000) // 15 min
);
const MAX_RETRY = 3;
const RETRY_BASE_MS = 5_000; // 5s → 10s → 20s

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ONCE = args.includes("--once");

// ─── State ────────────────────────────────────────────────────────────────────

let shuttingDown = false;
let cycleNum = 0;

process.on("SIGTERM", () => {
  console.log("[orchestrator] SIGTERM received — finishing current cycle then exiting");
  shuttingDown = true;
});
process.on("SIGINT", () => {
  console.log("[orchestrator] SIGINT received — graceful shutdown");
  shuttingDown = true;
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const timer = setTimeout(finish, ms);
    const check = setInterval(() => {
      if (shuttingDown) { clearTimeout(timer); clearInterval(check); finish(); }
    }, 500);
    setTimeout(() => clearInterval(check), ms + 1000);
  });
}

function makeCycleId(): string {
  cycleNum++;
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `DS_INJECT_${ts}_C${cycleNum.toString().padStart(3, "0")}`;
}

function printStatus(): void {
  const recent = readRecentMetrics(5);
  const successes = recent.filter((m) => m.status === "success").length;
  console.log(`[orchestrator] recent 5 cycles: ${successes}/5 success`);
  if (recent.length > 0) {
    const last = recent[recent.length - 1];
    console.log(`[orchestrator] last: ${last.status} | stale=${last.staleness_tier ?? "?"} | imb=${last.imbalance?.toFixed(4) ?? "?"}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[orchestrator] DS_INJECT Orchestrator starting`);
  console.log(`[orchestrator] cycle_interval=${CYCLE_INTERVAL_MS / 1000}s dry_run=${DRY_RUN} once=${ONCE}`);
  console.log(`[orchestrator] PID=${process.pid} session=${randomUUID().slice(0, 8)}`);
  console.log();

  while (!shuttingDown) {
    const cycleId = makeCycleId();
    console.log(`\n[orchestrator] ── cycle ${cycleNum} start ── ${cycleId}`);

    let result = null;
    for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
      if (attempt > 0) {
        const backoff = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        console.log(`[${cycleId}] retry ${attempt}/${MAX_RETRY - 1} in ${backoff}ms`);
        await sleep(backoff);
        if (shuttingDown) break;
      }

      try {
        result = await runCycle(cycleId, cycleNum, { dryRun: DRY_RUN });
      } catch (err) {
        console.error(`[${cycleId}] unhandled error (attempt ${attempt + 1}): ${err}`);
        continue;
      }

      // Retry only on data_read_failed (transient); abort on others
      if (result.status !== "data_read_failed") break;
    }

    if (!result) {
      console.error(`[${cycleId}] all retries exhausted`);
    } else {
      const ok = result.status === "success";
      console.log(`[orchestrator] cycle ${cycleNum} → ${ok ? "✅" : "❌"} ${result.status} (${result.metrics.total_cycle_ms}ms)`);
    }

    printStatus();

    if (ONCE || shuttingDown) break;

    console.log(`[orchestrator] sleeping ${CYCLE_INTERVAL_MS / 1000}s until next cycle`);
    await sleep(CYCLE_INTERVAL_MS);
  }

  const t1 = new Date().toISOString();
  console.log(`\n[orchestrator] shutdown complete at ${t1}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[orchestrator] fatal:", err);
  process.exit(1);
});
