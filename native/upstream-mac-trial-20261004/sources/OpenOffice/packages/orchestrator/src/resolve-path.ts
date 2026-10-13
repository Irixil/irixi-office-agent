import path from "path";
import { existsSync } from "fs";

/**
 * Resolve an agent-reported file path against disk reality.
 * Agents report paths unpredictably — sometimes relative to workspace root,
 * sometimes relative to projectDir, sometimes just a filename, sometimes hallucinated.
 * This function tries multiple strategies and returns the first that exists on disk.
 */
export function resolveAgentPath(
  filePath: string,
  projectDir: string,
  workspace: string,
): string | undefined {
  if (!filePath || !filePath.trim()) return undefined;

  // 1. Already absolute and exists
  if (path.isAbsolute(filePath) && existsSync(filePath)) return filePath;

  // 2. Relative to projectDir (most common correct case)
  const fromProject = path.join(projectDir, filePath);
  if (existsSync(fromProject)) return fromProject;

  // 3. Relative to workspace root (agent may report "projectName/file.html")
  const fromWorkspace = path.join(workspace, filePath);
  if (existsSync(fromWorkspace)) return fromWorkspace;

  // 4. Basename only in projectDir (strip any directory prefix)
  const basename = path.basename(filePath);
  if (basename !== filePath) {
    const fromBasename = path.join(projectDir, basename);
    if (existsSync(fromBasename)) return fromBasename;
  }

  return undefined;
}
