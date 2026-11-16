import type { JsonObject } from "@lxe/protocol";

export const candidate = (parts: JsonObject[], finishReason?: string, continuationToken?: string) => ({
  candidates: [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}),
    ...(continuationToken ? { continuationToken } : {}) }],
});

export function sse(...chunks: unknown[]): Response {
  const bytes = new TextEncoder().encode(chunks.map(chunk => "data: " + JSON.stringify(chunk) + "\r\n\r\n").join(""));
  return new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}

export const inputOverflowMessage = "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)";

export function googleHttpError(code: number, status: string, message: string): Response {
  return Response.json({ error: { code, status, message } }, { status: code });
}
