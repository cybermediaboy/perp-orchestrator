import { z } from "zod";

const WEBHOOK_PORT = process.env.WEBHOOK_PORT ?? "8765";

export const webhookFireSchema = {
  alert_type: z.string().describe("Type of alert (e.g., 'signal', 'error', 'status')"),
  symbol: z.string().optional().describe("Trading symbol (e.g., 'BTCUSDT', 'ES1!')"),
  message: z.string().describe("Alert message content"),
  severity: z
    .enum(["info", "warning", "critical"])
    .default("info")
    .describe("Alert severity level"),
};

export async function webhookFire(args: {
  alert_type: string;
  symbol?: string;
  message: string;
  severity: "info" | "warning" | "critical";
}): Promise<{ status: "ok" | "error"; response_code: number }> {
  const url = `http://localhost:${WEBHOOK_PORT}/webhook/alert`;

  const body = {
    type: args.alert_type,
    symbol: args.symbol ?? null,
    message: args.message,
    severity: args.severity,
    timestamp: new Date().toISOString(),
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });

    return {
      status: response.ok ? "ok" : "error",
      response_code: response.status,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Webhook request failed: ${msg}`);
  }
}

export const webhookHealthSchema = {};

export async function webhookHealth(): Promise<{
  healthy: boolean;
  latency_ms: number;
}> {
  const url = `http://localhost:${WEBHOOK_PORT}/health`;
  const start = Date.now();

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });

    const latency_ms = Date.now() - start;
    return {
      healthy: response.ok,
      latency_ms,
    };
  } catch {
    const latency_ms = Date.now() - start;
    return {
      healthy: false,
      latency_ms,
    };
  }
}
