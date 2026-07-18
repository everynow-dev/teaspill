/**
 * `teaspill logs <url>` (0001:T6.2): follow an entity's timeline stream and render
 * events readably. Reuses the frontend-sdk `createAgentTimeline` (0001:T5.2) for the
 * resumable read + reducer, and `render.ts` (which folds the reducer's
 * collections) for the terminal output. Nothing about stream reading, dedup,
 * or drift is reimplemented here.
 */

import type { AgentTimelineState, AgentTimelineOptions } from "@teaspill/frontend-sdk";
import type { CliDeps } from "../deps.js";
import type { ResolvedConfig } from "../config.js";
import { resolveTimelineTarget } from "../targets.js";
import { renderNewLines } from "../render.js";

export interface LogsFlags {
  deltas?: boolean;
  fromSnapshot?: number;
}

/**
 * Follow + render the timeline until the stream closes or `signal` aborts.
 * Resolves when done; each newly-applied event is printed in seq order.
 */
export async function followLogs(
  deps: CliDeps,
  config: ResolvedConfig,
  target: string,
  flags: LogsFlags = {},
  signal?: AbortSignal,
): Promise<void> {
  const resolved = resolveTimelineTarget(target, config.gatewayUrl, config.tenant);
  deps.io.err(`following ${resolved.entityUrl}`);

  const auth = config.apiKey !== undefined ? { apiKey: config.apiKey } : undefined;
  const timelineOpts: AgentTimelineOptions = {
    ...(auth !== undefined ? { auth } : {}),
    ...(flags.deltas === true ? { deltas: true } : {}),
    ...(flags.fromSnapshot !== undefined ? { fromSnapshot: { seq: flags.fromSnapshot } } : {}),
    onDrift: (drift) => {
      deps.io.err(
        `⚠ drift (${drift.kind}): expected seq ${drift.expectedSeq}, got ${drift.gotSeq}`,
      );
    },
    onRecordError: (error) => {
      deps.io.err(`⚠ skipped unparseable record: ${String(error)}`);
    },
  };

  const timeline = deps.createAgentTimeline(resolved.streamUrl, timelineOpts);

  let watermark = -1;
  const flush = (state: AgentTimelineState): void => {
    for (const l of renderNewLines(state.timeline, watermark)) {
      deps.io.out(l.text);
      watermark = Math.max(watermark, l.seq);
    }
  };

  return await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      unsubscribe();
      timeline.close();
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = (): void => finish();

    const unsubscribe = timeline.subscribe((state) => {
      flush(state);
      if (state.streamClosed) {
        deps.io.err("stream closed");
        finish();
      }
    });

    // Render anything already present before the first notification.
    flush(timeline.getState());

    if (signal !== undefined) {
      if (signal.aborted) finish();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
