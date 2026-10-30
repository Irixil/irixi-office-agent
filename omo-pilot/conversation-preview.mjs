import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.pdf': 'application/pdf' };
const protectedName = (name) => name.split('/').some((part) => part.startsWith('.') || /^(?:credentials?|secrets?)(?:\.|$)/iu.test(part)) || /\.(?:pem|key|p12|pfx)$/iu.test(name);
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// Each project receives its own persistent local origin: storage survives reloads,
// while a generated page cannot call the office API or read another project's data.
export class ConversationPreviews {
  constructor(store) { this.store = store; this.servers = new Map(); this.pending = new Map(); this.starting = new Set(); this.closed = false; }
  async ensure(project) {
    if (this.closed) throw new Error('预览服务已经关闭。');
    if (this.servers.has(project.id)) return project.previewPort;
    if (this.pending.has(project.id)) return this.pending.get(project.id);
    const starting = this.start(project).finally(() => this.pending.delete(project.id));
    this.pending.set(project.id, starting); return starting;
  }
  async start(project) {
    const server = http.createServer(async (req, res) => {
      const sendError = (code, message) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(message); };
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(405, '成果预览仅提供文件，不执行后台操作。');
        if (req.headers.host !== `127.0.0.1:${project.previewPort}`) return sendError(403, '预览地址无效。');
        const url = new URL(req.url, `http://${req.headers.host}`);
        let name = decodeURIComponent(url.pathname).replace(/^\//u, '');
        let versionId = null;
        if (name.startsWith('v/')) { const parts = name.split('/'); versionId = parts[1]; name = parts.slice(2).join('/'); }
        else if (req.headers.referer) {
          const ref = new URL(req.headers.referer);
          if (ref.host === req.headers.host && ref.pathname.startsWith('/v/')) {
            versionId = ref.pathname.split('/')[2];
            const runPrefix = ref.pathname.split('/')[3] === '__run__' ? '__run__/' : '';
            res.writeHead(302, { Location: `/v/${encodeURIComponent(versionId)}/${runPrefix}${name.split('/').map(encodeURIComponent).join('/')}${url.search}` }); res.end(); return;
          }
        }
        const run = name.startsWith('__run__/'); if (run) name = name.slice('__run__/'.length);
        name ||= 'index.html';
        if (protectedName(name) || name.includes('\0') || name.split('/').includes('..')) return sendError(403, '此文件不通过成果预览提供。');
        const turn = versionId ? this.store.state.conversations.flatMap((c) => c.turns).find((t) => t.id === versionId && t.projectId === project.id && t.adoptedAt) : null;
        if (versionId && !turn) return sendError(404, '未找到这个成果版本。');
        if (run && (!turn || turn.artifactEntrypoint !== 'dist/index.html')) return sendError(404, '此版本尚无经过检查的小游戏入口。');
        const base = await fs.realpath(turn ? turn.workspace : project.root);
        const root = run ? path.join(base, 'dist') : base;
        const file = path.resolve(root, name);
        if (!file.startsWith(root + path.sep) || await fs.realpath(file) !== file) return sendError(403, '文件超出成果范围。');
        const bytes = await fs.readFile(file);
        if (turn && turn.resultIndex?.[run ? `dist/${name}` : name] !== sha(bytes)) return sendError(409, '文件与该成果版本不一致，未显示混合版本。');
        res.writeHead(200, { 'Content-Type': `${types[path.extname(name)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "sandbox allow-scripts allow-same-origin allow-forms; default-src 'self' data: blob: 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-src 'none'; base-uri 'self'" });
        res.end(req.method === 'HEAD' ? undefined : bytes);
      } catch (error) { sendError(error.code === 'ENOENT' ? 404 : 500, error.code === 'ENOENT' ? '成果文件不存在。' : '成果暂时无法打开。'); }
    });
    this.starting.add(server);
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(project.previewPort || 0, '127.0.0.1', resolve); });
      if (this.closed) throw new Error('预览服务正在关闭。');
      project.previewPort = server.address().port; await this.store.save();
      if (this.closed) throw new Error('预览服务正在关闭。');
      this.servers.set(project.id, server);
      return project.previewPort;
    } catch (error) { server.close(); throw new Error(`成果预览未能启动。${project.previewPort ? `请关闭占用 ${project.previewPort} 的旧预览后重开。` : ''} ${error.message}`); }
    finally { this.starting.delete(server); }
  }
  async redirect(projectId, name, turnId, res) {
    const project = this.store.state.projects.find((p) => p.id === projectId);
    if (!project) throw new Error('项目不存在。');
    const port = await this.ensure(project);
    const relative = (name || 'index.html').split('/').map(encodeURIComponent).join('/');
    res.writeHead(302, { Location: `http://127.0.0.1:${port}/${turnId ? `v/${encodeURIComponent(turnId)}/` : ''}${relative}` }); res.end();
  }
  close() { this.closed = true; for (const server of new Set([...this.servers.values(), ...this.starting])) server.close(); this.servers.clear(); this.pending.clear(); }
}
