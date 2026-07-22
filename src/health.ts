import { createServer, type Server } from "node:http";

export interface HealthState {
  startedAt: string;
  eventReady: boolean;
  sqliteReady: boolean;
  feishuReady: boolean;
  modelConfigured: boolean;
  lastModelSuccess?: string;
  degradedReason?: string;
}

export function startHealthServer(host: string, port: number, state: HealthState): Server {
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/healthz") {
      response.writeHead(404).end();
      return;
    }
    const healthy = state.eventReady && state.sqliteReady && state.feishuReady && state.modelConfigured;
    response.writeHead(healthy ? 200 : 503, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ status: healthy ? "ok" : "degraded", ...state }));
  });
  server.listen(port, host);
  return server;
}
