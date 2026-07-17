/**
 * Terminal rendering for `teaspill logs <url>` (T6.2).
 *
 * Reuses the frontend-sdk timeline reducer (T5.2): the CLI folds the stream
 * through `createAgentTimeline` and this module turns the materialized
 * `TimelineState` into readable, seq-ordered log lines. Each underlying
 * canonical event becomes one line, keyed by the seq at which it landed —
 * `tool_call`/`tool_result` and `run_started`/`run_finished` therefore render
 * as two lines (call then result, start then finish) at their own seqs.
 *
 * Pure and framework-free so it is unit-tested against a canned event stream
 * folded through the reducer — no live stack needed.
 */

import type { ContentBlock, JsonValue } from "@teaspill/schema";
import type { TimelineState } from "@teaspill/frontend-sdk";

export interface RenderedLine {
  /** The canonical seq this line was produced at (dedup/watermark key). */
  seq: number;
  text: string;
}

const MAX_INLINE = 200;

/** Flatten text+image content blocks into a compact one-line string. */
export function renderContent(blocks: readonly ContentBlock[]): string {
  const parts = blocks.map((b) => (b.type === "text" ? b.text : `[image ${b.mimeType}]`));
  return truncate(parts.join(" ").replace(/\s+/g, " ").trim());
}

function renderJson(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return truncate(value);
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function truncate(s: string, max = MAX_INLINE): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Short `HH:MM:SS` prefix from an ISO timestamp (best-effort). */
function clock(ts: string): string {
  const t = ts.slice(11, 19);
  return t.length === 8 ? t : ts;
}

function line(seq: number, ts: string, body: string): RenderedLine {
  return { seq, text: `${clock(ts)}  #${seq}  ${body}` };
}

/**
 * Collect every renderable line from a reducer snapshot, sorted by seq.
 * The `logs` command keeps a watermark and prints lines with `seq` beyond it,
 * so a growing state yields exactly the newly-arrived events each time.
 */
export function collectRenderable(state: TimelineState): RenderedLine[] {
  const lines: RenderedLine[] = [];

  if (state.spawned !== null && state.join.mode === "replay") {
    // entity_spawned is always seq 0; a fast-join skips it (join.mode snapshot).
    const s = state.spawned;
    const parent = s.parentId !== null ? ` parent=${short(s.parentId)}` : "";
    lines.push(line(0, state.lastEventTs ?? "", `● spawned ${s.entityType}${parent}`));
  }

  for (const r of state.runs) {
    if (r.startedSeq !== undefined) {
      const bits = [r.harness, r.model].filter(Boolean).join(" ");
      const wake = r.wake?.source !== undefined ? ` wake=${r.wake.source}` : "";
      lines.push(
        line(
          r.startedSeq,
          r.ts ?? "",
          `▶ run ${short(r.runId)} started${bits ? ` (${bits})` : ""}${wake}`,
        ),
      );
    }
    if (r.finishedSeq !== undefined) {
      const usage = r.usage ? ` tokens=${usageTotal(r.usage)}` : "";
      const dur = r.durationMs !== undefined ? ` ${r.durationMs}ms` : "";
      lines.push(
        line(r.finishedSeq, "", `■ run ${short(r.runId)} ${r.outcome ?? "finished"}${usage}${dur}`),
      );
    }
  }

  for (const m of state.messages) {
    const from = m.from !== undefined ? ` (${m.from})` : "";
    lines.push(line(m.seq, m.ts, `${m.role}${from}: ${renderContent(m.content)}`));
  }

  for (const rs of state.reasoning) {
    lines.push(
      line(rs.seq, rs.ts, `🤔 reasoning: ${truncate(rs.text.replace(/\s+/g, " ").trim())}`),
    );
  }

  for (const t of state.toolCalls) {
    if (t.callSeq !== undefined) {
      lines.push(
        line(t.callSeq, t.callTs ?? "", `⚙ tool ${t.name ?? "?"}(${renderJson(t.input)})`),
      );
    }
    if (t.resultSeq !== undefined && t.result !== undefined) {
      const flag = t.result.isError ? "✖ error" : "→ ok";
      const body =
        t.result.content.length > 0 ? renderContent(t.result.content) : renderJson(t.result.detail);
      lines.push(line(t.resultSeq, t.resultTs ?? "", `${flag} ${t.name ?? "tool"}: ${body}`));
    }
  }

  for (const c of state.children) {
    if (c.spawnedSeq !== undefined) {
      lines.push(
        line(c.spawnedSeq, "", `↳ spawned child ${c.childType ?? "?"}/${short(c.childId)}`),
      );
    }
    if (c.finishedSeq !== undefined) {
      const result = c.result !== undefined ? `: ${renderJson(c.result)}` : "";
      lines.push(
        line(c.finishedSeq, "", `↳ child ${short(c.childId)} ${c.outcome ?? "finished"}${result}`),
      );
    }
  }

  for (const c of state.controls) {
    const reason = c.reason !== undefined ? ` — ${c.reason}` : "";
    lines.push(line(c.seq, c.ts, `⏻ control: ${c.verb}${reason}`));
  }

  for (const e of state.errors) {
    const code = e.code !== undefined ? `/${e.code}` : "";
    lines.push(line(e.seq, e.ts, `✖ error [${e.source}${code}]: ${e.message}`));
  }

  for (const s of state.summarizations) {
    lines.push(
      line(s.seq, s.ts, `… summarized through #${s.replacesThroughSeq}: ${truncate(s.summary)}`),
    );
  }

  for (const s of state.snapshots) {
    const hole = s.historyHole === true ? " (history hole)" : "";
    lines.push(line(s.seq, s.ts, `◆ snapshot ${s.reason}${hole}`));
  }

  for (const o of state.opaques) {
    lines.push(line(o.seq, o.ts, `▢ opaque ${o.origin}/${o.kind}`));
  }

  if (state.archived !== null) {
    const a = state.archived;
    lines.push(line(a.seq, a.ts, `⏹ archived (${a.reason})`));
  }

  lines.sort((a, b) => a.seq - b.seq);
  return lines;
}

/** Lines with `seq > afterSeq`, in order — the newly-arrived events. */
export function renderNewLines(state: TimelineState, afterSeq: number): RenderedLine[] {
  return collectRenderable(state).filter((l) => l.seq > afterSeq);
}

function short(id: string): string {
  // Show the last url segment (the instance id) or a truncated raw id.
  const seg = id.split("/").filter(Boolean).pop() ?? id;
  return seg.length > 12 ? seg.slice(0, 12) : seg;
}

function usageTotal(usage: { inputTokens?: number; outputTokens?: number }): number {
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}
