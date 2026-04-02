(() => {
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const editorArea = document.getElementById('editorArea');
  const cropOverlay = document.getElementById('cropOverlay');
  const cropSelection = document.getElementById('cropSelection');
  const dimensionsEl = document.getElementById('dimensions');
  const zoomLevelEl = document.getElementById('zoomLevel');

  let originalImage = null;
  let isCropping = false;
  let zoom = 1; // 1 = full width of editor area

  let crop = { x: 0, y: 0, w: 0, h: 0 }; // in displayed px relative to canvas
  let dragState = null;

  // ---- Zoom ----
  // zoom=1 means the canvas display width fills the editor area width.
  function applyZoom() {
    const areaWidth = editorArea.clientWidth - 40; // minus padding
    const displayWidth = areaWidth * zoom;
    const aspect = canvas.height / canvas.width;
    const displayHeight = displayWidth * aspect;
    canvas.style.width = displayWidth + 'px';
    canvas.style.height = displayHeight + 'px';
    zoomLevelEl.textContent = Math.round(zoom * 100) + '%';
  }

  function setZoom(newZoom) {
    zoom = Math.max(0.1, Math.min(5, newZoom));
    applyZoom();
  }

  document.getElementById('zoomIn').addEventListener('click', () => setZoom(zoom + 0.1));
  document.getElementById('zoomOut').addEventListener('click', () => setZoom(zoom - 0.1));
  document.getElementById('zoomFit').addEventListener('click', () => setZoom(1));

  // Reapply zoom on window resize
  window.addEventListener('resize', () => { if (!isCropping) applyZoom(); });

  // ---- Load & Stitch ----
  async function loadAndStitch() {
    const { captureMetadata } = await chrome.storage.local.get('captureMetadata');
    if (!captureMetadata) return;

    const { segmentKeys, fullHeight, viewportWidth, dpr } = captureMetadata;
    const canvasWidth = viewportWidth * dpr;
    const canvasHeight = fullHeight * dpr;

    const MAX_CANVAS_DIM = 32767;
    if (canvasHeight > MAX_CANVAS_DIM) {
      document.body.innerHTML = '<p style="color:#fff;padding:40px;">Page is too tall to capture. Try a shorter page.</p>';
      return;
    }

    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    const segments = [];
    for (const key of segmentKeys) {
      const data = await chrome.storage.local.get(key);
      const segment = data[key];
      if (!segment) continue;
      const img = await loadImage(segment.dataUrl);
      segments.push({ img, y: segment.y * dpr });
    }

    if (segments.length > 0) {
      ctx.drawImage(segments[0].img, 0, 0);
    }

    for (let i = 1; i < segments.length; i++) {
      const prev = segments[i - 1];
      const curr = segments[i];
      const prevBottom = prev.y + prev.img.height;
      const overlap = Math.max(0, prevBottom - curr.y);
      if (overlap >= curr.img.height) continue;
      const srcY = overlap;
      const srcH = curr.img.height - overlap;
      const destY = curr.y + overlap;
      const drawH = Math.min(srcH, canvasHeight - destY);
      if (drawH <= 0) continue;
      ctx.drawImage(curr.img, 0, srcY, curr.img.width, drawH, 0, destY, curr.img.width, drawH);
    }

    const finalImg = new Image();
    finalImg.onload = () => {
      originalImage = finalImg;
      updateDimensions();
      setZoom(1); // 100% = full width
    };
    finalImg.src = canvas.toDataURL('image/png');

    await chrome.storage.local.remove([...segmentKeys, 'captureMetadata']);
  }

  loadAndStitch();

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function updateDimensions() {
    dimensionsEl.textContent = `${canvas.width} x ${canvas.height}`;
  }

  // ---- Helpers to get canvas display rect ----
  function getCanvasDisplaySize() {
    const rect = canvas.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }

  function getCanvasOffset() {
    const canvasRect = canvas.getBoundingClientRect();
    const areaRect = editorArea.getBoundingClientRect();
    return {
      x: canvasRect.left - areaRect.left + editorArea.scrollLeft,
      y: canvasRect.top - areaRect.top + editorArea.scrollTop
    };
  }

  // ---- Crop Mode ----
  document.getElementById('cropBtn').addEventListener('click', () => {
    if (isCropping) return;
    enterCropMode();
  });

  document.getElementById('resetCropBtn').addEventListener('click', () => {
    if (!originalImage) return;
    canvas.width = originalImage.width;
    canvas.height = originalImage.height;
    ctx.drawImage(originalImage, 0, 0);
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

    // Start with full image selected
    const display = getCanvasDisplaySize();
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
    const display = getCanvasDisplaySize();
    const scaleX = canvas.width / display.width;
    const scaleY = canvas.height / display.height;

    const sx = Math.round(crop.x * scaleX);
    const sy = Math.round(crop.y * scaleY);
    const sw = Math.round(crop.w * scaleX);
    const sh = Math.round(crop.h * scaleY);

    if (sw < 1 || sh < 1) return;

    const imageData = ctx.getImageData(sx, sy, sw, sh);
    canvas.width = sw;
    canvas.height = sh;
    ctx.putImageData(imageData, 0, 0);
    updateDimensions();
    applyZoom();

    document.getElementById('resetCropBtn').style.display = 'flex';
    exitCropMode();
  }

  function updateCropSelection() {
    const offset = getCanvasOffset();
    cropSelection.style.left = (offset.x + crop.x) + 'px';
    cropSelection.style.top = (offset.y + crop.y) + 'px';
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
    const display = getCanvasDisplaySize();

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
  document.getElementById('downloadPng').addEventListener('click', () => {
    const link = document.createElement('a');
    link.download = `fullsnap-${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  });

  document.getElementById('downloadPdf').addEventListener('click', () => {
    const imgData = canvas.toDataURL('image/jpeg', 0.95);
    const imgWidth = canvas.width;
    const imgHeight = canvas.height;

    const pageWidth = 210;
    const pageHeight = 297;
    const margin = 10;
    const contentWidth = pageWidth - 2 * margin;
    const contentHeight = pageHeight - 2 * margin;

    const scale = contentWidth / imgWidth;
    const scaledHeight = imgHeight * scale;
    const { jsPDF } = window.jspdf;

    if (scaledHeight <= contentHeight) {
      const pdf = new jsPDF('p', 'mm', 'a4');
      pdf.addImage(imgData, 'JPEG', margin, margin, contentWidth, scaledHeight);
      pdf.save(`fullsnap-${Date.now()}.pdf`);
    } else {
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pixelsPerPage = contentHeight / scale;
      let remainingHeight = imgHeight;
      let sourceY = 0;
      let pageNum = 0;

      while (remainingHeight > 0) {
        if (pageNum > 0) pdf.addPage();
        const sliceHeight = Math.min(pixelsPerPage, remainingHeight);
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = imgWidth;
        tempCanvas.height = sliceHeight;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(canvas, 0, sourceY, imgWidth, sliceHeight, 0, 0, imgWidth, sliceHeight);
        const sliceData = tempCanvas.toDataURL('image/jpeg', 0.95);
        const sliceScaledHeight = sliceHeight * scale;
        pdf.addImage(sliceData, 'JPEG', margin, margin, contentWidth, sliceScaledHeight);
        sourceY += sliceHeight;
        remainingHeight -= sliceHeight;
        pageNum++;
      }

      pdf.save(`fullsnap-${Date.now()}.pdf`);
    }
  });

  // ---- Copy to Clipboard ----
  document.getElementById('copyBtn').addEventListener('click', async () => {
    try {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
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
