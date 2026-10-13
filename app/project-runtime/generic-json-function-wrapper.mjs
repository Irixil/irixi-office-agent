import { pathToFileURL } from 'node:url';
import { types as utilTypes } from 'node:util';

const MAX_INPUT_BYTES = 16 * 1024;
const parse = JSON.parse.bind(JSON);
const stringify = JSON.stringify.bind(JSON);
const write = process.stdout.write.bind(process.stdout);
const apply = Reflect.apply.bind(Reflect);
const arrayIsArray = Array.isArray.bind(Array);
const getPrototypeOf = Object.getPrototypeOf.bind(Object);
const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors.bind(Object);
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor.bind(Object);
const objectKeys = Object.keys.bind(Object);
const hasOwn = Object.hasOwn.bind(Object);
const finite = Number.isFinite.bind(Number);
const byteLength = Buffer.byteLength.bind(Buffer);
const plainPrototype = Object.prototype;
const arrayPrototype = Array.prototype;
const objectToJsonBefore = getOwnPropertyDescriptor(plainPrototype, 'toJSON');
const arrayToJsonBefore = getOwnPropertyDescriptor(arrayPrototype, 'toJSON');
const isProxy = utilTypes.isProxy.bind(utilTypes);
const MAX_JSON_DEPTH = 8;
const MAX_JSON_NODES = 256;
const assertPlainJson = (value) => {
  let nodes = 0;
  const visit = (item, depth) => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw new Error('candidate_result_shape_invalid');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') {
      if (!finite(item)) throw new Error('candidate_result_shape_invalid');
      return;
    }
    if (isProxy(item)) throw new Error('candidate_result_shape_invalid');
    if (arrayIsArray(item)) {
      if (getPrototypeOf(item) !== arrayPrototype || objectKeys(item).length !== item.length) throw new Error('candidate_result_shape_invalid');
      const descriptors = getOwnPropertyDescriptors(item);
      for (let index = 0; index < item.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) throw new Error('candidate_result_shape_invalid');
        visit(descriptor.value, depth + 1);
      }
      return;
    }
    if (typeof item !== 'object' || (getPrototypeOf(item) !== plainPrototype && getPrototypeOf(item) !== null)) throw new Error('candidate_result_shape_invalid');
    const descriptors = getOwnPropertyDescriptors(item);
    const keys = objectKeys(descriptors);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const descriptor = descriptors[key];
      if (key === '__proto__' || key === 'prototype' || key === 'constructor' || !hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) throw new Error('candidate_result_shape_invalid');
      visit(descriptor.value, depth + 1);
    }
  };
  visit(value, 0);
  const encoded = stringify(value);
  if (typeof encoded !== 'string' || byteLength(encoded) > MAX_INPUT_BYTES) throw new Error('candidate_result_shape_invalid');
};
let body = '';
for await (const chunk of process.stdin) {
  body += chunk;
  if (byteLength(body) > MAX_INPUT_BYTES) throw new Error('protocol_input_too_large');
}
const request = parse(body);
if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('protocol_request_invalid');
if (typeof request.caseId !== 'string' || !request.caseId || request.caseId.length > 80) throw new Error('protocol_case_id_invalid');
if (typeof request.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(request.nonce)) throw new Error('protocol_nonce_invalid');
if (typeof request.exportName !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/.test(request.exportName)) throw new Error('protocol_export_invalid');
if (!arrayIsArray(request.args)) throw new Error('protocol_args_invalid');
assertPlainJson(request.args);
const candidatePath = process.argv[2];
if (!candidatePath) throw new Error('candidate_path_missing');
const candidate = await import(pathToFileURL(candidatePath).href);
const callable = candidate[request.exportName];
if (typeof callable !== 'function') throw new Error('candidate_export_missing');
const value = apply(callable, undefined, request.args);
if (value && typeof value.then === 'function') throw new Error('candidate_async_result_forbidden');
if (getOwnPropertyDescriptor(plainPrototype, 'toJSON') !== objectToJsonBefore
  || getOwnPropertyDescriptor(arrayPrototype, 'toJSON') !== arrayToJsonBefore) throw new Error('candidate_intrinsic_changed');
assertPlainJson(value);
write(`${stringify({ type: 'json-function-result-v1', caseId: request.caseId, nonce: request.nonce, value })}\n`);
