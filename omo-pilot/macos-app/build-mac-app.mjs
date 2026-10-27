import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');
const APP_NAME = 'iRIXI Personal Agent';
const testPortIndex = process.argv.indexOf('--test-port');
const testRuntimeIndex = process.argv.indexOf('--test-runtime');
const testPort = testPortIndex >= 0 ? Number(process.argv[testPortIndex + 1]) : null;
const testRuntime = testRuntimeIndex >= 0 ? process.argv[testRuntimeIndex + 1] : null;
if (testPort !== null && (!Number.isInteger(testPort) || testPort < 1024 || testPort > 65535 || testPort === 58312 || !path.isAbsolute(testRuntime || ''))) throw new Error('隔离包需要独立端口和完整数据路径。');
const bundleId = testPort ? `local.irixi.personal-agent.qa${testPort}` : 'local.irixi.personal-agent.p0';
const outputIndex = process.argv.indexOf('--output');
const requestedOutput = path.resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] : path.join(WORKSPACE_ROOT, `${APP_NAME}.app`));
const APP_BUNDLE_PATH = fs.existsSync(requestedOutput) ? fs.realpathSync(requestedOutput) : requestedOutput;
if (!APP_BUNDLE_PATH.endsWith('.app')) throw new Error('输出位置必须以 .app 结尾');
await fsp.mkdir(path.dirname(APP_BUNDLE_PATH), { recursive: true });
const staging = await fsp.mkdtemp(path.join(path.dirname(APP_BUNDLE_PATH), '.irixi-build-'));
const STAGED_APP = path.join(staging, `${APP_NAME}.app`);
const buildVersion = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const xml = (text) => text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
const CONTENTS_DIR = path.join(STAGED_APP, 'Contents');
const MACOS_DIR = path.join(CONTENTS_DIR, 'MacOS');
const RESOURCES_DIR = path.join(CONTENTS_DIR, 'Resources');
const ICONSET_DIR = path.join(staging, 'AppIcon.iconset');

await fsp.mkdir(MACOS_DIR, { recursive: true });
await fsp.mkdir(RESOURCES_DIR, { recursive: true });

// 1. Build AppIcon.icns from the Victorian Owl Gentleman sprite
const sourceIcon = path.join(WORKSPACE_ROOT, 'art', 'office-playable-v1', 'characters', 'irixi', 'frames', 'down-idle.png');
if (fs.existsSync(sourceIcon)) {
  await fsp.rm(ICONSET_DIR, { recursive: true, force: true });
  await fsp.mkdir(ICONSET_DIR, { recursive: true });
  const sizes = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png'],
  ];
  for (const [size, filename] of sizes) {
    execFileSync('/usr/bin/sips', [
      '-z', String(size), String(size),
      sourceIcon,
      '--out', path.join(ICONSET_DIR, filename),
    ], { stdio: 'ignore' });
  }
  execFileSync('/usr/bin/iconutil', [
    '-c', 'icns',
    ICONSET_DIR,
    '-o', path.join(RESOURCES_DIR, 'AppIcon.icns'),
  ], { stdio: 'ignore' });
  await fsp.rm(ICONSET_DIR, { recursive: true, force: true });
}

// 2. Write Info.plist
const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>iRIXI Personal Agent</string>
  <key>CFBundleExecutable</key>
  <string>iRIXI Personal Agent</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleId}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>iRIXI Personal Agent</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>3.0.0</string>
  <key>CFBundleVersion</key>
  <string>${buildVersion}</string>
  <key>IrixiWorkspaceRoot</key>
  <string>${xml(WORKSPACE_ROOT)}</string>
${testPort ? `<key>IrixiPilotPort</key><integer>${testPort}</integer><key>IrixiRuntimeDirectory</key><string>${xml(testRuntime)}</string>` : `<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>IRiXI Local Conversation</string><key>CFBundleURLSchemes</key><array><string>irixi</string></array></dict></array>`}
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
  </dict>
</dict>
</plist>
`;
await fsp.writeFile(path.join(CONTENTS_DIR, 'Info.plist'), infoPlist, 'utf8');

// 3. Compile Swift native macOS executable
const swiftSource = path.join(__dirname, 'IrixiMacApp.swift');
const downloadSource = path.join(__dirname, 'ConfirmedDeliveryDownload.swift');
const binaryOut = path.join(MACOS_DIR, APP_NAME);
execFileSync('/usr/bin/swiftc', [
  swiftSource,
  downloadSource,
  '-o', binaryOut,
  '-module-cache-path', path.join(staging, 'swift-module-cache'),
  '-framework', 'Cocoa',
  '-framework', 'WebKit',
], { stdio: 'inherit' });

execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', bundleId, STAGED_APP], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', ['--verify', '--strict', STAGED_APP], { stdio: 'inherit' });
if (fs.existsSync(APP_BUNDLE_PATH)) {
  const backupDir = path.join(path.dirname(APP_BUNDLE_PATH), '.irixi-app-backups', buildVersion);
  await fsp.mkdir(backupDir, { recursive: true });
  const backup = path.join(backupDir, path.basename(APP_BUNDLE_PATH));
  await fsp.rename(APP_BUNDLE_PATH, backup);
  console.log(`原应用完整保留: ${backup}`);
  try { await fsp.rename(STAGED_APP, APP_BUNDLE_PATH); }
  catch (error) { await fsp.rename(backup, APP_BUNDLE_PATH); throw error; }
} else {
  await fsp.rename(STAGED_APP, APP_BUNDLE_PATH);
}
await fsp.rm(staging, { recursive: true, force: true });
console.log(`已成功打包原生 Mac 桌面应用: ${APP_BUNDLE_PATH} (${buildVersion})`);
