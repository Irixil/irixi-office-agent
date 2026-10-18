export const NOOBI_GAME_PROJECT_ID = 'noobi-owl-book-sorter-v1';
export const NOOBI_GAME_PLAYTEST_PATH = '.noobi/playtest.json';
export const MAX_NOOBI_REGISTERED_PNG_BYTES = 2 * 1024 * 1024;

export const NOOBI_GAME_WRITE_PATHS = Object.freeze([
  '.noobi/playtest.json',
  'GAME_DESIGN.md',
  'README.md',
  'index.html',
  'package.json',
  'public/assets/asset-pack.json',
  'src/main.js',
  'src/style.css',
]);

export const NOOBI_GAME_READONLY_PNG_PATHS = Object.freeze([
  'public/assets/images/books/book-stack-at-desk.png',
  'public/assets/images/books/book-stack-master.png',
  'public/assets/images/books/book-stack-shelved-patch.png',
  'public/assets/images/irixi/runtime/down.png',
  'public/assets/images/irixi/runtime/irixi-left.png',
  'public/assets/images/irixi/runtime/irixi-right.png',
  'public/assets/images/irixi/runtime/irixi-up.png',
  'public/assets/images/irixi/walk/down/spritesheet.png',
  'public/assets/images/irixi/walk/left/spritesheet.png',
  'public/assets/images/irixi/walk/right/spritesheet.png',
  'public/assets/images/irixi/walk/up/spritesheet.png',
  'public/assets/images/rooms/room-1440x810.png',
]);

export const NOOBI_GAME_READONLY_MANIFEST_PATHS = Object.freeze([
  'public/assets/provenance/source-manifests/irixi-character-v4.json',
  'public/assets/provenance/source-manifests/irixi-room-concept-runtime-v4.json',
  'public/assets/provenance/source-manifests/irixi-walk-down-v4.json',
  'public/assets/provenance/source-manifests/irixi-walk-left-v4.json',
  'public/assets/provenance/source-manifests/irixi-walk-right-v4.json',
  'public/assets/provenance/source-manifests/irixi-walk-up-v4.json',
  'public/assets/provenance/source-manifests/steward-mole-book-delivery-v6.json',
]);

export const NOOBI_GAME_BASELINE_PATHS = Object.freeze([
  ...NOOBI_GAME_WRITE_PATHS,
  ...NOOBI_GAME_READONLY_PNG_PATHS,
  ...NOOBI_GAME_READONLY_MANIFEST_PATHS,
].sort());

const SAFE_PROJECT_PATH = /^(?!\.)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;

export function isSafeRegisteredProjectPath(projectId, value) {
  if (projectId === NOOBI_GAME_PROJECT_ID && value === NOOBI_GAME_PLAYTEST_PATH) return true;
  if (typeof value !== 'string' || !SAFE_PROJECT_PATH.test(value)) return false;
  return !value.split('/').some((part) => part === '.git' || part === '.noobi'
    || part.startsWith('.env'));
}

export function isNoobiReadonlyPngPath(projectId, value) {
  return projectId === NOOBI_GAME_PROJECT_ID && NOOBI_GAME_READONLY_PNG_PATHS.includes(value);
}

export function inspectPngHeader(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Registered PNG header is invalid');
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24], colorType = bytes[25], compression = bytes[26], filter = bytes[27], interlace = bytes[28];
  const allowedDepths = colorType === 0 ? [1, 2, 4, 8, 16]
    : colorType === 3 ? [1, 2, 4, 8] : [8, 16];
  if (!width || !height || width > 100_000 || height > 100_000
    || !allowedDepths.includes(bitDepth) || ![0, 2, 3, 4, 6].includes(colorType)
    || compression !== 0 || filter !== 0 || ![0, 1].includes(interlace)) {
    throw new Error('Registered PNG IHDR metadata is invalid');
  }
  return { format: 'PNG', width, height, bitDepth, colorType, compression, filter, interlace };
}
