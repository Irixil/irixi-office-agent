import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DESKTOP_CLI_RELATIVE_PATH = path.join('Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex');

export function resolveCodexRuntime({ env = process.env, realUserHome = os.userInfo().homedir, platform = process.platform } = {}) {
  const realHome = path.resolve(realUserHome);
  const appHome = typeof env.HOME === 'string' && env.HOME ? path.resolve(env.HOME) : null;
  const appHomeIsSynthetic = appHome && appHome !== realHome;
  const inside = (base, target) => {
    const relative = path.relative(base, target);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  const configuredCodexHome = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : null;
  const codexHome = configuredCodexHome && !(appHomeIsSynthetic && inside(appHome, configuredCodexHome))
    ? configuredCodexHome : path.join(realHome, '.codex');

  const explicitCli = typeof env.IRIXI_CODEX_PATH === 'string' && env.IRIXI_CODEX_PATH.trim()
    ? { executable: path.resolve(env.IRIXI_CODEX_PATH), source: 'IRIXI_CODEX_PATH' }
    : null;
  const desktopEnvCli = typeof env.CODEX_CLI_PATH === 'string' && env.CODEX_CLI_PATH.trim()
    ? { executable: path.resolve(env.CODEX_CLI_PATH), source: 'CODEX_CLI_PATH' }
    : null;
  let selected = explicitCli || desktopEnvCli;
  if (!selected && platform === 'darwin') {
    const candidates = [
      path.join('/Applications', 'ChatGPT.app', DESKTOP_CLI_RELATIVE_PATH),
      path.join(realHome, 'Applications', 'ChatGPT.app', DESKTOP_CLI_RELATIVE_PATH),
    ];
    const installed = candidates.find((candidate) => {
      try { return fs.statSync(candidate).isFile(); } catch { return false; }
    });
    if (installed) selected = { executable: installed, source: 'desktop-app-bundle' };
  }

  return {
    executable: selected?.executable || null,
    executableSource: selected?.source || null,
    executableError: selected ? null : platform === 'darwin'
      ? '未找到 Desktop 自带的 Codex CLI。请修复 Desktop 安装或明确设置 IRIXI_CODEX_PATH；不会回退到用户全局 CLI。'
      : '当前平台未发现受支持的 Desktop Codex CLI。请明确设置 IRIXI_CODEX_PATH；不会回退到用户全局 CLI。',
    codexHome,
  };
}
