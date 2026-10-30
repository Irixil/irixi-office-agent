import { createHash } from 'node:crypto';

const timingTypes = `export interface GameplayInputTiming {
  type: GameplayPlaytestInput['type'];
  code?: string;
  requestedDurationMs: number;
  inputDurationMs: number;
  captureWaitMs: number;
  captures: Array<{ sampleIndex: 1 | 2; startedOffsetMs: number; finishedOffsetMs: number; status: 'pending' | 'completed' | 'failed' }>;
}

`;

const dispatchReplacement = String.raw`function createInputCaptures(
  input: GameplayPlaytestInput,
  requestedDurationMs: number,
  capture: ((sampleIndex: 1 | 2) => Promise<void>) | undefined,
  inputTimings: GameplayInputTiming[],
) {
  const startedAt = performance.now();
  const captures: GameplayInputTiming['captures'] = [];
  const jobs: Promise<void>[] = [];
  let failure: unknown = null;
  let timing: GameplayInputTiming | null = null;
  return {
    remaining(targetMs: number) { return Math.max(0, targetMs - (performance.now() - startedAt)); },
    sample(sampleIndex: 1 | 2) {
      if (!capture) return;
      const record: GameplayInputTiming['captures'][number] = {
        sampleIndex, startedOffsetMs: performance.now() - startedAt,
        finishedOffsetMs: 0, status: 'pending',
      };
      captures.push(record);
      // Do not await the screenshot on the input lane. Capture/PNG work must
      // not prolong a pressed key or mouse button. Rejections are retained.
      jobs.push(Promise.resolve().then(() => capture(sampleIndex)).then(() => {
        record.status = 'completed';
        record.finishedOffsetMs = performance.now() - startedAt;
      }, (error: unknown) => {
        record.status = 'failed';
        record.finishedOffsetMs = performance.now() - startedAt;
        failure ??= error;
      }));
    },
    async finish() {
      const releasedAt = performance.now();
      await Promise.all(jobs);
      timing = {
        type: input.type,
        ...(input.type === 'key' ? { code: input.code } : {}),
        requestedDurationMs,
        inputDurationMs: releasedAt - startedAt,
        captureWaitMs: performance.now() - releasedAt,
        captures,
      };
      inputTimings.push(timing);
    },
    result() {
      if (failure) throw failure;
      // A capture completed after release remains in the report, but cannot
      // be claimed as evidence obtained while the input was held.
      return captures.length === 2 && timing !== null && captures.every((sample) =>
        sample.status === 'completed' && sample.finishedOffsetMs <= timing!.inputDurationMs);
    },
  };
}

async function dispatchAction(
  window: GameplayBrowserWindow,
  action: GameplayExperienceAction,
  surface: GameplaySurfaceSnapshot | null,
  keyHoldMs: number,
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  captureWhileHeld?: (sampleIndex: 1 | 2) => Promise<void>,
  inputTimings: GameplayInputTiming[] = [],
): Promise<boolean> {
  let capturedWhileHeld = false;
  for (const input of action.inputs) {
    ensureActive(window, signal);
    if (input.type === 'wait') {
      const capture = createInputCaptures(input, input.ms, undefined, inputTimings);
      try { await sleep(input.ms, signal); } finally { await capture.finish(); }
      continue;
    }
    if (input.type === 'pointer') {
      const capture = createInputCaptures(input, 0, undefined, inputTimings);
      const point = surfacePoint(surface, input.xRatio, input.yRatio);
      window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
      window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y,
        button: electronMouseButton(input.button), clickCount: 1 });
      window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y,
        button: electronMouseButton(input.button), clickCount: 1 });
      await capture.finish();
      continue;
    }
    if (input.type === 'look' || input.type === 'drag') {
      const sampled: boolean = input.type === 'look'
        ? await dispatchLookInput(window, input, surface, sleep, signal,
            capturedWhileHeld ? undefined : captureWhileHeld, inputTimings)
        : await dispatchDragInput(window, input, surface, sleep, signal,
            capturedWhileHeld ? undefined : captureWhileHeld, inputTimings);
      capturedWhileHeld ||= sampled;
      continue;
    }
    const keyCode = electronKeyCode(input.code);
    const holdMs = input.holdMs > 0 ? input.holdMs : keyHoldMs;
    const shouldSample = Boolean(captureWhileHeld && !capturedWhileHeld && holdMs >= MIN_HELD_TEMPORAL_MS);
    const capture = createInputCaptures(input, holdMs, shouldSample ? captureWhileHeld : undefined, inputTimings);
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    try {
      if (shouldSample) {
        const firstSlice = Math.floor(holdMs / 3);
        const secondSlice = Math.floor(holdMs / 3);
        await sleep(capture.remaining(firstSlice), signal);
        ensureActive(window, signal);
        capture.sample(1);
        await sleep(capture.remaining(firstSlice + secondSlice), signal);
        ensureActive(window, signal);
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
        capture.sample(2);
        await sleep(capture.remaining(holdMs), signal);
      } else if (holdMs > 0) {
        await sleep(capture.remaining(holdMs), signal);
      }
    } finally {
      let releaseError: unknown; let releaseFailed = false;
      try { if (!window.isDestroyed()) window.webContents.sendInputEvent({ type: 'keyUp', keyCode }); }
      catch (error) { releaseError = error; releaseFailed = true; }
      finally { try { await capture.finish(); } catch (error) { if (!releaseFailed) throw error; } }
      if (releaseFailed) throw releaseError;
    }
    capturedWhileHeld ||= capture.result();
  }
  return capturedWhileHeld;
}

async function dispatchLookInput(
  window: GameplayBrowserWindow,
  input: Extract<GameplayPlaytestInput, { type: 'look' }>,
  surface: GameplaySurfaceSnapshot | null,
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  captureDuringMotion?: (sampleIndex: 1 | 2) => Promise<void>,
  inputTimings: GameplayInputTiming[] = [],
): Promise<boolean> {
  const start = surfacePoint(surface, 0.5, 0.5);
  const viewport = surface?.viewport ?? { width: 1024, height: 640 };
  const steps = motionStepCount(input.durationMs);
  const firstSampleStep = Math.max(1, Math.floor(steps / 3));
  const secondSampleStep = Math.max(firstSampleStep + 1, Math.floor((steps * 2) / 3));
  const capture = createInputCaptures(input, input.durationMs, captureDuringMotion, inputTimings);
  let cumulativeX = 0, cumulativeY = 0, capturedSamples = 0;
  try {
    for (let step = 1; step <= steps; step += 1) {
      ensureActive(window, signal);
      const movementX = distributedMotionDelta(input.deltaX, step, steps);
      const movementY = distributedMotionDelta(input.deltaY, step, steps);
      cumulativeX += movementX; cumulativeY += movementY;
      window.webContents.sendInputEvent({ type: 'mouseMove',
        x: clampCoordinate(start.x + cumulativeX, viewport.width),
        y: clampCoordinate(start.y + cumulativeY, viewport.height), movementX, movementY });
      await sleep(capture.remaining(Math.round(input.durationMs * step / steps)), signal);
      if (captureDuringMotion && capturedSamples === 0 && step >= firstSampleStep) {
        ensureActive(window, signal); capture.sample(1); capturedSamples = 1;
      }
      if (captureDuringMotion && capturedSamples === 1 && step >= secondSampleStep) {
        ensureActive(window, signal); capture.sample(2); capturedSamples = 2;
      }
    }
  } finally { await capture.finish(); }
  return capture.result();
}

async function dispatchDragInput(
  window: GameplayBrowserWindow,
  input: Extract<GameplayPlaytestInput, { type: 'drag' }>,
  surface: GameplaySurfaceSnapshot | null,
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  captureDuringMotion?: (sampleIndex: 1 | 2) => Promise<void>,
  inputTimings: GameplayInputTiming[] = [],
): Promise<boolean> {
  const from = surfacePoint(surface, input.fromXRatio, input.fromYRatio);
  const to = surfacePoint(surface, input.toXRatio, input.toYRatio);
  const button = electronMouseButton(input.button);
  const steps = motionStepCount(input.durationMs);
  const firstSampleStep = Math.max(1, Math.floor(steps / 3));
  const secondSampleStep = Math.max(firstSampleStep + 1, Math.floor((steps * 2) / 3));
  const capture = createInputCaptures(input, input.durationMs, captureDuringMotion, inputTimings);
  let current = from, capturedSamples = 0;
  window.webContents.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button, clickCount: 1 });
  try {
    for (let step = 1; step <= steps; step += 1) {
      ensureActive(window, signal);
      const next = { x: Math.round(from.x + ((to.x - from.x) * step) / steps),
        y: Math.round(from.y + ((to.y - from.y) * step) / steps) };
      window.webContents.sendInputEvent({ type: 'mouseMove', x: next.x, y: next.y,
        movementX: next.x - current.x, movementY: next.y - current.y, button });
      current = next;
      await sleep(capture.remaining(Math.round(input.durationMs * step / steps)), signal);
      if (captureDuringMotion && capturedSamples === 0 && step >= firstSampleStep) {
        ensureActive(window, signal); capture.sample(1); capturedSamples = 1;
      }
      if (captureDuringMotion && capturedSamples === 1 && step >= secondSampleStep) {
        ensureActive(window, signal); capture.sample(2); capturedSamples = 2;
      }
    }
  } finally {
    let releaseError: unknown; let releaseFailed = false;
    try { if (!window.isDestroyed()) window.webContents.sendInputEvent({ type: 'mouseUp',
      x: current.x, y: current.y, button, clickCount: 1 }); }
    catch (error) { releaseError = error; releaseFailed = true; }
    finally { try { await capture.finish(); } catch (error) { if (!releaseFailed) throw error; } }
    if (releaseFailed) throw releaseError;
  }
  return capture.result();
}

`;

export function patchNoobiInputTiming(source, expectedDispatchHash) {
  function replace(before, after) {
    if (source.split(before).length !== 2) throw new Error('Noobi gameplay evaluator changed; input timing adaptation requires review.');
    source = source.replace(before, after);
  }
  const first=source.indexOf('async function dispatchAction('),last=source.indexOf('function motionStepCount(',first);
  const actual=createHash('sha256').update(source.slice(first,last)).digest('hex');
  if(first<0||last<0||actual!==expectedDispatchHash) throw new Error('Noobi input dispatcher changed; timing adaptation requires review.');
  source=source.slice(0,first)+dispatchReplacement+source.slice(last);
  replace('export interface GameplayJourneyStepResult {',timingTypes+'export interface GameplayJourneyStepResult {');
  replace('  durationMs: number;\n  observations: GameplayObservationResult[];', '  durationMs: number;\n  inputTimings: GameplayInputTiming[];\n  observations: GameplayObservationResult[];');
  replace('      const heldFrames: CapturedFrame[] = [];','      const heldFrames: CapturedFrame[] = [];\n      const inputTimings: GameplayInputTiming[] = [];');
  replace('            heldFrames.push(heldFrame);','            heldFrames[sampleIndex - 1] = heldFrame;');
  replace('          : undefined,\n      );\n      await this.#sleep(', '          : undefined,\n        inputTimings,\n      );\n      await this.#sleep(');
  replace('        durationMs: Date.now() - stepStartedAt,\n        observations: observationResults,','        durationMs: Date.now() - stepStartedAt,\n        inputTimings,\n        observations: observationResults,');
  return source;
}
