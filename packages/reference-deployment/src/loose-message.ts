/**
 * Loose-message normalization (0002:T4.1).
 *
 * The gateway's `/api/.../send` forwards the request body to the agent's
 * `message` handler VERBATIM (0001:T1.2 — the gateway never rewrites payloads).
 * The canonical `AgentMessageInput` wants `content: ContentBlock[]`, but the
 * developer-facing surfaces (and the conformance kit's live driver — see
 * `packages/conformance/README.md` "conformance-agent contract") send loose
 * shorthand bodies like `{ text: "hello" }` or `{ command: "sleep 5" }`.
 * Without normalization those wakes DIE at the frozen schema's
 * `finalizeEvent` parse (message payload requires a ContentBlock array).
 *
 * This module is the deployment-side answer (the seam is
 * `AgentObjectConfig.validateMessage` — "validate/NORMALIZE an inbound
 * message", 0001:T6.1): fold any loose plain-message body into a canonical
 * single-text-block message BEFORE the wake commits it.
 *
 * Rules (deliberately boring):
 *  - platform-typed kinds (`child_finished`, `subscription_update`) pass
 *    through untouched;
 *  - a plain message that already carries a `content` array passes through;
 *  - `{ text: string }` → `content: [{ type: "text", text }]`;
 *  - anything else → `content: [{ type: "text", text: JSON.stringify(body) }]`
 *    (minus the envelope fields `kind`/`from`/`source`), so a structured body
 *    like `{ command: "…" }` survives round-trippable — the conformance
 *    long-exec agent `JSON.parse`s it back out of the wake message.
 *
 * `from`/`source` are preserved when they are well-formed strings.
 */

import type { AgentMessageInput } from "@teaspill/coordination";

type PlainMessage = Extract<AgentMessageInput, { kind?: "message" }>;

/** Normalize a loose inbound message body into canonical `AgentMessageInput`. */
export function normalizeLooseMessage(input: AgentMessageInput): AgentMessageInput {
  // Platform-typed deliveries are never loose — pass through untouched.
  if (
    input !== null &&
    typeof input === "object" &&
    "kind" in input &&
    input.kind !== undefined &&
    input.kind !== "message"
  ) {
    return input;
  }

  const raw = (input ?? {}) as Record<string, unknown>;
  if (Array.isArray(raw["content"])) return input; // already canonical

  const from = typeof raw["from"] === "string" ? raw["from"] : undefined;
  const source =
    typeof raw["source"] === "string"
      ? (raw["source"] as NonNullable<PlainMessage["source"]>)
      : undefined;

  let text: string;
  if (typeof raw["text"] === "string") {
    text = raw["text"];
  } else {
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === "kind" || k === "from" || k === "source" || k === "content") continue;
      rest[k] = v;
    }
    text = JSON.stringify(rest);
  }

  const normalized: PlainMessage = {
    kind: "message",
    content: [{ type: "text", text }],
    ...(from !== undefined && { from }),
    ...(source !== undefined && { source }),
  };
  return normalized;
}
