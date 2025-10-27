// Content script for injecting sidebar UI
(() => {
  try { console.log('[CWLV] content script loaded'); } catch (e) {}
  let sidebarVisible = false;
  let activeTab = 'requests'; // Only 'requests' tab now
  let logsData = new Map(); // requestId -> raw events
  let sqlLogsData = new Map(); // requestId -> sql-only events
  const requestInfoMap = new Map(); // requestId -> { url, method }
  let completedSet = new Set();
  // Track which requests have been fetched at least once
  let fetchedSet = new Set();
  // TTFL (Time To First Log) timers/state
  let ttflStart = null;
  let ttflRecorded = null;
  let ttflTimerId = null;
  let sidebar = null;
  const SQL_EXCLUDE_TABLES = ['ahoy_visits', 'flipper_features', 'jwt_deny_list'];
  // Track retry status for each request
  const retryStatus = new Map(); // requestId -> { attempt, nextRetryTime, intervalId }

  // Install interceptors to extract X-Request-Id reliably
  function installNetworkInterceptors() {
    try {
      // Intercept fetch
      const originalFetch = window.fetch;
      window.fetch = async function(...args) {
        const url = args[0]?.url || args[0];
        console.log('[CWLV] Fetch intercepted:', url);
        const response = await originalFetch.apply(this, args);
        try {
          const cloned = response.clone();
          const reqId = cloned.headers?.get('x-request-id') || cloned.headers?.get('X-Request-Id');
          console.log('[CWLV] Response headers:', { url: cloned.url, requestId: reqId });
          if (reqId) {
            chrome.runtime.sendMessage({ type: 'CWLV_REQUEST_ID', requestId: reqId, url: cloned.url });
          } else {
            // Optional: try to read JSON body for a request id key
            const ct = cloned.headers?.get('content-type') || '';
            if (ct.includes('application/json')) {
              cloned.text().then(txt => {
                try {
                  const data = JSON.parse(txt);
                  const rid = data?.request_id || data?.requestId || data?.meta?.request_id || data?.meta?.requestId;
                  if (rid) {
                    console.log('[CWLV] Found request ID in body:', rid);
                    chrome.runtime.sendMessage({ type: 'CWLV_REQUEST_ID', requestId: rid, url: cloned.url });
                  }
                } catch (_) {}
              }).catch(() => {});
            }
          }
        } catch (e) { 
          console.error('[CWLV] Error processing response:', e);
        }
        return response;
      };

      // Intercept XMLHttpRequest
      const OriginalXHR = window.XMLHttpRequest;
      function WrappedXHR() {
        const xhr = new OriginalXHR();
        const origOpen = xhr.open;
        xhr.open = function(method, url, async, user, password) {
          this._cwlv_url = url;
          return origOpen.apply(this, arguments);
        };
        xhr.addEventListener('readystatechange', function() {
          if (this.readyState === 4) {
            try {
              const rid = this.getResponseHeader && (this.getResponseHeader('X-Request-Id') || this.getResponseHeader('x-request-id'));
              console.log('[CWLV] XHR response:', { url: this._cwlv_url, requestId: rid });
              if (rid) {
                chrome.runtime.sendMessage({ type: 'CWLV_REQUEST_ID', requestId: rid, url: this._cwlv_url });
              }
            } catch (e) {
              console.error('[CWLV] XHR error:', e);
            }
          }
        });
        return xhr;
      }
      window.XMLHttpRequest = WrappedXHR;
      console.log('[CWLV] Network interceptors installed successfully');
    } catch (e) {
      try { console.warn('[CWLV] failed to install interceptors', e); } catch (_) {}
    }
  }

  function extractTables(sqlText) {
    if (!sqlText || typeof sqlText !== 'string') return [];
    const s = sqlText;
    const found = new Set();
    const push = (name) => {
      if (!name) return;
      let n = name.trim();
      n = n.replace(/^[`"\[]/, '').replace(/[`"\]]$/, '');
      const last = n.split('.').pop() || n;
      found.add(last.toLowerCase());
    };
    let m;
    const insertRe = /\bINSERT\s+INTO\s+([`"\[]?[\w.]+[`"\]]?)/ig;
    while ((m = insertRe.exec(s)) !== null) push(m[1]);
    const updateRe = /\bUPDATE\s+([`"\[]?[\w.]+[`"\]]?)/ig;
    while ((m = updateRe.exec(s)) !== null) push(m[1]);
    const fromRe = /\bFROM\s+([`"\[]?[\w.]+[`"\]]?)/ig;
    while ((m = fromRe.exec(s)) !== null) push(m[1]);
    const joinRe = /\bJOIN\s+([`"\[]?[\w.]+[`"\]]?)/ig;
    while ((m = joinRe.exec(s)) !== null) push(m[1]);
    return Array.from(found);
  }

  function getSqlFilteredMap() {
    const filtered = new Map();
    const excludes = SQL_EXCLUDE_TABLES.map(t => t.toLowerCase());
    sqlLogsData.forEach((logs, requestId) => {
      const keep = logs.filter(log => {
        const meta = parseSqlMeta(stripAnsi(log.message));
        const sql = (meta.sql || stripAnsi(log.message));
        const tables = extractTables(sql);
        if (tables.length === 0) {
          const lower = sql.toLowerCase();
          return !excludes.some(x => lower.includes(x));
        }
        return !tables.some(t => excludes.some(x => t.includes(x)));
      });
      if (keep.length > 0) filtered.set(requestId, keep);
    });
    return filtered;
  }

  // renderReportingView removed - no longer needed

  function renderRequestsView(container) {
    // Helper to compute SQL stats per request
    function getSqlStats(requestId) {
      const logs = sqlLogsData.get(requestId) || [];
      let totalMs = 0;
      logs.forEach(log => {
        const meta = parseSqlMeta(stripAnsi(log.message));
        if (meta.execMs != null && isFinite(meta.execMs)) {
          totalMs += meta.execMs;
        }
      });
      return { count: logs.length, totalMs };
    }

    // Helper to filter reporting-relevant SQL logs
    function getReportingLogs(requestId) {
      const logs = sqlLogsData.get(requestId) || [];
      const out = [];
      logs.forEach(l => {
        const s = stripAnsi(l.message);
        const meta = parseSqlMeta(s);
        if ((meta.op || '').toUpperCase() !== 'SELECT') return;
        const sql = meta.sql || s;
        const tables = extractTables(sql);
        const kw = ['click', 'lead', 'call'];
        if (tables.some(t => kw.some(k => t.includes(k)))) out.push(l);
      });
      return out;
    }

    // List of captured requests with Fetch buttons and expandable details
    const requests = Array.from(requestInfoMap.entries()).map(([requestId, info]) => ({ requestId, info }));
    if (requests.length === 0) {
      container.innerHTML = '<div class="cw-logs-empty">No requests captured yet.</div>';
      return;
    }
    requests.sort((a, b) => 0);

    const list = document.createElement('div');
    list.className = 'cw-request-list';
    const anyCompleted = completedSet.size > 0;
    
    requests.forEach(({ requestId, info }) => {
      const endpoint = formatEndpoint(info);
      const fetched = fetchedSet.has(requestId);
      const completed = completedSet.has(requestId);
      const btnLabel = completed ? 'Refetch' : 'Fetch';
      const status = completed
        ? `<span class=\"cw-status-badge cw-completed\">Fetched</span>`
        : (!anyCompleted ? `<span class=\"cw-waiting\">Checking availability...</span>` : '');
      const { count: sqlCount, totalMs } = getSqlStats(requestId);
      const sqlSummary = sqlCount > 0 ? `<span class=\"cw-sql-summary\" title=\"Sum of SQL times\">SQL: ${sqlCount} • ${totalMs.toFixed(1)} ms</span>` : `<span class=\"cw-sql-summary\">No SQL</span>`;

      const row = document.createElement('div');
      row.className = 'cw-request-row';
      row.setAttribute('data-request-id', requestId);

      const header = document.createElement('div');
      header.className = 'cw-request-header';
      header.innerHTML = `
        <span class=\"cw-caret\">▶</span>
        <div class=\"cw-request-endpoint\" title=\"Request ID: ${requestId}\n${escapeHtml(info.url)}\">${escapeHtml(endpoint)}</div>
        ${sqlSummary}
        ${status}
        <button class=\"cw-request-fetch\" ${anyCompleted ? '' : 'disabled'} data-request-id=\"${requestId}\">${btnLabel}</button>
      `;

      // Details block
      const details = document.createElement('div');
      details.className = 'cw-request-details';

      // SQL section
      const sqlSection = document.createElement('div');
      sqlSection.className = 'cw-request-section';
      sqlSection.innerHTML = `<div class=\"cw-section-title\">SQL</div>`;
      const sqlLogs = sqlLogsData.get(requestId) || [];
      if (sqlLogs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'cw-section-empty';
        empty.textContent = (completed || anyCompleted) ? 'No SQL logs' : 'Waiting for SQL logs to load';
        sqlSection.appendChild(empty);
      } else {
        const content = document.createElement('div');
        content.className = 'cw-section-content';
        sqlLogs.forEach(l => content.appendChild(createSqlLogEntry(l)));
        sqlSection.appendChild(content);
      }

      // Reporting section
      const reportingSection = document.createElement('div');
      reportingSection.className = 'cw-request-section';
      reportingSection.innerHTML = `<div class=\"cw-section-title\">Reporting</div>`;
      const reportingLogs = getReportingLogs(requestId);
      if (reportingLogs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'cw-section-empty';
        empty.textContent = (completed || anyCompleted) ? 'No reporting logs' : 'Waiting for SQL logs to load';
        reportingSection.appendChild(empty);
      } else {
        const content = document.createElement('div');
        content.className = 'cw-section-content';
        reportingLogs.forEach(l => content.appendChild(createSqlLogEntry(l)));
        reportingSection.appendChild(content);
      }

      // Raw logs section
      const rawSection = document.createElement('div');
      rawSection.className = 'cw-request-section';
      rawSection.innerHTML = `<div class=\"cw-section-title\">Raw</div>`;
      const rawLogs = logsData.get(requestId) || [];
      if (rawLogs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'cw-section-empty';
        empty.textContent = (completed || anyCompleted) ? 'No raw logs' : 'Waiting for SQL logs to load';
        rawSection.appendChild(empty);
      } else {
        const content = document.createElement('div');
        content.className = 'cw-section-content';
        rawLogs.forEach(l => content.appendChild(createLogEntry(l)));
        rawSection.appendChild(content);
      }

      details.appendChild(sqlSection);
      details.appendChild(reportingSection);
      details.appendChild(rawSection);

      // Toggle expand/collapse
      header.addEventListener('click', (e) => {
        // Ignore clicks on Fetch button
        const target = e.target;
        if (target && target.classList && target.classList.contains('cw-request-fetch')) return;
        row.classList.toggle('expanded');
      });

      // Fetch button
      header.querySelector('.cw-request-fetch')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const rid = e.currentTarget.getAttribute('data-request-id');
        if (rid && !e.currentTarget.disabled) {
          updateStatus(`Fetching ${rid}...`);
          chrome.runtime.sendMessage({ type: 'FETCH_LOGS', requestId: rid });
        }
      });

      row.appendChild(header);
      row.appendChild(details);
      list.appendChild(row);
    });

    container.appendChild(list);
  }

  function determineReportingHighlight(s) {
    const l = s.toLowerCase();
    if (l.includes('click')) return 'cw-hl-clicks';
    if (l.includes('lead')) return 'cw-hl-leads';
    if (l.includes('call')) return 'cw-hl-calls';
    return '';
  }

  // Create and inject sidebar
  function createSidebar() {
    // Create sidebar container
    sidebar = document.createElement('div');
    sidebar.id = 'cloudwatch-logs-sidebar';
    sidebar.className = 'cw-logs-sidebar';
    
    // Create header
    const header = document.createElement('div');
    header.className = 'cw-logs-header';
    header.innerHTML = `
      <div class="cw-logs-title">
        <h3>SQL Logs</h3>
        <span id="cw-ttfl" class="cw-ttfl">TTFL: --</span>
        <span id="cw-progress" class="cw-progress">0 of 0</span>
      </div>
      <div class="cw-logs-controls">
        <button id="cw-logs-clear" title="Clear logs">🗑️</button>
        <button id="cw-logs-refresh" title="Refresh all">🔄</button>
        <button id="cw-logs-toggle" title="Toggle sidebar">✕</button>
      </div>
    `;
    
    // No tabs needed anymore - single view

    // Create clean single-row status bar
    const filters = document.createElement('div');
    filters.className = 'cw-logs-filters';
    filters.style.cssText = 'display:flex; align-items:center; gap:16px; padding:10px 16px; border-bottom:1px solid #333; background:#1a1a1a;';
    filters.innerHTML = `
      <input type="text" id="cw-logs-search" placeholder="Search SQL queries..." style="width:200px; padding:5px 8px; background:#2a2a2a; border:1px solid #444; border-radius:4px; color:#fff; font-size:12px;" />
      <div style="width:1px; height:20px; background:#444;"></div>
      <div id="cw-status-bar" style="flex:1; display:flex; align-items:center; gap:10px; font-size:12px;">
        <span id="cw-status-icon" style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#666; flex-shrink:0;"></span>
        <span id="cw-status-message" style="color:#ccc; flex-shrink:0;">Waiting for requests...</span>
        <span id="cw-status-detail" style="color:#888; margin-left:auto;"></span>
      </div>
    `;
    
    // Create logs container
    const logsContainer = document.createElement('div');
    logsContainer.id = 'cw-logs-container';
    logsContainer.className = 'cw-logs-container';
    
    // Status is now in the filters bar, no separate status bar needed
    
    // Assemble sidebar
    sidebar.appendChild(header);
    sidebar.appendChild(filters);
    sidebar.appendChild(logsContainer);
    
    // Add to page
    document.body.appendChild(sidebar);

    // Add event listeners
    attachEventListeners();

    // Check server health via background script (avoids Mixed Content issues on HTTPS pages)
    try {
      chrome.runtime.sendMessage({ type: 'CHECK_SERVER_HEALTH' }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[CWLV] Health check error:', chrome.runtime.lastError);
          updateStatus('Server not reachable');
        } else if (response && response.success) {
          updateStatus('Ready');
        } else {
          updateStatus('Server not reachable');
        }
      });
    } catch (e) {
      console.error('[CWLV] Health check exception:', e);
      updateStatus('Server not reachable');
    }

    // Sync any already captured requests for this tab
    try {
      chrome.runtime.sendMessage({ type: 'GET_ALL_REQUESTS' }, (response) => {
        if (response && Array.isArray(response.requests)) {
          response.requests.forEach(req => {
            if (!logsData.has(req.requestId)) {
              logsData.set(req.requestId, []);
            }
            requestInfoMap.set(req.requestId, { url: req.url, method: req.method });
          });
          updateLogsDisplay();
          if (response.requests.length > 0) startTTFLIfNeeded();
          updateProgressDisplay();
        }
      });
    } catch (_) {}

    return sidebar;
  }

  // Attach event listeners
  function attachEventListeners() {
    // No tab handlers needed anymore - removed all tab-related code
    // Toggle sidebar
    document.getElementById('cw-logs-toggle')?.addEventListener('click', toggleSidebar);
    
    // Clear logs
    document.getElementById('cw-logs-clear')?.addEventListener('click', clearLogs);
    
    // Refresh all logs (only for requests that already have logs)
    document.getElementById('cw-logs-refresh')?.addEventListener('click', () => {
      const hasAnyCompleted = Array.from(completedSet).length > 0;
      if (!hasAnyCompleted) {
        updateStatus('Waiting for SQL logs to load');
        return;
      }
      refreshAllLogs();
    });
    
    // Search functionality with debounce
    let searchTimeout;
    document.getElementById('cw-logs-search')?.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => filterLogs(), 150);
    });
    
    // Clear search on Escape key
    document.getElementById('cw-logs-search')?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.target.value = '';
        filterLogs();
        updateStatus('Ready', '', 'idle');
      }
    });
    
    // Level filter removed - no longer in UI

    // Manual fetch removed - automatic only
  }

  // Toggle sidebar visibility
  function toggleSidebar() {
    sidebarVisible = !sidebarVisible;
    if (sidebar) {
      sidebar.classList.toggle('hidden');
    }
  }

  // Clear all logs
  function clearLogs() {
    logsData.clear();
    sqlLogsData.clear();
    requestInfoMap.clear();
    completedSet.clear();
    fetchedSet.clear();
    updateLogsDisplay();
    updateProgressDisplay();
    chrome.runtime.sendMessage({ type: 'CLEAR_REQUESTS' });
    resetTTFL();
  }

  // Refresh all logs
  function refreshAllLogs() {
    updateStatus('Refreshing logs...');
    chrome.runtime.sendMessage({ type: 'GET_ALL_REQUESTS' }, (response) => {
      if (response && response.requests) {
        if (response.requests.length === 0) {
          updateStatus('Nothing to refresh', '', 'info');
          return;
        }
        const anyCompleted = completedSet.size > 0;
        if (!anyCompleted) {
          updateStatus('Waiting for SQL logs to load');
          return;
        }

        let fetchCount = 0;
        const totalRequests = response.requests.length;

        response.requests.forEach(request => {
          updateStatus('Refreshing logs', `Request ${fetchCount + 1} of ${totalRequests}`, 'fetching');
          chrome.runtime.sendMessage({
            type: 'FETCH_LOGS',
            requestId: request.requestId
          }, () => {
            fetchCount++;
            if (fetchCount === totalRequests) {
              updateStatus('Refresh complete', `Updated ${totalRequests} requests`, 'success');
              setTimeout(() => updateStatus('Ready', '', 'idle'), 3000);
            }
          });
        });
      } else {
        updateStatus('No requests found');
        setTimeout(() => updateStatus('Ready'), 2000);
      }
    });
  }

  // Filter and highlight logs based on search
  function filterLogs() {
    const searchTerm = document.getElementById('cw-logs-search')?.value || '';
    const searchLower = searchTerm.toLowerCase();
    
    // First, remove all existing highlights
    document.querySelectorAll('.cw-highlight').forEach(el => {
      const parent = el.parentNode;
      parent.replaceChild(document.createTextNode(el.textContent), el);
      parent.normalize(); // Merge adjacent text nodes
    });
    
    if (!searchTerm) {
      // Show all if no search term
      document.querySelectorAll('.cw-request-row').forEach(row => {
        row.style.display = '';
      });
      document.querySelectorAll('.cw-sql-entry').forEach(entry => {
        entry.style.display = '';
      });
      return;
    }
    
    // Filter request rows based on SQL content
    document.querySelectorAll('.cw-request-row').forEach(row => {
      let hasMatch = false;
      
      // Check SQL entries within this request
      row.querySelectorAll('.cw-sql-entry').forEach(entry => {
        const sqlStatement = entry.querySelector('.cw-sql-statement');
        const model = entry.querySelector('.cw-sql-model');
        
        let entryHasMatch = false;
        
        // Check SQL statement
        if (sqlStatement) {
          const text = sqlStatement.textContent;
          if (text.toLowerCase().includes(searchLower)) {
            entryHasMatch = true;
            highlightText(sqlStatement, searchTerm);
          }
        }
        
        // Check model name
        if (model) {
          const text = model.textContent;
          if (text.toLowerCase().includes(searchLower)) {
            entryHasMatch = true;
            highlightText(model, searchTerm);
          }
        }
        
        // Show/hide this SQL entry
        entry.style.display = entryHasMatch ? '' : 'none';
        if (entryHasMatch) hasMatch = true;
      });
      
      // Show/hide the entire request row
      row.style.display = hasMatch ? '' : 'none';
    });
    
    // Update status to show search results
    const visibleRows = document.querySelectorAll('.cw-request-row:not([style*="display: none"])');
    const totalRows = document.querySelectorAll('.cw-request-row');
    if (searchTerm) {
      updateStatus('Search results', `${visibleRows.length} of ${totalRows.length} requests`, 'info');
    }
  }
  
  // Helper function to highlight text
  function highlightText(element, searchTerm) {
    const text = element.textContent;
    const regex = new RegExp(`(${escapeRegex(searchTerm)})`, 'gi');
    const parts = text.split(regex);
    
    element.textContent = '';
    parts.forEach(part => {
      if (part.toLowerCase() === searchTerm.toLowerCase()) {
        const mark = document.createElement('span');
        mark.className = 'cw-highlight';
        mark.textContent = part;
        mark.style.cssText = 'background: #ffeb3b; color: #000; padding: 0 2px; border-radius: 2px;';
        element.appendChild(mark);
      } else {
        element.appendChild(document.createTextNode(part));
      }
    });
  }
  
  // Helper to escape regex special characters
  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // toggleExcludeInfo removed - no longer needed

  // Update logs display - only requests view now
  function updateLogsDisplay() {
    const container = document.getElementById('cw-logs-container');
    if (!container) return;
    
    container.innerHTML = '';
    // Always render requests view
    renderRequestsView(container);
    return;
    
    // Group logs by request ID
    sourceMap.forEach((logs, requestId) => {
      const requestGroup = document.createElement('div');
      requestGroup.className = 'cw-log-group';
      
      const groupHeader = document.createElement('div');
      groupHeader.className = 'cw-log-group-header';
      const isCompleted = completedSet.has(requestId) || (logs && logs.length > 0);
      const status = isCompleted ? `<span class="cw-status-badge cw-completed">Completed</span>
        <button class="cw-group-autofetch" data-request-id="${requestId}" title="Re-enable auto-fetch for this ID">Auto</button>` : '';
      const info = requestInfoMap.get(requestId);
      const endpoint = info ? formatEndpoint(info) : requestId;
      groupHeader.innerHTML = `
        <span class="cw-endpoint" title="Request ID: ${requestId}\n${info ? escapeHtml(info.url) : ''}">${escapeHtml(endpoint)}</span>
        <span class="cw-log-count">${logs.length} logs</span>
        ${status}
        <button class="cw-group-refresh" data-request-id="${requestId}" title="Refresh this request">⟳</button>
      `;
      groupHeader.addEventListener('click', () => {
        requestGroup.classList.toggle('collapsed');
      });
      // Prevent collapsing on refresh button click
      groupHeader.querySelector('.cw-group-refresh')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const rid = e.currentTarget.getAttribute('data-request-id');
        if (rid) {
          updateStatus(`Refreshing ${rid}...`);
          chrome.runtime.sendMessage({ type: 'FETCH_LOGS', requestId: rid });
        }
      });
      groupHeader.querySelector('.cw-group-autofetch')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const rid = e.currentTarget.getAttribute('data-request-id');
        if (rid) {
          chrome.runtime.sendMessage({ type: 'RESET_COMPLETED', requestId: rid }, () => {
            showToast('Auto-fetch re-enabled');
          });
        }
      });
      
      const groupContent = document.createElement('div');
      groupContent.className = 'cw-log-group-content';
      
      logs.forEach(log => {
        const entry = activeTab === 'all' ? createLogEntry(log) : createSqlLogEntry(log);
        groupContent.appendChild(entry);
      });
      
      requestGroup.appendChild(groupHeader);
      requestGroup.appendChild(groupContent);
      container.appendChild(requestGroup);
    });
  }

  // SQL log entry renderer
  function createSqlLogEntry(log) {
    const entry = document.createElement('div');
    entry.className = 'cw-log-entry cw-sql-entry';

    const cleaned = stripAnsi(log.message);
    const meta = parseSqlMeta(cleaned);
    const timestamp = new Date(log.timestamp).toLocaleTimeString();

    entry.innerHTML = `
      <div class="cw-log-meta">
        <span class="cw-log-time">${timestamp}</span>
        ${meta.model ? `<span class="cw-sql-model">${escapeHtml(meta.model)}</span>` : ''}
        ${meta.execMs != null ? `<span class="cw-sql-time">${meta.execMs.toFixed(1)} ms</span>` : ''}
        ${meta.op ? `<span class="cw-sql-op">${escapeHtml(meta.op)}</span>` : ''}
      </div>
      <div class="cw-sql-statement">${escapeHtml(meta.sql || cleaned)}</div>
    `;

    entry.addEventListener('click', () => {
      navigator.clipboard.writeText(meta.sql || cleaned);
      showToast('SQL copied to clipboard');
    });

    return entry;
  }

  function stripAnsi(s) {
    try { return s.replace(/\x1B\[[0-9;]*m/g, ''); } catch (_) { return s; }
  }

  function parseSqlMeta(s) {
    const out = { model: null, execMs: null, op: null, sql: null };
    // Model Load (Xms)
    const loadMatch = s.match(/([A-Za-z0-9_]+)\s+Load\s*\((\d+\.?\d*)ms\)/i);
    if (loadMatch) {
      out.model = loadMatch[1];
      out.execMs = parseFloat(loadMatch[2]);
    } else {
      const timeMatch = s.match(/\((\d+\.?\d*)ms\)/i);
      if (timeMatch) out.execMs = parseFloat(timeMatch[1]);
    }
    // Operation + SQL (SELECT/INSERT/UPDATE/DELETE)
    const opMatch = s.match(/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE)\b/i);
    if (opMatch) {
      out.op = opMatch[1].toUpperCase().replace(/\s+INTO/, '');
      const idx = s.toUpperCase().indexOf(opMatch[1].toUpperCase());
      if (idx >= 0) out.sql = s.slice(idx).trim();
    }
    return out;
  }

  // Create individual log entry
  function createLogEntry(log) {
    const entry = document.createElement('div');
    entry.className = 'cw-log-entry';
    
    const level = detectLogLevel(log.message);
    entry.dataset.level = level;
    entry.classList.add(`cw-log-${level}`);
    
    const timestamp = new Date(log.timestamp).toLocaleTimeString();
    
    entry.innerHTML = `
      <div class="cw-log-meta">
        <span class="cw-log-time">${timestamp}</span>
        <span class="cw-log-level">${level.toUpperCase()}</span>
      </div>
      <div class="cw-log-message">${escapeHtml(log.message)}</div>
    `;
    
    // Add click to copy
    entry.addEventListener('click', () => {
      navigator.clipboard.writeText(log.message);
      showToast('Log copied to clipboard');
    });
    
    return entry;
  }

  // Detect log level from message
  function detectLogLevel(message) {
    const lower = message.toLowerCase();
    if (lower.includes('error') || lower.includes('exception')) return 'error';
    if (lower.includes('warn') || lower.includes('warning')) return 'warn';
    if (lower.includes('debug')) return 'debug';
    return 'info';
  }

  // Update status with icon, message and detail
  function updateStatus(message, detail = '', type = 'info') {
    const iconEl = document.getElementById('cw-status-icon');
    const messageEl = document.getElementById('cw-status-message');
    const detailEl = document.getElementById('cw-status-detail');
    
    if (messageEl) messageEl.textContent = message;
    if (detailEl) detailEl.textContent = detail;
    
    if (iconEl) {
      // Set icon color based on type
      const colors = {
        'waiting': '#ffcc00',  // Yellow - waiting/retrying
        'fetching': '#00aaff', // Blue - actively fetching
        'success': '#00ff00',  // Green - found logs
        'error': '#ff4444',    // Red - error
        'info': '#666666',     // Gray - default
        'idle': '#666666'      // Gray - idle
      };
      iconEl.style.background = colors[type] || colors.info;
      
      // Add pulsing animation for active states
      if (type === 'fetching' || type === 'waiting') {
        iconEl.style.animation = 'pulse 1s infinite';
      } else {
        iconEl.style.animation = 'none';
      }
    }
  }

  // Show retry countdown in status detail
  function showRetryCountdown(requestId, secondsLeft) {
    const detailEl = document.getElementById('cw-status-detail');
    if (!detailEl) return;
    
    if (secondsLeft > 0) {
      detailEl.textContent = `${secondsLeft}s`;
    } else {
      detailEl.textContent = '';
    }
  }

  // Start retry countdown for a request
  function startRetryCountdown(requestId, delayMs) {
    console.log('[CWLV] Starting countdown:', { requestId, delayMs });
    
    // Clear any existing countdown for this request
    const existing = retryStatus.get(requestId);
    if (existing?.intervalId) {
      clearInterval(existing.intervalId);
    }

    const endTime = Date.now() + delayMs;
    const intervalId = setInterval(() => {
      const remaining = Math.ceil((endTime - Date.now()) / 1000);
      if (remaining <= 0) {
        clearInterval(intervalId);
        retryStatus.delete(requestId);
        showRetryCountdown(requestId, 0);
      } else {
        showRetryCountdown(requestId, remaining);
      }
    }, 100);

    retryStatus.set(requestId, { intervalId, endTime });
    showRetryCountdown(requestId, Math.ceil(delayMs / 1000));
  }

  // TTFL helpers
  function startTTFLIfNeeded() {
    if (ttflRecorded != null) return; // already have TTFL
    if (ttflStart != null) return; // already counting
    ttflStart = Date.now();
    updateTTFLDisplay(0);
    ttflTimerId = setInterval(() => {
      const sec = (Date.now() - ttflStart) / 1000;
      updateTTFLDisplay(sec);
    }, 500);
  }

  function recordTTFLIfNeeded() {
    if (ttflRecorded != null || ttflStart == null) return;
    ttflRecorded = Date.now() - ttflStart;
    if (ttflTimerId) clearInterval(ttflTimerId);
    updateTTFLDisplay(ttflRecorded / 1000);
  }

  function resetTTFL() {
    if (ttflTimerId) clearInterval(ttflTimerId);
    ttflTimerId = null;
    ttflStart = null;
    ttflRecorded = null;
    const el = document.getElementById('cw-ttfl');
    if (el) el.textContent = 'TTFL: --';
  }

  function updateTTFLDisplay(seconds) {
    const el = document.getElementById('cw-ttfl');
    if (!el) return;
    const val = (typeof seconds === 'number' && isFinite(seconds)) ? seconds.toFixed(1) : '--';
    el.textContent = `TTFL: ${val}s`;
  }

  function updateProgressDisplay() {
    const el = document.getElementById('cw-progress');
    if (!el) return;
    const total = Array.from(logsData.keys()).length;
    const completed = Array.from(completedSet).filter(id => logsData.has(id)).length;
    el.textContent = `${completed} of ${total}`;
  }

  // Enable all fetch buttons once we have at least one completed request
  function updateFetchButtonsIfNeeded() {
    if (completedSet.size > 0) {
      // Enable all fetch buttons
      document.querySelectorAll('.cw-request-fetch').forEach(btn => {
        btn.disabled = false;
      });
      console.log('[CWLV] Fetch buttons enabled - first request completed');
      updateStatus(
        'Buttons enabled',
        'Click fetch to retrieve now',
        'success'
      );
    }
  }

  function formatEndpoint(info) {
    try {
      const u = new URL(info.url);
      return `${info.method || 'GET'} ${u.host}${u.pathname}${u.search || ''}`;
    } catch (_) {
      return info.url || '';
    }
  }

  // Show toast notification
  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'cw-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
      toast.remove();
    }, 2000);
  }

  // Escape HTML for safe display
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'NEW_REQUEST') {
      const isFirst = requestInfoMap.size === 0;
      const endpoint = message.data.url ? formatEndpoint(message.data) : 'request';
      updateStatus(
        isFirst ? 'First request' : 'New request',
        endpoint,
        'fetching'
      );
      startTTFLIfNeeded();
      requestInfoMap.set(message.data.requestId, { url: message.data.url, method: message.data.method });
      
      // Initialize empty array for this request
      if (!logsData.has(message.data.requestId)) {
        logsData.set(message.data.requestId, []);
        sqlLogsData.set(message.data.requestId, []);
        updateLogsDisplay();
      }
    } else if (message.type === 'LOGS_RECEIVED') {
      const { requestId, logs } = message.data;
      logsData.set(requestId, logs || []);
      if (message.data.sqlLogs) {
        sqlLogsData.set(requestId, message.data.sqlLogs || []);
      } else {
        // Derive SQL locally if server didn't send
        const derived = (logs || []).filter(l => parseSqlMeta(stripAnsi(l.message)).op);
        sqlLogsData.set(requestId, derived);
      }
      
      const info = requestInfoMap.get(requestId);
      const endpoint = info ? formatEndpoint(info) : requestId;
      
      // Mark completed only if non-empty logs
      if (message.data.completed || (logs && logs.length > 0)) {
        fetchedSet.add(requestId);
        completedSet.add(requestId);
        
        const sqlCount = sqlLogsData.get(requestId)?.length || 0;
        updateStatus(
          `Found ${logs.length} logs`,
          `${sqlCount} SQL • ${endpoint}`,
          'success'
        );
      } else {
        updateStatus(
          'No logs found',
          endpoint,
          'waiting'
        );
      }
      
      if ((logs && logs.length > 0)) {
        recordTTFLIfNeeded();
      }
      updateLogsDisplay();
      updateProgressDisplay();
    } else if (message.type === 'LOGS_ERROR') {
      updateStatus(
        'Error fetching logs',
        message.data.error || 'Unknown error',
        'error'
      );
    } else if (message.type === 'TOGGLE_SIDEBAR') {
      // Create sidebar if it doesn't exist yet
      if (!sidebar) {
        createSidebar();
      }
      toggleSidebar();
    } else if (message.type === 'NAVIGATION_RESET') {
      // Reset on navigation
      console.log('[CWLV] Navigation reset received');
      resetOnNavigation();
    } else if (message.type === 'RETRY_SCHEDULED') {
      // Handle retry notification from background
      const { requestId, delayMs, attempt, isFirstRequest } = message;
      console.log('[CWLV] Retry scheduled:', { requestId, delayMs, attempt, isFirstRequest });
      
      const info = requestInfoMap.get(requestId);
      const endpoint = info ? formatEndpoint(info) : requestId;
      
      if (isFirstRequest) {
        // This is to enable buttons
        if (attempt === 0) {
          updateStatus(
            'Checking if logs are available',
            endpoint,
            'fetching'
          );
        } else {
          updateStatus(
            `Logs not ready - retry ${attempt}/10`,
            endpoint,
            'waiting'
          );
        }
      } else {
        // This is auto-fetch for subsequent requests
        if (attempt === 0) {
          updateStatus(
            'Auto-fetching',
            endpoint,
            'fetching'
          );
        } else {
          updateStatus(
            `Retry ${attempt}/10`,
            endpoint,
            'waiting'
          );
        }
      }
      
      startRetryCountdown(requestId, delayMs);
    } else if (message.type === 'FETCH_COMPLETE') {
      // Clear any retry countdown when fetch completes
      const requestId = message.requestId;
      if (requestId) {
        const existing = retryStatus.get(requestId);
        if (existing?.intervalId) {
          clearInterval(existing.intervalId);
          retryStatus.delete(requestId);
          showRetryCountdown(requestId, 0);
        }
        if (!completedSet.has(requestId)) {
          completedSet.add(requestId);
          updateFetchButtonsIfNeeded();
        }
        if (completedSet.size === 1) {
          updateStatus(
            'Buttons enabled',
            'Click fetch to retrieve now',
            'success'
          );
        } else {
          updateStatus(
            'Ready',
            `${completedSet.size} requests fetched`,
            'idle'
          );
        }
        updateProgressDisplay();
      }
    }
  });

  // Clear data on page load/navigation
  function resetOnNavigation() {
    console.log('[CWLV] Resetting data for new page');
    logsData.clear();
    sqlLogsData.clear();
    requestInfoMap.clear();
    completedSet.clear();
    fetchedSet.clear();
    retryStatus.clear();
    resetTTFL();
    updateLogsDisplay();
    updateProgressDisplay();
    updateStatus('Ready', '', 'idle');
  }

  // Check if we should auto-initialize on this domain
  function shouldAutoInitialize() {
    const hostname = window.location.hostname;
    const port = window.location.port;
    
    // Only auto-initialize on localhost with ports 3000 or 3001
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost')) {
      return port === '3000' || port === '3001';
    }
    return false;
  }

  // Initialize based on domain
  function initialize() {
    console.log('[CWLV] Initializing on', window.location.hostname + ':' + window.location.port);
    resetOnNavigation();
    
    // Always install network interceptors (for when sidebar is manually opened)
    installNetworkInterceptors();
    
    // Only auto-create sidebar on specific localhost ports
    if (shouldAutoInitialize()) {
      console.log('[CWLV] Auto-creating sidebar for localhost development');
      createSidebar();
    } else {
      console.log('[CWLV] Sidebar not auto-created. Use Ctrl+Shift+L or extension icon to open.');
    }
  }

  // Initialize on page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }

  // Add keyboard shortcut to toggle sidebar
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'L') {
      // Create sidebar if it doesn't exist yet
      if (!sidebar) {
        createSidebar();
      }
      toggleSidebar();
    }
  });
})();
