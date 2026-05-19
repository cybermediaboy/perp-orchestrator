#!/usr/bin/env node
/**
 * pickup-helper — Cascade-side dispatch pickup CLI
 *
 * Usage:
 *   node pickup-helper.js --target tw-mcp --check
 *     → prints latest pending dispatch for this target (or "none")
 *
 *   node pickup-helper.js --target tw-mcp --read
 *     → prints full dispatch body_markdown for Cascade to execute
 *
 *   node pickup-helper.js --target tw-mcp --write-receipt --dispatch-id <uuid> --status complete --response "Done: ..."
 *     → writes receipt + moves dispatch to archive/
 *
 *   node pickup-helper.js --target tw-mcp --reject --dispatch-id <uuid> --error "reason"
 *     → writes rejection receipt + moves dispatch to failed/
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const SHARED_STATE_DIR =
  process.env.SHARED_STATE_DIR ??
  path.join(os.homedir(), "CascadeProjects", "shared_state", "dispatches");

const DIRS = {
  inbox: path.join(SHARED_STATE_DIR, "inbox"),
  processing: path.join(SHARED_STATE_DIR, "processing"),
  receipts: path.join(SHARED_STATE_DIR, "receipts"),
  failed: path.join(SHARED_STATE_DIR, "failed"),
  archive: path.join(SHARED_STATE_DIR, "archive"),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); }
  catch { return null; }
}

function listJson(dir) {
  try { return fs.readdirSync(dir).filter(f => f.endsWith(".json")); }
  catch { return []; }
}

function findDispatchForTarget(target) {
  // Check processing first (already picked up), then inbox
  for (const dir of [DIRS.processing, DIRS.inbox]) {
    for (const file of listJson(dir)) {
      const d = readJson(path.join(dir, file));
      if (d && d.target === target) {
        return { dispatch: d, file, dir };
      }
    }
  }
  return null;
}

function moveFile(fromDir, toDir, filename) {
  try {
    fs.renameSync(path.join(fromDir, filename), path.join(toDir, filename));
    return true;
  } catch { return false; }
}

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
};
const has = (flag) => args.includes(flag);

const target = get("--target");
if (!target) {
  console.error("ERROR: --target required");
  process.exit(1);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

if (has("--check")) {
  const found = findDispatchForTarget(target);
  if (!found) {
    console.log("NO_DISPATCH");
    process.exit(0);
  }
  const { dispatch, dir } = found;
  const inDir = dir === DIRS.processing ? "processing" : "inbox";
  console.log(`DISPATCH_FOUND`);
  console.log(`ID: ${dispatch.dispatch_id}`);
  console.log(`TYPE: ${dispatch.envelope.type}`);
  console.log(`PRIORITY: ${dispatch.priority}`);
  console.log(`STATUS: ${inDir}`);
  console.log(`PREVIEW: ${dispatch.envelope.body_markdown.slice(0, 120)}`);
  process.exit(0);
}

if (has("--read")) {
  const found = findDispatchForTarget(target);
  if (!found) {
    console.log("NO_DISPATCH");
    process.exit(0);
  }
  const { dispatch, file, dir } = found;

  // Move to processing if still in inbox
  if (dir === DIRS.inbox) {
    moveFile(DIRS.inbox, DIRS.processing, file);
    // Write "received" receipt
    const received = {
      receipt_id: crypto.randomUUID(),
      dispatch_id: dispatch.dispatch_id,
      timestamp: new Date().toISOString(),
      responder: target,
      status: "received",
      error: null,
      processing_time_ms: Date.now() - new Date(dispatch.timestamp).getTime(),
    };
    const rName = `receipt_${dispatch.dispatch_id}_${received.timestamp.replace(/[:.]/g, "-")}.json`;
    fs.writeFileSync(path.join(DIRS.receipts, rName), JSON.stringify(received, null, 2));
  }

  // Output formatted dispatch for Cascade to execute
  console.log("═".repeat(72));
  console.log(`DISPATCH: ${dispatch.dispatch_id}`);
  console.log(`TARGET:   ${dispatch.target}`);
  console.log(`TYPE:     ${dispatch.envelope.type}`);
  console.log(`PRIORITY: ${dispatch.priority}`);
  if (dispatch.envelope.context) {
    console.log(`CONTEXT:  ${JSON.stringify(dispatch.envelope.context)}`);
  }
  console.log("═".repeat(72));
  console.log("");
  console.log(dispatch.envelope.body_markdown);
  console.log("");
  console.log("═".repeat(72));
  console.log(`DISPATCH_ID=${dispatch.dispatch_id}`);
  process.exit(0);
}

if (has("--write-receipt")) {
  const dispatchId = get("--dispatch-id");
  const status = get("--status") ?? "complete";
  const response = get("--response") ?? "";

  if (!dispatchId) {
    console.error("ERROR: --dispatch-id required");
    process.exit(1);
  }

  // Find the dispatch file to get original data + move to archive
  let startedAt = new Date().toISOString();
  for (const file of listJson(DIRS.processing)) {
    if (file.includes(dispatchId)) {
      const d = readJson(path.join(DIRS.processing, file));
      if (d) startedAt = d.timestamp;
      moveFile(DIRS.processing, DIRS.archive, file);
      break;
    }
  }

  const receipt = {
    receipt_id: crypto.randomUUID(),
    dispatch_id: dispatchId,
    timestamp: new Date().toISOString(),
    responder: target,
    status,
    response_body_markdown: response,
    error: null,
    processing_time_ms: Date.now() - new Date(startedAt).getTime(),
    metadata: { auto_pickup: true },
  };

  const ts = receipt.timestamp.replace(/[:.]/g, "-");
  const rPath = path.join(DIRS.receipts, `receipt_${dispatchId}_${ts}.json`);
  fs.writeFileSync(rPath, JSON.stringify(receipt, null, 2));

  console.log(`RECEIPT_WRITTEN: ${rPath}`);
  console.log(`STATUS: ${status}`);
  process.exit(0);
}

if (has("--reject")) {
  const dispatchId = get("--dispatch-id");
  const error = get("--error") ?? "Execution failed";

  if (!dispatchId) {
    console.error("ERROR: --dispatch-id required");
    process.exit(1);
  }

  // Move from processing to failed
  for (const file of listJson(DIRS.processing)) {
    if (file.includes(dispatchId)) {
      moveFile(DIRS.processing, DIRS.failed, file);
      break;
    }
  }

  const receipt = {
    receipt_id: crypto.randomUUID(),
    dispatch_id: dispatchId,
    timestamp: new Date().toISOString(),
    responder: target,
    status: "rejected",
    response_body_markdown: null,
    error,
    processing_time_ms: 0,
    metadata: { auto_pickup: true },
  };

  const ts = receipt.timestamp.replace(/[:.]/g, "-");
  const rPath = path.join(DIRS.receipts, `receipt_${dispatchId}_${ts}.json`);
  fs.writeFileSync(rPath, JSON.stringify(receipt, null, 2));

  console.log(`REJECTION_WRITTEN: ${rPath}`);
  process.exit(0);
}

console.error("ERROR: unknown command. Use --check, --read, --write-receipt, or --reject");
process.exit(1);
