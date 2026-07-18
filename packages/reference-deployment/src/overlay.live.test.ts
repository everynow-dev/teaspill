/**
 * Overlay smoke (0002:T4.1) — a MINIMAL live check that THIS reference
 * deployment is actually up and serving the conformance agents, before
 * 0002:T4.2 runs the full live suites. Skip-guarded on `TEASPILL_STACK_URL`
 * (conformance's gate); never required by the default suite.
 *
 * Run recipe (README "Getting started"):
 *   pnpm --filter @teaspill/gateway bundle && pnpm --filter @teaspill/reference-deployment bundle
 *   docker compose -f docker-compose.yml -f docker-compose.overlay.yml up -d --build
 *   TEASPILL_STACK_URL=http://localhost:8787 TEASPILL_STACK_API_KEY=tsp_… \
 *     pnpm --filter @teaspill/reference-deployment test
 */

import { describe, expect, it } from "vitest";
import {
  SKIP_MESSAGE,
  SPAWN_RESPOND,
  createLiveDriver,
  readStackConfig,
} from "@teaspill/conformance";

const stack = readStackConfig();

describe.skipIf(stack === null)(
  `reference overlay smoke [${stack?.baseUrl ?? SKIP_MESSAGE}]`,
  () => {
    it("the deployed conformance-echo agent answers a loose { text } send", async () => {
      const driver = createLiveDriver(stack!);
      const spawned = await driver.actions.spawn({ type: stack!.agentTypes.echo });
      await driver.actions.send(spawned.url, { text: "overlay-smoke" });
      const events = await driver.observeUntil(spawned.streamUrl, (evs) =>
        evs.some((e) => e.type === "run_finished"),
      );
      const result = SPAWN_RESPOND.check(events, { replyIncludes: "overlay-smoke" });
      expect(result.violations).toEqual([]);
      expect(result.ok).toBe(true);
    });
  },
);
