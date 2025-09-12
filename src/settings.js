// Settings management module for the extension
const SettingsManager = (() => {
  // Default settings
  const DEFAULT_SETTINGS = {
    serverUrl: 'http://13.203.150.222:8090',
    serverPort: 8090,
    autoFetch: true,
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
      'http://localhost:3001',
      'http://admin.localhost:3000',
      'http://admin.localhost:3001',
      'http://www.localhost:3001'
    ],
    monitorAllLocalhost: true,
    requestHeader: 'X-Request-Id',
    backoffDelays: '2000, 5000, 10000, 15000, 20000, 30000, 45000, 60000, 90000, 120000',
    sqlExcludeTables: 'ahoy_visits\nflipper_features\njwt_deny_list',
    enableDebug: false,
    enableWebsocket: true
  };

  let cachedSettings = null;
  let settingsListeners = [];

  // Load settings from storage
  async function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULT_SETTINGS, (result) => {
        cachedSettings = result;
        resolve(result);
      });
    });
  }

  // Save settings to storage
  async function saveSettings(settings) {
    return new Promise((resolve) => {
      chrome.storage.sync.set(settings, () => {
        cachedSettings = settings;
        notifyListeners(settings);
        resolve();
      });
    });
  }

  // Get cached settings or load if not cached
  async function getSettings() {
    if (cachedSettings) {
      return cachedSettings;
    }
    return await loadSettings();
  }

  // Get a specific setting
  async function getSetting(key) {
    const settings = await getSettings();
    return settings[key];
  }

  // Update a specific setting
  async function updateSetting(key, value) {
    const settings = await getSettings();
    settings[key] = value;
    await saveSettings(settings);
  }

  // Add listener for settings changes
  function addListener(callback) {
    settingsListeners.push(callback);
  }

  // Remove listener
  function removeListener(callback) {
    settingsListeners = settingsListeners.filter(l => l !== callback);
  }

  // Notify all listeners of settings change
  function notifyListeners(settings) {
    settingsListeners.forEach(listener => {
      try {
        listener(settings);
      } catch (e) {
        console.error('Error in settings listener:', e);
      }
    });
  }

  // Parse backoff delays from string to array
  function getBackoffDelays(settings) {
    const delaysStr = settings.backoffDelays || DEFAULT_SETTINGS.backoffDelays;
    return delaysStr.split(',').map(d => parseInt(d.trim())).filter(d => !isNaN(d));
  }

  // Parse SQL exclude tables from string to array
  function getSqlExcludeTables(settings) {
    const tablesStr = settings.sqlExcludeTables || DEFAULT_SETTINGS.sqlExcludeTables;
    return tablesStr.split('\n').map(t => t.trim()).filter(t => t.length > 0);
  }

  // Get server URLs based on settings
  function getServerUrls(settings) {
    const urls = [];
    if (settings.serverUrl) {
      urls.push(settings.serverUrl);
    }
    // Add fallback URLs
    urls.push(`http://localhost:${settings.serverPort}`);
    urls.push(`http://127.0.0.1:${settings.serverPort}`);
    return [...new Set(urls)]; // Remove duplicates
  }

  // Check if a URL should be monitored
  function shouldMonitorUrl(url, settings) {
    try {
      const u = new URL(url);
      
      // Check if monitoring all localhost
      if (settings.monitorAllLocalhost) {
        if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname.endsWith('.localhost')) {
          return true;
        }
      }
      
      // Check against configured domains
      const allDomains = [
        ...settings.prodDomains,
        ...settings.stageDomains,
        ...settings.localDomains
      ];
      
      for (const domain of allDomains) {
        try {
          const domainUrl = new URL(domain);
          if (u.hostname === domainUrl.hostname) {
            // Check if ports match if specified
            if (domainUrl.port && u.port !== domainUrl.port) {
              continue;
            }
            return true;
          }
        } catch (e) {
          // If domain is not a valid URL, try as a hostname pattern
          if (u.hostname.includes(domain)) {
            return true;
          }
        }
      }
      
      return false;
    } catch (e) {
      return false;
    }
  }

  // Guess log groups based on URL and settings
  function guessLogGroups(url, settings) {
    // Ensure settings object exists with proper defaults
    if (!settings || typeof settings !== 'object') {
      return [];
    }
    
    // Start with configured log groups, ensuring it's an array
    const groups = Array.isArray(settings.logGroups) ? [...settings.logGroups] : [];
    
    // Handle invalid or missing URLs
    if (!url || typeof url !== 'string' || url.trim() === '') {
      return groups;
    }
    
    try {
      // Clean and prepare URL for parsing
      let urlToParse = url.trim();
      
      // Add protocol if missing
      if (!urlToParse.match(/^https?:\/\//i)) {
        urlToParse = 'https://' + urlToParse;
      }
      
      // Try to parse the URL
      let u;
      try {
        u = new URL(urlToParse);
      } catch (urlError) {
        console.warn('Invalid URL provided to guessLogGroups:', url);
        return groups;
      }
      
      const host = u.hostname.toLowerCase();
      
      // Process production domains
      const prodDomains = Array.isArray(settings.prodDomains) ? settings.prodDomains : [];
      for (const domain of prodDomains) {
        if (!domain || typeof domain !== 'string' || domain.trim() === '') continue;
        
        try {
          // Try to parse domain as URL
          let domainUrl;
          if (domain.match(/^https?:\/\//i)) {
            domainUrl = new URL(domain);
          } else {
            domainUrl = new URL('https://' + domain);
          }
          
          if (host.includes(domainUrl.hostname.toLowerCase())) {
            // Production log groups are already in settings.logGroups
            break;
          }
        } catch (e) {
          // If domain parsing fails, try simple string matching
          try {
            const cleanDomain = domain.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
            if (cleanDomain && (host.includes(cleanDomain) || cleanDomain.includes(host))) {
              break;
            }
          } catch (stringError) {
            // Skip this domain if all parsing attempts fail
            continue;
          }
        }
      }
      
      // Process staging domains
      const stageDomains = Array.isArray(settings.stageDomains) ? settings.stageDomains : [];
      for (const domain of stageDomains) {
        if (!domain || typeof domain !== 'string' || domain.trim() === '') continue;
        
        try {
          // Try to parse domain as URL
          let domainUrl;
          if (domain.match(/^https?:\/\//i)) {
            domainUrl = new URL(domain);
          } else {
            domainUrl = new URL('https://' + domain);
          }
          
          if (host.includes(domainUrl.hostname.toLowerCase())) {
            // Add stage-specific log groups if not already included
            const stageGroup = '/aws/elasticbeanstalk/ad-portal-stage/var/log/eb-docker/containers/eb-current-app/stdouterr.log';
            if (!groups.includes(stageGroup)) {
              groups.push(stageGroup);
            }
            break;
          }
        } catch (e) {
          // If domain parsing fails, try simple string matching
          try {
            const cleanDomain = domain.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
            if (cleanDomain && (host.includes(cleanDomain) || cleanDomain.includes(host))) {
              const stageGroup = '/aws/elasticbeanstalk/ad-portal-stage/var/log/eb-docker/containers/eb-current-app/stdouterr.log';
              if (!groups.includes(stageGroup)) {
                groups.push(stageGroup);
              }
              break;
            }
          } catch (stringError) {
            // Skip this domain if all parsing attempts fail
            continue;
          }
        }
      }
    } catch (e) {
      console.error('Error in guessLogGroups:', e, 'URL:', url);
    }
    
    // Remove duplicates while preserving order
    return [...new Set(groups)];
  }

  // Initialize settings on load
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync') {
      // Reload cached settings
      loadSettings().then(settings => {
        notifyListeners(settings);
      });
    }
  });

  // Initial load
  loadSettings();

  return {
    DEFAULT_SETTINGS,
    loadSettings,
    saveSettings,
    getSettings,
    getSetting,
    updateSetting,
    addListener,
    removeListener,
    getBackoffDelays,
    getSqlExcludeTables,
    getServerUrls,
    shouldMonitorUrl,
    guessLogGroups
  };
})();

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SettingsManager;
}