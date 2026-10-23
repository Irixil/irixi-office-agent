import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMapHotspot } from '../public/native-project-hotspot.js';

test('项目入口按办公室地图层和相机视口裁切并投影', () => {
  const rect = projectMapHotspot({
    mapLayer: { x: 0, y: 0 },
    view: { x: 500, y: 0, right: 1100, bottom: 540 },
    canvasRect: { left: 40, top: 30, width: 960, height: 540 },
    shellRect: { left: 10, top: 10 },
    camera: { x: 0, y: 0, zoom: 1 },
    sceneScale: { width: 960, height: 540 },
  });
  assert.deepEqual(rect, { left: 162, top: 56, width: 172, height: 100 });
});

test('相机视口未覆盖地图热点时不显示', () => {
  const rect = projectMapHotspot({
    mapLayer: { x: 0, y: 0 }, view: { x: 0, y: 0, right: 500, bottom: 500 },
    canvasRect: { left: 0, top: 0, width: 500, height: 500 }, shellRect: { left: 0, top: 0 },
    camera: { x: 0, y: 0, zoom: 1 }, sceneScale: { width: 500, height: 500 },
  });
  assert.equal(rect, null);
});
