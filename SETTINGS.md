# Sql Viewer - Configuration Guide

## Overview

Version 2.0 of Sql Viewer introduces a comprehensive settings system that eliminates hardcoded values and provides full configurability through a user-friendly interface.

## Accessing Settings

There are two ways to access the settings page:

1. **Via Extension Popup**: Click the extension icon and then click the "Settings" button
2. **Via Chrome Settings**: Go to `chrome://extensions/`, find Sql Viewer, and click "Extension options"

## Configuration Options

### General Settings

- **Local Server URL**: The URL of your local CloudWatch logs server (default: `http://localhost:8090`)
- **Server Port**: Port number for the local server (default: `8090`)
- **Auto-fetch Logs**: Automatically fetch logs for new requests without manual interaction
- **Show SQL Queries**: Display SQL queries in a separate tab within the logs viewer

### AWS Configuration

- **AWS Profile**: The AWS CLI profile to use for CloudWatch access (default: `sf`)
- **AWS Region**: The AWS region where your CloudWatch logs are stored
- **Log Groups**: List of CloudWatch log groups to search (searched in order of priority)
- **Default Time Range**: How many hours back to search for logs (default: 12 hours)

### Monitored Domains

Configure which domains the extension should monitor for API requests:

- **Production Domains**: Production API endpoints to monitor
- **Staging Domains**: Staging/testing API endpoints
- **Local Development Domains**: Local development URLs
- **Monitor All Localhost**: Toggle to automatically monitor all localhost traffic

### Advanced Settings

- **Request ID Header Name**: The HTTP header that contains the request ID (default: `X-Request-Id`)
- **Retry Backoff Delays**: Comma-separated list of delays in milliseconds for retry attempts
- **SQL Tables to Exclude**: Tables to exclude from SQL logs display (one per line)
- **Enable Debug Logging**: Show detailed debug information in the browser console
- **Enable WebSocket**: Use WebSocket for real-time log updates

## Settings Management

### Import/Export

You can export your settings to a JSON file for backup or sharing:

1. Click "Export Settings" to download your current configuration
2. Click "Import Settings" to load a previously exported configuration

### Reset to Defaults

Click "Reset to Defaults" to restore all settings to their initial values.

## Server Configuration

The local server also supports environment variables for configuration:

1. Copy `.env.example` to `.env` in the `local-server` directory
2. Configure the following variables:

```env
# Server Configuration
PORT=8090

# AWS Configuration
AWS_PROFILE=sf
AWS_REGION=us-east-1

# Default Log Group
DEFAULT_LOG_GROUP=/aws/elasticbeanstalk/your-app/var/log/...

# Debug Mode
DEBUG=false
```

## Dynamic Configuration

The extension now passes configuration parameters with each request to the server:

```javascript
{
  requestIds: ["uuid-1", "uuid-2"],
  logGroups: ["log-group-1", "log-group-2"],
  timeRange: {
    start: timestamp,
    end: timestamp
  },
  awsProfile: "sf",
  awsRegion: "us-east-1"
}
```

This allows you to:
- Use different AWS profiles for different environments
- Search multiple log groups dynamically
- Adjust time ranges per request
- Switch regions without restarting the server

## Migration from v1.0

When upgrading from version 1.0:

1. Your existing hardcoded values will be used as defaults
2. The extension will automatically create a default configuration
3. Review and adjust settings as needed through the settings page

## Security Considerations

- AWS credentials are never stored in the extension
- All AWS authentication is handled by the local server using AWS CLI profiles
- Settings are stored in Chrome's sync storage (encrypted if Chrome sync is enabled)
- No sensitive data is transmitted over the network

## Troubleshooting

### Settings Not Saving

- Check browser console for errors
- Ensure you have sufficient Chrome storage quota
- Try disabling and re-enabling the extension

### Server Not Responding with New Settings

- Ensure the server is running the latest version
- Check server logs for configuration errors
- Verify AWS profile exists and has necessary permissions

### Domains Not Being Monitored

- Check that domains are correctly formatted in settings
- Verify "Monitor All Localhost" is enabled for local development
- Check browser console for debug messages (if debug mode is enabled)

## Example Configurations

### Development Environment

```json
{
  "serverUrl": "http://localhost:8090",
  "autoFetch": true,
  "awsProfile": "dev",
  "awsRegion": "us-west-2",
  "logGroups": [
    "/aws/lambda/dev-api",
    "/aws/ecs/dev-cluster"
  ],
  "monitorAllLocalhost": true,
  "enableDebug": true
}
```

### Production Monitoring

```json
{
  "serverUrl": "http://localhost:8090",
  "autoFetch": false,
  "awsProfile": "prod-readonly",
  "awsRegion": "us-east-1",
  "logGroups": [
    "/aws/elasticbeanstalk/prod-env/var/log/app.log"
  ],
  "prodDomains": [
    "https://api.example.com"
  ],
  "timeRange": 24,
  "enableDebug": false
}
```

## Support

For issues or feature requests, please visit the [GitHub repository](https://github.com/your-repo/cloudwatch-logs-viewer).