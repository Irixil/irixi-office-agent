import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const code = /\.(?:html?|css|[cm]?js|jsx|[cm]?ts|tsx)$/iu;
const inside = (root, file) => file.startsWith(root + path.sep);

// An editable manifest can be malformed without invalidating the private
// generation receipts. Report that defect to Noobi's bounded repair loop;
// never silently trust it or require another paid image to repair JSON.
export async function noobiAssetsForReview(assetStore, projectId, workspace) {
  try { return { assets: await assetStore.list(projectId, workspace), error: null }; }
  catch (error) {
    if (!(error instanceof SyntaxError) && error.message !== 'Asset manifest does not match this project or schema version') throw error;
    return { assets: [], error: 'ASSET_MANIFEST: public/assets/asset-pack.json 格式或项目身份不正确。修复清单并通过 noobi_asset_register 登记已有图片；先保留已有图片，不重复生成。清单修复后仍须重新核对真实生成记录和游戏中的使用。' };
  }
}

// Coverage starts at files the real playtest loaded. Source maps must contain
// the exact local source; a directory scan or a build success is not coverage.
export async function noobiWebCoverage(root, previewUrl, loadedUrls) {
  root = await fs.realpath(root);
  const dist = path.join(root, 'dist'), origin = new URL(previewUrl).origin;
  const checkedFiles = {}, loadedHashes = new Set();
  const read = async (file) => {
    if (!inside(root, file) || await fs.realpath(file) !== file) throw new Error('试玩文件超出当前项目。');
    const bytes = await fs.readFile(file); checkedFiles[path.relative(root, file)] = hash(bytes); return bytes;
  };
  for (const url of new Set(loadedUrls)) {
    const parsed = new URL(url);
    if (parsed.origin !== origin) continue;
    const name = decodeURIComponent(parsed.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(dist, name);
    if (!inside(dist, file) || name.split('/').some((part) => part.startsWith('.'))) continue;
    const bytes = await read(file); loadedHashes.add(hash(bytes));
    if (!/\.(?:[cm]?js|css)$/iu.test(file)) continue;
    const mapName = [...bytes.toString('utf8').matchAll(/[#@]\s*sourceMappingURL=([^\s*]+)/gu)].at(-1)?.[1];
    if (!mapName || /^(?:data:|https?:|\/)/iu.test(mapName)) continue;
    const mapFile = path.resolve(path.dirname(file), decodeURIComponent(mapName));
    if (!inside(dist, mapFile)) continue;
    const map = JSON.parse((await read(mapFile)).toString('utf8'));
    for (let i = 0; i < (map.sources || []).length; i++) {
      if (typeof map.sources[i] !== 'string' || typeof map.sourcesContent?.[i] !== 'string') continue;
      const source = path.resolve(path.dirname(mapFile), map.sourceRoot || '', map.sources[i]);
      if (!inside(root, source) || !code.test(source) || path.relative(root, source).split(path.sep).some((part) => part.startsWith('.') || part === 'node_modules')) continue;
      if (await fs.realpath(source) !== source) throw new Error('源码映射包含链接路径。');
      const actual = await fs.readFile(source);
      if (hash(actual) !== hash(map.sourcesContent[i])) throw new Error('试玩构建与实际源码版本不同。');
      checkedFiles[path.relative(root, source)] = hash(actual);
    }
  }
  // Plain JS/HTML projects often copy their source unchanged into dist.
  async function identicalSources(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ['dist', 'node_modules'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await identicalSources(file);
      else if (entry.isFile() && code.test(file)) {
        const sha = hash(await fs.readFile(file)); if (loadedHashes.has(sha)) checkedFiles[path.relative(root, file)] = sha;
      }
    }
  }
  await identicalSources(root);
  if (!checkedFiles['dist/index.html']) throw new Error('没有实际打开正式小游戏入口。');
  return checkedFiles;
}

// The evaluator already owns a detailed repair report. An absent loaded page
// is a consequence of an invalid manifest, not a replacement diagnosis.
export async function noobiPlaytestEvidence({ playtest, root, previewUrl, loadedUrls, signal, coverageReader = noobiWebCoverage }) {
  signal?.throwIfAborted();
  const failedChecks = (playtest?.checks || []).filter((check) => check.status === 'repair');
  const errors = playtest?.errors || [];
  if (playtest?.verdict !== 'pass' || failedChecks.length || errors.some((error) => error.fatal)) {
    const findings = [
      `PLAYTEST_EXPERIENCE: ${playtest?.summary || '真实试玩尚未通过。'}`,
      ...errors.map((error) => `PLAYTEST_ERROR[${error.kind || 'unknown'}]: ${error.message || '试玩错误未提供详情。'}`),
      ...failedChecks.map((check) => `PLAYTEST_CHECK[${check.id || 'unknown'}]: ${check.message || '该项试玩未通过。'}`),
    ];
    return { findings, checkedFiles: {} };
  }
  try {
    const checkedFiles = await coverageReader(root, previewUrl, loadedUrls);
    signal?.throwIfAborted();
    return { findings: [], checkedFiles };
  } catch (error) {
    signal?.throwIfAborted();
    if (error.name === 'AbortError') throw error;
    return { findings: [`PLAYTEST_COVERAGE: ${error.message || String(error)}`], checkedFiles: {} };
  }
}

export const NOOBI_PLAYTEST_GUIDANCE = '试玩配置使用宿主实际契约：launch、success、post-action-settle 是保留步骤 id；第一步 action 为 launch，但 id 必须另取唯一名称，例如 ready。start、move、primary、restart 步骤必须声明 screen-change，baselineStepId 指向紧邻的前一步。pointer/drag 的比例坐标相对检测到的 Canvas 或游戏 DOM 区域，而非整个视口。success 只在全部 journey 结束后的当前画面检查；得分、终局等中间结果写在对应步骤的 observe，不能要求重开后的画面同时显示过去终局。正式试玩只服务 dist，且不会从源码目录补素材；构建需把引用的素材复制到 dist 并使用生产可解析的路径。宿主若返回 repair，按报告的 errors 和 checks 修复后再跑；不要自行写入宿主报告或声称已通过。';
