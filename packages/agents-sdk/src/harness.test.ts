/**
 * httpToolContext transport regression (0002:T4.2): the tool-invocation
 * idempotency key — `toolIdempotencyKey`'s rendering embeds U+001F — must be
 * header-safe by the time it rides the `idempotency-key` header of a raw
 * Restate ingress POST. Discovered live: undici rejects the raw key
 * (`invalid idempotency-key header`), which broke EVERY ingress tool effect.
 */

import { describe, expect, it } from "vitest";
import { headerSafeIdempotencyKey, toolIdempotencyKey } from "@teaspill/harness-native";
import type { HarnessBuildContext } from "@teaspill/coordination";
import { httpToolContext } from "./harness.js";

const ENTITY = "/t/default/a/demo/01unit";

function capturedFetch(calls: { url: string; headers: Record<string, string> }[]): typeof fetch {
  return (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init); // throws on an illegal header value, like real fetch
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    calls.push({ url: req.url, headers });
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
}

describe("httpToolContext idempotency-key header transport (0002:T4.2)", () => {
  it("sends the HEADER-SAFE rendering of a real toolIdempotencyKey on spawn and send", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const builder = httpToolContext({ ingressUrl: "http://restate:8080", fetch: capturedFetch(calls) });
    const raw = toolIdempotencyKey(ENTITY, "inv_run1", "toolu_1");
    const build: HarnessBuildContext = {
      ctx: {} as HarnessBuildContext["ctx"], // builder only reads entityId
      entityId: ENTITY,
      runId: "inv_run1",
      wakeSource: "message",
    };
    const toolCtx = builder(build)({
      entityUrl: ENTITY,
      runId: "inv_run1",
      toolUseId: "toolu_1",
      idempotencyKey: raw,
      signal: new AbortController().signal,
    });

    await toolCtx.platform.spawn({ entityType: "worker" });
    await toolCtx.platform.send({ to: "/t/default/a/worker/w1", mode: "message", content: [{ type: "text", text: "hi" }] });

    expect(calls).toHaveLength(2);
    // undici's dispatch-time header-value validation (the layer that rejected
    // the raw key live): any char outside HTAB / SP-~ / 0x80-0xFF is illegal.
    const ILLEGAL_HEADER_VALUE_CHAR = /[^\t\x20-\x7e\x80-\xff]/;
    expect(ILLEGAL_HEADER_VALUE_CHAR.test(raw)).toBe(true); // the raw key would be rejected
    for (const call of calls) {
      const sent = call.headers["idempotency-key"]!;
      expect(sent).toBe(headerSafeIdempotencyKey(raw));
      expect(ILLEGAL_HEADER_VALUE_CHAR.test(sent)).toBe(false);
    }
  });
});
