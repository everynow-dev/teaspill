import { describe, expect, it } from "vitest";
import type { AgentMessageInput } from "@teaspill/coordination";
import { normalizeLooseMessage } from "./loose-message.js";

const loose = (body: Record<string, unknown>): AgentMessageInput =>
  body as unknown as AgentMessageInput;

describe("normalizeLooseMessage", () => {
  it("passes canonical content-block messages through unchanged", () => {
    const input: AgentMessageInput = {
      kind: "message",
      content: [{ type: "text", text: "hi" }],
      from: "/t/default/a/x/y",
    };
    expect(normalizeLooseMessage(input)).toBe(input);
  });

  it("passes platform-typed kinds through untouched", () => {
    const cf: AgentMessageInput = { kind: "child_finished", childId: "c", outcome: "success" };
    expect(normalizeLooseMessage(cf)).toBe(cf);
    const su: AgentMessageInput = {
      kind: "subscription_update",
      entityId: "/t/default/a/x/y",
      headSeq: 3,
      status: "active",
    };
    expect(normalizeLooseMessage(su)).toBe(su);
  });

  it("folds { text } into a single text block (the conformance echo shape)", () => {
    expect(normalizeLooseMessage(loose({ text: "hello teaspill" }))).toEqual({
      kind: "message",
      content: [{ type: "text", text: "hello teaspill" }],
    });
  });

  it("folds structured bodies into round-trippable JSON text (the long-exec shape)", () => {
    const out = normalizeLooseMessage(loose({ command: "sleep 5 && echo done" }));
    expect(out).toMatchObject({ kind: "message" });
    const text = (out as { content: Array<{ type: string; text: string }> }).content[0]!.text;
    expect(JSON.parse(text)).toEqual({ command: "sleep 5 && echo done" });
  });

  it("preserves well-formed from/source; strips them from the JSON fold", () => {
    const out = normalizeLooseMessage(
      loose({ command: "x", from: "/t/default/a/p/1", source: "cron" }),
    );
    expect(out).toMatchObject({ from: "/t/default/a/p/1", source: "cron" });
    const text = (out as { content: Array<{ text: string }> }).content[0]!.text;
    expect(JSON.parse(text)).toEqual({ command: "x" });
  });

  it("an empty body still becomes a valid message", () => {
    const out = normalizeLooseMessage(loose({}));
    expect(out).toEqual({ kind: "message", content: [{ type: "text", text: "{}" }] });
  });
});
