import fs from 'node:fs/promises';
import net from 'node:net';
import { spawnSync } from 'node:child_process';

const request = JSON.parse(await new Promise((resolve, reject) => {
  let body = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { body += chunk; if (body.length > 16 * 1024) reject(new Error('probe_input_too_large')); });
  process.stdin.on('end', () => resolve(body));
  process.stdin.on('error', reject);
}));

async function denied(operation) {
  try { await operation(); return false; }
  catch (error) { return ['EPERM', 'EACCES'].includes(error?.code); }
}

let passed = false;
if (request.action === 'positive-read') passed = (await fs.readFile(request.path, 'utf8')).includes('export function');
else if (request.action === 'denied-read') passed = await denied(() => fs.readFile(request.path));
else if (request.action === 'denied-write') passed = await denied(() => fs.writeFile(request.path, 'forbidden'));
else if (request.action === 'denied-spawn') {
  const result = spawnSync('/usr/bin/true', [], { encoding: 'utf8' });
  passed = ['EPERM', 'EACCES'].includes(result.error?.code);
} else if (request.action === 'denied-network') {
  passed = await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: request.port });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', (error) => resolve(['EPERM', 'EACCES'].includes(error?.code)));
    setTimeout(() => { socket.destroy(); resolve(false); }, 750).unref();
  });
} else if (request.action === 'clean-env') {
  const forbidden = Object.keys(process.env).filter((key) => /^(?:HOME|PATH|NODE_OPTIONS|.*PROXY|SSH.*|AWS.*|AZURE.*|GOOGLE.*|GCLOUD.*|OPENAI.*|ANTHROPIC.*)$/i.test(key));
  passed = forbidden.length === 0;
}
process.stdout.write(`${JSON.stringify({ probeId: request.probeId, nonce: request.nonce, passed })}\n`);
