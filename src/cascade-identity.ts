#!/usr/bin/env node
/**
 * cascade-identity — heartbeat daemon for a Cascade coder window.
 *
 * Usage:
 *   node dist/cascade-identity.js --target tw-mcp
 *   node dist/cascade-identity.js --target libcoder --workspace /path/to/project
 *
 * Writes ~/CascadeProjects/shared_state/targets/<target_id>.identity.json
 * every 30s. Poller reads this to determine liveness (alive if last_seen < 90s).
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";

// ─── Config ──────────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = parseInt(
  process.env.IDENTITY_HEARTBEAT_MS ?? "30000"
);
const TARGETS_DIR =
  process.env.TARGETS_DIR ??
  path.join(os.homedir(), "CascadeProjects", "shared_state", "targets");

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CascadeIdentity {
  target_id: string;
  pid: number;
  workspace_path: string;
  started_at: string;
  last_seen: string;
  cascade_session_id: string;
  version: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function identityPath(target_id: string): string {
  return path.join(TARGETS_DIR, `${target_id}.identity.json`);
}

function readExisting(target_id: string): CascadeIdentity | null {
  try {
    return JSON.parse(fs.readFileSync(identityPath(target_id), "utf-8"));
  } catch {
    return null;
  }
}

function writeIdentity(identity: CascadeIdentity): void {
  fs.mkdirSync(TARGETS_DIR, { recursive: true });
  const prev = readExisting(identity.target_id);

  if (prev && prev.pid !== identity.pid && prev.pid !== process.pid) {
    // Detect conflicting registration
    const prevAge =
      (Date.now() - new Date(prev.last_seen).getTime()) / 1000;
    if (prevAge < 90) {
      console.error(
        `[cascade-identity] ⚠️  conflict: target "${identity.target_id}" ` +
          `already claimed by PID ${prev.pid} (${Math.round(prevAge)}s ago) — ` +
          `last-writer-wins, overwriting`
      );
    }
  }

  fs.writeFileSync(
    identityPath(identity.target_id),
    JSON.stringify(identity, null, 2),
    "utf-8"
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const targetArg = args[args.indexOf("--target") + 1];
const workspaceArg = args.includes("--workspace")
  ? args[args.indexOf("--workspace") + 1]
  : process.cwd();

if (!targetArg) {
  console.error(
    "[cascade-identity] usage: node dist/cascade-identity.js --target <target_id> [--workspace /path]"
  );
  console.error(
    "  valid targets: tw-mcp, pg-mcp, libcoder, bridge"
  );
  process.exit(1);
}

const SESSION_ID = randomUUID();
const STARTED_AT = new Date().toISOString();

const identity: CascadeIdentity = {
  target_id: targetArg,
  pid: process.pid,
  workspace_path: workspaceArg,
  started_at: STARTED_AT,
  last_seen: STARTED_AT,
  cascade_session_id: SESSION_ID,
  version: "1.0.0",
};

// Write immediately on start
writeIdentity(identity);
console.error(
  `[cascade-identity] registered target="${targetArg}" pid=${process.pid} session=${SESSION_ID}`
);
console.error(
  `[cascade-identity] identity file: ${identityPath(targetArg)}`
);
console.error(
  `[cascade-identity] heartbeat every ${HEARTBEAT_INTERVAL_MS / 1000}s`
);

// Refresh loop
setInterval(() => {
  identity.last_seen = new Date().toISOString();
  writeIdentity(identity);
  console.error(
    `[cascade-identity] ♥  ${targetArg} — ${identity.last_seen}`
  );
}, HEARTBEAT_INTERVAL_MS);

// Cleanup on exit
function cleanup(): void {
  try {
    const p = identityPath(targetArg);
    if (fs.existsSync(p)) {
      // Mark as offline instead of deleting so poller sees the transition
      const final: CascadeIdentity = {
        ...identity,
        last_seen: new Date(0).toISOString(), // epoch = clearly dead
      };
      fs.writeFileSync(p, JSON.stringify(final, null, 2), "utf-8");
    }
  } catch { /* best effort */ }
  console.error(`[cascade-identity] ${targetArg} offline`);
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
