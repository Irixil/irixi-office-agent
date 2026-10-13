import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function readConfiguration(file) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 256 * 1024
      || fs.realpathSync(file) !== file) throw new Error('Historical bindings must be a bounded canonical regular file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes;
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('Historical bindings changed before read');
    bytes = fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
  const after = fs.lstatSync(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size)
    throw new Error('Historical bindings changed during read');
  return JSON.parse(bytes.toString('utf8'));
}

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

// This fixed sibling file is an administrator-owned local configuration, never model input.
const localFile = fileURLToPath(new URL('./historical-bindings.local.json', import.meta.url));
const exampleFile = fileURLToPath(new URL('./historical-bindings.example.json', import.meta.url));
let config;
try { config = readConfiguration(localFile); }
catch (error) { if (error.code !== 'ENOENT') throw error; config = readConfiguration(exampleFile); }
const objectKeys = ['cleanInput35', 'storageRepair48', 'storageRepair49', 'reviewBinding', 'nativeDevelopment', 'nativeLearning', 'legacyExactValues'];
const mapKeys = ['learningResumePlatformFailures', 'reviewFailureContinuations'];
if (config?.schemaVersion !== 1 || [...objectKeys, ...mapKeys, 'schemaVersion'].sort().join('|') !== Object.keys(config).sort().join('|')
    || objectKeys.some(key => !config[key] || typeof config[key] !== 'object' || Array.isArray(config[key]))
    || mapKeys.some(key => !Array.isArray(config[key]) || config[key].some(entry => !Array.isArray(entry) || entry.length !== 2
        || typeof entry[0] !== 'string' || !entry[0] || !entry[1] || typeof entry[1] !== 'object' || Array.isArray(entry[1]))
        || new Set(config[key].map(entry => entry[0])).size !== config[key].length))
  throw new Error('Historical binding configuration is malformed');
export const historicalBindings = freeze(config);
