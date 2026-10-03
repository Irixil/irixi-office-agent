import { pathToFileURL } from 'node:url';

const MAX_INPUT_BYTES = 16 * 1024;
let body = '';
for await (const chunk of process.stdin) {
  body += chunk;
  if (Buffer.byteLength(body) > MAX_INPUT_BYTES) throw new Error('protocol_input_too_large');
}
const request = JSON.parse(body);
if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('protocol_request_invalid');
if (typeof request.caseId !== 'string' || !request.caseId || request.caseId.length > 120) throw new Error('protocol_case_id_invalid');
if (typeof request.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(request.nonce)) throw new Error('protocol_nonce_invalid');
if (typeof request.exportName !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/.test(request.exportName)) throw new Error('protocol_export_invalid');

const stringify = JSON.stringify.bind(JSON);
const write = process.stdout.write.bind(process.stdout);
const candidatePath = process.argv[2];
if (!candidatePath) throw new Error('candidate_path_missing');
const candidate = await import(pathToFileURL(candidatePath).href);
const callable = candidate[request.exportName];
if (typeof callable !== 'function') throw new Error('candidate_export_missing');
const value = await callable(request.input);
write(`${stringify({ caseId: request.caseId, nonce: request.nonce, value })}\n`);
