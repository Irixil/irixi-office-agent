import { readFileSync } from "fs";
import { join } from "path";

export function completeArticleReviewPayload(cwd: string, changedFiles: string[]): string {
  return changedFiles.map((file) => `=== NEW FILE: ${file} ===\n${readFileSync(join(cwd, file), "utf-8")}`).join("\n\n");
}
