/**
 * Shared test plumbing: gateway config factory, capturing fake upstream
 * HTTP servers, and a listening-gateway helper. Test-only (imported by
 * *.test.ts); kept under src/testing so the 0001:R5 fake and this glue live
 * together.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { GatewayConfig } from "../config.js";
import { createAuthenticator } from "../auth.js";
import { buildGateway } from "../app.js";

export const TEST_API_KEY = "tsp_test-key-for-gateway-tests";

export function testConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    tenant: "default",
    // Unroutable defaults so a test that forgets to point a route at its
    // fake upstream fails fast instead of hitting something real.
    restateIngressUrl: "http://127.0.0.1:9",
    restateAdminUrl: "http://127.0.0.1:9",
    electricUrl: "http://127.0.0.1:9",
    durableStreamsUrl: "http://127.0.0.1:9",
    databaseUrl: undefined,
    bootstrapApiKey: TEST_API_KEY,
    maxBodyBytes: 1024 * 1024,
    upstreamHeadersTimeoutMs: 10_000,
    jwtSecret: undefined,
    jwtClockToleranceSeconds: 60,
    corsAllowOrigins: "*",
    logLevel: "silent",
    otlpEndpoint: undefined,
    ...overrides,
  };
}

export function testGateway(config: GatewayConfig): FastifyInstance {
  return buildGateway(config, {
    authenticator: createAuthenticator({
      store: null,
      bootstrapApiKey: config.bootstrapApiKey,
    }),
  });
}

export async function listeningGateway(
  config: GatewayConfig,
): Promise<{ app: FastifyInstance; url: string }> {
  const app = testGateway(config);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return { app, url: `http://127.0.0.1:${port}` };
}

export interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface FakeUpstream {
  url: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

/** Minimal capturing upstream that answers every request identically. */
export async function fakeUpstream(respond: {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}): Promise<FakeUpstream> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(respond.status, respond.headers ?? {});
      res.end(respond.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}

export const authHeader = { authorization: `Bearer ${TEST_API_KEY}` };
