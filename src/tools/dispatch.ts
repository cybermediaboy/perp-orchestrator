import { z } from "zod";
import {
  createDispatch,
  writeDispatch,
  findDispatch,
  findReceipt,
  scanDir,
  scanReceipts,
  getDispatchAge,
  isExpired,
  cancelSuperseded,
  pollForReceipt,
  isTargetAlive,
  getAllIdentities,
  readIdentity,
  DIRS,
  Priority,
  Target,
} from "../lib/dispatch-manager.js";

// ─── Target Registry ─────────────────────────────────────────────────────────

const TARGET_DESCRIPTIONS: Record<Target, string> = {
  "tw-mcp": "TradingView MCP coder — Pine Script edits, chart operations",
  "pg-mcp": "Pine-Guard MCP coder — pine-guard rules, validation, linting",
  libcoder: "Library coder — Pine Script lib + DSINJECT fetchers + trajectory queries (project-3)",
  bridge: "Bridge coder self — health checks, echo tests, trajectory on-demand",
};

// ─── Tool Schemas ─────────────────────────────────────────────────────────────

export const dispatchToCascadeSchema = {
  target: z
    .enum(["tw-mcp", "pg-mcp", "libcoder", "bridge"])
    .describe("Destination coder window"),
  message: z.string().describe("Message content in Markdown format"),
  priority: z
    .enum(["urgent", "normal", "low"])
    .default("normal")
    .describe("Processing priority"),
  type: z
    .enum(["command", "query", "info"])
    .default("command")
    .describe("Message type: command (action), query (question), info (FYI)"),
  context: z
    .record(z.unknown())
    .optional()
    .describe("Additional context metadata (file, line, etc.)"),
  expects_ack: z
    .boolean()
    .default(true)
    .describe("Whether to wait for an acknowledgement receipt"),
  ttl_seconds: z
    .number()
    .int()
    .min(1)
    .max(3600)
    .default(300)
    .describe("Time-to-live in seconds before dispatch expires"),
  supersedes: z
    .string()
    .optional()
    .describe("dispatch_id of a previous dispatch to cancel"),
  wait_for_receipt_ms: z
    .number()
    .int()
    .min(0)
    .max(30000)
    .default(0)
    .describe(
      "If >0, poll for receipt up to this many ms before returning (max 30s)"
    ),
  force: z
    .boolean()
    .default(false)
    .describe(
      "If true, dispatch even if target has no live identity (broadcast/override)"
    ),
  requires_approval: z
    .boolean()
    .default(true)
    .describe(
      "If false, target Cascade window auto-executes dispatch without user confirmation"
    ),
};

export const queryDispatchStatusSchema = {
  dispatch_id: z.string().describe("UUID of the dispatch to check"),
};

export const listPendingDispatchesSchema = {
  target: z
    .enum(["tw-mcp", "pg-mcp", "libcoder", "bridge"])
    .optional()
    .describe("Filter by target (omit for all targets)"),
  priority: z
    .enum(["urgent", "normal", "low"])
    .optional()
    .describe("Filter by priority (omit for all priorities)"),
};

export const listCascadeTargetsSchema = {};

export const checkMyInboxSchema = {
  target_id: z
    .enum(["tw-mcp", "pg-mcp", "libcoder", "bridge"])
    .describe("Target ID to check inbox for (your own target)"),
};

// ─── Tool Implementations ─────────────────────────────────────────────────────

export async function dispatchToCascade(args: {
  target: Target;
  message: string;
  priority: Priority;
  type: "command" | "query" | "info";
  context?: Record<string, unknown>;
  expects_ack: boolean;
  ttl_seconds: number;
  supersedes?: string;
  wait_for_receipt_ms: number;
  force: boolean;
  requires_approval: boolean;
}): Promise<object> {
  // Liveness check — reject if target has no live identity unless forced
  if (!args.force && args.target !== "bridge") {
    if (!isTargetAlive(args.target)) {
      const identity = readIdentity(args.target);
      const hint = identity
        ? `last seen ${Math.round((Date.now() - new Date(identity.last_seen).getTime()) / 1000)}s ago (TTL 90s)`
        : "no identity file — run: node dist/cascade-identity.js --target " + args.target;
      return {
        dispatch_id: null,
        status: "target_not_alive",
        target: args.target,
        hint,
        override: "set force=true to dispatch anyway",
      };
    }
  }

  // Cancel superseded dispatch from inbox if still pending
  if (args.supersedes) {
    const wasCancelled = cancelSuperseded(args.supersedes);
    if (!wasCancelled) {
      // Already in processing — note it but continue
    }
  }

  const dispatch = createDispatch(args.target, args.message, args.priority, {
    type: args.type,
    context: args.context,
    expects_ack: args.expects_ack,
    ttl_seconds: args.ttl_seconds,
    supersedes: args.supersedes,
    requires_approval: args.requires_approval,
  });

  writeDispatch(dispatch);

  // Optional inline wait
  if (args.wait_for_receipt_ms > 0 && args.expects_ack) {
    const receipt = await pollForReceipt(
      dispatch.dispatch_id,
      args.wait_for_receipt_ms
    );
    if (receipt) {
      return {
        dispatch_id: dispatch.dispatch_id,
        status: receipt.status,
        receipt,
        waited_ms: args.wait_for_receipt_ms,
        superseded_id: args.supersedes ?? null,
      };
    }
  }

  return {
    dispatch_id: dispatch.dispatch_id,
    status: "queued",
    target: dispatch.target,
    priority: dispatch.priority,
    ttl_seconds: dispatch.ttl_seconds,
    superseded_id: args.supersedes ?? null,
    hint: "Use query_dispatch_status(dispatch_id) to check for receipt",
  };
}

export function queryDispatchStatus(args: {
  dispatch_id: string;
}): object {
  const { dispatch_id } = args;

  // Check receipts first (most likely path for completed dispatches)
  const receipt = findReceipt(dispatch_id);
  if (receipt) {
    return {
      dispatch_id,
      status: receipt.status,
      receipt,
      location: "receipts",
      age_seconds: null,
    };
  }

  const found = findDispatch(dispatch_id);
  if (!found) {
    return {
      dispatch_id,
      status: "not_found",
      receipt: null,
      age_seconds: null,
      location: null,
    };
  }

  const { dispatch, location } = found;
  const age_seconds = Math.round(getDispatchAge(dispatch));
  const expired = isExpired(dispatch);

  const status =
    location === "failed"
      ? "timeout"
      : location === "processing" && expired
        ? "timeout"
        : location === "processing"
          ? "processing"
          : location === "inbox" && expired
            ? "timeout"
            : location === "inbox"
              ? "queued"
              : "complete";

  return {
    dispatch_id,
    status,
    location,
    age_seconds,
    ttl_seconds: dispatch.ttl_seconds,
    target: dispatch.target,
    priority: dispatch.priority,
    preview: dispatch.envelope.body_markdown.slice(0, 100),
    receipt: null,
  };
}

export function listPendingDispatches(args: {
  target?: Target;
  priority?: Priority;
}): object {
  const inboxItems = scanDir(DIRS.inbox).map((d) => ({
    ...d,
    _loc: "inbox" as const,
  }));
  const processingItems = scanDir(DIRS.processing).map((d) => ({
    ...d,
    _loc: "processing" as const,
  }));

  const all = [...inboxItems, ...processingItems].filter((d) => {
    if (args.target && d.target !== args.target) return false;
    if (args.priority && d.priority !== args.priority) return false;
    return true;
  });

  return {
    count: all.length,
    dispatches: all.map((d) => ({
      dispatch_id: d.dispatch_id,
      target: d.target,
      priority: d.priority,
      type: d.envelope.type,
      status: d._loc === "inbox" ? "queued" : "processing",
      age_seconds: Math.round(getDispatchAge(d)),
      ttl_seconds: d.ttl_seconds,
      preview:
        d.envelope.body_markdown.slice(0, 80) +
        (d.envelope.body_markdown.length > 80 ? "…" : ""),
    })),
  };
}

export function listCascadeTargets(): object {
  const inboxItems = scanDir(DIRS.inbox);
  const processingItems = scanDir(DIRS.processing);
  const identities = getAllIdentities();
  const identityMap = Object.fromEntries(identities.map((i) => [i.target_id, i]));

  const targets: Target[] = [
    "tw-mcp",
    "pg-mcp",
    "libcoder",
    "bridge",
  ];

  return {
    targets: targets.map((target_id) => {
      const pending = inboxItems.filter((d) => d.target === target_id).length;
      const processing = processingItems.filter((d) => d.target === target_id).length;
      const identity = identityMap[target_id] ?? null;
      const alive = identity
        ? (Date.now() - new Date(identity.last_seen).getTime()) / 1000 < 90
        : false;

      const status: "available" | "busy" | "offline" =
        processing > 0 ? "busy" : alive ? "available" : "offline";

      return {
        target_id,
        description: TARGET_DESCRIPTIONS[target_id],
        status,
        alive,
        pending_count: pending,
        processing_count: processing,
        identity: identity
          ? {
              pid: identity.pid,
              workspace_path: identity.workspace_path,
              session_id: identity.cascade_session_id,
              last_seen: identity.last_seen,
              last_seen_age_s: Math.round(
                (Date.now() - new Date(identity.last_seen).getTime()) / 1000
              ),
            }
          : null,
      };
    }),
  };
}

export function checkMyInbox(args: { target_id: Target }): object {
  const { target_id } = args;
  const inboxItems = scanDir(DIRS.inbox).filter((d) => d.target === target_id);

  const pending = inboxItems.map((dispatch) => {
    const age_seconds = Math.round(getDispatchAge(dispatch));
    const message_preview = dispatch.envelope.body_markdown.substring(0, 200);
    
    return {
      dispatch_id: dispatch.dispatch_id,
      priority: dispatch.priority,
      age_seconds,
      requires_approval: dispatch.requires_approval ?? true,
      message_preview,
      type: dispatch.envelope.type,
      timestamp: dispatch.timestamp,
    };
  });

  const auto_executable_count = pending.filter(
    (d) => d.requires_approval === false
  ).length;

  return {
    target_id,
    pending,
    total_count: pending.length,
    auto_executable_count,
    hint: auto_executable_count > 0
      ? `${auto_executable_count} dispatch(es) can auto-execute. Use query_dispatch_status(dispatch_id) to get full content.`
      : pending.length > 0
        ? "All pending dispatches require approval."
        : "Inbox empty.",
  };
}
