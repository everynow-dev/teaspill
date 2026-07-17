/**
 * Thin React bindings (T5.2). React is an OPTIONAL peer dependency: this
 * module is a separate export (`@teaspill/frontend-sdk/react`) so the
 * framework-agnostic core never loads it. The hooks are deliberately just
 * lifecycle glue around the core stores — all materialization logic lives in
 * reducer.ts / timeline.ts / catalog.ts.
 */

import { useEffect, useRef, useState } from "react";
import { initialTimelineState } from "./reducer.js";
import {
  createAgentTimeline,
  type AgentTimelineOptions,
  type AgentTimelineState,
} from "./timeline.js";
import { createAgentCatalog, type AgentCatalogOptions, type AgentCatalogState } from "./catalog.js";

function freshTimelineState(opts: AgentTimelineOptions): AgentTimelineState {
  return {
    timeline: initialTimelineState(
      opts.fromSnapshot !== undefined ? { fromSnapshot: { seq: opts.fromSnapshot.seq } } : {},
    ),
    upToDate: false,
    streamOffset: null,
    streamClosed: false,
    parseErrors: 0,
    lastError: null,
  };
}

/**
 * Subscribe to an entity timeline. Pass `null`/`undefined` to render without
 * a subscription (e.g. while the stream URL is still loading).
 *
 * Identity: the subscription restarts when `streamUrl` or the structural
 * options (`fromSnapshot`, `deltas`, `live`) change; callbacks and auth are
 * read from the latest render without restarting.
 */
export function useAgentTimeline(
  streamUrl: string | URL | null | undefined,
  options: AgentTimelineOptions = {},
): AgentTimelineState {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const key = JSON.stringify([
    streamUrl === null || streamUrl === undefined ? null : String(streamUrl),
    options.fromSnapshot?.seq ?? null,
    options.fromSnapshot?.offset ?? null,
    options.deltas === undefined || options.deltas === false
      ? false
      : options.deltas === true
        ? true
        : String(options.deltas.url),
    options.live ?? true,
  ]);

  const [state, setState] = useState<AgentTimelineState>(() => freshTimelineState(options));

  useEffect(() => {
    if (streamUrl === null || streamUrl === undefined) {
      setState(freshTimelineState(optionsRef.current));
      return;
    }
    const timeline = createAgentTimeline(streamUrl, optionsRef.current);
    setState(timeline.getState());
    const unsubscribe = timeline.subscribe(setState);
    return () => {
      unsubscribe();
      timeline.close();
    };
  }, [key]);

  return state;
}

/**
 * Subscribe to catalog rows (entities by type/parent/status/tenant) over
 * Electric shapes through the gateway. Pass `null` to skip subscribing.
 */
export function useAgentCatalog(
  options: AgentCatalogOptions | null | undefined,
): AgentCatalogState {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const key =
    options === null || options === undefined
      ? null
      : JSON.stringify([
          String(options.baseUrl),
          options.table ?? "entities",
          options.filter ?? null,
          options.where ?? null,
        ]);

  const [state, setState] = useState<AgentCatalogState>({
    rows: [],
    isUpToDate: false,
    lastError: null,
  });

  useEffect(() => {
    const current = optionsRef.current;
    if (current === null || current === undefined) {
      setState({ rows: [], isUpToDate: false, lastError: null });
      return;
    }
    const catalog = createAgentCatalog(current);
    setState(catalog.getState());
    const unsubscribe = catalog.subscribe(setState);
    return () => {
      unsubscribe();
      catalog.close();
    };
  }, [key]);

  return state;
}
