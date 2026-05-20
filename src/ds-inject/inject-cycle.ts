/**
 * DS_INJECT single cycle
 *
 * Flow: read payload → stale check → generate Pine → write file →
 *       dispatch to tw-mcp → poll receipt → parse isolation_verified → log
 */
import "dotenv/config";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  computeStaleness,
  generateDsTemplateV1,
  DomPayload,
} from "./template-v1.js";
import {
  logCycleMetrics,
  readRecentMetrics,
  computeMaxDup,
  CycleMetrics,
  CycleStatus,
} from "./metrics.js";
import {
  createDispatch,
  writeDispatch,
  pollForReceipt,
  isTargetAlive,
  DIRS,
} from "../lib/dispatch-manager.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const DOM_LEVELS_PATH =
  process.env.DOM_LEVELS_PATH ??
  path.join(os.homedir(), "data", "dom_levels_last.json");

const LOCK_PATH = DOM_LEVELS_PATH + ".lock";

const DS_PINE_OUTPUT =
  process.env.DS_PINE_OUTPUT ??
  path.join(os.homedir(), "data", "ds_levels_btc_pending.pine");

const MAX_DATA_AGE_MS = parseInt(
  process.env.DS_MAX_DATA_AGE_MS ?? String(30 * 60 * 1000)  // 30 min
);

const MAX_DUP_THRESHOLD = parseInt(process.env.DS_MAX_DUP ?? "3");

const DISPATCH_RECEIPT_TIMEOUT_MS = parseInt(
  process.env.DS_DISPATCH_TIMEOUT_MS ?? String(5 * 60 * 1000) // 5 min
);

// ─── Result type ──────────────────────────────────────────────────────────────

export interface CycleResult {
  status: CycleStatus;
  metrics: CycleMetrics;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function acquireLock(): boolean {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf-8"));
      const age = Date.now() - lock.acquired_at;
      if (age < 30_000) return false; // Active lock
    }
    fs.writeFileSync(
      LOCK_PATH,
      JSON.stringify({ owner: "orchestrator", pid: process.pid, acquired_at: Date.now() })
    );
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  try { fs.unlinkSync(LOCK_PATH); } catch { /* ignore */ }
}

async function readDomPayload(): Promise<DomPayload> {
  const raw = fs.readFileSync(DOM_LEVELS_PATH, "utf-8");
  return JSON.parse(raw) as DomPayload;
}

function parseIsolationVerified(
  responseBody: string | null | undefined
): boolean {
  if (!responseBody) return false;
  // tw-mcp coder writes "isolation_verified: true" or includes it in JSON
  return (
    responseBody.includes("isolation_verified: true") ||
    responseBody.includes('"isolation_verified":true') ||
    responseBody.includes('"isolation_verified": true')
  );
}

// ─── Main cycle ───────────────────────────────────────────────────────────────

export async function runCycle(
  cycleId: string,
  cycleNum: number,
  opts: { dryRun?: boolean; mockCompile?: boolean } = {}
): Promise<CycleResult> {
  const t0 = Date.now();

  const buildResult = (
    status: CycleStatus,
    extra: Partial<CycleMetrics> = {}
  ): CycleResult => {
    const metrics: CycleMetrics = {
      cycle_id: cycleId,
      cycle_num: cycleNum,
      timestamp: new Date().toISOString(),
      status,
      total_cycle_ms: Date.now() - t0,
      ...extra,
    };
    logCycleMetrics(metrics);
    return { status, metrics };
  };

  // ── 1. Check tw-mcp identity liveness (unless dry-run) ────────────────────
  if (!opts.dryRun && !opts.mockCompile && !isTargetAlive("tw-mcp")) {
    console.error(`[${cycleId}] tw-mcp is offline — skipping cycle`);
    return buildResult("dispatch_timeout", { error: "tw-mcp identity not alive" });
  }

  // ── 2. Check maxDup ───────────────────────────────────────────────────────
  const recent = readRecentMetrics(10);
  const maxDup = computeMaxDup(recent);
  if (maxDup >= MAX_DUP_THRESHOLD) {
    console.error(`[${cycleId}] maxDup=${maxDup} ≥ ${MAX_DUP_THRESHOLD} — emergency abort`);
    return buildResult("aborted_maxdup", { maxDup });
  }

  // ── 3. Read DOM payload ───────────────────────────────────────────────────
  let payload: DomPayload;
  try {
    payload = await readDomPayload();
  } catch (err) {
    console.error(`[${cycleId}] DOM read failed: ${err}`);
    return buildResult("data_read_failed", { error: String(err) });
  }

  // ── 4. Compute staleness ──────────────────────────────────────────────────
  const staleness = computeStaleness(payload.timestamp);
  const { tier, age_ms } = staleness;

  if (age_ms > MAX_DATA_AGE_MS) {
    console.warn(`[${cycleId}] data age ${Math.round(age_ms / 1000)}s > ${MAX_DATA_AGE_MS / 1000}s — aborting`);
    return buildResult("aborted_stale_data", {
      data_age_ms: age_ms,
      staleness_tier: tier,
    });
  }

  console.log(`[${cycleId}] payload: tier=${tier} age=${Math.round(age_ms / 1000)}s imbalance=${payload.summary.imbalance.toFixed(4)}`);

  // ── 5. Generate Pine Script ───────────────────────────────────────────────
  const pineSource = generateDsTemplateV1(payload, staleness, cycleId);

  // ── 6. Write Pine file (with lock) ────────────────────────────────────────
  const lockAcquired = acquireLock();
  if (!lockAcquired) {
    console.warn(`[${cycleId}] lock busy — skipping write`);
    return buildResult("error", { error: "DOM lock busy" });
  }
  try {
    fs.mkdirSync(path.dirname(DS_PINE_OUTPUT), { recursive: true });
    fs.writeFileSync(DS_PINE_OUTPUT, pineSource, "utf-8");
    console.log(`[${cycleId}] Pine written → ${DS_PINE_OUTPUT} (${pineSource.length} chars)`);
  } finally {
    releaseLock();
  }

  // ── 7. Compile (mock / dispatch) ─────────────────────────────────────────
  if (opts.dryRun || opts.mockCompile) {
    // Dry-run: skip actual compile, return success with isolation_verified=true
    console.log(`[${cycleId}] dry-run — skipping compile dispatch`);
    return buildResult("success", {
      data_age_ms: age_ms,
      staleness_tier: tier,
      isolation_verified: true,
      maxDup,
      imbalance: payload.summary.imbalance,
      bid_total: payload.summary.bid_total_size,
      ask_total: payload.summary.ask_total_size,
      compile_ms: 0,
    });
  }

  // Real dispatch to tw-mcp
  const dispatch = createDispatch("tw-mcp", `
## DS_INJECT Compile Request
**Cycle:** ${cycleId}
**File:** ${DS_PINE_OUTPUT}
**Staleness:** ${tier} (${Math.round(age_ms / 1000)}s)
**Imbalance:** ${payload.summary.imbalance.toFixed(4)}

### Steps:
1. \`pine_set_source\` — inject from file \`${DS_PINE_OUTPUT}\`
2. \`pine_smart_compile\` — compile on DS_INJECT sandbox tab
3. Verify indicator title = "DS_LEVELS_BTC" / shorttitle = "DS_BTC" is on the sandbox tab
4. Write receipt with: isolation_verified: true (if sandbox tab confirmed) OR isolation_verified: false

Reply with isolation_verified status in receipt response_body_markdown.
  `.trim(), "urgent", {
    type: "command",
    expects_ack: true,
    ttl_seconds: 360,
    context: { cycle_id: cycleId, pine_file: DS_PINE_OUTPUT, staleness: tier },
  });

  writeDispatch(dispatch);
  console.log(`[${cycleId}] dispatched → ${dispatch.dispatch_id}`);

  const t_dispatch = Date.now();
  const receipt = await pollForReceipt(
    dispatch.dispatch_id,
    DISPATCH_RECEIPT_TIMEOUT_MS
  );

  const compile_ms = Date.now() - t_dispatch;

  if (!receipt) {
    console.error(`[${cycleId}] dispatch timeout after ${compile_ms}ms`);
    return buildResult("dispatch_timeout", {
      data_age_ms: age_ms,
      staleness_tier: tier,
      compile_ms,
      dispatch_id: dispatch.dispatch_id,
      error: `No receipt in ${DISPATCH_RECEIPT_TIMEOUT_MS}ms`,
    });
  }

  if (receipt.status === "rejected") {
    console.error(`[${cycleId}] compile rejected: ${receipt.error}`);
    return buildResult("compile_error", {
      data_age_ms: age_ms,
      staleness_tier: tier,
      compile_ms,
      dispatch_id: dispatch.dispatch_id,
      isolation_verified: false,
      error: receipt.error ?? "rejected",
    });
  }

  const isolation_verified = parseIsolationVerified(receipt.response_body_markdown);

  if (!isolation_verified) {
    console.error(`[${cycleId}] isolation_verified=false — aborting`);
    return buildResult("isolation_failed", {
      data_age_ms: age_ms,
      staleness_tier: tier,
      compile_ms,
      dispatch_id: dispatch.dispatch_id,
      isolation_verified: false,
    });
  }

  console.log(`[${cycleId}] ✅ success compile_ms=${compile_ms} isolation=verified`);

  return buildResult("success", {
    data_age_ms: age_ms,
    staleness_tier: tier,
    compile_ms,
    total_cycle_ms: Date.now() - t0,
    isolation_verified: true,
    maxDup,
    imbalance: payload.summary.imbalance,
    bid_total: payload.summary.bid_total_size,
    ask_total: payload.summary.ask_total_size,
    dispatch_id: dispatch.dispatch_id,
  });
}
