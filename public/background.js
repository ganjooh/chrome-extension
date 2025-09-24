// Import settings manager (loaded via importScripts for service worker)
importScripts('./settings.js');

// Background service worker for intercepting network requests
const requestIdStore = new Map();
const completedRequestIds = new Set(); // IDs that returned >0 events
let currentSettings = null;

// Load settings on startup
async function initializeSettings() {
  currentSettings = await SettingsManager.getSettings();
  
  // Listen for settings changes
  SettingsManager.addListener((newSettings) => {
    currentSettings = newSettings;
    if (currentSettings.enableDebug) {
      console.log('[CWLV] Settings updated:', newSettings);
    }
  });
}

// Initialize settings
initializeSettings();

// Debug logging helper
function debugLog(...args) {
  if (currentSettings?.enableDebug) {
    console.log('[CWLV]', ...args);
  }
}

// Extract request ID from headers based on settings
function getRequestIdFromHeaders(headers, headerName) {
  if (!headers) return null;
  const h = headers.find(h => h.name && h.name.toLowerCase() === headerName.toLowerCase());
  return h ? h.value : null;
}

function safeSendToTab(tabId, message) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  try {
    chrome.tabs.sendMessage(tabId, message, () => {
      // Ignore missing receiver errors
      if (chrome.runtime.lastError) {
        debugLog('sendMessage warning:', chrome.runtime.lastError.message);
      }
    });
  } catch (e) {
    debugLog('sendMessage exception:', e?.message);
  }
}

// Common handler once a requestId is discovered
async function handleDiscoveredRequestId({ requestId, url, method = 'GET', tabId }) {
  const settings = await SettingsManager.getSettings();
  
  console.log('[CWLV] handleDiscoveredRequestId:', { requestId, url, method, tabId });
  
  // Check if we should monitor this URL
  if (!SettingsManager.shouldMonitorUrl(url, settings)) {
    console.log('[CWLV] URL not monitored:', url);
    return;
  }
  
  console.log('[CWLV] URL is monitored, storing request');
  const info = { requestId, url, method, timestamp: Date.now(), tabId };
  requestIdStore.set(requestId, info);

  // Notify content script
  if (tabId >= 0) {
    console.log('[CWLV] Notifying content script');
    safeSendToTab(tabId, { type: 'NEW_REQUEST', data: info });
    
    // Check if this is the FIRST request (to enable buttons)
    const isFirstRequest = requestIdStore.size === 1 || completedRequestIds.size === 0;
    console.log('[CWLV] Is first request?', isFirstRequest, 'Completed requests:', completedRequestIds.size);
    
    // ALWAYS try to fetch the first request to enable buttons
    if (isFirstRequest) {
      console.log('[CWLV] First request detected - will fetch to enable buttons');
      try {
        const entry = perTabQueues.get(tabId);
        const canQueue = !entry || (!entry.running && entry.queue.length === 0);
        if (canQueue) {
          console.log('[CWLV] Starting fetch to enable buttons for:', requestId);
          enqueueRequestForTab(tabId, requestId, url);
        }
      } catch (e) {
        console.error('[CWLV] Error queuing first request:', e);
      }
    } 
    // For subsequent requests, only fetch if auto-fetch is enabled
    else if (settings.autoFetch) {
      console.log('[CWLV] Auto-fetch enabled for subsequent request');
      try {
        const entry = perTabQueues.get(tabId);
        const canAuto = !entry || (!entry.running && entry.queue.length === 0);
        if (canAuto) {
          console.log('[CWLV] Auto-fetching:', requestId);
          enqueueRequestForTab(tabId, requestId, url);
        }
      } catch (e) {
        console.error('[CWLV] Auto-fetch error:', e);
      }
    } else {
      console.log('[CWLV] Auto-fetch disabled - will not fetch subsequent requests');
    }
  } else {
    console.log('[CWLV] Invalid tabId:', tabId);
  }
}

// 1) Listen for outgoing requests (if client supplies request ID)
chrome.webRequest.onBeforeSendHeaders.addListener(
  async (details) => {
    const settings = await SettingsManager.getSettings();
    console.log('[CWLV] onBeforeSendHeaders:', { url: details.url, type: details.type, tabId: details.tabId });
    
    if (!(details.type === 'xmlhttprequest' || details.type === 'fetch')) return;
    
    const requestId = getRequestIdFromHeaders(details.requestHeaders, settings.requestHeader);
    console.log('[CWLV] Looking for request ID in request headers:', {
      url: details.url,
      headerName: settings.requestHeader,
      found: !!requestId,
      requestId
    });
    if (requestId) {
      handleDiscoveredRequestId({
        requestId,
        url: details.url,
        method: details.method,
        tabId: details.tabId,
      });
    }
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders']
);

// 2) Also listen for responses (common: server sets request ID in response)
chrome.webRequest.onHeadersReceived.addListener(
  async (details) => {
    const settings = await SettingsManager.getSettings();
    console.log('[CWLV] onHeadersReceived:', { url: details.url, type: details.type, tabId: details.tabId });
    
    if (!(details.type === 'xmlhttprequest' || details.type === 'fetch')) return;
    
    const requestId = getRequestIdFromHeaders(details.responseHeaders, settings.requestHeader);
    console.log('[CWLV] Looking for request ID in response headers:', {
      url: details.url,
      headerName: settings.requestHeader,
      found: !!requestId,
      requestId,
      headers: (details.responseHeaders || []).map(h => h.name)
    });
    
    if (requestId) {
      handleDiscoveredRequestId({
        requestId,
        url: details.url,
        tabId: details.tabId,
      });
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders', 'extraHeaders']
);

// Fetch logs from local server
// Per-tab sequential queues
const perTabQueues = new Map(); // tabId -> { queue: Array<{requestId:string,url:string}>, running: boolean, inQueue:Set<string> }

async function fetchLogsForRequest(requestId, tabId, urlForGuess, attempt = 0) {
  console.log('[CWLV] fetchLogsForRequest called:', { requestId, tabId, urlForGuess, attempt });
  const settings = await SettingsManager.getSettings();
  
  try {
    const guessedGroups = SettingsManager.guessLogGroups(urlForGuess, settings);
    console.log('[CWLV] Guessed log groups:', guessedGroups);
    
    const requestBody = {
      requestIds: [requestId],
      logGroups: guessedGroups,
      timeRange: {
        start: Date.now() - (settings.timeRange * 3600000),
        end: Date.now()
      },
      awsProfile: settings.awsProfile,
      awsRegion: settings.awsRegion
    };
    
    console.log('[CWLV] Request body for server:', requestBody);
    
    const serverUrls = SettingsManager.getServerUrls(settings);
    console.log('[CWLV] Server URLs:', serverUrls);
    let response;
    let lastErr;
    
    for (const base of serverUrls) {
      try {
        console.log('[CWLV] Trying server:', base);
        response = await fetch(`${base}/api/logs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });
        console.log('[CWLV] Server response:', { url: base, ok: response?.ok, status: response?.status });
        if (response && response.ok) {
          console.log('[CWLV] Server responded successfully at', base);
          break;
        }
      } catch (e) {
        lastErr = e;
        console.error('[CWLV] Fetch to', base, 'failed:', e);
      }
    }
    
    if (!response) {
      throw lastErr || new Error('No server response');
    }
    
    console.log('[CWLV] Final response status:', response?.status);
    
    if (response.ok) {
      const logs = await response.json();
      const count = logs.events?.length || 0;
      console.log('[CWLV] Received logs:', { requestId, count, hasEvents: count > 0 });

      // Send logs to content script
      safeSendToTab(tabId, {
        type: 'LOGS_RECEIVED',
        data: {
          requestId,
          logs: logs.events || [],
          sqlLogs: logs.sql || [],
          completed: count > 0
        }
      });
      
      // Send completion notification to enable buttons
      if (count > 0) {
        safeSendToTab(tabId, {
          type: 'FETCH_COMPLETE',
          requestId: requestId
        });
      }
      
      if (count > 0) {
        completedRequestIds.add(requestId);
      }
      return { ok: true, count };
    } else {
      const errorText = await response.text();
      console.error('Server error response:', errorText);
      throw new Error(`Server returned ${response.status}: ${errorText}`);
    }
  } catch (error) {
    console.error('Failed to fetch logs:', error);
    
    // Notify content script of error
    safeSendToTab(tabId, {
      type: 'LOGS_ERROR',
      data: {
        requestId,
        error: error.message
      }
    });
    return { ok: false, error: error.message };
  }
}

async function enqueueRequestForTab(tabId, requestId, url) {
  console.log('[CWLV] enqueueRequestForTab called:', { tabId, requestId, url });
  const settings = await SettingsManager.getSettings();
  const backoffDelays = SettingsManager.getBackoffDelays(settings);
  console.log('[CWLV] Backoff delays:', backoffDelays);
  
  let entry = perTabQueues.get(tabId);
  if (!entry) {
    entry = { queue: [], running: false, inQueue: new Set() };
    perTabQueues.set(tabId, entry);
    console.log('[CWLV] Created new queue for tab:', tabId);
  }
  
  if (entry.inQueue.has(requestId)) {
    console.log('[CWLV] Request already in queue:', requestId);
    return; // dedupe
  }
  entry.inQueue.add(requestId);
  entry.queue.push({ requestId, url });
  console.log('[CWLV] Added to queue. Queue length:', entry.queue.length);
  
  if (!entry.running) {
    console.log('[CWLV] Starting queue processing');
    entry.running = true;
    (async () => {
      while (entry.queue.length > 0) {
        const item = entry.queue[0];
        console.log('[CWLV] Processing queue item:', item);
        // sequential backoff attempts for this request ID
        const isFirstRequest = completedRequestIds.size === 0;
        
        for (let attempt = 0; attempt < backoffDelays.length; attempt++) {
          const delay = backoffDelays[attempt];
          
          // Notify content script about the countdown
          try {
            chrome.tabs.sendMessage(tabId, {
              type: 'RETRY_SCHEDULED',
              requestId: item.requestId,
              delayMs: delay,
              attempt: attempt,
              isFirstRequest: isFirstRequest  // Tell content script this is for button enabling
            });
          } catch (e) {
            console.error('Failed to send retry notification:', e);
          }
          
          await new Promise(r => setTimeout(r, delay));
          console.log('[CWLV] Fetching logs attempt', attempt + 1, 'of', backoffDelays.length, 'for', item.requestId);
          const result = await fetchLogsForRequest(item.requestId, tabId, item.url, attempt);
          console.log('[CWLV] Fetch result:', result);
          
          if (!result || !result.ok) {
            // stop on error
            console.log('[CWLV] Fetch failed with error, stopping retries');
            break;
          }
          if ((result.count || 0) > 0) {
            // found logs; stop further attempts
            console.log('[CWLV] Found', result.count, 'logs - buttons will be enabled!');
            break;
          } else {
            console.log('[CWLV] No logs found yet, will retry...');
          }
        }
        entry.queue.shift();
        entry.inQueue.delete(item.requestId);
      }
      entry.running = false;
    })();
  }
}

// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'FETCH_LOGS') {
    // Manual fetch: use the same retry queue mechanism
    const tabId = sender.tab?.id;
    if (tabId) {
      enqueueRequestForTab(tabId, request.requestId, request.url || '');
    }
    sendResponse({ status: 'started' });
  } else if (request.type === 'CWLV_REQUEST_ID') {
    // Request ID discovered from content-script network interceptors
    const tabId = sender?.tab?.id ?? -1;
    console.log('[CWLV] CWLV_REQUEST_ID received from content script:', {
      requestId: request.requestId,
      url: request.url,
      tabId: tabId,
      senderTab: sender?.tab
    });
    handleDiscoveredRequestId({
      requestId: request.requestId,
      url: request.url || '',
      tabId: tabId,
    });
  } else if (request.type === 'RESET_COMPLETED') {
    const rid = request.requestId;
    if (rid) {
      completedRequestIds.delete(rid);
      sendResponse?.({ status: 'reset', requestId: rid });
    } else {
      sendResponse?.({ status: 'error', error: 'No requestId' });
    }
  } else if (request.type === 'GET_ALL_REQUESTS') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ requests: [] });
      return;
    }
    const requests = Array.from(requestIdStore.values())
      .filter(req => req.tabId === tabId)
      .sort((a, b) => b.timestamp - a.timestamp);
    sendResponse({ requests });
  } else if (request.type === 'CLEAR_REQUESTS') {
    // Clear requests for specific tab
    const tabId = sender.tab?.id;
    if (!tabId) return;
    for (const [key, value] of requestIdStore.entries()) {
      if (value.tabId === tabId) {
        requestIdStore.delete(key);
      }
    }
    sendResponse({ status: 'cleared' });
  } else if (request.type === 'RELOAD_SETTINGS') {
    // Reload settings
    initializeSettings().then(() => {
      sendResponse({ status: 'reloaded' });
    });
    return true; // Keep message channel open for async response
  } else if (request.type === 'GET_SETTINGS') {
    // Return current settings
    SettingsManager.getSettings().then(settings => {
      sendResponse(settings);
    });
    return true; // Keep message channel open for async response
  } else if (request.type === 'CHECK_SERVER_HEALTH') {
    // Check server health - background script can make HTTP requests to any origin
    SettingsManager.getSettings().then(settings => {
      const serverUrl = settings.serverUrl || 'http://13.203.150.222:8090';
      fetch(`${serverUrl}/health`)
        .then(response => response.json())
        .then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false }));
    });
    return true; // Keep message channel open for async response
  }

  return true; // Keep message channel open for async response
});

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  // Remove stored requests for closed tab
  for (const [key, value] of requestIdStore.entries()) {
    if (value.tabId === tabId) {
      requestIdStore.delete(key);
    }
  }
  // Clean up queue for closed tab
  perTabQueues.delete(tabId);
});

// Clear data on navigation (page reload or URL change)
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) { // Main frame only
    debugLog('Navigation detected, clearing data for tab:', details.tabId);
    
    // Clear stored requests for this tab
    for (const [key, value] of requestIdStore.entries()) {
      if (value.tabId === details.tabId) {
        requestIdStore.delete(key);
      }
    }
    
    // Clear any running queues
    perTabQueues.delete(details.tabId);
    
    // Notify content script to reset
    safeSendToTab(details.tabId, { type: 'NAVIGATION_RESET' });
  }
});

// Initialize connection check
chrome.runtime.onInstalled.addListener(async () => {
  console.log('CloudWatch Logs Viewer extension installed');
  
  const settings = await SettingsManager.getSettings();
  const serverUrls = SettingsManager.getServerUrls(settings);
  
  // Check if local server is running
  for (const base of serverUrls) {
    try {
      const resp = await fetch(`${base}/health`);
      if (resp.ok) {
        console.log('Connected to local server at', base);
        return;
      }
    } catch (_) {}
  }
  console.warn(`Local server not running. Please start it on port ${settings.serverPort}`);
});

// Also check on browser startup
chrome.runtime.onStartup?.addListener(async () => {
  const settings = await SettingsManager.getSettings();
  const serverUrls = SettingsManager.getServerUrls(settings);
  
  for (const base of serverUrls) {
    try {
      const resp = await fetch(`${base}/health`);
      if (resp.ok) {
        console.log('Connected to local server at', base);
        return;
      }
    } catch (_) {}
  }
  console.warn(`Local server not running. Please start it on port ${settings.serverPort}`);
});