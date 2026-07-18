/**
 * Entity addressing — canonical implementation now lives in
 * `@teaspill/schema` (`packages/schema/src/addressing.ts`, 0002:T1.1). This
 * file re-exports the subset the gateway uses; it is kept only because
 * `addressing.test.ts` and a couple of gateway modules import "./addressing.js"
 * directly (0001:T1.2 file location). Do not reintroduce a local
 * implementation here — add to @teaspill/schema instead.
 */

export {
  AddressingError,
  assertInstanceId,
  entityUrl,
  gatewayStreamUrl,
  newInstanceId,
  parseEntityUrl,
  restateAgentKey,
  timelineStreamPath,
  TYPE_RE,
  type EntityRef,
  type RestateTarget,
} from "@teaspill/schema";
