// Clicking the extension icon directly starts capture (no popup)
chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') ||
        tab.url.startsWith('https://chromewebstore.google.com') || tab.url.startsWith('about:')) {
      return;
    }

    // Gather page info directly via scripting
    const [pageInfoResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        dpr: window.devicePixelRatio || 1,
        originalScrollX: window.scrollX,
        originalScrollY: window.scrollY
      })
    });

    await handleCapture(tab.id, pageInfoResult.result);
  } catch (err) {
    console.error('FullSnap capture failed:', err);
  }
});

async function handleCapture(tabId, pageInfo) {
  const { viewportHeight, viewportWidth, dpr } = pageInfo;

  // Clear any stale data from previous captures
  const oldData = await chrome.storage.local.get('captureMetadata');
  if (oldData.captureMetadata) {
    await chrome.storage.local.remove([...oldData.captureMetadata.segmentKeys, 'captureMetadata']);
  }

  // Scroll to top first
  await scrollTab(tabId, 0);
  await sleep(500);

  // Hide fixed/sticky elements BEFORE any captures
  await chrome.scripting.executeScript({
    target: { tabId },
    func: hideFixedElements
  });
  await sleep(500);

  // Capture first viewport
  const first = await captureTab();
  const segmentKeys = ['segment_0'];
  await chrome.storage.local.set({ segment_0: { dataUrl: first, y: 0 } });
  let segmentCount = 1;

  // Scroll-until-stuck
  let previousScrollY = 0;
  let targetScrollY = viewportHeight;

  while (true) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (targetY) => { window.scrollTo(0, targetY); return window.scrollY; },
      args: [targetScrollY]
    });
    const actualY = result.result;

    if (actualY <= previousScrollY) break;

    await sleep(600);
    const capture = await captureTab();

    const key = `segment_${segmentCount}`;
    segmentKeys.push(key);
    await chrome.storage.local.set({ [key]: { dataUrl: capture, y: actualY } });
    segmentCount++;

    previousScrollY = actualY;
    targetScrollY = actualY + viewportHeight;
  }

  // Get the final full height
  const [heightResult] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => Math.max(
      document.body.scrollHeight,
      document.body.offsetHeight,
      document.documentElement.scrollHeight,
      document.documentElement.offsetHeight
    )
  });
  const fullHeight = heightResult.result;

  // Make sure we captured the very bottom viewport
  const maxScrollY = fullHeight - viewportHeight;
  const lastSegmentData = await chrome.storage.local.get(segmentKeys[segmentKeys.length - 1]);
  const lastCapturedY = lastSegmentData[segmentKeys[segmentKeys.length - 1]].y;

  if (maxScrollY - lastCapturedY > 2) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (targetY) => { window.scrollTo(0, targetY); return window.scrollY; },
      args: [maxScrollY]
    });
    await sleep(600);
    const capture = await captureTab();

    const key = `segment_${segmentCount}`;
    segmentKeys.push(key);
    await chrome.storage.local.set({ [key]: { dataUrl: capture, y: result.result } });
    segmentCount++;
  }

  // Restore fixed elements and original scroll
  await chrome.scripting.executeScript({
    target: { tabId },
    func: restoreFixedElements
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (x, y) => window.scrollTo(x, y),
    args: [pageInfo.originalScrollX, pageInfo.originalScrollY]
  });

  // Store metadata
  await chrome.storage.local.set({
    captureMetadata: {
      segmentKeys,
      fullHeight,
      viewportHeight,
      viewportWidth,
      dpr
    }
  });

  chrome.tabs.create({ url: chrome.runtime.getURL('editor.html') });
}

async function captureTab() {
  // Retry with backoff to handle MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
      return dataUrl;
    } catch (err) {
      if (err.message && err.message.includes('MAX_CAPTURE') && attempt < 4) {
        await sleep(1000);
        continue;
      }
      throw err;
    }
  }
}

function scrollTab(tabId, y) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: (targetY) => window.scrollTo(0, targetY),
    args: [y]
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hideFixedElements() {
  const stored = [];
  document.querySelectorAll('*').forEach(el => {
    const style = getComputedStyle(el);
    if (style.position === 'fixed' || style.position === 'sticky') {
      stored.push({ el, orig: el.style.display });
      el.style.setProperty('display', 'none', 'important');
    }
  });
  window.__fullsnap_fixed = stored;
}

function restoreFixedElements() {
  if (window.__fullsnap_fixed) {
    for (const { el, orig } of window.__fullsnap_fixed) {
      el.style.display = orig;
    }
    delete window.__fullsnap_fixed;
  }
}
