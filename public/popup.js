// Popup script
document.addEventListener('DOMContentLoaded', async () => {
  const statusDiv = document.getElementById('status');
  const statusText = document.getElementById('status-text');
  const requestCount = document.getElementById('request-count');
  
  // Get settings
  const settings = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, resolve);
  });
  
  // Check server connection using settings
  const serverUrls = [settings.serverUrl, `http://localhost:${settings.serverPort}`, `http://127.0.0.1:${settings.serverPort}`];
  let connected = false;
  
  for (const url of serverUrls) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) {
        connected = true;
        statusDiv.className = 'status connected';
        statusText.textContent = 'Server connected and ready';
        break;
      }
    } catch (error) {
      // Try next URL
    }
  }
  
  if (!connected) {
    statusDiv.className = 'status disconnected';
    statusText.textContent = `Server disconnected - Please start the local server on port ${settings.serverPort}`;
  }
  
  // Get request count
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    chrome.runtime.sendMessage(
      { type: 'GET_ALL_REQUESTS' },
      (response) => {
        if (response && response.requests) {
          const count = response.requests.length;
          requestCount.textContent = count === 0 
            ? 'No requests captured' 
            : `${count} request${count === 1 ? '' : 's'} captured`;
        }
      }
    );
  });
  
  // Open sidebar button
  document.getElementById('open-sidebar').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'TOGGLE_SIDEBAR'
      });
      window.close();
    });
  });
  
  // Clear logs button
  document.getElementById('clear-logs').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_REQUESTS' });
    requestCount.textContent = 'No requests captured';
  });
  
  // Settings button
  document.getElementById('open-settings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
});