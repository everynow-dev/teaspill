/**
 * CASDK session-line model (0001:T7.1) — the durable-session JSONL vocabulary.
 *
 * The contract is the spike-verified SESSION_FORMAT minimum (see
 * `references/casdk-spike-digest.md` §0 and `work/plans/0001-build-v1/notes/casdk-mapping.md` §3),
 * validated live against `@anthropic-ai/claude-agent-sdk@0.3.211`:
 * a resumable content line needs exactly
 * `{ type: 'user'|'assistant', message: <Anthropic-shaped>, timestamp: <valid ISO> }`;
 * `uuid` + `parentUuid` (chained, `null` first) are strongly recommended.
 * Everything else — including whole meta line types (`queue-operation`,
 * `file-history-snapshot`, `ai-title`, `last-prompt`, `mode`, `attachment`) —
 * is pass-through: we keep lines verbatim in the store (the SDK's
 * SessionStore contract says "treat entries as pass-through blobs") and never
 * synthesize them on cold rebuild.
 */

import type { JsonValue } from "@teaspill/schema";

// ---------------------------------------------------------------------------
// Line + block shapes (structural; Anthropic API message shapes)
// ---------------------------------------------------------------------------

export interface SessionTextBlock {
  type: "text";
  text: string;
}

export interface SessionImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

export interface SessionToolUseBlock {
  type: "tool_use";
  id: string;
  /** MCP-qualified for our tools: `mcp__teaspill__<name>`. */
  name: string;
  input: unknown;
}

export interface SessionToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: Array<SessionTextBlock | SessionImageBlock> | string;
  /** Present only when the call errored (observed on-disk format). */
  is_error?: boolean;
}

export interface SessionThinkingBlock {
  type: "thinking";
  thinking?: string;
  signature?: string;
}

export type SessionContentBlock =
  | SessionTextBlock
  | SessionImageBlock
  | SessionToolUseBlock
  | SessionToolResultBlock
  | SessionThinkingBlock
  | { type: string; [k: string]: unknown };

/**
 * One JSONL transcript line. `type` `'user'`/`'assistant'` are content lines
 * (the only kind cold rebuild synthesizes); any other `type` is a meta line
 * carried verbatim. Matches the SDK's `SessionStoreEntry` structurally.
 */
export interface SessionLine {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  message?: { role: "user" | "assistant"; content: SessionContentBlock[] | string } | undefined;
  [k: string]: unknown;
}

export function isContentLine(
  line: SessionLine,
): line is SessionLine & { message: { role: "user" | "assistant"; content: SessionContentBlock[] | string } } {
  return (line.type === "user" || line.type === "assistant") && line.message !== undefined;
}

export function contentBlocksOf(line: SessionLine): SessionContentBlock[] {
  const c = line.message?.content;
  if (typeof c === "string") return [{ type: "text", text: c }];
  return Array.isArray(c) ? c : [];
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializeSessionLines(lines: readonly SessionLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length > 0 ? "\n" : "");
}

export function parseSessionLines(jsonl: string): SessionLine[] {
  return jsonl
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as SessionLine);
}

// ---------------------------------------------------------------------------
// Chain builder (uuid + parentUuid + monotonic timestamps)
// ---------------------------------------------------------------------------

export interface LineChainOptions {
  /** Injected uuid source (tests use a deterministic counter). */
  newUuid: () => string;
  /** Base epoch ms; line i gets `base + i` (monotonic, all parseable). */
  baseTimeMs: number;
  /** parentUuid of the first line (default null — a fresh transcript). */
  parentUuid?: string | null;
}

/**
 * A line body before chain identity (uuid/parentUuid/timestamp) is applied.
 * Declared explicitly (not `Omit<SessionLine, …>`) because SessionLine's
 * pass-through index signature would swallow the required `type` key under
 * `Omit` (keyof over an index signature collapses to `string`).
 */
export interface UnchainedLine {
  type: string;
  message?: SessionLine["message"];
  [k: string]: unknown;
}

/**
 * Apply uuid/parentUuid chaining and monotonic ISO timestamps to a projected
 * line sequence (SESSION_FORMAT: presence matters, values are regenerable —
 * a correct chain costs nothing and avoids the "unverified history" hedging).
 */
export function chainLines(bodies: readonly UnchainedLine[], opts: LineChainOptions): SessionLine[] {
  let parentUuid: string | null = opts.parentUuid ?? null;
  return bodies.map((body, i) => {
    const uuid = opts.newUuid();
    const line: SessionLine = {
      ...body,
      uuid,
      parentUuid,
      timestamp: new Date(opts.baseTimeMs + i).toISOString(),
    };
    parentUuid = uuid;
    return line;
  });
}

// ---------------------------------------------------------------------------
// Repair (line level) — dangling tool_use / orphan tool_result
// ---------------------------------------------------------------------------

export const INTERRUPTED_TOOL_RESULT_TEXT = "[tool execution interrupted: process restarted]";

export interface SessionRepairResult {
  lines: SessionLine[];
  /** toolUseIds that received a synthesized error tool_result. */
  repairedToolUseIds: string[];
  /** Count of orphan tool_result lines dropped. */
  droppedOrphanResults: number;
}

/**
 * Line-level analogue of electric's `repairDanglingToolCalls`, applied to a
 * WARM-resumed transcript before the SDK sees it (a crash between "model
 * asked for a tool" and "result recorded" — or a dropped mirror batch — is
 * exactly the shape a mid-run crash leaves behind; the Messages API rejects
 * an unresulted `tool_use`). Two passes, non-mutating:
 *  1. drop `tool_result` blocks with no PRECEDING `tool_use` of the same id
 *     (a line left with zero blocks is dropped);
 *  2. synthesize an `is_error` tool_result line immediately after any
 *     `tool_use` that never received a result.
 * Meta lines pass through untouched, in place.
 *
 * Live-validated against 0.3.211: a transcript truncated to a dangling
 * tool_use tail, repaired this way, resumes and continues cleanly (0001:T7.1
 * experiment C).
 */
export function repairSessionLines(
  lines: readonly SessionLine[],
  opts: { newUuid: () => string; now?: () => number },
): SessionRepairResult {
  const now = opts.now ?? Date.now;

  // Pass 0: collect tool_use ids in order, and resulted ids.
  const usedIds: string[] = [];
  const resulted = new Set<string>();
  for (const line of lines) {
    if (!isContentLine(line)) continue;
    for (const b of contentBlocksOf(line)) {
      if (b.type === "tool_use") usedIds.push((b as SessionToolUseBlock).id);
      if (b.type === "tool_result") resulted.add((b as SessionToolResultBlock).tool_use_id);
    }
  }
  const known = new Set(usedIds);

  // Pass 1: drop orphan tool_results (seen-before check is positional).
  const seenUses = new Set<string>();
  let droppedOrphanResults = 0;
  const pass1: SessionLine[] = [];
  for (const line of lines) {
    if (!isContentLine(line)) {
      pass1.push(line);
      continue;
    }
    const blocks = contentBlocksOf(line);
    const kept = blocks.filter((b) => {
      if (b.type === "tool_use") {
        seenUses.add((b as SessionToolUseBlock).id);
        return true;
      }
      if (b.type === "tool_result") {
        const id = (b as SessionToolResultBlock).tool_use_id;
        if (!seenUses.has(id) || !known.has(id)) {
          droppedOrphanResults += 1;
          return false;
        }
      }
      return true;
    });
    if (kept.length === 0 && blocks.length > 0) continue; // line emptied by the drop
    pass1.push(
      kept.length === blocks.length ? line : { ...line, message: { ...line.message!, content: kept } },
    );
  }

  // Pass 2: synthesize error results for dangling tool_uses, immediately
  // after the line carrying the tool_use.
  const dangling = usedIds.filter((id) => !resulted.has(id));
  if (dangling.length === 0) {
    return { lines: pass1, repairedToolUseIds: [], droppedOrphanResults };
  }
  const danglingSet = new Set(dangling);
  const out: SessionLine[] = [];
  let leafUuid: string | null | undefined = null;
  for (const line of pass1) {
    out.push(line);
    if (line.uuid !== undefined) leafUuid = line.uuid;
    if (!isContentLine(line)) continue;
    for (const b of contentBlocksOf(line)) {
      if (b.type !== "tool_use") continue;
      const id = (b as SessionToolUseBlock).id;
      if (!danglingSet.has(id)) continue;
      const uuid = opts.newUuid();
      out.push({
        type: "user",
        uuid,
        parentUuid: leafUuid ?? null,
        timestamp: new Date(now()).toISOString(),
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: id,
              is_error: true,
              content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT_TEXT }],
            },
          ],
        },
      });
      leafUuid = uuid;
    }
  }
  return { lines: out, repairedToolUseIds: dangling, droppedOrphanResults };
}

/** JSON-sanitize an arbitrary value for `opaque.data` (drops undefined, fns). */
export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}
