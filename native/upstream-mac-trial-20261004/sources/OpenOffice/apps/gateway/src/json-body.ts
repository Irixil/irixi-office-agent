import type { IncomingMessage } from "http";

export function readSmallJson(req: IncomingMessage, limit = 16 * 1024, options: { drainOnLimit?: boolean } = {}): Promise<any> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        if (!tooLarge) {
          tooLarge = true;
          chunks.length = 0;
          if (options.drainOnLimit !== true) { reject(new Error("Request is too large")); req.destroy(); }
        }
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) { reject(new Error("Request is too large")); return; }
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("Request is not valid JSON")); }
    });
    req.on("error", reject);
  });
}
