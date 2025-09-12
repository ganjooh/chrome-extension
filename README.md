# Sql Viewer Chrome Extension

A Chrome extension that automatically captures and displays SQL queries for API requests based on their X-Request-Id headers.

**Version 2.0** - Fully configurable through the extension settings panel.

## Features

- 🔍 Automatically intercepts network requests and captures X-Request-Id headers
- 📊 Fetches corresponding logs from AWS CloudWatch
- 🎨 Beautiful dark-themed sidebar UI that integrates seamlessly with your web app
- 🔄 Real-time log streaming via WebSocket
- 🎯 Log level filtering (Error, Warning, Info, Debug)
- 🔎 Search functionality within logs
- 📋 Click-to-copy log entries
- ⌨️ Keyboard shortcut (Ctrl+Shift+L) to toggle sidebar
- ⚙️ **NEW**: Fully configurable settings - no more hardcoded values!
- 🔐 **NEW**: Support for multiple AWS profiles and regions
- 🌐 **NEW**: Dynamic domain monitoring configuration
- 💾 **NEW**: Import/export settings for easy sharing

## Prerequisites

- Chrome browser
- Backend server configured to send logs

## Installation

### Installing the Chrome Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top-right corner)
3. Click "Load unpacked"
4. Select this `chrome-extension` directory
5. The "Sql Viewer" extension icon will appear in your toolbar

### Configure the Extension

1. Click the extension icon and select "Settings"
2. Configure your server URL
3. Add domains you want to monitor
4. Customize retry delays and other options
5. Save your settings

## Usage

1. **Navigate to your application**

2. **Open the logs sidebar**:
   - Click the extension icon and click "Open Sidebar", OR
   - Press `Ctrl+Shift+L` (or `Cmd+Shift+L` on Mac)

3. **Make API requests** in your application - SQL logs will automatically appear!

## How It Works

1. **Request Interception**: The extension's background script intercepts network requests to configured domains
2. **Header Extraction**: X-Request-Id headers are extracted from API calls
3. **Log Fetching**: Request IDs are sent to your configured server endpoint
4. **Display**: SQL queries and logs are formatted and displayed in the sidebar

## Configuration

### Extension Settings

All configuration is done through the settings page:
- Server endpoint URL
- Monitored domains
- Request ID header names
- Retry strategies and delays
- Auto-fetch preferences
- Debug mode toggle

See [SETTINGS.md](./SETTINGS.md) for detailed configuration options.

## Development

### Modifying the Extension

1. Make changes to files in `src/` or `public/`
2. Go to `chrome://extensions/`
3. Click the refresh icon on the extension card
4. Reload your web page

### File Structure

```
chrome-extension/
├── manifest.json           # Extension manifest
├── src/
│   ├── background.js      # Service worker for request interception
│   ├── content.js         # Content script for sidebar UI
│   ├── settings.js        # Settings management module
│   └── sidebar.css        # Sidebar styles
├── public/
│   ├── popup.html         # Extension popup
│   ├── popup.js           # Popup logic
│   ├── settings.html      # Settings page
│   └── settings.js        # Settings page logic
└── docs/
    ├── README.md          # This file
    └── SETTINGS.md        # Settings documentation
```


## Troubleshooting

### Connection Issues
- Check the server URL in extension settings
- Verify the server is accessible from your browser
- Check the extension popup for connection status

### No Logs Appearing
- Check that your API includes the configured Request ID header (default: X-Request-Id)
- Verify the domain is in your monitored domains list
- Look for errors in Chrome DevTools console
- Enable debug mode in settings for detailed logging

### Extension Not Working
- Check that the extension is enabled in Chrome
- Verify domains are properly configured in settings
- Check background script errors: chrome://extensions/ → "Inspect views: service worker"
- Enable debug mode in settings for detailed logging

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│                 │     │                  │     │                 │
│  Web App        │────▶│ Chrome Extension │────▶│  Backend Server │
│  (Frontend)     │     │                  │     │                 │
│                 │     │                  │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

## Security Notes

- The extension only stores non-sensitive configuration
- All sensitive operations are handled by the backend server
- Use HTTPS for production deployments
- Configure CORS properly on your server

## Configuration Documentation

- [SETTINGS.md](./SETTINGS.md) - Detailed settings documentation


## Contributing

Contributions are welcome! Please ensure:
1. Code follows existing patterns
2. Settings remain configurable (no hardcoded values)
3. Documentation is updated for new features

## License

MIT
