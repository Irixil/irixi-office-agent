export function requiredResponseFields(prompt) {
  const line = String(prompt || '').split('\n').at(-1);
  let envelope;
  try { envelope = JSON.parse(line); } catch { throw new Error('Inference prompt has no parseable registered request envelope'); }
  const required = envelope?.payload?.responseContract?.required;
  if (!required || typeof required !== 'object' || Array.isArray(required)) throw new Error('Inference request has no registered responseContract.required object');
  const fields = Object.keys(required);
  if (!fields.length || fields.some((field) => !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(field))) throw new Error('Inference response contract required fields are invalid');
  return fields.sort();
}

export function assertOutputSchemaCoversContract(prompt, schema) {
  // This is deliberately a fail-closed top-level field gate. The registered JSON
  // schemas remain the authority for nested types; prose responseContract values
  // are not parsed heuristically into a second schema language.
  if (!schema || schema.type !== 'object' || schema.additionalProperties !== false || !Array.isArray(schema.required) || !schema.properties || typeof schema.properties !== 'object') throw new Error('Registered output schema is malformed');
  const schemaRequired = new Set(schema.required), properties = new Set(Object.keys(schema.properties));
  const missing = requiredResponseFields(prompt).filter((field) => !schemaRequired.has(field) || !properties.has(field));
  if (missing.length) throw new Error(`Registered output schema does not cover responseContract.required top-level fields: ${missing.join(',')}`);
  return true;
}
