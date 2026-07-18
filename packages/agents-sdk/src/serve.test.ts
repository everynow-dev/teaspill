import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineAgent } from "./define-agent.js";
import { native } from "./harness.js";
import { registerDeployment } from "./serve.js";

const agent = defineAgent({
  type: "researcher",
  revision: 2,
  state: z.object({ notes: z.array(z.string()).optional() }),
  harness: native({ model: "fake-model", platform: false }),
});

describe("registerDeployment", () => {
  it("POSTs the deployment uri to the gateway /registry/deployments with auth + idempotent force", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "dp_1" }), { status: 201 }));
    const result = await registerDeployment({
      gatewayUrl: "http://localhost:8081/",
      deploymentUrl: "http://host.docker.internal:9080",
      apiKey: "tsp_secret",
      agents: [agent],
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:8081/registry/deployments");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tsp_secret");
    expect(JSON.parse(init.body as string)).toEqual({
      uri: "http://host.docker.internal:9080",
      force: true,
    });

    // The revisioned manifest comes back for the caller.
    expect(result.deploymentUrl).toBe("http://host.docker.internal:9080");
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({ type: "researcher", revision: 2, harness: "native" });
  });

  it("throws on a non-2xx gateway response (0001:T6.2 owns retry/backoff)", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 502 }));
    await expect(
      registerDeployment({
        gatewayUrl: "http://localhost:8081",
        deploymentUrl: "http://host.docker.internal:9080",
        agents: [agent],
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/gateway 502/);
  });
});
