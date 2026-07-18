/**
 * Agent-loop assembly (0002:T4.1): which agents are served, demo env-gating
 * (missing key ⇒ skipped, NEVER a crash), degraded no-database mode, and env
 * parsing for both services.
 */

import { describe, expect, it } from "vitest";
import { buildAgentLoop } from "./agent-loop.js";
import { CONFORMANCE_TYPES } from "./conformance-agents.js";
import { DEMO_TYPES } from "./demo-agents.js";
import { readAgentLoopEnv, readExecutorEnv } from "./env.js";

const baseCfg = {
  ingressUrl: "http://restate:8080",
  streamsUrl: "http://durable-streams:4437",
  gatewayUrl: "http://gateway:8787",
  deploymentUrl: "http://agent-loop:9080",
  logger: () => {},
};

describe("buildAgentLoop", () => {
  it("always serves the four conformance agents; demos skip without a key; no reconciler without a db", () => {
    const build = buildAgentLoop({ ...baseCfg });
    const types = build.definitions.map((d) => d.type);
    expect(types).toEqual([
      CONFORMANCE_TYPES.echo,
      CONFORMANCE_TYPES.fanoutParent,
      CONFORMANCE_TYPES.fanoutChild,
      CONFORMANCE_TYPES.longExec,
    ]);
    expect(build.skipped.map((s) => s.type)).toEqual([DEMO_TYPES.pi, DEMO_TYPES.casdk]);
    expect(build.reconciler).toBeNull();
    expect(build.objects).toHaveLength(4);
  });

  it("serves the pi demo with a key; CASDK stays opt-in", () => {
    const withKey = buildAgentLoop({ ...baseCfg, anthropicApiKey: "sk-ant-test" });
    expect(withKey.definitions.map((d) => d.type)).toContain(DEMO_TYPES.pi);
    expect(withKey.definitions.map((d) => d.type)).not.toContain(DEMO_TYPES.casdk);
    expect(withKey.skipped.map((s) => s.type)).toEqual([DEMO_TYPES.casdk]);

    const withCasdk = buildAgentLoop({
      ...baseCfg,
      anthropicApiKey: "sk-ant-test",
      demoCasdkEnabled: true,
    });
    expect(withCasdk.definitions.map((d) => d.type)).toContain(DEMO_TYPES.casdk);
    expect(withCasdk.skipped).toEqual([]);
  });

  it("building with demos NEVER loads a provider or throws without credentials at run-less time", () => {
    // Compiling + registration manifests must work with no key at all
    // (harness clients are lazy — 0001:T6.1).
    const build = buildAgentLoop({ ...baseCfg });
    const manifests = build.definitions.map((d) => d.registration());
    expect(manifests.every((m) => m.harness === "native")).toBe(true);
  });
});

describe("env parsing", () => {
  it("agent-loop defaults are the compose-overlay in-network values", () => {
    const env = readAgentLoopEnv({});
    expect(env).toMatchObject({
      port: 9080,
      gatewayUrl: "http://gateway:8787",
      ingressUrl: "http://restate:8080",
      streamsUrl: "http://durable-streams:4437",
      deploymentUrl: "http://agent-loop:9080",
      tenant: "default",
      migrate: true,
      reconcilerEnabled: true,
      workspaceAdapter: "docker",
      demoCasdkEnabled: false,
    });
    expect(env.apiKey).toBeUndefined();
    expect(env.databaseUrl).toBeUndefined();
  });

  it("reconciler and migrate opt-outs; casdk opt-in", () => {
    const env = readAgentLoopEnv({
      TEASPILL_RECONCILER: "off",
      TEASPILL_MIGRATE: "0",
      TEASPILL_DEMO_CASDK: "1",
      ANTHROPIC_API_KEY: "sk-ant-x",
      TEASPILL_DEPLOYMENT_URL: "http://host.docker.internal:9080",
    });
    expect(env.reconcilerEnabled).toBe(false);
    expect(env.migrate).toBe(false);
    expect(env.demoCasdkEnabled).toBe(true);
    expect(env.anthropicApiKey).toBe("sk-ant-x");
    expect(env.deploymentUrl).toBe("http://host.docker.internal:9080");
  });

  it("executor defaults", () => {
    expect(readExecutorEnv({})).toMatchObject({
      port: 9081,
      deploymentUrl: "http://executor:9081",
      adapter: "docker",
    });
  });
});
