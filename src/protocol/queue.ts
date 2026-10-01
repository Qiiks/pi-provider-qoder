// shape: none — one boundary seam: `unknown` gateway payloads unwrapped level
// by level (Qoder double-encodes its envelopes) into a typed queue state.
//
// A request for a busy Qoder model comes back as a queue-admission payload
// nested inside two envelopes, e.g. the legacy stream's
//   Upstream status 403: {"code":"403","message":"{\"code\":\"10605\",
//   \"message\":\"{\\\"isQueued\\\":true,\\\"modelKey\\\":\\\"qfmodel\\\", ...
//   \\\"retryAfterSeconds\\\":30,\\\"serviceAvailable\\\":false}\"}"}
// The outer 403 is the gateway's carrier for that state, not an auth failure.
// Hosts classify error text by pattern (OMP: `503 | 429 | overloaded |
// service unavailable | retry your request | …` → transient, retried with the
// parsed wait; a bare `403` → auth failure, not retried), so forwarding the
// raw envelope mislabels a temporary queue as a broken credential and skips
// the wait the provider asked for. This module extracts the queue state and
// renders one message that reads correctly to a human and to those
// classifiers: transient, with a parseable "try again in Ns" wait hint.

/** Levels of `message`-in-`message` JSON nesting to follow (observed depth: 3). */
const MAX_ENVELOPE_DEPTH = 4;

export interface QoderQueueState {
  /** Upstream model key the queue applies to (e.g. `qfmodel` = Qwen3.8-Flash). */
  modelKey?: string;
  /** Provider queue class (e.g. `p3`). */
  queueType?: string;
  /** Requests ahead of this one in the queue. */
  queueCount?: number;
  /** Seconds the provider asks the client to wait before re-issuing. */
  waitSeconds?: number;
  /** Qoder business code carried alongside the queue state (10605). */
  code?: string;
}

/** Raw field read at the JSON boundary: anything that is not a plain object
 * reads as absent, and the caller narrows the value it needs. Field-level
 * `typeof` checks keep the data contract visible at each use instead of
 * behind a container-wide guard. */
function readValue(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null || Array.isArray(source)) return undefined;
  return Object.getOwnPropertyDescriptor(source, key)?.value;
}

function readNumber(source: unknown, key: string): number | undefined {
  const value = readValue(source, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(source: unknown, key: string): string | undefined {
  const value = readValue(source, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Boolean field, tolerating Qoder's stringified `"true"`/`"false"`. */
function readFlag(source: unknown, key: string): boolean | undefined {
  const value = readValue(source, key);
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

function findQueueState(value: unknown, depth: number, inheritedCode?: string): QoderQueueState | undefined {
  if (depth > MAX_ENVELOPE_DEPTH) return undefined;
  const code = readString(value, "code") ?? inheritedCode;
  const wait = readNumber(value, "retryAfterSeconds") ?? readNumber(value, "waitTime");
  // The discriminator is the queue flag itself; the fallback arm covers a
  // payload that dropped the flag but still reports the service as down and
  // hands out a wait. Both describe the same transient admission state.
  if (readFlag(value, "isQueued") === true || (wait !== undefined && readFlag(value, "serviceAvailable") === false)) {
    return {
      modelKey: readString(value, "modelKey"),
      queueType: readString(value, "queueType"),
      queueCount: readNumber(value, "queueCount"),
      waitSeconds: wait,
      code,
    };
  }
  // Follow one nesting level: envelope bodies wrap the next JSON document in
  // their `message` string.
  const nested = readString(value, "message");
  if (!nested) return undefined;
  try {
    return findQueueState(JSON.parse(nested), depth + 1, code);
  } catch {
    return undefined;
  }
}

/**
 * Extract a Qoder queue state from an error body, if it carries one.
 * Returns undefined for any body that is not JSON or not a queue payload,
 * so callers keep their original error text for everything else.
 */
export function parseQoderQueueState(body: string): QoderQueueState | undefined {
  try {
    return findQueueState(JSON.parse(body), 0);
  } catch {
    return undefined;
  }
}

/**
 * Render the queue state as one line that:
 *   - reads correctly to a person ("service unavailable" because that is
 *     literally what the payload's own `serviceAvailable:false` says),
 *   - classifies as transient on host pattern tables, and
 *   - carries the provider's wait as `try again in Ns`, a form hosts parse
 *     into a real delay before re-issuing the request.
 * It deliberately drops the raw envelope: the outer body embeds a bare `403`
 * token, which host classifiers read as an auth failure and refuse to retry.
 */
export function describeQoderQueueError(state: QoderQueueState): string {
  const subject = state.modelKey ? `model ${state.modelKey}` : "the model";
  const details: string[] = [];
  if (state.queueType) details.push(`queue ${state.queueType}`);
  if (state.queueCount !== undefined) details.push(`${state.queueCount} ahead`);
  const detail = details.length > 0 ? ` (${details.join(", ")})` : "";
  const code = state.code ? ` (code ${state.code})` : "";
  const wait = state.waitSeconds !== undefined ? `try again in ${state.waitSeconds}s.` : "try again in a moment.";
  return `Qoder service unavailable${code}: ${subject} is queued${detail}; ${wait}`;
}
