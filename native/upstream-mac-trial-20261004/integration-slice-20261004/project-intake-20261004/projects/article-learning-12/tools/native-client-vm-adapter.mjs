// Operator-only access to native functions in both classic and esbuild IIFE
// scripts. Native source runs byte-for-byte; temporary observation hooks retain
// function references and the actual first saved session object, then restore
// the builtins before acceptance operations. This is controlled-DOM evidence.
import assert from 'node:assert/strict';
import vm from 'node:vm';

export function executeNativeApp(context, app, filename = 'native-app.js') {
  vm.runInContext(`
    globalThis.__nativeAcceptanceNames = Object.create(null);
    globalThis.__nativeAcceptanceDefine = Object.defineProperty;
    globalThis.__nativeAcceptanceStringify = JSON.stringify;
    Object.defineProperty = function(target, key, descriptor) {
      if (typeof target === 'function' && key === 'name' && typeof descriptor?.value === 'string')
        globalThis.__nativeAcceptanceNames[descriptor.value] = target;
      return globalThis.__nativeAcceptanceDefine(target, key, descriptor);
    };
    JSON.stringify = function(value, ...args) {
      if (value && typeof value.sessionId === 'string' && Object.hasOwn(value, 'draft') &&
          Array.isArray(value.turns) && Array.isArray(value.assessments) && Array.isArray(value.opinions))
        globalThis.__nativeAcceptanceState = value;
      return globalThis.__nativeAcceptanceStringify(value, ...args);
    };
  `, context);
  try {
    vm.runInContext(app, context, { filename });
  } finally {
    vm.runInContext(`
      Object.defineProperty = globalThis.__nativeAcceptanceDefine;
      JSON.stringify = globalThis.__nativeAcceptanceStringify;
    `, context);
  }
  assert.ok(context.__nativeAcceptanceState, 'Native app did not save its initial session');
  context.state = context.__nativeAcceptanceState;
  for (const [name, fn] of Object.entries(context.__nativeAcceptanceNames)) context[name] = fn;
  for (const [name, fn] of Object.entries(context.LearningCore)) context[name] = fn;
  return { nativeSourceModified: false, compiledClosureObserved: Object.keys(context.__nativeAcceptanceNames).length > 0,
    originalBuiltinsRestored: true, exposedNativeFunctionNames: Object.keys(context.__nativeAcceptanceNames) };
}
