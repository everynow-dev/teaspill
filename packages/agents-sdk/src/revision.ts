/**
 * Type revisioning + the additive-only state-schema rule (T6.1).
 *
 * ## The v1 rule (PLAN T6.1 Anticipate — the classic live-entity trap)
 *
 * State schemas are **ADDITIVE-ONLY within a revision**: a live agent instance
 * persists state shaped by the revision it was spawned under, and a running
 * deployment may only widen that shape in backward-compatible ways —
 * **add optional fields**. A BREAKING change (removing a field, changing a
 * field's type, or adding a REQUIRED field — none of which existing persisted
 * state satisfies) requires a **new revision**: the bump means new instances
 * only; old instances keep the old revision until they archive (D7). The SDK
 * enforces this at `defineAgent` time so the mistake is a loud build-time
 * error, never silent state corruption at runtime.
 *
 * The diff is computed over each schema's JSON Schema (zod's own converter, the
 * same one the harness uses for tool schemas) so it is structural and does not
 * depend on zod internals.
 */

import { z, type ZodType } from "zod";
import type { JsonValue } from "@teaspill/schema";

interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonValue>;
  required?: string[];
}

function toJsonSchema(schema: ZodType): JsonSchemaObject {
  return z.toJSONSchema(schema as never, { target: "draft-2020-12" }) as JsonSchemaObject;
}

const stableStringify = (v: JsonValue | undefined): string => JSON.stringify(v ?? null);

export interface StateSchemaDiff {
  /** True iff every change is backward-compatible (only optional fields added). */
  additive: boolean;
  /** Field names present in `next` but not `prev`. */
  added: string[];
  /** Field names present in `prev` but not `next` (breaking). */
  removed: string[];
  /** Field names in both whose JSON Schema differs (breaking type change). */
  changed: string[];
  /** Added fields that are REQUIRED, or fields that went optional→required (breaking). */
  tightenedRequired: string[];
}

/**
 * Structurally diff two state schemas for the additive-only rule. Both are
 * expected to be object schemas (the normal shape of agent state); a
 * non-object change that alters the JSON Schema is treated as breaking.
 */
export function diffStateSchema(prev: ZodType, next: ZodType): StateSchemaDiff {
  const p = toJsonSchema(prev);
  const n = toJsonSchema(next);

  // Non-object (or type-changed) schemas: additive only if byte-identical.
  if (p.type !== "object" || n.type !== "object") {
    const same = stableStringify(p as unknown as JsonValue) === stableStringify(n as unknown as JsonValue);
    return {
      additive: same,
      added: [],
      removed: [],
      changed: same ? [] : ["<root>"],
      tightenedRequired: [],
    };
  }

  const pProps = p.properties ?? {};
  const nProps = n.properties ?? {};
  const pReq = new Set(p.required ?? []);
  const nReq = new Set(n.required ?? []);

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const tightenedRequired: string[] = [];

  for (const key of Object.keys(pProps)) {
    if (!(key in nProps)) {
      removed.push(key);
      continue;
    }
    if (stableStringify(pProps[key]) !== stableStringify(nProps[key])) changed.push(key);
    if (!pReq.has(key) && nReq.has(key)) tightenedRequired.push(key); // optional → required
  }
  for (const key of Object.keys(nProps)) {
    if (key in pProps) continue;
    added.push(key);
    if (nReq.has(key)) tightenedRequired.push(key); // new required field
  }

  const additive =
    removed.length === 0 && changed.length === 0 && tightenedRequired.length === 0;
  return { additive, added, removed, changed, tightenedRequired };
}

export class StateRevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateRevisionError";
  }
}

export interface StateRevisionBaseline {
  /** The currently-deployed revision number for this agent type. */
  revision: number;
  /** The state schema deployed at that revision. */
  state: ZodType;
}

export interface AssertStateRevisionInput {
  type: string;
  /** The revision the developer is declaring for the NEW schema. */
  revision: number;
  /** The NEW state schema. */
  state: ZodType;
  /** The previously-deployed revision + schema, when known. Absent ⇒ first deploy. */
  baseline?: StateRevisionBaseline;
}

/**
 * Enforce the additive-only rule against a known baseline. Throws
 * `StateRevisionError` when a breaking change is declared without bumping the
 * revision (or when the revision moves backwards). Returns the diff for logging.
 */
export function assertStateRevision(input: AssertStateRevisionInput): StateSchemaDiff | null {
  const { type, revision, state, baseline } = input;
  if (!Number.isInteger(revision) || revision < 0) {
    throw new StateRevisionError(
      `agent ${JSON.stringify(type)}: revision must be a non-negative integer (got ${revision})`,
    );
  }
  if (!baseline) return null; // first deployment — nothing to compare
  if (revision < baseline.revision) {
    throw new StateRevisionError(
      `agent ${JSON.stringify(type)}: revision cannot go backwards ` +
        `(declared ${revision} < deployed ${baseline.revision})`,
    );
  }
  const diff = diffStateSchema(baseline.state, state);
  if (!diff.additive && revision === baseline.revision) {
    const reasons = [
      diff.removed.length > 0 && `removed field(s): ${diff.removed.join(", ")}`,
      diff.changed.length > 0 && `changed field type(s): ${diff.changed.join(", ")}`,
      diff.tightenedRequired.length > 0 &&
        `newly-required field(s): ${diff.tightenedRequired.join(", ")}`,
    ].filter(Boolean);
    throw new StateRevisionError(
      `agent ${JSON.stringify(type)}: BREAKING state-schema change at unchanged revision ${revision} ` +
        `(${reasons.join("; ")}). State schemas are additive-only within a revision — ` +
        `bump the revision to > ${baseline.revision} so the change applies to NEW instances only ` +
        `(old instances keep revision ${baseline.revision} until they archive, D7).`,
    );
  }
  return diff;
}
