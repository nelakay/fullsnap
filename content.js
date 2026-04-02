// Content script gathers page info and tells background to start capture
(() => {
  const pageInfo = {
    viewportHeight: window.innerHeight,
    viewportWidth: window.innerWidth,
    dpr: window.devicePixelRatio || 1,
    originalScrollX: window.scrollX,
    originalScrollY: window.scrollY
  };

  chrome.runtime.sendMessage({ action: 'startCapture', pageInfo });
})();
