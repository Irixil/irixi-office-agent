import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Pinned vendor browser. No user's Chrome profile or account is used.
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('当前本机版本的网页检查器支持 Apple Silicon macOS。');
const project = fileURLToPath(new URL('../', import.meta.url));
const target = path.join(project, '.irixi-runtime/browser/chromium-headless-shell-1248');
const binary = path.join(target, 'chrome-headless-shell');
const expected = '77d8278b1ac9d0687fad4e817ea83023ede09b1deef36e1864b49ba194ac9634';
const valid = async (file) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex') === expected;
try { if (await valid(binary)) { console.log('网页检查器已就绪。'); process.exit(0); } } catch {}
execFileSync('npm', ['exec', '--yes', '--package=playwright@1.64.1', '--', 'playwright', 'install', 'chromium-headless-shell'], { stdio: 'inherit' });
const source = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64');
if (!await valid(path.join(source, 'chrome-headless-shell'))) throw new Error('下载的检查器与固定版本不符，未安装。');
await fs.mkdir(path.dirname(target), { recursive: true });
await fs.cp(source, target, { recursive: true, force: false, errorOnExist: true });
console.log('网页检查器安装完成。');
