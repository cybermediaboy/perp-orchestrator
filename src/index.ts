#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import express from "express";

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

// --- Server Setup ---
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

// --- Transport Selection ---
const transportArg = process.argv.includes("--transport")
  ? process.argv[process.argv.indexOf("--transport") + 1]
  : "stdio";

async function main() {
  if (transportArg === "http") {
    const port = parseInt(process.env.MCP_HTTP_PORT ?? "8766", 10);
    const app = express();

    // Store active transports for SSE
    const transports: Record<string, SSEServerTransport> = {};

    app.get("/sse", async (req, res) => {
      const transport = new SSEServerTransport("/messages", res);
      transports[transport.sessionId] = transport;
      res.on("close", () => {
        delete transports[transport.sessionId];
      });
      await server.connect(transport);
    });

    app.post("/messages", async (req, res) => {
      const sessionId = req.query.sessionId as string;
      const transport = transports[sessionId];
      if (transport) {
        await transport.handlePostMessage(req, res);
      } else {
        res.status(400).json({ error: "Unknown session" });
      }
    });

    app.get("/health", (_req, res) => {
      res.json({ status: "ok", server: "perp-orchestrator", transport: "http+sse" });
    });

    app.listen(port, () => {
      console.error(`[perp-orchestrator] HTTP+SSE transport listening on port ${port}`);
      console.error(`[perp-orchestrator] SSE endpoint: http://localhost:${port}/sse`);
      console.error(`[perp-orchestrator] Health: http://localhost:${port}/health`);
    });
  } else {
    // Default: stdio transport for Windsurf/Claude
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[perp-orchestrator] stdio transport connected");
  }
}

main().catch((err) => {
  console.error("[perp-orchestrator] Fatal error:", err);
  process.exit(1);
});
