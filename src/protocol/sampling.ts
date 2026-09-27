// shape: none — dispatch object does not apply: straight-line filter over a key
//   list; the log-once Set is membership state, not a discriminator.
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { debugLog } from "../debug.js";

const droppedKeysThisSession = new Set<string>();

/**
 * F2 sampling-parameter guard. pi-ai merges `model.samplingParams` under
 * `options.samplingParams` and applies the result LAST, so anything configured
 * at either level reaches the wire — and Qoder's validator hard-errors on the
 * rejected keys. Drop them from both maps here, before dispatch, on both
 * transports. Absent/empty maps stay byte-identical to unfiltered requests.
 */
export function filterSamplingParams(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
  rejectedKeys: readonly string[],
): void {
  const maps = [model.samplingParams as Record<string, unknown> | undefined, options?.samplingParams];
  for (const params of maps) {
    if (!params) continue;
    for (const key of rejectedKeys) {
      if (!(key in params)) continue;
      delete params[key];
      if (!droppedKeysThisSession.has(key)) {
        droppedKeysThisSession.add(key);
        debugLog(
          `provider.filter_drop key=${key} (rejected by Qoder; dropped from samplingParams for the rest of this session)`,
        );
      }
    }
  }
}

/** Test-only resetter, alongside the fork's existing resetter pattern. */
export function clearQoderFilterMemCache(): void {
  droppedKeysThisSession.clear();
}
