#!/usr/bin/env node
/**
 * EXAMPLE / reference entrypoint for a CASDK-harness agent-loop container
 * (T7.3 packaging — see ../PACKAGING.md). This is intentionally NOT a
 * generic production server: a real deployment defines its own agent(s)
 * (state schema, spawn schema, tools) via `@teaspill/agents-sdk`'s
 * `defineAgent(...)` + `serve(...)` in the DEVELOPER'S app code — that shape
 * is app-specific and cannot live in this harness package (see
 * PACKAGING.md "Wiring your own app" for the call shape, and the note there
 * about `claudeAgentSdk(...)` in `@teaspill/agents-sdk` still being an
 * unwired T6.1 stub as of this writing).
 *
 * What IS this package's job, and what this script demonstrates end-to-end
 * so the image is runnable and its HEALTHCHECK has something real to probe:
 *
 *  1. the persistent session volume (TEASPILL_CASDK_SESSION_DIR) is present
 *     and writable — the SessionStore / JSONL-mirror discipline
 *     session-store.ts's `createFileSessionStore` depends on;
 *  2. the bundled CASDK CLI subprocess resolves (shared logic with
 *     docker/healthcheck.mjs);
 *  3. optionally (TEASPILL_CASDK_DEMO_PROMPT set), drives ONE real
 *     `createCasdkHarness(...).run(...)` call end to end — proving the
 *     env/model/API-key plumbing actually reaches the Anthropic API, not
 *     just that the binary exists on disk.
 *
 * Kept free of Restate/gateway wiring on purpose (packaging, not logic).
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createCasdkHarness,
  createClaudeAgentSdkClient,
  createFileSessionStore,
} from "@teaspill/harness-casdk";
import { resolveClaudeCliPath } from "./cli-path.mjs";

const sessionDir = process.env["TEASPILL_CASDK_SESSION_DIR"] ?? "/data/casdk-sessions";
const model = process.env["TEASPILL_CASDK_MODEL"] ?? "claude-sonnet-4-5";
const entityId = process.env["TEASPILL_CASDK_ENTITY_ID"] ?? "/t/default/a/boot-probe/demo";
const demoPrompt = process.env["TEASPILL_CASDK_DEMO_PROMPT"];

async function checkVolume() {
  await mkdir(sessionDir, { recursive: true });
  const probe = join(sessionDir, ".write-probe");
  await writeFile(probe, String(Date.now()));
  await rm(probe, { force: true });
  console.log(`[entrypoint] session volume OK (writable): ${sessionDir}`);
}

function checkCli() {
  const bin = resolveClaudeCliPath();
  console.log(`[entrypoint] casdk cli resolved: ${bin}`);
}

async function runDemoWake() {
  const store = createFileSessionStore(sessionDir);
  const sdk = createClaudeAgentSdkClient();
  const harness = createCasdkHarness({ store, sdk, model });
  console.log(`[entrypoint] running one demo wake against ${entityId} (model=${model})...`);
  const result = await harness.run({
    entityId,
    runId: `boot-probe-${Date.now()}`,
    canonicalContext: [],
    wakeMessage: { source: "message", content: [{ type: "text", text: demoPrompt }] },
    tools: [],
    steerSource: { drain: async () => [] },
    signal: new AbortController().signal,
    emitDelta: () => {},
  });
  console.log(
    `[entrypoint] demo wake produced ${result.events.length} canonical event(s); usage:`,
    result.usage,
  );
}

async function main() {
  console.log("[entrypoint] teaspill CASDK harness runtime image — example/reference entrypoint (T7.3)");
  console.log(
    `[entrypoint] env: TEASPILL_CASDK_SESSION_DIR=${sessionDir} TEASPILL_CASDK_MODEL=${model}`,
  );
  console.log(
    "[entrypoint] ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN must be set for a real (non-boot-probe) run — see PACKAGING.md.",
  );
  await checkVolume();
  checkCli();
  if (demoPrompt) {
    await runDemoWake();
  } else {
    console.log(
      "[entrypoint] TEASPILL_CASDK_DEMO_PROMPT not set — skipping the live LLM call (boot checks only).",
    );
  }
  console.log(
    "[entrypoint] boot checks complete. Replace this file with your own defineAgent(...) + serve() app — see PACKAGING.md.",
  );
  // Reference-image behavior: stay up so `docker run -d` / compose treat
  // this as a long-running service the HEALTHCHECK can probe, exactly like
  // a real agent-loop server would (a real app's serve(...) call already
  // blocks this way — it listens on PORT). NOTE: an unresolved bare
  // `new Promise(() => {})` does NOT keep Node's event loop alive (no
  // pending I/O/timer registered) — the process would exit 0 right here.
  // An interval does.
  const keepAlive = setInterval(() => {}, 1 << 30);
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      console.log(`[entrypoint] ${sig} received, shutting down.`);
      clearInterval(keepAlive);
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error("[entrypoint] fatal:", err);
  process.exit(1);
});
