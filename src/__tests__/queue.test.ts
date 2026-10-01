// shape: none — unit tests for the queue-admission boundary seam. The nesting
// built here reproduces the exact triple-encoded body Qoder sent for a busy
// Qwen3.8-Flash (2026-10-01): {"code":"403","message":"{\"code\":\"10605\",
// \"message\":\"{\\\"isQueued\\\":true,...retryAfterSeconds:30...}\"}")"}.
// The host-facing assertions pin the contract stream.ts relies on: the
// rendered line must classify as transient (not auth) on host pattern tables
// and carry the provider's wait in a form hosts parse into a real delay.
import { describe, expect, it } from "vitest";
import { describeQoderQueueError, parseQoderQueueState, type QoderQueueState } from "../protocol/queue.js";

/** The live queue state for `qfmodel` (Qwen3.8-Flash), as decoded from the wire. */
const LIVE_QUEUE_STATE = {
  isQueued: true,
  modelKey: "qfmodel",
  queueCount: 0,
  queueType: "p3",
  retryAfterSeconds: 30,
  serviceAvailable: false,
  waitTime: 30,
};

/** Build the triple-encoded envelope body exactly as the gateway sends it. */
function envelopeBody(queueState: unknown): string {
  return JSON.stringify({
    code: "403",
    message: JSON.stringify({ code: "10605", message: JSON.stringify(queueState) }),
  });
}

describe("parseQoderQueueState", () => {
  it("unwraps the live triple-encoded envelope into the queue state", () => {
    expect(parseQoderQueueState(envelopeBody(LIVE_QUEUE_STATE))).toEqual({
      modelKey: "qfmodel",
      queueType: "p3",
      queueCount: 0,
      waitSeconds: 30,
      code: "10605",
    });
  });

  it("accepts a single-level queue object and tolerates stringified flags", () => {
    expect(
      parseQoderQueueState(JSON.stringify({ isQueued: "true", modelKey: "qmodel_38max", waitTime: 15.5 })),
    ).toEqual({
      modelKey: "qmodel_38max",
      waitSeconds: 15.5,
      code: undefined,
      queueCount: undefined,
      queueType: undefined,
    });
  });

  it("returns undefined for non-queue bodies so callers keep their error text", () => {
    expect(parseQoderQueueState("Internal failure")).toBeUndefined();
    expect(parseQoderQueueState(JSON.stringify({ code: "401", message: "bad token" }))).toBeUndefined();
    // A wait without the queue flag and with the service up is not a queue:
    // mislabeling it would steal the payload's own classification.
    expect(parseQoderQueueState(JSON.stringify({ retryAfterSeconds: 30, serviceAvailable: true }))).toBeUndefined();
  });
});

describe("describeQoderQueueError", () => {
  it("renders the observed state as one transient, retryable line", () => {
    const state: QoderQueueState = {
      modelKey: "qfmodel",
      queueType: "p3",
      queueCount: 0,
      waitSeconds: 30,
      code: "10605",
    };
    expect(describeQoderQueueError(state)).toBe(
      "Qoder service unavailable (code 10605): model qfmodel is queued (queue p3, 0 ahead); try again in 30s.",
    );
  });

  it("degrades gracefully when the payload omits the wait or the model key", () => {
    expect(describeQoderQueueError({})).toBe("Qoder service unavailable: the model is queued; try again in a moment.");
  });

  it("stays in the host transient lane and out of the auth lane", () => {
    const message = describeQoderQueueError({
      modelKey: "qfmodel",
      queueType: "p3",
      queueCount: 0,
      waitSeconds: 30,
      code: "10605",
    });
    // `service unavailable` is the transient token host pattern tables match.
    expect(message).toMatch(/service ?unavailable/i);
    // The wait hint is what hosts parse into a real retry delay.
    expect(message).toMatch(/try again in ([\d.]+)(ms|s)/i);
    // No bare status token: a `403` here would route the retry into the auth
    // (non-retryable) lane, which is exactly the bug this module fixes.
    expect(message).not.toMatch(/\b(?:401|403|unauthorized|forbidden|authentication)\b/i);
  });
});
