/**
 * The reference tool-context builder (0002:T4.1): real `listChildren` over the
 * ChildrenStore seam, spawn-time parent-linkage recording (best-effort), and
 * the per-tool-call ingress workspace client bound to the private workspace.
 */

import { describe, expect, it } from "vitest";
import type { HarnessBuildContext } from "@teaspill/coordination";
import { privateWorkspaceKey } from "@teaspill/schema";
import { createMemoryChildrenStore, type ChildrenStore } from "./children.js";
import { createReferenceToolContext } from "./tool-context.js";

const PARENT = "/t/default/a/demo-pi/p-1";

function build(): HarnessBuildContext {
  return {
    ctx: {} as HarnessBuildContext["ctx"], // the builder never touches ctx
    entityId: PARENT,
    runId: "inv-run",
    wakeSource: "message",
  };
}

const binding = {
  entityUrl: PARENT,
  runId: "inv-run",
  toolUseId: "toolu_1",
  idempotencyKey: "KEY",
  signal: new AbortController().signal,
};

function fakeFetch(calls: Array<{ url: string; body: Record<string, unknown> }>): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
}

describe("createReferenceToolContext", () => {
  it("spawn fires the ingress send AND records the parent linkage; listChildren reads it back", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const children = createMemoryChildrenStore();
    const toolContext = createReferenceToolContext({
      ingressUrl: "http://restate:8080",
      fetch: fakeFetch(calls),
      children,
    })(build());

    const ctx = toolContext(binding);
    const { entityId } = await ctx.platform.spawn({ entityType: "conformance-echo", id: "kid-1" });
    expect(entityId).toBe("/t/default/a/conformance-echo/kid-1");
    expect(calls[0]!.url).toContain("/agent.conformance-echo/kid-1/spawn");
    expect(calls[0]!.body["parentRef"]).toBe(PARENT);

    const listed = await ctx.platform.listChildren();
    expect(listed).toEqual([
      { entityId: "/t/default/a/conformance-echo/kid-1", entityType: "conformance-echo", status: "active" },
    ]);
  });

  it("a failing linkage record NEVER fails the spawn (best-effort)", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const soft: string[] = [];
    const failing: ChildrenStore = {
      recordSpawn: async () => {
        throw new Error("db down");
      },
      listChildren: async () => [],
    };
    const toolContext = createReferenceToolContext({
      ingressUrl: "http://restate:8080",
      fetch: fakeFetch(calls),
      children: failing,
      onSoftError: (context) => soft.push(context),
    })(build());
    const ctx = toolContext(binding);
    const out = await ctx.platform.spawn({ entityType: "conformance-echo" });
    expect(out.entityId).toMatch(/^\/t\/default\/a\/conformance-echo\//);
    expect(soft).toHaveLength(1);
  });

  it("no children store ⇒ listChildren returns [] (pre-0002 behavior)", async () => {
    const toolContext = createReferenceToolContext({
      ingressUrl: "http://restate:8080",
      fetch: fakeFetch([]),
    })(build());
    expect(await toolContext(binding).platform.listChildren()).toEqual([]);
  });

  it("wires the workspace client to the entity's PRIVATE workspace key", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const toolContext = createReferenceToolContext({
      ingressUrl: "http://restate:8080",
      fetch: fakeFetch(calls),
      workspace: { ensure: { adapter: "docker" } },
    })(build());
    const ctx = toolContext(binding);
    expect(ctx.workspace).toBeDefined();
    expect(ctx.workspace!.workspaceRef).toBe(privateWorkspaceKey(PARENT));
    await ctx.workspace!.writeFile("a.txt", "x");
    expect(calls.map((c) => c.url)).toEqual([
      `http://restate:8080/workspace/${encodeURIComponent(privateWorkspaceKey(PARENT))}/ensure`,
      `http://restate:8080/workspace/${encodeURIComponent(privateWorkspaceKey(PARENT))}/fsWrite`,
    ]);
  });

  it("no workspace option ⇒ no workspace client (tools answer 'no workspace')", () => {
    const toolContext = createReferenceToolContext({
      ingressUrl: "http://restate:8080",
      fetch: fakeFetch([]),
    })(build());
    expect(toolContext(binding).workspace).toBeUndefined();
  });
});

describe("createMemoryChildrenStore", () => {
  it("is set-once per child and lists url-ordered", async () => {
    const store = createMemoryChildrenStore();
    await store.recordSpawn({ childUrl: "/t/default/a/t/b", parentUrl: PARENT });
    await store.recordSpawn({ childUrl: "/t/default/a/t/a", parentUrl: PARENT });
    await store.recordSpawn({ childUrl: "/t/default/a/t/b", parentUrl: "/t/default/a/x/other" });
    const listed = await store.listChildren(PARENT);
    expect(listed.map((c) => c.entityId)).toEqual(["/t/default/a/t/a", "/t/default/a/t/b"]);
  });
});
