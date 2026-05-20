#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import express from "express";
import fs from "fs";
import path from "path";
import os from "os";

import {
  perplexitySearch,
  perplexitySearchSchema,
} from "./tools/perplexity.js";
import {
  webhookFire,
  webhookFireSchema,
  webhookHealth,
} from "./tools/webhook.js";
import { tunnelStatus } from "./tools/tunnel.js";
import {
  dispatchToCascade,
  dispatchToCascadeSchema,
  queryDispatchStatus,
  queryDispatchStatusSchema,
  listPendingDispatches,
  listPendingDispatchesSchema,
  listCascadeTargets,
  listCascadeTargetsSchema,
  checkMyInbox,
  checkMyInboxSchema,
} from "./tools/dispatch.js";

// --- Server Setup ---
// Factory function to create a new McpServer instance with all tools registered.
// Used for per-connection instances in SSE mode to avoid SDK "Already connected" error.
function createServer(): McpServer {
  const server = new McpServer({
    name: "perp-orchestrator",
    version: "1.0.0",
  });

  // --- Tool Registration ---
  server.tool(
    "perplexity_search",
    "Search Perplexity AI for quant finance research",
    perplexitySearchSchema,
    async (args) => {
      const result = await perplexitySearch(args);
      const citationText =
        result.citations.length > 0
          ? `\n\nCitations:\n${result.citations.map((c, i) => `[${i + 1}] ${c}`).join("\n")}`
          : "";
      return {
        content: [{ type: "text", text: result.answer + citationText }],
      };
    }
  );

  server.tool(
    "webhook_fire",
    "Send alert to pine-guard webhook server",
    webhookFireSchema,
    async (args) => {
      const result = await webhookFire(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "tunnel_status",
    "Check if Cloudflare tunnel pine-guard-webhook is active",
    {},
    async () => {
      const result = await tunnelStatus();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "webhook_health",
    "Check if webhook server on localhost:8765 is running",
    {},
    async () => {
      const result = await webhookHealth();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "dispatch_to_cascade",
    "Send a dispatch to a Cascade coder window (tw-mcp, libcoder, researcher, trajectory, bridge)",
    dispatchToCascadeSchema,
    async (args) => {
      const result = await dispatchToCascade(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "query_dispatch_status",
    "Check the status of a previously sent dispatch by its dispatch_id",
    queryDispatchStatusSchema,
    async (args) => {
      const result = queryDispatchStatus(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "list_pending_dispatches",
    "List all pending or in-progress dispatches, optionally filtered by target or priority",
    listPendingDispatchesSchema,
    async (args) => {
      const result = listPendingDispatches(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "list_cascade_targets",
    "List all addressable Cascade coder targets with status and pending dispatch counts",
    listCascadeTargetsSchema,
    async () => {
      const result = listCascadeTargets();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "check_my_inbox",
    "Check your own inbox for pending dispatches. Returns auto-executable count and previews.",
    checkMyInboxSchema,
    async (args) => {
      const result = checkMyInbox(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  return server;
}

// --- Transport Selection ---
const transportArg = process.argv.includes("--transport")
  ? process.argv[process.argv.indexOf("--transport") + 1]
  : "stdio";

async function main() {
  if (transportArg === "http") {
    const port = parseInt(process.env.MCP_HTTP_PORT ?? "8766", 10);
    const app = express();

    // Bearer token auth (opt-in via BRIDGE_MCP_TOKEN env var)
    const MCP_TOKEN = process.env.BRIDGE_MCP_TOKEN;
    if (MCP_TOKEN) {
      const authMiddleware = (
        req: express.Request,
        res: express.Response,
        next: express.NextFunction
      ) => {
        const auth = req.headers.authorization;
        if (auth !== `Bearer ${MCP_TOKEN}`) {
          res.status(401).json({ error: "Unauthorized", hint: "Authorization: Bearer <BRIDGE_MCP_TOKEN>" });
          return;
        }
        next();
      };
      app.use("/sse", authMiddleware);
      app.use("/messages", authMiddleware);
      console.error(`[perp-orchestrator] bearer token auth enabled`);
    } else {
      console.error(`[perp-orchestrator] ⚠️  no BRIDGE_MCP_TOKEN set — SSE endpoint is unauthenticated`);
    }

    // Store active transports and servers for SSE (per-connection instances)
    const sessions: Record<string, { transport: SSEServerTransport; server: McpServer }> = {};

    app.get("/sse", async (req, res) => {
      const transport = new SSEServerTransport("/messages", res);
      const server = createServer(); // New instance per connection
      sessions[transport.sessionId] = { transport, server };
      
      res.on("close", () => {
        delete sessions[transport.sessionId];
        transport.close().catch(() => {}); // Clean up transport
      });
      
      await server.connect(transport);
    });

    app.post("/messages", async (req, res) => {
      const sessionId = req.query.sessionId as string;
      const session = sessions[sessionId];
      if (session) {
        await session.transport.handlePostMessage(req, res);
      } else {
        res.status(400).json({ error: "Unknown session" });
      }
    });

    // --- Push Notification System ---
    // Watch receipts directory and push notifications to all active SSE sessions
    const RECEIPTS_DIR = path.join(
      os.homedir(),
      "CascadeProjects",
      "shared_state",
      "dispatches",
      "receipts"
    );

    let debounceTimer: NodeJS.Timeout | null = null;
    const processedFiles = new Set<string>();

    function pushReceiptNotification(filename: string) {
      try {
        const receiptPath = path.join(RECEIPTS_DIR, filename);
        if (!fs.existsSync(receiptPath)) return;

        const content = fs.readFileSync(receiptPath, "utf8");
        const receipt = JSON.parse(content);

        const summary = receipt.response_body_markdown?.substring(0, 200) || "(no response)";
        const notification = {
          method: "notifications/receipt",
          params: {
            dispatch_id: receipt.dispatch_id,
            target: receipt.metadata?.target || "unknown",
            status: receipt.status,
            summary,
            receipt_id: receipt.receipt_id,
            timestamp: receipt.timestamp,
          },
        };

        // Push to all active sessions
        let pushCount = 0;
        for (const [sessionId, session] of Object.entries(sessions)) {
          try {
            // Send notification via transport (MCP protocol notifications/message)
            session.transport.send({
              jsonrpc: "2.0",
              method: "notifications/message",
              params: {
                level: "info",
                data: notification.params,
              },
            });
            pushCount++;
          } catch (err) {
            console.error(`[push] Failed to notify session ${sessionId}:`, err);
          }
        }

        if (pushCount > 0) {
          console.error(`[push] Receipt ${receipt.receipt_id} → ${pushCount} session(s)`);
        }
      } catch (err) {
        console.error(`[push] Failed to process ${filename}:`, err);
      }
    }

    if (fs.existsSync(RECEIPTS_DIR)) {
      const watcher = fs.watch(RECEIPTS_DIR, (eventType, filename) => {
        if (!filename || filename.startsWith(".") || filename.endsWith(".tmp")) return;
        if (processedFiles.has(filename)) return;

        // Debounce to handle rapid file system events
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          processedFiles.add(filename);
          pushReceiptNotification(filename);
          // Clean up old entries to prevent memory leak
          if (processedFiles.size > 1000) {
            const entries = Array.from(processedFiles);
            entries.slice(0, 500).forEach((f) => processedFiles.delete(f));
          }
        }, 200);
      });

      process.on("SIGTERM", () => {
        watcher.close();
      });

      console.error(`[push] Watching ${RECEIPTS_DIR} for receipt notifications`);
    } else {
      console.error(`[push] ⚠️  ${RECEIPTS_DIR} does not exist — push notifications disabled`);
    }

    app.get("/health", (_req, res) => {
      res.json({ status: "ok", server: "perp-orchestrator", transport: "http+sse" });
    });

    app.get("/mcp-health", (_req, res) => {
      res.json({ status: "ok", server: "perp-orchestrator", transport: "http+sse", via: "mcp.psbridge.com" });
    });

    // Kill any existing process on this port before starting
    const { execSync } = await import("child_process");
    try {
      const pids = execSync(`lsof -ti :${port}`, { encoding: "utf8" }).trim();
      if (pids) {
        console.error(`[perp-orchestrator] Killing existing process(es) on port ${port}: ${pids.replace(/\n/g, ", ")}`);
        execSync(`lsof -ti :${port} | xargs kill -9`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch {
      // No process on port — good
    }

    const httpServer = app.listen(port, () => {
      console.error(`[perp-orchestrator] HTTP+SSE transport listening on port ${port}`);
      console.error(`[perp-orchestrator] SSE endpoint: http://localhost:${port}/sse`);
      console.error(`[perp-orchestrator] Health: http://localhost:${port}/health`);
    });

    // Graceful shutdown
    const shutdown = () => {
      console.error("[perp-orchestrator] Shutting down...");
      httpServer.close();
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } else {
    // Default: stdio transport for Windsurf/Claude
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[perp-orchestrator] stdio transport connected");
  }
}

main().catch((err) => {
  console.error("[perp-orchestrator] Fatal error:", err);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("[perp-orchestrator] Uncaught exception:", err.message);
});
