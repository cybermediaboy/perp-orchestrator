export async function tunnelStatus(): Promise<{
  active: boolean;
  connections: number;
  tunnel_id: string;
}> {
  const TUNNEL_ID = "992bd692-8e97-43a5-a2c3-c9f69a31b0ae";

  try {
    const response = await fetch("http://localhost:20241/metrics", {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      return { active: false, connections: 0, tunnel_id: TUNNEL_ID };
    }

    const text = await response.text();

    // Parse Prometheus metrics for connection count
    const connMatch = text.match(
      /cloudflared_tunnel_active_streams\s+(\d+)/
    );
    const connections = connMatch ? parseInt(connMatch[1], 10) : 0;

    // Check for tunnel_id confirmation in metrics
    const hasTunnel = text.includes(TUNNEL_ID) || text.includes("cloudflared");

    return {
      active: hasTunnel,
      connections,
      tunnel_id: TUNNEL_ID,
    };
  } catch {
    // Metrics endpoint not reachable — try fallback: check if cloudflared process exists
    try {
      const proc = await import("child_process");
      const result = proc.execSync("pgrep -x cloudflared", {
        encoding: "utf-8",
        timeout: 2000,
      });
      const active = result.trim().length > 0;
      return { active, connections: 0, tunnel_id: TUNNEL_ID };
    } catch {
      return { active: false, connections: 0, tunnel_id: TUNNEL_ID };
    }
  }
}
