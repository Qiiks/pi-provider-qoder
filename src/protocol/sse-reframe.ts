// shape: wrapper function — trigger #12 (a function returning the wrapped
//   value, adding stream-repair behavior to an inner fetch). The internals are
//   a buffered text transform; below the ≥3 dispatch threshold.
//
// The v2 gateway (api2-v2.qoder.sh) intermittently emits malformed SSE framing:
// an event's bytes are split by an inserted raw newline at an arbitrary offset —
// observed inside the JSON (36/33/102/198/204…) and inside the `data:` prefix
// itself (`data\n: {...}`, live 2026-09-29). A strict SSE client JSON-parses the
// fragment and throws — the openai SDK (core/streaming.js, JSON.parse of
// sse.data) killed the whole turn with "Unterminated string in JSON at position
// 198". Valid JSON can never contain a raw newline, so plain concatenation of
// the block's lines restores the original event bytes losslessly, wherever the
// split landed; replaying repaired captures through the untouched SDK decoder
// yields zero parse failures.
import { MAX_SSE_BUFFER_LENGTH } from "./stream.js";

function reframeBlock(block: string): string {
  // All single newlines inside a block are gateway-inserted splits; the event
  // separator is the blank line the caller already split on.
  const joined = block.split("\n").join("");
  if (!joined.startsWith("data:")) return `${block}\n\n`;
  let payload = joined.slice(5);
  if (payload.startsWith(" ")) payload = payload.slice(1);
  return `data: ${payload}\n\n`;
}

function reframeSseStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        let next = boundary + 2;
        while (buffer[next] === "\n") next += 1;
        buffer = buffer.slice(next);
        if (block.length > 0) controller.enqueue(encoder.encode(reframeBlock(block)));
        boundary = buffer.indexOf("\n\n");
      }
      if (buffer.length > MAX_SSE_BUFFER_LENGTH) {
        throw new Error(
          `Qoder SSE reframe buffer exceeded ${MAX_SSE_BUFFER_LENGTH} characters without an event boundary`,
        );
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.trim().length > 0) controller.enqueue(encoder.encode(reframeBlock(buffer)));
    },
  });
}

/** Wrap a fetch so event-stream bodies from the v2 transport are re-framed. */
export function createReframedFetch(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await inner(input, init);
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !response.body || !contentType.includes("text/event-stream")) return response;
    return new Response(response.body.pipeThrough(reframeSseStream()), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
