import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import vm from 'node:vm';

const MAX_INPUT_BYTES = 16 * 1024;
const MAX_CANDIDATE_BYTES = 128 * 1024;
const START_MARKER = 'function renderContinuity(task) {';
const END_MARKER = '\n}\n\nfunction renderProject(task) {';

let body = '';
for await (const chunk of process.stdin) {
  body += chunk;
  if (Buffer.byteLength(body) > MAX_INPUT_BYTES) throw new Error('protocol_input_too_large');
}
const request = JSON.parse(body);
if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('protocol_request_invalid');
if (typeof request.caseId !== 'string' || !request.caseId || request.caseId.length > 120) throw new Error('protocol_case_id_invalid');
if (typeof request.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(request.nonce)) throw new Error('protocol_nonce_invalid');
if (request.exportName !== 'renderContinuity') throw new Error('protocol_entrypoint_invalid');

const stringify = JSON.stringify.bind(JSON);
const write = process.stdout.write.bind(process.stdout);
const candidatePath = process.argv[2];
if (!candidatePath) throw new Error('candidate_path_missing');
const candidateBytes = await fs.readFile(candidatePath);
if (candidateBytes.length > MAX_CANDIDATE_BYTES) throw new Error('candidate_too_large');
const source = candidateBytes.toString('utf8');
if (source.includes('\uFFFD')) throw new Error('candidate_utf8_invalid');
const start = source.indexOf(START_MARKER);
const endStart = start < 0 ? -1 : source.indexOf(END_MARKER, start + START_MARKER.length);
if (start < 0 || endStart < 0
  || source.indexOf(START_MARKER, start + START_MARKER.length) !== -1
  || source.indexOf(END_MARKER, endStart + END_MARKER.length) !== -1) throw new Error('candidate_region_invalid');
const functionSource = source.slice(start, endStart + 2);
const esc = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
if (!functionSource.startsWith(START_MARKER) || !functionSource.endsWith('}')) throw new Error('candidate_function_boundary_invalid');
const functionBody = functionSource.slice(START_MARKER.length, -1);
const renderContinuity = vm.compileFunction(`"use strict";\n${functionBody}`, ['task'], { parsingContext: vm.createContext({ esc }) });
if (typeof renderContinuity !== 'function') throw new Error('candidate_function_missing');
const html = renderContinuity(request.input);
if (typeof html !== 'string') throw new Error('candidate_result_type');
const value = crypto.createHash('sha256').update(html).digest('hex');
write(`${stringify({ caseId: request.caseId, nonce: request.nonce, value })}\n`);
