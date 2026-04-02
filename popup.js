document.getElementById('captureBtn').addEventListener('click', async () => {
  const btn = document.getElementById('captureBtn');
  const status = document.getElementById('status');

  btn.disabled = true;
  status.textContent = 'Capturing...';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') ||
        tab.url.startsWith('https://chromewebstore.google.com')) {
      status.textContent = 'Cannot capture this page.';
      btn.disabled = false;
      return;
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });

    // Close popup - the editor will open in a new tab
    window.close();
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
    btn.disabled = false;
  }
});
