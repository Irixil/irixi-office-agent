import type { IncomingMessage } from "http";

export function readSmallJson(req: IncomingMessage, limit = 16 * 1024): Promise<any> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { reject(new Error("Request is too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("Request is not valid JSON")); }
    });
    req.on("error", reject);
  });
}
