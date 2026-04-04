(() => {
  const editorArea = document.getElementById('editorArea');
  const cropOverlay = document.getElementById('cropOverlay');
  const cropSelection = document.getElementById('cropSelection');
  const dimensionsEl = document.getElementById('dimensions');
  const zoomLevelEl = document.getElementById('zoomLevel');

  let tiles = [];         // array of { canvas, y, height } — each tile is its own canvas
  let fullWidth = 0;
  let fullHeight = 0;     // total pixel height across all tiles
  let originalTilesData = null; // for reset after crop

  let isCropping = false;
  let zoom = 1;
  let crop = { x: 0, y: 0, w: 0, h: 0 };
  let dragState = null;

  const MAX_TILE_HEIGHT = 16000; // safe per-canvas limit

  // ---- Zoom ----
  function applyZoom() {
    const areaWidth = editorArea.clientWidth - 40;
    const displayWidth = areaWidth * zoom;
    const displayScale = displayWidth / fullWidth;

    const container = document.getElementById('tilesContainer');
    container.style.width = displayWidth + 'px';

    for (const tile of tiles) {
      const h = tile.canvas.height * displayScale;
      tile.canvas.style.width = displayWidth + 'px';
      tile.canvas.style.height = h + 'px';
    }
    zoomLevelEl.textContent = Math.round(zoom * 100) + '%';
  }

  function setZoom(newZoom) {
    zoom = Math.max(0.1, Math.min(5, newZoom));
    applyZoom();
  }

  document.getElementById('zoomIn').addEventListener('click', () => setZoom(zoom + 0.1));
  document.getElementById('zoomOut').addEventListener('click', () => setZoom(zoom - 0.1));
  document.getElementById('zoomFit').addEventListener('click', () => setZoom(1));
  window.addEventListener('resize', () => { if (!isCropping) applyZoom(); });

  // ---- Load & Stitch into tiles ----
  async function loadAndStitch() {
    const { captureMetadata } = await chrome.storage.local.get('captureMetadata');
    if (!captureMetadata) return;

    const { segmentKeys, fullHeight: pageHeight, viewportWidth, dpr } = captureMetadata;

    fullWidth = Math.round(viewportWidth * dpr);
    const totalHeight = Math.round(pageHeight * dpr);

    // Load all captured segments
    const segments = [];
    for (const key of segmentKeys) {
      const data = await chrome.storage.local.get(key);
      const segment = data[key];
      if (!segment) continue;
      const img = await loadImage(segment.dataUrl);
      segments.push({ img, y: Math.round(segment.y * dpr) });
    }

    // Create a flat pixel map by drawing segments into tiles
    // First, figure out how many tiles we need
    const numTiles = Math.ceil(totalHeight / MAX_TILE_HEIGHT);
    tiles = [];

    // Create the container for tile canvases
    let container = document.getElementById('tilesContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'tilesContainer';
      container.style.cssText = 'display:flex;flex-direction:column;align-items:center;';
      editorArea.prepend(container);
    }
    container.innerHTML = '';

    // Remove the original single canvas from DOM if present
    const oldCanvas = document.getElementById('canvas');
    if (oldCanvas) oldCanvas.style.display = 'none';

    for (let t = 0; t < numTiles; t++) {
      const tileY = t * MAX_TILE_HEIGHT;
      const tileH = Math.min(MAX_TILE_HEIGHT, totalHeight - tileY);

      const c = document.createElement('canvas');
      c.width = fullWidth;
      c.height = tileH;
      c.style.display = 'block';
      c.style.boxShadow = t === 0 ? '0 -2px 30px rgba(0,0,0,0.5)' : 'none';
      if (t === numTiles - 1) c.style.boxShadow = '0 2px 30px rgba(0,0,0,0.5)';
      container.appendChild(c);

      const tileCtx = c.getContext('2d');

      // Draw relevant segments onto this tile
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const segTop = seg.y;
        const segBottom = seg.y + seg.img.height;
        const tileBottom = tileY + tileH;

        // Does this segment overlap this tile?
        if (segBottom <= tileY || segTop >= tileBottom) continue;

        // Calculate what portion of the segment to draw
        let srcY = 0, srcH = seg.img.height;
        let destY = segTop - tileY;

        // Handle overlap with previous segment
        if (i > 0) {
          const prev = segments[i - 1];
          const prevBottom = prev.y + prev.img.height;
          const overlapWithPrev = Math.max(0, prevBottom - seg.y);
          if (overlapWithPrev > 0) {
            srcY = overlapWithPrev;
            srcH -= overlapWithPrev;
            destY += overlapWithPrev;
          }
        }

        // Clip to tile bounds
        if (destY < 0) {
          srcY += (-destY);
          srcH -= (-destY);
          destY = 0;
        }
        if (destY + srcH > tileH) {
          srcH = tileH - destY;
        }
        if (srcH <= 0) continue;

        tileCtx.drawImage(seg.img, 0, srcY, seg.img.width, srcH,
                          0, destY, fullWidth, srcH);
      }

      tiles.push({ canvas: c, y: tileY, height: tileH });
    }

    fullHeight = totalHeight;
    saveTilesAsOriginal();
    updateDimensions();
    setZoom(1);

    await chrome.storage.local.remove([...segmentKeys, 'captureMetadata']);
  }

  loadAndStitch();

  function saveTilesAsOriginal() {
    originalTilesData = tiles.map(t => {
      const c = document.createElement('canvas');
      c.width = t.canvas.width;
      c.height = t.canvas.height;
      c.getContext('2d').drawImage(t.canvas, 0, 0);
      return { canvas: c, y: t.y, height: t.height };
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function updateDimensions() {
    dimensionsEl.textContent = `${fullWidth} x ${fullHeight}`;
  }

  // ---- Helper: render all tiles into a temporary canvas for export ----
  // For very tall images, we render in slices to avoid hitting limits
  function renderToBlob(format, quality) {
    return new Promise((resolve) => {
      // If it fits in one canvas, render directly
      if (fullHeight <= 16000) {
        const c = document.createElement('canvas');
        c.width = fullWidth;
        c.height = fullHeight;
        const ctx = c.getContext('2d');
        let y = 0;
        for (const tile of tiles) {
          ctx.drawImage(tile.canvas, 0, y);
          y += tile.canvas.height;
        }
        c.toBlob(blob => resolve({ blob, canvas: c }), format, quality);
      } else {
        // For very tall images, we can't make a single canvas.
        // Return tiles array for slice-based export.
        resolve({ blob: null, tiles, fullWidth, fullHeight });
      }
    });
  }

  // ---- Get total display size ----
  function getTotalDisplaySize() {
    if (tiles.length === 0) return { width: 0, height: 0 };
    const areaWidth = editorArea.clientWidth - 40;
    const displayWidth = areaWidth * zoom;
    const displayScale = displayWidth / fullWidth;
    return { width: displayWidth, height: fullHeight * displayScale };
  }

  // ---- Crop Mode ----
  document.getElementById('cropBtn').addEventListener('click', () => {
    if (isCropping) return;
    enterCropMode();
  });

  document.getElementById('resetCropBtn').addEventListener('click', () => {
    if (!originalTilesData) return;
    const container = document.getElementById('tilesContainer');
    container.innerHTML = '';
    tiles = originalTilesData.map(t => {
      const c = document.createElement('canvas');
      c.width = t.canvas.width;
      c.height = t.canvas.height;
      c.style.display = 'block';
      c.getContext('2d').drawImage(t.canvas, 0, 0);
      container.appendChild(c);
      return { canvas: c, y: t.y, height: t.height };
    });
    fullWidth = tiles[0].canvas.width;
    fullHeight = originalTilesData.reduce((sum, t) => sum + t.height, 0);
    updateDimensions();
    applyZoom();
    document.getElementById('resetCropBtn').style.display = 'none';
  });

  document.getElementById('applyCrop').addEventListener('click', applyCrop);
  document.getElementById('cancelCrop').addEventListener('click', exitCropMode);

  function enterCropMode() {
    isCropping = true;
    document.getElementById('cropBtn').classList.add('active');
    cropOverlay.style.display = 'block';
    cropOverlay.classList.add('active');
    document.getElementById('cropActions').style.display = 'flex';

    const display = getTotalDisplaySize();
    crop = { x: 0, y: 0, w: display.width, h: display.height };
    updateCropSelection();
    setupCropListeners();
  }

  function exitCropMode() {
    isCropping = false;
    document.getElementById('cropBtn').classList.remove('active');
    cropOverlay.style.display = 'none';
    cropOverlay.classList.remove('active');
    document.getElementById('cropActions').style.display = 'none';
    removeCropListeners();
  }

  function applyCrop() {
    const display = getTotalDisplaySize();
    const scaleX = fullWidth / display.width;
    const scaleY = fullHeight / display.height;

    const sx = Math.round(crop.x * scaleX);
    const sy = Math.round(crop.y * scaleY);
    const sw = Math.round(crop.w * scaleX);
    const sh = Math.round(crop.h * scaleY);

    if (sw < 1 || sh < 1) return;

    // Extract cropped region across tiles into new tiles
    const newNumTiles = Math.ceil(sh / MAX_TILE_HEIGHT);
    const newTiles = [];
    const container = document.getElementById('tilesContainer');
    container.innerHTML = '';

    for (let t = 0; t < newNumTiles; t++) {
      const newTileY = t * MAX_TILE_HEIGHT;
      const newTileH = Math.min(MAX_TILE_HEIGHT, sh - newTileY);

      const c = document.createElement('canvas');
      c.width = sw;
      c.height = newTileH;
      c.style.display = 'block';
      container.appendChild(c);
      const ctx = c.getContext('2d');

      // The region we need from the source: sy + newTileY to sy + newTileY + newTileH
      const needTop = sy + newTileY;
      const needBottom = needTop + newTileH;

      for (const tile of tiles) {
        const tileTop = tile.y;
        const tileBottom = tile.y + tile.canvas.height;

        if (tileBottom <= needTop || tileTop >= needBottom) continue;

        const overlapTop = Math.max(needTop, tileTop);
        const overlapBottom = Math.min(needBottom, tileBottom);
        const srcTileY = overlapTop - tileTop;
        const srcTileH = overlapBottom - overlapTop;
        const destTileY = overlapTop - needTop;

        ctx.drawImage(tile.canvas,
          sx, srcTileY, sw, srcTileH,
          0, destTileY, sw, srcTileH);
      }

      newTiles.push({ canvas: c, y: newTileY, height: newTileH });
    }

    tiles = newTiles;
    fullWidth = sw;
    fullHeight = sh;
    updateDimensions();
    applyZoom();

    document.getElementById('resetCropBtn').style.display = 'flex';
    exitCropMode();
  }

  function updateCropSelection() {
    const container = document.getElementById('tilesContainer');
    const containerRect = container.getBoundingClientRect();
    const areaRect = editorArea.getBoundingClientRect();
    const offsetX = containerRect.left - areaRect.left + editorArea.scrollLeft;
    const offsetY = containerRect.top - areaRect.top + editorArea.scrollTop;

    cropSelection.style.left = (offsetX + crop.x) + 'px';
    cropSelection.style.top = (offsetY + crop.y) + 'px';
    cropSelection.style.width = crop.w + 'px';
    cropSelection.style.height = crop.h + 'px';
  }

  function onCropMouseDown(e) {
    e.preventDefault();
    const handle = e.target.dataset?.handle;
    const areaRect = editorArea.getBoundingClientRect();
    const mouse = {
      x: e.clientX - areaRect.left + editorArea.scrollLeft,
      y: e.clientY - areaRect.top + editorArea.scrollTop
    };

    if (handle) {
      dragState = { type: handle, startX: mouse.x, startY: mouse.y, startCrop: { ...crop } };
    } else if (e.target === cropSelection) {
      dragState = { type: 'move', startX: mouse.x, startY: mouse.y, startCrop: { ...crop } };
    }
  }

  function onCropMouseMove(e) {
    if (!dragState) return;
    e.preventDefault();

    const areaRect = editorArea.getBoundingClientRect();
    const mouse = {
      x: e.clientX - areaRect.left + editorArea.scrollLeft,
      y: e.clientY - areaRect.top + editorArea.scrollTop
    };
    const dx = mouse.x - dragState.startX;
    const dy = mouse.y - dragState.startY;
    const sc = dragState.startCrop;
    const display = getTotalDisplaySize();

    if (dragState.type === 'move') {
      crop.x = Math.max(0, Math.min(sc.x + dx, display.width - sc.w));
      crop.y = Math.max(0, Math.min(sc.y + dy, display.height - sc.h));
    } else {
      const newCrop = { ...sc };
      if (dragState.type.includes('e')) newCrop.w = Math.max(10, sc.w + dx);
      if (dragState.type.includes('w')) { newCrop.x = sc.x + dx; newCrop.w = Math.max(10, sc.w - dx); }
      if (dragState.type.includes('s')) newCrop.h = Math.max(10, sc.h + dy);
      if (dragState.type.includes('n')) { newCrop.y = sc.y + dy; newCrop.h = Math.max(10, sc.h - dy); }

      newCrop.x = Math.max(0, newCrop.x);
      newCrop.y = Math.max(0, newCrop.y);
      if (newCrop.x + newCrop.w > display.width) newCrop.w = display.width - newCrop.x;
      if (newCrop.y + newCrop.h > display.height) newCrop.h = display.height - newCrop.y;
      crop = newCrop;
    }

    updateCropSelection();
  }

  function onCropMouseUp() {
    dragState = null;
  }

  function setupCropListeners() {
    editorArea.addEventListener('mousedown', onCropMouseDown);
    document.addEventListener('mousemove', onCropMouseMove);
    document.addEventListener('mouseup', onCropMouseUp);
  }

  function removeCropListeners() {
    editorArea.removeEventListener('mousedown', onCropMouseDown);
    document.removeEventListener('mousemove', onCropMouseMove);
    document.removeEventListener('mouseup', onCropMouseUp);
  }

  // ---- Downloads ----
  document.getElementById('downloadPng').addEventListener('click', async () => {
    const result = await renderToBlob('image/png');
    if (result.blob) {
      // Single canvas — download directly
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement('a');
      link.download = `fullsnap-${Date.now()}.png`;
      link.href = url;
      link.click();
      URL.revokeObjectURL(url);
    } else {
      // Too tall for one canvas — download each tile as a separate PNG
      for (let i = 0; i < tiles.length; i++) {
        const blob = await new Promise(r => tiles[i].canvas.toBlob(r, 'image/png'));
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = `fullsnap-${Date.now()}-part${i + 1}.png`;
        link.href = url;
        link.click();
        URL.revokeObjectURL(url);
      }
    }
  });

  document.getElementById('downloadPdf').addEventListener('click', () => {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');

    const pageWidth = 210;
    const pageHeight = 297;
    const margin = 10;
    const contentWidth = pageWidth - 2 * margin;
    const contentHeight = pageHeight - 2 * margin;

    const pxPerMm = fullWidth / contentWidth;
    const pxPerPage = contentHeight * pxPerMm;

    let remainingHeight = fullHeight;
    let sourceY = 0;
    let pageNum = 0;

    while (remainingHeight > 0) {
      if (pageNum > 0) pdf.addPage();

      const sliceH = Math.min(pxPerPage, remainingHeight);

      // Render this slice from tiles into a temp canvas
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = fullWidth;
      tempCanvas.height = Math.min(sliceH, MAX_TILE_HEIGHT);
      const tempCtx = tempCanvas.getContext('2d');

      const sliceTop = sourceY;
      const sliceBottom = sourceY + sliceH;

      for (const tile of tiles) {
        const tileTop = tile.y;
        const tileBottom = tile.y + tile.canvas.height;

        if (tileBottom <= sliceTop || tileTop >= sliceBottom) continue;

        const overlapTop = Math.max(sliceTop, tileTop);
        const overlapBottom = Math.min(sliceBottom, tileBottom);
        const srcY = overlapTop - tileTop;
        const srcH = overlapBottom - overlapTop;
        const destY = overlapTop - sliceTop;

        tempCtx.drawImage(tile.canvas, 0, srcY, fullWidth, srcH, 0, destY, fullWidth, srcH);
      }

      const sliceData = tempCanvas.toDataURL('image/jpeg', 0.92);
      const sliceMmH = (sliceH / fullWidth) * contentWidth;
      pdf.addImage(sliceData, 'JPEG', margin, margin, contentWidth, sliceMmH);

      sourceY += sliceH;
      remainingHeight -= sliceH;
      pageNum++;
    }

    pdf.save(`fullsnap-${Date.now()}.pdf`);
  });

  // ---- Copy to Clipboard ----
  document.getElementById('copyBtn').addEventListener('click', async () => {
    try {
      const result = await renderToBlob('image/png');
      let blob = result.blob;
      if (!blob) {
        // Too tall — copy just the first tile with a note
        blob = await new Promise(r => tiles[0].canvas.toBlob(r, 'image/png'));
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);

      const btn = document.getElementById('copyBtn');
      const originalText = btn.innerHTML;
      btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
      setTimeout(() => { btn.innerHTML = originalText; }, 2000);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  });
})();
