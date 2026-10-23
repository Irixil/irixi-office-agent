export function projectMapHotspot({ mapLayer, view, canvasRect, shellRect, camera, sceneScale }) {
  const left = Math.max(mapLayer.x + 632, view.x);
  const top = Math.max(mapLayer.y + 36, view.y);
  const right = Math.min(mapLayer.x + 804, view.right);
  const bottom = Math.min(mapLayer.y + 136, view.bottom);
  const scaleX = canvasRect.width / (sceneScale.width || canvasRect.width);
  const scaleY = canvasRect.height / (sceneScale.height || canvasRect.height);
  const width = (right - left) * camera.zoom * scaleX;
  const height = (bottom - top) * camera.zoom * scaleY;
  if (right <= left || bottom <= top || width < 44 || height < 28 || !canvasRect.width || !canvasRect.height) return null;
  return {
    left: canvasRect.left - shellRect.left + (camera.x + (left - view.x) * camera.zoom) * scaleX,
    top: canvasRect.top - shellRect.top + (camera.y + (top - view.y) * camera.zoom) * scaleY,
    width,
    height,
  };
}

export function attachProjectMapHotspot({ shell, sceneProvider, onActivate }) {
  const isolatedEvents = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click', 'dblclick', 'contextmenu', 'wheel', 'keydown', 'keyup'];
  let scene = null;
  let layer = null;
  let button = null;
  const position = () => {
    if (!button || !scene || !layer) return;
    const rect = projectMapHotspot({ mapLayer: layer, view: scene.cameras.main.worldView,
      canvasRect: scene.game.canvas.getBoundingClientRect(), shellRect: shell.getBoundingClientRect(),
      camera: scene.cameras.main, sceneScale: scene.scale });
    button.hidden = !rect;
    if (!rect) return;
    Object.assign(button.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    button.classList.toggle('can-label', rect.width >= 100);
  };
  const connect = () => {
    const candidate = sceneProvider();
    const background = candidate?.room?.backgroundLayers?.find((item) => item.key === 'office-room-base');
    if (!candidate || !background || scene === candidate) return;
    if (!button) {
      button = document.createElement('button');
      button.type = 'button'; button.className = 'office-map-project-button';
      button.textContent = '项目与对话'; button.setAttribute('aria-label', '打开真实项目与历史任务');
      button.hidden = true; shell.append(button);
      button.addEventListener('click', () => {
        onActivate();
        button.setAttribute('aria-expanded', String(shell.classList.contains('has-sidebar')));
      });
      for (const eventName of isolatedEvents) button.addEventListener(eventName, (event) => event.stopPropagation());
    }
    scene = candidate; layer = background;
    scene.cameras.main.on('postrender', position);
    scene.scale.on('resize', position);
    position();
  };
  const timer = window.setInterval(connect, 250);
  return { connect, position, destroy() { window.clearInterval(timer); if (button) button.remove(); } };
}
