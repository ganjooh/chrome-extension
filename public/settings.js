// Default settings
const DEFAULT_SETTINGS = {
  serverUrl: 'http://13.203.150.222:8090',
  serverPort: 8090,
  autoFetch: false,
  showSqlLogs: true,
  awsProfile: 'sf',
  awsRegion: 'us-east-1',
  logGroups: [
    '/aws/elasticbeanstalk/ad-portal-prod-env/var/log/eb-docker/containers/eb-current-app/stdouterr.log'
  ],
  timeRange: 12,
  prodDomains: [
    'https://api.portal.insurance.io',
    'https://api.ad-portal.smartfinancial.com'
  ],
  stageDomains: [
    'https://api-stage.ad-portal.smartfinancial.com'
  ],
  localDomains: [
    'http://localhost:3000',
    'http://admin.localhost:3000',
    'http://www.localhost:3000',
    'http://localhost:3001',
    'http://admin.localhost:3001',
    'http://www.localhost:3001'
  ],
  monitorAllLocalhost: true,
  requestHeader: 'X-Request-Id',
  backoffDelays: '2000, 5000, 10000, 20000, 30000, 45000, 60000, 90000, 120000, 180000',
  sqlExcludeTables: 'ahoy_visits\nflipper_features\njwt_deny_list',
  enableDebug: false,
  enableWebsocket: true
};

// Load settings from storage
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (result) => {
      resolve(result);
    });
  });
}

// Save settings to storage
async function saveSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(settings, () => {
      resolve();
    });
  });
}

// Show status message
function showStatus(message, type = 'success') {
  const statusEl = document.getElementById('status-message');
  statusEl.textContent = message;
  statusEl.className = `status-message ${type}`;
  setTimeout(() => {
    statusEl.className = 'status-message';
  }, 3000);
}

// Tab switching
document.querySelectorAll('.tab-button').forEach(button => {
  button.addEventListener('click', () => {
    const tabName = button.dataset.tab;
    
    // Update buttons
    document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));
    button.classList.add('active');
    
    // Update content
    document.querySelectorAll('.tab-content').forEach(content => {
      content.classList.remove('active');
    });
    document.getElementById(`${tabName}-tab`).classList.add('active');
  });
});

// Dynamic list management
function addItemToList(containerId, inputClass, value = '') {
  const container = document.getElementById(containerId);
  const item = document.createElement('div');
  item.className = 'removable-item';
  item.innerHTML = `
    <input type="text" class="${inputClass}" value="${value}" placeholder="${container.querySelector('input').placeholder}">
    <button class="remove-button">Remove</button>
  `;
  
  item.querySelector('.remove-button').addEventListener('click', () => {
    if (container.children.length > 1) {
      item.remove();
    }
  });
  
  container.appendChild(item);
}

// Add log group
document.getElementById('add-log-group').addEventListener('click', () => {
  addItemToList('log-groups-container', 'log-group-input');
});

// Add domain buttons
document.getElementById('add-prod-domain').addEventListener('click', () => {
  addItemToList('prod-domains-container', 'domain-input');
});

document.getElementById('add-stage-domain').addEventListener('click', () => {
  addItemToList('stage-domains-container', 'domain-input');
});

document.getElementById('add-local-domain').addEventListener('click', () => {
  addItemToList('local-domains-container', 'domain-input');
});

// Load settings into form
async function populateForm() {
  const settings = await loadSettings();
  
  // General tab
  document.getElementById('server-url').value = settings.serverUrl;
  document.getElementById('server-port').value = settings.serverPort;
  document.getElementById('auto-fetch').checked = settings.autoFetch;
  document.getElementById('show-sql-logs').checked = settings.showSqlLogs;
  
  // AWS tab
  document.getElementById('aws-profile').value = settings.awsProfile;
  document.getElementById('aws-region').value = settings.awsRegion;
  document.getElementById('time-range').value = settings.timeRange;
  
  // Log groups
  const logGroupsContainer = document.getElementById('log-groups-container');
  logGroupsContainer.innerHTML = '';
  settings.logGroups.forEach((group, index) => {
    if (index === 0) {
      logGroupsContainer.innerHTML = `
        <div class="removable-item">
          <input type="text" class="log-group-input" value="${group}" placeholder="/aws/elasticbeanstalk/app-name/var/log/...">
        </div>
      `;
    } else {
      addItemToList('log-groups-container', 'log-group-input', group);
    }
  });
  
  // Domains tab
  const populateDomains = (containerId, domains) => {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    if (domains.length === 0) {
      container.innerHTML = `
        <div class="removable-item">
          <input type="text" class="domain-input" value="" placeholder="${container.querySelector('input')?.placeholder || 'https://example.com'}">
        </div>
      `;
    } else {
      domains.forEach((domain, index) => {
        if (index === 0) {
          container.innerHTML = `
            <div class="removable-item">
              <input type="text" class="domain-input" value="${domain}" placeholder="https://example.com">
            </div>
          `;
        } else {
          addItemToList(containerId, 'domain-input', domain);
        }
      });
    }
  };
  
  populateDomains('prod-domains-container', settings.prodDomains);
  populateDomains('stage-domains-container', settings.stageDomains);
  populateDomains('local-domains-container', settings.localDomains);
  document.getElementById('monitor-all-localhost').checked = settings.monitorAllLocalhost;
  
  // Advanced tab
  document.getElementById('request-header').value = settings.requestHeader;
  document.getElementById('backoff-delays').value = settings.backoffDelays;
  document.getElementById('sql-exclude-tables').value = settings.sqlExcludeTables;
  document.getElementById('enable-debug').checked = settings.enableDebug;
  document.getElementById('enable-websocket').checked = settings.enableWebsocket;
}

// Get values from a list
function getListValues(selector) {
  const inputs = document.querySelectorAll(selector);
  return Array.from(inputs)
    .map(input => input.value.trim())
    .filter(value => value.length > 0);
}

// Save settings
document.getElementById('save-settings').addEventListener('click', async () => {
  const settings = {
    serverUrl: document.getElementById('server-url').value.trim(),
    serverPort: parseInt(document.getElementById('server-port').value),
    autoFetch: document.getElementById('auto-fetch').checked,
    showSqlLogs: document.getElementById('show-sql-logs').checked,
    awsProfile: document.getElementById('aws-profile').value.trim(),
    awsRegion: document.getElementById('aws-region').value,
    logGroups: getListValues('.log-group-input'),
    timeRange: parseInt(document.getElementById('time-range').value),
    prodDomains: getListValues('#prod-domains-container .domain-input'),
    stageDomains: getListValues('#stage-domains-container .domain-input'),
    localDomains: getListValues('#local-domains-container .domain-input'),
    monitorAllLocalhost: document.getElementById('monitor-all-localhost').checked,
    requestHeader: document.getElementById('request-header').value.trim(),
    backoffDelays: document.getElementById('backoff-delays').value.trim(),
    sqlExcludeTables: document.getElementById('sql-exclude-tables').value.trim(),
    enableDebug: document.getElementById('enable-debug').checked,
    enableWebsocket: document.getElementById('enable-websocket').checked
  };
  
  try {
    await saveSettings(settings);
    showStatus('Settings saved successfully!');
    
    // Notify background script to reload settings
    chrome.runtime.sendMessage({ type: 'RELOAD_SETTINGS' });
  } catch (error) {
    showStatus('Failed to save settings: ' + error.message, 'error');
  }
});

// Reset to defaults
document.getElementById('reset-defaults').addEventListener('click', async () => {
  if (confirm('Are you sure you want to reset all settings to defaults?')) {
    await saveSettings(DEFAULT_SETTINGS);
    await populateForm();
    showStatus('Settings reset to defaults');
    chrome.runtime.sendMessage({ type: 'RELOAD_SETTINGS' });
  }
});

// Export settings
document.getElementById('export-settings').addEventListener('click', async () => {
  const settings = await loadSettings();
  const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'cloudwatch-logs-viewer-settings.json';
  a.click();
  URL.revokeObjectURL(url);
  showStatus('Settings exported successfully');
});

// Import settings
document.getElementById('import-settings').addEventListener('click', () => {
  document.getElementById('import-file').click();
});

document.getElementById('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  
  try {
    const text = await file.text();
    const settings = JSON.parse(text);
    await saveSettings(settings);
    await populateForm();
    showStatus('Settings imported successfully');
    chrome.runtime.sendMessage({ type: 'RELOAD_SETTINGS' });
  } catch (error) {
    showStatus('Failed to import settings: ' + error.message, 'error');
  }
  
  e.target.value = '';
});

// Initialize form on load
populateForm();