#!/usr/bin/env node
import "dotenv/config";
import {
  scanDir,
  createReceipt,
  writeReceipt,
  moveToProcessing,
  moveToFailed,
  moveToArchive,
  isExpired,
  DIRS,
  Dispatch,
} from "./lib/dispatch-manager.js";

// ─── Config ────────────────────────────────────────────────────────────────

const POLL_MS = parseInt(process.env.DISPATCH_INBOX_POLL_MS ?? "1500");
const ORPHAN_SWEEP_MS = parseInt(process.env.DISPATCH_ORPHAN_SWEEP_MS ?? "60000");

// ─── Stats ─────────────────────────────────────────────────────────────────

let processed = 0;
let errors = 0;
const startTime = Date.now();

// ─── Dispatch Handlers ────────────────────────────────────────────────────

async function handleEcho(dispatch: Dispatch): Promise<void> {
  await new Promise((r) => setTimeout(r, 30)); // simulate micro-latency

  const response =
    `**PONG** — bridge echo for \`${dispatch.dispatch_id}\`\n\n` +
    `**Type:** ${dispatch.envelope.type}  \n` +
    `**Priority:** ${dispatch.priority}  \n` +
    `**Target:** ${dispatch.target}  \n\n` +
    `**Echoed body:**\n\n${dispatch.envelope.body_markdown}`;

  writeReceipt(createReceipt(dispatch, "complete", response, undefined, { echo: true }));
  moveToArchive(dispatch);
  processed++;
  console.error(
    `[cascade-poller] ✅  echo ${dispatch.dispatch_id} (${Date.now() - new Date(dispatch.timestamp).getTime()}ms)`
  );
}

async function handleConsolePickup(dispatch: Dispatch): Promise<void> {
  console.error(`\n${"═".repeat(72)}`);
  console.error(`[cascade-poller] 📬  DISPATCH READY FOR CASCADE`);
  console.error(`  ID:       ${dispatch.dispatch_id}`);
  console.error(`  Target:   ${dispatch.target}`);
  console.error(`  Priority: ${dispatch.priority}`);
  console.error(`  Type:     ${dispatch.envelope.type}`);
  console.error(`  TTL:      ${dispatch.ttl_seconds}s`);
  if (dispatch.envelope.context) {
    console.error(`  Context:  ${JSON.stringify(dispatch.envelope.context)}`);
  }
  console.error(`  Body:\n`);
  console.error(dispatch.envelope.body_markdown);
  console.error(`\n${"═".repeat(72)}`);
  console.error(
    `[cascade-poller] Dispatch is in processing/ — Cascade window picks up + writes receipt`
  );

  // Write "received" ACK immediately
  writeReceipt(createReceipt(dispatch, "received", undefined, undefined, {
    note: "Awaiting Cascade window pickup",
  }));
  processed++;
}

async function processDispatch(dispatch: Dispatch): Promise<void> {
  moveToProcessing(dispatch);

  if (dispatch.target === "bridge") {
    await handleEcho(dispatch);
  } else {
    await handleConsolePickup(dispatch);
  }
}

// ─── Poll Loop ────────────────────────────────────────────────────────────

async function pollInbox(): Promise<void> {
  const items = scanDir(DIRS.inbox);

  for (const dispatch of items) {
    if (isExpired(dispatch)) {
      writeReceipt(
        createReceipt(dispatch, "timeout", undefined, "TTL expired in inbox (never picked up)")
      );
      moveToFailed(dispatch);
      errors++;
      console.error(
        `[cascade-poller] ⏱  expired in inbox: ${dispatch.dispatch_id}`
      );
      continue;
    }

    try {
      await processDispatch(dispatch);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cascade-poller] ❌  error on ${dispatch.dispatch_id}: ${msg}`);
      writeReceipt(createReceipt(dispatch, "rejected", undefined, msg));
      moveToFailed(dispatch);
      errors++;
    }
  }
}

// ─── Orphan Sweep ─────────────────────────────────────────────────────────

function orphanSweep(): void {
  let swept = 0;

  for (const dispatch of scanDir(DIRS.processing)) {
    if (isExpired(dispatch)) {
      writeReceipt(
        createReceipt(dispatch, "timeout", undefined, "TTL expired during processing")
      );
      moveToFailed(dispatch);
      swept++;
      errors++;
      console.error(
        `[cascade-poller] ⚠️  orphan swept: ${dispatch.dispatch_id}`
      );
    }
  }

  if (swept > 0) {
    console.error(`[cascade-poller] orphan sweep: ${swept} moved to failed/`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

console.error(
  `[cascade-poller] started — poll: ${POLL_MS}ms, sweep: ${ORPHAN_SWEEP_MS}ms`
);
console.error(`[cascade-poller] inbox:      ${DIRS.inbox}`);
console.error(`[cascade-poller] processing: ${DIRS.processing}`);
console.error(`[cascade-poller] receipts:   ${DIRS.receipts}`);

let lastSweep = Date.now();

setInterval(async () => {
  try {
    await pollInbox();
  } catch (err) {
    console.error("[cascade-poller] poll error:", err);
  }

  if (Date.now() - lastSweep >= ORPHAN_SWEEP_MS) {
    orphanSweep();
    lastSweep = Date.now();
  }
}, POLL_MS);

setInterval(() => {
  const uptime = Math.round((Date.now() - startTime) / 1000);
  console.error(
    `[cascade-poller] heartbeat — uptime: ${uptime}s, processed: ${processed}, errors: ${errors}`
  );
}, 60_000);

function shutdown(signal: string): void {
  const uptime = Math.round((Date.now() - startTime) / 1000);
  console.error(
    `\n[cascade-poller] ${signal} — uptime: ${uptime}s, processed: ${processed}, errors: ${errors}`
  );
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
