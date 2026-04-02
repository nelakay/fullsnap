chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startCapture') {
    handleCapture(sender.tab.id, message.pageInfo).then(() => {
      sendResponse({ done: true });
    });
    return true;
  }
});

async function handleCapture(tabId, pageInfo) {
  const { viewportHeight, viewportWidth, dpr } = pageInfo;

  // Scroll to top first
  await scrollTab(tabId, 0);
  await sleep(300);

  // Hide fixed/sticky elements BEFORE any captures to ensure consistent layout
  await chrome.scripting.executeScript({
    target: { tabId },
    func: hideFixedElements
  });
  await sleep(300);

  // Capture first viewport
  const first = await captureTab();
  const segmentKeys = ['segment_0'];
  await chrome.storage.local.set({ segment_0: { dataUrl: first, y: 0 } });
  let segmentCount = 1;

  // Scroll-until-stuck: keep scrolling by viewport height until we can't go further
  let previousScrollY = 0;
  let targetScrollY = viewportHeight;

  while (true) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (targetY) => { window.scrollTo(0, targetY); return window.scrollY; },
      args: [targetScrollY]
    });
    const actualY = result.result;

    // If we didn't move at all, we've hit the bottom
    if (actualY <= previousScrollY) break;

    await sleep(400);
    const capture = await captureTab();

    const key = `segment_${segmentCount}`;
    segmentKeys.push(key);
    await chrome.storage.local.set({ [key]: { dataUrl: capture, y: actualY } });
    segmentCount++;

    previousScrollY = actualY;
    targetScrollY = actualY + viewportHeight;
  }

  // Get the final full height after all dynamic content has loaded
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
    await sleep(400);
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

function captureTab() {
  return new Promise((resolve) => {
    chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
      resolve(dataUrl);
    });
  });
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
