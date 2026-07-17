import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEPLOYMENT_URL,
  DEFAULT_GATEWAY_URL,
  deploymentUrlWarning,
  resolveConfig,
  resolveDeploymentUrls,
} from "./config.js";

describe("resolveConfig", () => {
  it("defaults gateway/tenant and leaves apiKey undefined", () => {
    const c = resolveConfig({}, {});
    expect(c.gatewayUrl).toBe(DEFAULT_GATEWAY_URL);
    expect(c.tenant).toBe("default");
    expect(c.apiKey).toBeUndefined();
  });

  it("reads from env", () => {
    const c = resolveConfig(
      {},
      {
        TEASPILL_GATEWAY_URL: "https://gw.example.com/",
        TEASPILL_API_KEY: "tsp_abc",
        TEASPILL_TENANT: "team-x",
      },
    );
    expect(c.gatewayUrl).toBe("https://gw.example.com"); // trailing slash trimmed
    expect(c.apiKey).toBe("tsp_abc");
    expect(c.tenant).toBe("team-x");
  });

  it("flags override env", () => {
    const c = resolveConfig(
      { gateway: "http://localhost:9999", apiKey: "flagkey", tenant: "flagt" },
      { TEASPILL_GATEWAY_URL: "http://env", TEASPILL_API_KEY: "envkey", TEASPILL_TENANT: "envt" },
    );
    expect(c.gatewayUrl).toBe("http://localhost:9999");
    expect(c.apiKey).toBe("flagkey");
    expect(c.tenant).toBe("flagt");
  });
});

describe("resolveDeploymentUrls", () => {
  it("defaults to host.docker.internal", () => {
    expect(resolveDeploymentUrls(undefined, {})).toEqual([DEFAULT_DEPLOYMENT_URL]);
  });
  it("uses flag list when provided", () => {
    expect(resolveDeploymentUrls(["http://a:1", "http://b:2"], {})).toEqual([
      "http://a:1",
      "http://b:2",
    ]);
  });
  it("parses a comma-separated env list", () => {
    expect(
      resolveDeploymentUrls(undefined, { TEASPILL_DEPLOYMENT_URL: "http://a:1, http://b:2" }),
    ).toEqual(["http://a:1", "http://b:2"]);
  });
});

describe("deploymentUrlWarning (host.docker.internal stance)", () => {
  it("warns on loopback hosts", () => {
    expect(deploymentUrlWarning("http://localhost:9080")).toContain("host.docker.internal");
    expect(deploymentUrlWarning("http://127.0.0.1:9080")).toContain("host.docker.internal");
  });
  it("is silent for host.docker.internal and service names", () => {
    expect(deploymentUrlWarning("http://host.docker.internal:9080")).toBeNull();
    expect(deploymentUrlWarning("http://agent-loop:9080")).toBeNull();
  });
});
