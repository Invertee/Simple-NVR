// Simple NVR player zoom v1.1.1
(() => {
  const player = document.querySelector('#player');
  const stage = player?.closest('.video-stage');
  const cameraSelect = document.querySelector('#camera-select');
  if (!player || !stage) return;

  const MIN_ZOOM = 1;
  const MAX_ZOOM = 5;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let panning = false;
  let panPointerId = null;
  let panStartX = 0;
  let panStartY = 0;
  let panOriginX = 0;
  let panOriginY = 0;

  const resetButton = document.createElement('button');
  resetButton.type = 'button';
  resetButton.className = 'video-zoom-reset';
  resetButton.hidden = true;
  resetButton.title = 'Reset video zoom';
  stage.appendChild(resetButton);
  stage.title = 'Scroll over the video to zoom. Drag the image to pan while zoomed.';

  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

  function clampPan() {
    if (zoom <= MIN_ZOOM) {
      panX = 0;
      panY = 0;
      return;
    }
    const rect = stage.getBoundingClientRect();
    const maxX = rect.width * (zoom - 1) / 2;
    const maxY = rect.height * (zoom - 1) / 2;
    panX = clamp(panX, -maxX, maxX);
    panY = clamp(panY, -maxY, maxY);
  }

  function applyTransform() {
    clampPan();
    player.style.transform = `translate3d(${panX.toFixed(2)}px, ${panY.toFixed(2)}px, 0) scale(${zoom.toFixed(4)})`;
    const active = zoom > MIN_ZOOM + 0.001;
    stage.classList.toggle('video-zoomed', active);
    resetButton.hidden = !active;
    resetButton.textContent = `${zoom.toFixed(1)}x Reset`;
  }

  function resetZoom() {
    zoom = MIN_ZOOM;
    panX = 0;
    panY = 0;
    panning = false;
    panPointerId = null;
    stage.classList.remove('video-panning');
    applyTransform();
  }

  function zoomAt(clientX, clientY, nextZoom) {
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const localX = clientX - rect.left - rect.width / 2;
    const localY = clientY - rect.top - rect.height / 2;
    const contentX = (localX - panX) / zoom;
    const contentY = (localY - panY) / zoom;

    zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    if (zoom <= MIN_ZOOM + 0.001) {
      resetZoom();
      return;
    }

    panX = localX - contentX * zoom;
    panY = localY - contentY * zoom;
    applyTransform();
  }

  stage.addEventListener('wheel', (event) => {
    if (!player.hasAttribute('src')) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0015);
    zoomAt(event.clientX, event.clientY, zoom * factor);
  }, { passive:false });

  stage.addEventListener('pointerdown', (event) => {
    if (zoom <= MIN_ZOOM + 0.001 || event.button !== 0 || !player.hasAttribute('src') || event.target === resetButton) return;
    const rect = stage.getBoundingClientRect();
    if (event.clientY >= rect.bottom - 46) return;

    panning = true;
    panPointerId = event.pointerId;
    panStartX = event.clientX;
    panStartY = event.clientY;
    panOriginX = panX;
    panOriginY = panY;
    stage.classList.add('video-panning');
    stage.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  stage.addEventListener('pointermove', (event) => {
    if (!panning || event.pointerId !== panPointerId) return;
    panX = panOriginX + event.clientX - panStartX;
    panY = panOriginY + event.clientY - panStartY;
    applyTransform();
  });

  function stopPanning(event) {
    if (!panning || event.pointerId !== panPointerId) return;
    panning = false;
    stage.classList.remove('video-panning');
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    panPointerId = null;
  }

  stage.addEventListener('pointerup', stopPanning);
  stage.addEventListener('pointercancel', stopPanning);
  resetButton.addEventListener('click', (event) => {
    event.stopPropagation();
    resetZoom();
  });

  cameraSelect?.addEventListener('change', resetZoom);
  player.addEventListener('emptied', () => {
    if (!player.hasAttribute('src')) resetZoom();
  });
  window.addEventListener('resize', applyTransform);

  applyTransform();
})();
