import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Target =
  | "tw-mcp"
  | "pg-mcp"
  | "libcoder"
  | "bridge";

export type Priority = "urgent" | "normal" | "low";
export type DispatchType = "command" | "query" | "info";
export type ReceiptStatus =
  | "received"
  | "processing"
  | "complete"
  | "rejected"
  | "timeout";
export type DispatchLocation =
  | "inbox"
  | "processing"
  | "failed"
  | "archive";

export interface Dispatch {
  dispatch_id: string;
  timestamp: string;
  source: "orchestrator" | "perplexity" | "manual";
  target: Target;
  priority: Priority;
  supersedes?: string;
  envelope: {
    type: DispatchType;
    body_markdown: string;
    context?: Record<string, unknown>;
  };
  expects_ack: boolean;
  ttl_seconds: number;
  reply_to?: string;
  requires_approval?: boolean;
}

export interface Receipt {
  receipt_id: string;
  dispatch_id: string;
  timestamp: string;
  responder: Target;
  status: ReceiptStatus;
  response_body_markdown?: string;
  error?: string | null;
  processing_time_ms?: number;
  metadata?: Record<string, unknown>;
}

// ─── Directory Setup ──────────────────────────────────────────────────────────

const SHARED_STATE_DIR =
  process.env.SHARED_STATE_DIR ??
  path.join(os.homedir(), "CascadeProjects", "shared_state", "dispatches");

export const TARGETS_DIR =
  process.env.TARGETS_DIR ??
  path.join(os.homedir(), "CascadeProjects", "shared_state", "targets");

export const DIRS = {
  inbox: path.join(SHARED_STATE_DIR, "inbox"),
  processing: path.join(SHARED_STATE_DIR, "processing"),
  receipts: path.join(SHARED_STATE_DIR, "receipts"),
  failed: path.join(SHARED_STATE_DIR, "failed"),
  archive: path.join(SHARED_STATE_DIR, "archive"),
};

export function ensureDirs(): void {
  Object.values(DIRS).forEach((d) => fs.mkdirSync(d, { recursive: true }));
  fs.mkdirSync(TARGETS_DIR, { recursive: true });
}

ensureDirs();

// ─── Identity Types & Helpers ─────────────────────────────────────────────────

export interface CascadeIdentity {
  target_id: string;
  pid: number;
  workspace_path: string;
  started_at: string;
  last_seen: string;
  cascade_session_id: string;
  version: string;
}

const IDENTITY_TTL_SECONDS = 90;

export function readIdentity(target_id: string): CascadeIdentity | null {
  const p = path.join(TARGETS_DIR, `${target_id}.identity.json`);
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as CascadeIdentity;
  } catch {
    return null;
  }
}

export function isTargetAlive(target_id: string): boolean {
  const identity = readIdentity(target_id);
  if (!identity) return false;
  const age = (Date.now() - new Date(identity.last_seen).getTime()) / 1000;
  return age < IDENTITY_TTL_SECONDS;
}

export function getAllIdentities(): CascadeIdentity[] {
  try {
    return fs
      .readdirSync(TARGETS_DIR)
      .filter((f) => f.endsWith(".identity.json"))
      .map((f) => {
        try {
          return JSON.parse(
            fs.readFileSync(path.join(TARGETS_DIR, f), "utf-8")
          ) as CascadeIdentity;
        } catch {
          return null;
        }
      })
      .filter((i): i is CascadeIdentity => i !== null);
  } catch {
    return [];
  }
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function listJsonFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

export function readJsonFile<T>(filepath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function dispatchFilename(dispatch: Dispatch): string {
  const ts = dispatch.timestamp.replace(/[:.]/g, "-");
  return `dispatch_${ts}_${dispatch.dispatch_id}.json`;
}

function receiptFilename(receipt: Receipt): string {
  const ts = receipt.timestamp.replace(/[:.]/g, "-");
  return `receipt_${receipt.dispatch_id}_${ts}.json`;
}

// ─── Dispatch Lifecycle ───────────────────────────────────────────────────────

export function createDispatch(
  target: Target,
  body_markdown: string,
  priority: Priority = "normal",
  opts: {
    type?: DispatchType;
    context?: Record<string, unknown>;
    expects_ack?: boolean;
    ttl_seconds?: number;
    supersedes?: string;
    reply_to?: string;
    requires_approval?: boolean;
  } = {}
): Dispatch {
  return {
    dispatch_id: randomUUID(),
    timestamp: new Date().toISOString(),
    source: "orchestrator",
    target,
    priority,
    supersedes: opts.supersedes,
    envelope: {
      type: opts.type ?? "command",
      body_markdown,
      context: opts.context,
    },
    expects_ack: opts.expects_ack ?? true,
    ttl_seconds: opts.ttl_seconds ?? 300,
    reply_to: opts.reply_to,
    requires_approval: opts.requires_approval ?? true,
  };
}

export function writeDispatch(dispatch: Dispatch): string {
  const filepath = path.join(DIRS.inbox, dispatchFilename(dispatch));
  fs.writeFileSync(filepath, JSON.stringify(dispatch, null, 2), "utf-8");

  // Also write to per-target inbox to trigger launchd QueueDirectories watcher
  const targetInbox = path.join(SHARED_STATE_DIR, dispatch.target, "inbox");
  fs.mkdirSync(targetInbox, { recursive: true });
  fs.writeFileSync(path.join(targetInbox, dispatchFilename(dispatch)), JSON.stringify(dispatch, null, 2), "utf-8");

  return filepath;
}

export function writeReceipt(receipt: Receipt): string {
  const filepath = path.join(DIRS.receipts, receiptFilename(receipt));
  fs.writeFileSync(filepath, JSON.stringify(receipt, null, 2), "utf-8");
  return filepath;
}

export function createReceipt(
  dispatch: Dispatch,
  status: ReceiptStatus,
  response?: string,
  error?: string,
  metadata?: Record<string, unknown>
): Receipt {
  return {
    receipt_id: randomUUID(),
    dispatch_id: dispatch.dispatch_id,
    timestamp: new Date().toISOString(),
    responder: dispatch.target,
    status,
    response_body_markdown: response,
    error: error ?? null,
    processing_time_ms: Date.now() - new Date(dispatch.timestamp).getTime(),
    metadata,
  };
}

// ─── Directory Scanning ───────────────────────────────────────────────────────

export function scanDir(dir: string): Dispatch[] {
  return listJsonFiles(dir)
    .map((f) => readJsonFile<Dispatch>(path.join(dir, f)))
    .filter((d): d is Dispatch => d !== null && "dispatch_id" in d);
}

export function scanReceipts(): Receipt[] {
  return listJsonFiles(DIRS.receipts)
    .map((f) => readJsonFile<Receipt>(path.join(DIRS.receipts, f)))
    .filter((r): r is Receipt => r !== null && "receipt_id" in r);
}

export function findDispatch(
  dispatch_id: string
): { dispatch: Dispatch; location: DispatchLocation } | null {
  const locations: Array<[string, DispatchLocation]> = [
    [DIRS.inbox, "inbox"],
    [DIRS.processing, "processing"],
    [DIRS.failed, "failed"],
    [DIRS.archive, "archive"],
  ];

  for (const [dir, location] of locations) {
    for (const file of listJsonFiles(dir)) {
      if (file.includes(dispatch_id)) {
        const dispatch = readJsonFile<Dispatch>(path.join(dir, file));
        if (dispatch) return { dispatch, location };
      }
    }
  }
  return null;
}

export function findReceipt(dispatch_id: string): Receipt | null {
  for (const file of listJsonFiles(DIRS.receipts)) {
    if (file.includes(dispatch_id)) {
      return readJsonFile<Receipt>(path.join(DIRS.receipts, file));
    }
  }
  return null;
}

// ─── File Moves ───────────────────────────────────────────────────────────────

function moveFile(fromDir: string, toDir: string, dispatch_id: string): boolean {
  for (const file of listJsonFiles(fromDir)) {
    if (file.includes(dispatch_id)) {
      try {
        fs.renameSync(path.join(fromDir, file), path.join(toDir, file));
        return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function moveToProcessing(dispatch: Dispatch): boolean {
  return moveFile(DIRS.inbox, DIRS.processing, dispatch.dispatch_id);
}

export function moveToFailed(dispatch: Dispatch): boolean {
  return (
    moveFile(DIRS.processing, DIRS.failed, dispatch.dispatch_id) ||
    moveFile(DIRS.inbox, DIRS.failed, dispatch.dispatch_id)
  );
}

export function moveToArchive(dispatch: Dispatch): boolean {
  return (
    moveFile(DIRS.processing, DIRS.archive, dispatch.dispatch_id) ||
    moveFile(DIRS.inbox, DIRS.archive, dispatch.dispatch_id)
  );
}

// ─── Supersede / TTL ─────────────────────────────────────────────────────────

export function cancelSuperseded(dispatch_id: string): boolean {
  for (const file of listJsonFiles(DIRS.inbox)) {
    if (file.includes(dispatch_id)) {
      try {
        fs.unlinkSync(path.join(DIRS.inbox, file));
        return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function getDispatchAge(dispatch: Dispatch): number {
  return (Date.now() - new Date(dispatch.timestamp).getTime()) / 1000;
}

export function isExpired(dispatch: Dispatch): boolean {
  return getDispatchAge(dispatch) > (dispatch.ttl_seconds ?? 300);
}

// ─── Polling ─────────────────────────────────────────────────────────────────

export async function pollForReceipt(
  dispatch_id: string,
  wait_ms: number,
  poll_interval_ms = 200
): Promise<Receipt | null> {
  const deadline = Date.now() + wait_ms;
  while (Date.now() < deadline) {
    const receipt = findReceipt(dispatch_id);
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, poll_interval_ms));
  }
  return null;
}
