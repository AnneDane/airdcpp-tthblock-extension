'use strict';

/*
 * TTH Blocker Extension for AirDC++
 * Version: 1.20.56
 * Description: Blocks downloads based on TTH (Tiger Tree Hash) values from JSON blocklists stored in the /blocklists/ directory.
 *              Adds context menu items in AirDC++ search results and filelists to append selected files' TTHs to internal_blocklist.json.
 *              Supports multiple read-only blocklists (local and remote) with dynamic detection and enable/disable settings in the AirDC++ UI.
 *              Auto-updates remote blocklists with a 'url' field every X minutes, as configured in the extension's settings.
 * Purpose: Prevents downloading files with specific TTHs, enhancing user control over content in AirDC++ (a Direct Connect client).
 * Dependencies: Uses Node.js built-in modules (fs, path), node-fetch for HTTP requests, and AirDC++'s airdcpp-apisocket and airdcpp-extension-settings for API and settings management.
 * References:
 * - AirDC++ Extension API: https://airdcpp-docs.lowpri.de/extensions/api.html
 * - Node.js fs module: https://nodejs.org/api/fs.html
 * - node-fetch: https://github.com/node-fetch/node-fetch
 * - AirDC++ Settings API: https://github.com/airdcpp/airdcpp-extension-settings-js
 * Changelog:
 * - 1.20.56: Added code commentary.
 */

// Enable strict mode to catch common coding errors (e.g., undeclared variables) and improve performance.
// Reference: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Strict_mode
const fs = require('fs');
// Use synchronous file operations for initialization and critical tasks to ensure immediate feedback; async used elsewhere for non-blocking I/O.
// Reference: https://nodejs.org/api/fs.html

const path = require('path');
// Path module for cross-platform file path handling, ensuring compatibility on Windows (e.g., L:\AirDC_Test\Settings\extensions).
// Reference: https://nodejs.org/api/path.html

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
// Dynamic import of node-fetch for HTTP requests to update remote blocklists. Used for fetching JSON files from URLs like raw.githubusercontent.com.
// Reference: https://github.com/node-fetch/node-fetch

const EXTENSION_VERSION = '1.20.56';
// Defines the extension version for logging and user-facing notifications, ensuring version tracking for debugging and updates.

const CONFIG_VERSION = 1;
// Tracks the configuration file format version to handle future schema changes gracefully.

const BLOCKLIST_DIR = path.resolve(__dirname, '..', 'blocklists');
// Defines the blocklist directory path relative to the extension’s main.js (dist folder).
// Uses path.resolve to ensure absolute paths, mitigating ENOENT errors seen in logs.
// Example: L:\AirDC_Test\Settings\extensions\airdcpp-tthblock-extension\package\blocklists
// Linked to: ensureBlocklistDir(), getBlocklistFiles(), watchBlocklistDir()

const INTERNAL_BLOCKLIST_FILE = path.join(BLOCKLIST_DIR, 'internal_blocklist.json');
// Path to the internal (writable) blocklist file where TTHs added via context menus are stored.
// Example: L:\AirDC_Test\Settings\extensions\airdcpp-tthblock-extension\package\blocklists\internal_blocklist.json
// Linked to: addToBlocklist(), loadBlockedTTHs(), validateBlocklistFile()

let blockedTTHSet = new Set();
// Stores all active TTHs from enabled blocklists for quick lookup during download checks.
// Uses Set for O(1) lookup performance when checking TTHs in queueBundleFileAddHook.
// Linked to: loadBlockedTTHs(), addToBlocklist(), queueBundleFileAddHook()

let blocklistFiles = [];
// Array storing metadata of all blocklist files (local and remote) in BLOCKLIST_DIR.
// Structure: [{ file, path, mtime, url, version, updated_at, description }]
// Populated by getBlocklistFiles(), used in loadBlockedTTHs(), updateSettingsDefinitions(), watchBlocklistDir()
// Linked to: getBlocklistFiles(), loadBlockedTTHs(), updateSettingsDefinitions()

let blocklistTTHMap = new Map();
// Maps blocklist filenames to their respective TTH Sets for tracking which TTHs belong to which blocklist.
// Used to unload/reload TTHs when blocklists are updated or disabled.
// Example: blocklistTTHMap.get('bob_blocklist.json') -> Set(['TTH1', 'TTH2'])
// Linked to: loadBlockedTTHs(), updateSingleBlocklist()

let blocklistETags = new Map();
// Stores ETag headers for remote blocklists to support HTTP 304 (Not Modified) responses, reducing unnecessary downloads.
// Example: blocklistETags.get('remote_blocklist.json') -> 'etag-value'
// Linked to: fetchAndUpdateBlocklist()

let blocklistVersions = new Map();
// Tracks version or updated_at timestamps of blocklists to detect changes during remote updates.
// Example: blocklistVersions.get('remote_blocklist.json') -> '1.0.0' or '2025-08-27T14:49:00Z'
// Linked to: fetchAndUpdateBlocklist(), loadBlockedTTHs()

let updateIntervalId = null;
// Stores the interval ID for scheduled remote blocklist updates to allow cleanup on extension stop.
// Linked to: scheduleBlocklistUpdates(), extension.onStop()

let lastUpdateWriteTime = new Map();
// Tracks the last modification time (mtimeMs) of each blocklist file to prevent redundant reloads during rapid changes.
// Example: lastUpdateWriteTime.get('internal_blocklist.json') -> 1756291959208.9578
// Linked to: updateSingleBlocklist(), watchBlocklistDir()

const { addContextMenuItems } = require('airdcpp-apisocket');
// Imports AirDC++’s API socket function to add context menu items in search results and filelists.
// Used in extension.onStart to register menus for adding TTHs to internal_blocklist.json.
// Note: The use of `grouped_search_result` in addContextMenuItems causes the `No such hook` error in AirDC++ 4.22b-246-g54cf8; correct hook is `search_result_menu_items`.
// Reference: https://airdcpp-docs.lowpri.de/extensions/api.html#search_result_menu_items
// Linked to: extension.onStart(), addTTHFromSearch(), addTTHFromFilelist()

const SettingsManager = require('airdcpp-extension-settings');
// Manages extension settings, integrating with AirDC++’s settings UI for enabling/disabling blocklists and setting update intervals.
// Reference: https://github.com/airdcpp/airdcpp-extension-settings-js
// Linked to: updateSettingsDefinitions(), module.exports(), loadBlockedTTHs()

console.log('[TTH Block] Initializing module');
// Logs initialization to output.log for debugging, confirming the extension has started loading.
// Seen in logs: [8/27/2025 2:49:25 PM:63] Starting the extension...

// Suppress deprecation warnings for node-domexception and punycode to avoid cluttering logs with irrelevant warnings.
// This is a workaround for dependencies used by node-fetch or airdcpp-apisocket.
// Reference: https://nodejs.org/api/process.html#event-warning
process.on('warning', (warning) => {
  if (warning.name === 'DeprecationWarning' && (warning.message.includes('node-domexception') || warning.message.includes('punycode'))) {
    return;
  }
  console.warn(warning);
});

// Formats JSON blocklist files for consistent readability, especially for internal_blocklist.json.
// Ensures TTH objects are written on a single line for compactness while keeping other fields pretty-printed.
// Example input: { "tths": [{ "tth": "ABC...", "comment": "Test" }, ...] }
// Example output: Pretty JSON with tths array items on single lines.
// Linked to: validateBlocklistFile(), addToBlocklist(), fetchAndUpdateBlocklist()
function formatBlocklistJSON(data) {
  const prettyJSON = JSON.stringify(data, null, 2).split('\n');
  // Split JSON into lines for custom formatting.
  const result = [];
  let inTTHsArray = false;
  let tthObjectLines = [];
  
  for (let i = 0; i < prettyJSON.length; i++) {
    const line = prettyJSON[i];
    if (line.trim() === '"tths": [') {
      inTTHsArray = true;
      result.push(line);
      continue;
    }
    if (inTTHsArray && line.trim() === ']') {
      inTTHsArray = false;
      result.push(line);
      continue;
    }
    if (inTTHsArray) {
      tthObjectLines.push(line);
      if (line.trim() === '},' || line.trim() === '}') {
        // Combine TTH object lines into a single line for compactness.
        const singleLine = tthObjectLines.join(' ').replace(/\s+/g, ' ').replace('} ,', '},').trim();
        result.push(`    ${singleLine}`);
        tthObjectLines = [];
      }
    } else {
      result.push(line);
    }
  }
  
  return result.join('\n');
}

// Ensures the blocklist directory exists, creating it if necessary.
// Prevents ENOENT errors seen in logs when accessing BLOCKLIST_DIR.
// Uses synchronous mkdirSync for initialization to ensure the directory is ready before proceeding.
// Linked to: module.exports(), getBlocklistFiles()
function ensureBlocklistDir() {
  try {
    if (!fs.existsSync(BLOCKLIST_DIR)) {
      fs.mkdirSync(BLOCKLIST_DIR, { recursive: true });
      console.log(`[TTH Block] Created blocklist directory: ${BLOCKLIST_DIR}`);
      // Logs directory creation to output.log, e.g., [TTH Block] Created blocklist directory: L:\AirDC_Test\Settings\extensions\airdcpp-tthblock-extension\package\blocklists
    }
  } catch (err) {
    console.error(`[TTH Block] Failed to create blocklist directory: ${err.message}`);
    // Logs errors to error.log and notifies via socket.post('events').
  }
}

// Validates a TTH string to ensure it’s a 39-character base32 string (A-Z, 2-7).
// Used to check TTHs in blocklists and context menu actions to prevent invalid entries.
// Reference: https://en.wikipedia.org/wiki/Tiger_(hash_function)#TTH
// Linked to: loadBlockedTTHs(), addTTHFromSearch(), addTTHFromFilelist()
function isValidTTH(id) {
  const tthRegex = /^[A-Z2-7]{39}$/;
  // Matches exactly 39 characters of base32 (A-Z, 2-7, uppercase).
  if (!tthRegex.test(id)) {
    const invalidChars = id.split('').filter(c => !/[A-Z2-7]/.test(c)).join('');
    const errorMessage = `[TTH Block] Invalid TTH: ${id} (must be 39 characters, base32 A-Z/2-7${
      invalidChars ? `, found invalid characters: ${invalidChars}` : ''
    })`;
    console.warn(errorMessage);
    return false;
  }
  return true;
}

// Checks if a blocklist URL is valid for remote fetching (HTTP/HTTPS, preferably raw GitHub URLs).
// Allows 'Internal' for internal_blocklist.json and validates URLs for remote blocklists.
// Example: https://raw.githubusercontent.com/user/repo/main/blocklist.json
// Linked to: getBlocklistFiles(), fetchAndUpdateBlocklist(), updateSettingsDefinitions()
function isValidBlocklistURL(url) {
  if (url === 'Internal') return true;
  try {
    const parsed = new URL(url);
    const isValidProtocol = parsed.protocol === 'https:' || parsed.protocol === 'http:';
    const isRawURL = parsed.hostname.includes('raw.githubusercontent.com') || parsed.pathname.includes('/raw/');
    // Prefers raw GitHub URLs for JSON files, as they’re common for blocklists.
    return isValidProtocol && isRawURL;
  } catch (err) {
    return false;
  }
}

// Validates a blocklist file’s JSON structure and initializes empty or invalid files.
// Ensures blocklists have a valid tths array and metadata (url, version, updated_at, description).
// Resets invalid files to a default structure to prevent crashes.
// Linked to: getBlocklistFiles(), loadBlockedTTHs(), updateSingleBlocklist()
function validateBlocklistFile(filePath, socket) {
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    if (data.trim() === '') {
      console.log(`[TTH Block] Blocklist ${filePath} is empty, initializing`);
      const defaultBlocklist = {
        url: filePath === INTERNAL_BLOCKLIST_FILE ? 'Internal' : null,
        version: filePath === INTERNAL_BLOCKLIST_FILE ? 'Internal' : '1.0.0',
        updated_at: new Date().toISOString(),
        description: filePath === INTERNAL_BLOCKLIST_FILE ? 'Internal' : path.basename(filePath, '.json'),
        tths: []
      };
      fs.writeFileSync(filePath, formatBlocklistJSON(defaultBlocklist), 'utf-8');
      socket.post('events', {
        text: `Blocklist ${path.basename(filePath)} was empty and has been initialized`,
        severity: 'info'
      });
      return { valid: true, url: defaultBlocklist.url, version: defaultBlocklist.version, updated_at: defaultBlocklist.updated_at, description: defaultBlocklist.description };
    }
    const blocklist = JSON.parse(data);
    if (!blocklist.url || blocklist.url === null || !isValidBlocklistURL(blocklist.url)) {
      console.log(`[TTH Block] Treating ${filePath} as local read-only blocklist (URL: ${blocklist.url || 'none'})`);
      return {
        valid: true,
        url: null,
        version: blocklist.version || '1.0.0',
        updated_at: blocklist.updated_at || new Date().toISOString(),
        description: blocklist.description || path.basename(filePath, '.json')
      };
    }
    if (!Array.isArray(blocklist.tths)) {
      console.error(`[TTH Block] Invalid blocklist format in ${filePath}: 'tths' not an array`);
      socket.post('events', {
        text: `Invalid format in blocklist ${path.basename(filePath)}: 'tths' is not an array`,
        severity: 'error'
      });
      return { valid: false, url: blocklist.url, version: blocklist.version || '1.0.0', updated_at: blocklist.updated_at || new Date().toISOString(), description: blocklist.description || '' };
    }
    const hasValidTTH = blocklist.tths.some(item => item.tth && isValidTTH(item.tth));
    if (!hasValidTTH && blocklist.tths.length > 0) {
      console.error(`[TTH Block] No valid TTHs found in ${filePath}`);
      socket.post('events', {
        text: `No valid TTHs found in blocklist ${path.basename(filePath)}`,
        severity: 'error'
      });
      return { valid: false, url: blocklist.url, version: blocklist.version || '1.0.0', updated_at: blocklist.updated_at || new Date().toISOString(), description: blocklist.description || '' };
    }
    return {
      valid: true,
      url: blocklist.url,
      version: blocklist.version || '1.0.0',
      updated_at: blocklist.updated_at || new Date().toISOString(),
      description: blocklist.description || path.basename(filePath, '.json')
    };
  } catch (err) {
    console.error(`[TTH Block] Failed to validate blocklist ${filePath}: ${err.message}`);
    socket.post('events', {
      text: `Failed to validate blocklist ${path.basename(filePath)}: ${err.message}. Resetting to default`,
      severity: 'error'
    });
    const defaultBlocklist = {
      url: filePath === INTERNAL_BLOCKLIST_FILE ? 'Internal' : null,
      version: filePath === INTERNAL_BLOCKLIST_FILE ? 'Internal' : '1.0.0',
      updated_at: new Date().toISOString(),
      description: filePath === INTERNAL_BLOCKLIST_FILE ? 'Internal' : path.basename(filePath, '.json'),
      tths: []
    };
    try {
      fs.writeFileSync(filePath, formatBlocklistJSON(defaultBlocklist), 'utf-8');
      console.log(`[TTH Block] Reset ${filePath} to default structure`);
      return { valid: true, url: defaultBlocklist.url, version: defaultBlocklist.version, updated_at: defaultBlocklist.updated_at, description: defaultBlocklist.description };
    } catch (writeErr) {
      console.error(`[TTH Block] Failed to reset blocklist ${filePath}: ${writeErr.message}`);
      socket.post('events', {
        text: `Failed to reset blocklist ${path.basename(filePath)}: ${writeErr.message}`,
        severity: 'error'
      });
      return { valid: false, url: null, version: '1.0.0', updated_at: new Date().toISOString(), description: '' };
    }
  }
}

// Scans BLOCKLIST_DIR for JSON blocklist files and validates their structure.
// Populates blocklistFiles array with metadata for use in settings and TTH loading.
// Returns an array to prevent `r.filter is not a function` errors seen in logs.
// Linked to: validateBlocklistFile(), loadBlockedTTHs(), updateSettingsDefinitions()
function getBlocklistFiles(socket) {
  try {
    const files = fs.readdirSync(BLOCKLIST_DIR).filter(file => file.endsWith('.json'));
    const blocklists = files
      .map(file => {
        const filePath = path.join(BLOCKLIST_DIR, file);
        const { valid, url, version, updated_at, description } = validateBlocklistFile(filePath, socket);
        if (valid) {
          const stats = fs.statSync(filePath);
          return { file, path: filePath, mtime: stats.mtimeMs, url, version, updated_at, description };
        }
        return null;
      })
      .filter(b => b !== null);
    console.log(`[TTH Block] Found valid blocklist files: ${blocklists.map(b => b.file).join(', ') || 'none'}`);
    // Seen in logs: [TTH Block] Found valid blocklist files: internal_blocklist.json
    return blocklists;
  } catch (err) {
    console.error(`[TTH Block] Failed to read blocklist directory: ${err.message}`);
    socket.post('events', {
      text: `Failed to read blocklist directory: ${err.message}`,
      severity: 'error'
    });
    return [];
    // Always return an array to avoid `r.filter is not a function` errors.
  }
}

// Updates AirDC++ settings UI with dynamic blocklist settings (enable/disable toggles and update interval).
// Handles 409 conflicts by caching settings and falling back to minimal settings.
// Linked to: module.exports(), loadBlockedTTHs(), watchBlocklistDir()
async function updateSettingsDefinitions(socket, extension, localBlocklists, remoteBlocklists, settings) {
  const SettingDefinitions = [
    {
      key: 'internal_block_list',
      title: 'Internal blocklist',
      default_value: true,
      type: 'boolean'
    },
    ...localBlocklists
      .filter(blocklist => blocklist.file !== path.basename(INTERNAL_BLOCKLIST_FILE))
      .map(blocklist => ({
        key: `blocklist_${blocklist.file}`,
        title: `Local: ${blocklist.file}`,
        default_value: true,
        type: 'boolean'
      })),
    {
      key: 'update_interval',
      title: 'Update interval for remote blocklists (minutes)',
      default_value: 60,
      type: 'number',
      min: 1
    },
    ...remoteBlocklists.map(blocklist => ({
      key: `blocklist_${blocklist.file}`,
      title: `Remote: ${blocklist.file}${blocklist.description ? ` (${blocklist.description})` : ''}`,
      default_value: true,
      type: 'boolean'
    }))
  ];
  console.log(`[TTH Block] Proposed settings definitions:`, JSON.stringify(SettingDefinitions, null, 2));
  // Logs settings for debugging, seen in output.log.

  const cacheFile = path.join(extension.configPath, 'settings_cache.json');
  // Cache file to prevent redundant settings updates.
  let lastAttemptedSettings = null;
  try {
    if (fs.existsSync(cacheFile)) {
      lastAttemptedSettings = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    }
  } catch (err) {
    console.warn(`[TTH Block] Failed to read settings cache: ${err.message}`);
  }

  try {
    const existingDefinitions = await socket.get(`extensions/${extension.name}/settings/definitions`) || [];
    console.log(`[TTH Block] Existing settings definitions:`, JSON.stringify(existingDefinitions, null, 2));
    
    if (JSON.stringify(existingDefinitions) === JSON.stringify(SettingDefinitions)) {
      console.log(`[TTH Block] Settings definitions match existing, skipping update`);
      fs.writeFileSync(cacheFile, JSON.stringify(SettingDefinitions, null, 2), 'utf-8');
      return;
    }
    if (lastAttemptedSettings && JSON.stringify(lastAttemptedSettings) === JSON.stringify(SettingDefinitions)) {
      console.log(`[TTH Block] Settings definitions match last attempt, skipping update`);
      return;
    }

    console.log(`[TTH Block] Settings definitions differ, attempting update`);
    try {
      await socket.post(`extensions/${extension.name}/settings/definitions`, SettingDefinitions);
      console.log(`[TTH Block] Updated settings definitions with ${localBlocklists.length} local and ${remoteBlocklists.length} remote blocklists`);
      await socket.post('events', {
        text: `Updated settings with blocklists: ${[...localBlocklists, ...remoteBlocklists].map(b => b.file).join(', ')}`,
        severity: 'info'
      });
      // Seen in logs: [8/27/2025 2:49:25 PM:121] Updated settings with blocklists: internal_blocklist.json
      fs.writeFileSync(cacheFile, JSON.stringify(SettingDefinitions, null, 2), 'utf-8');
      await settings.save();
      console.log(`[TTH Block] Forced settings reload via SettingsManager.save()`);
    } catch (postErr) {
      if (postErr.message.includes('409') || postErr.message.includes('Setting definitions exist')) {
        console.warn(`[TTH Block] 409 conflict detected, using existing settings and caching attempt`);
        fs.writeFileSync(cacheFile, JSON.stringify(SettingDefinitions, null, 2), 'utf-8');
        if (!fs.existsSync(path.join(extension.configPath, 'conflict_notified'))) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          // Delay to ensure socket authentication, addressing auth errors from 1.20.51.
          try {
            await socket.post('events', {
              text: `Failed to update blocklist settings (409 conflict). Please uninstall and reinstall the TTH Blocker Extension in Settings > Extensions to reset settings.`,
              severity: 'error'
            });
            fs.writeFileSync(path.join(extension.configPath, 'conflict_notified'), '1', 'utf-8');
          } catch (authErr) {
            console.error(`[TTH Block] Failed to post 409 conflict event: ${authErr.message}`);
          }
        }
        const minimalSettings = [
          {
            key: 'internal_block_list',
            title: 'Internal blocklist',
            default_value: true,
            type: 'boolean'
          },
          {
            key: 'update_interval',
            title: 'Update interval for remote blocklists (minutes)',
            default_value: 60,
            type: 'number',
            min: 1
          }
        ];
        try {
          await socket.post(`extensions/${extension.name}/settings/definitions`, minimalSettings);
          await settings.save();
          console.log(`[TTH Block] Applied minimal settings as fallback`);
        } catch (minimalErr) {
          console.error(`[TTH Block] Failed to apply minimal settings: ${minimalErr.message}`);
        }
      } else {
        throw postErr;
      }
    }
  } catch (err) {
    console.error(`[TTH Block] Failed to update settings definitions: ${err.message}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      await socket.post('events', {
        text: `Failed to update settings definitions: ${err.message}. Please uninstall and reinstall the extension to reset settings.`,
        severity: 'error'
      });
    } catch (authErr) {
      console.error(`[TTH Block] Failed to post error event: ${authErr.message}`);
    }
  }
}

// Loads TTHs from enabled blocklists into blockedTTHSet for download blocking.
// Validates settings and blocklist formats, initializing or resetting invalid files.
// Linked to: validateBlocklistFile(), updateSingleBlocklist(), addToBlocklist()
function loadBlockedTTHs(socket, settings) {
  if (!settings || typeof settings.getValue !== 'function') {
    console.error(`[TTH Block] Settings object is invalid, skipping blocklist load`);
    socket.post('events', {
      text: `Settings object is invalid, skipping blocklist load`,
      severity: 'error'
    });
    return;
  }

  blockedTTHSet.clear();
  blocklistTTHMap.clear();
  blocklistVersions.clear();

  if (settings.getValue('internal_block_list')) {
    try {
      if (fs.existsSync(INTERNAL_BLOCKLIST_FILE)) {
        const data = fs.readFileSync(INTERNAL_BLOCKLIST_FILE, 'utf-8');
        if (data.trim() === '') {
          console.log(`[TTH Block] Internal blocklist is empty, initializing`);
          const defaultBlocklist = {
            url: 'Internal',
            version: 'Internal',
            updated_at: new Date().toISOString(),
            description: 'Internal',
            tths: []
          };
          fs.writeFileSync(INTERNAL_BLOCKLIST_FILE, formatBlocklistJSON(defaultBlocklist), 'utf-8');
          socket.post('events', {
            text: `Internal blocklist was empty and has been initialized`,
            severity: 'info'
          });
        } else {
          const blocklist = JSON.parse(data);
          if (blocklist.url === 'Internal' && Array.isArray(blocklist.tths)) {
            const tthSet = new Set();
            blocklist.tths.forEach(item => {
              if (item.tth && isValidTTH(item.tth)) {
                blockedTTHSet.add(item.tth);
                tthSet.add(item.tth);
              }
            });
            blocklistTTHMap.set(path.basename(INTERNAL_BLOCKLIST_FILE), tthSet);
            blocklistVersions.set(path.basename(INTERNAL_BLOCKLIST_FILE), blocklist.version || blocklist.updated_at || null);
            console.log(`[TTH Block] Loaded ${tthSet.size} TTH(s) from internal blocklist ${INTERNAL_BLOCKLIST_FILE} (description: ${blocklist.description || 'none'})`);
            // Seen in logs: [TTH Block] Loaded 0 TTH(s) from internal blocklist internal_blocklist.json
          } else {
            console.warn(`[TTH Block] Invalid format in ${INTERNAL_BLOCKLIST_FILE}, initializing`);
            const defaultBlocklist = {
              url: 'Internal',
              version: 'Internal',
              updated_at: new Date().toISOString(),
              description: 'Internal',
              tths: []
            };
            fs.writeFileSync(INTERNAL_BLOCKLIST_FILE, formatBlocklistJSON(defaultBlocklist), 'utf-8');
            socket.post('events', {
              text: `Invalid format in internal blocklist, reset to default`,
              severity: 'error'
            });
          }
        }
      } else {
        console.log(`[TTH Block] Internal blocklist not found, creating ${INTERNAL_BLOCKLIST_FILE}`);
        const defaultBlocklist = {
          url: 'Internal',
          version: 'Internal',
          updated_at: new Date().toISOString(),
          description: 'Internal',
          tths: []
        };
        fs.writeFileSync(INTERNAL_BLOCKLIST_FILE, formatBlocklistJSON(defaultBlocklist), 'utf-8');
        socket.post('events', {
          text: `Internal blocklist not found, created default`,
          severity: 'info'
        });
      }
    } catch (err) {
      console.error(`[TTH Block] Failed to load internal blocklist: ${err.message}`);
      socket.post('events', {
        text: `Failed to load internal blocklist: ${err.message}`,
        severity: 'error'
      });
    }
  } else {
    console.log(`[TTH Block] Internal blocklist disabled in settings, skipping load`);
  }

  blocklistFiles.forEach(blocklist => {
    if (blocklist.file === path.basename(INTERNAL_BLOCKLIST_FILE)) return;
    const settingKey = `blocklist_${blocklist.file}`;
    let settingValue;
    try {
      settingValue = settings.getValue(settingKey);
    } catch (err) {
      console.warn(`[TTH Block] Setting ${settingKey} not found, assuming enabled`);
      settingValue = true;
    }
    if (settingValue) {
      try {
        const data = fs.readFileSync(blocklist.path, 'utf-8');
        if (data.trim() === '') {
          console.log(`[TTH Block] Blocklist ${blocklist.file} is empty, skipping`);
          return;
        }
        const blocklistData = JSON.parse(data);
        if (Array.isArray(blocklistData.tths)) {
          const tthSet = new Set();
          blocklistData.tths.forEach(item => {
            if (item.tth && isValidTTH(item.tth)) {
              blockedTTHSet.add(item.tth);
              tthSet.add(item.tth);
            }
          });
          blocklistTTHMap.set(blocklist.file, tthSet);
          blocklistVersions.set(blocklist.file, blocklistData.version || blocklistData.updated_at || null);
          const type = blocklist.url && isValidBlocklistURL(blocklist.url) && blocklist.url !== 'Internal' ? 'remote' : 'local read-only';
          console.log(`[TTH Block] Loaded ${tthSet.size} TTH(s) from ${type} blocklist ${blocklist.file} (version: ${blocklistData.version || 'none'}, description: ${blocklistData.description || 'none'})`);
        } else {
          console.error(`[TTH Block] Invalid format in ${blocklist.file}, skipping`);
          socket.post('events', {
            text: `Invalid format in blocklist ${blocklist.file}: 'tths' is not an array`,
            severity: 'error'
          });
        }
      } catch (err) {
        console.error(`[TTH Block] Failed to load blocklist ${blocklist.file}: ${err.message}`);
        socket.post('events', {
          text: `Failed to load blocklist ${blocklist.file}: ${err.message}`,
          severity: 'error'
        });
      }
    } else {
      console.log(`[TTH Block] Blocklist ${blocklist.file} disabled in settings, skipping load`);
    }
  });
}

// Updates a single blocklist file’s TTHs in blockedTTHSet, checking for changes via mtime.
// Used for both manual file changes and remote updates to ensure TTHs are reloaded correctly.
// Linked to: watchBlocklistDir(), fetchAndUpdateBlocklist()
async function updateSingleBlocklist(socket, settings, filename, isFetchUpdate = false) {
  const blocklist = blocklistFiles.find(b => b.file === filename);
  if (!blocklist) {
    console.log(`[TTH Block] Blocklist ${filename} not found in blocklistFiles, treating as new`);
    return false;
  }
  const filePath = blocklist.path;
  const stats = fs.statSync(filePath);
  if (lastUpdateWriteTime.get(filename) === stats.mtimeMs) {
    console.log(`[TTH Block] Skipping reload for ${filename}: no change since last update (mtime: ${stats.mtimeMs})`);
    return false;
  }
  lastUpdateWriteTime.set(filename, stats.mtimeMs);

  const oldTTHs = blocklistTTHMap.get(filename) || new Set();
  oldTTHs.forEach(tth => blockedTTHSet.delete(tth));
  blocklistTTHMap.delete(filename);
  console.log(`[TTH Block] Unloaded ${oldTTHs.size} TTH(s) from ${filename}`);

  const settingKey = filename === path.basename(INTERNAL_BLOCKLIST_FILE) ? 'internal_block_list' : `blocklist_${filename}`;
  let settingValue;
  try {
    settingValue = settings.getValue(settingKey);
  } catch (err) {
    console.warn(`[TTH Block] Setting ${settingKey} not found, assuming enabled`);
    settingValue = true;
  }
  if (settingValue) {
    if (validateBlocklistFile(filePath, socket).valid) {
      try {
        const data = fs.readFileSync(filePath, 'utf-8');
        const blocklistData = JSON.parse(data);
        const tthSet = new Set();
        blocklistData.tths.forEach(item => {
          if (item.tth && isValidTTH(item.tth)) {
            blockedTTHSet.add(item.tth);
            tthSet.add(item.tth);
          }
        });
        blocklistTTHMap.set(filename, tthSet);
        blocklistVersions.set(filename, blocklistData.version || blocklistData.updated_at || null);
        const type = filename === path.basename(INTERNAL_BLOCKLIST_FILE) ? 'internal' : (blocklist.url && isValidBlocklistURL(blocklist.url) && blocklist.url !== 'Internal' ? 'remote' : 'local read-only');
        console.log(`[TTH Block] Loaded ${tthSet.size} TTH(s) from ${type} blocklist ${filename} (version: ${blocklistData.version || 'none'}, description: ${blocklistData.description || 'none'})`);
        return true;
      } catch (err) {
        console.error(`[TTH Block] Failed to reload blocklist ${filename}: ${err.message}`);
        socket.post('events', {
          text: `Failed to reload blocklist ${filename}: ${err.message}`,
          severity: 'error'
        });
      }
    } else {
      console.log(`[TTH Block] Blocklist ${filename} is invalid after update, not reloaded`);
    }
  } else {
    console.log(`[TTH Block] Blocklist ${filename} is disabled, not reloaded`);
  }
  return false;
}

// Fetches and updates a remote blocklist, using ETags to avoid redundant downloads.
// Retries on failure and updates blocklistVersions and blocklistETags.
// Linked to: scheduleBlocklistUpdates(), updateSingleBlocklist()
async function fetchAndUpdateBlocklist(socket, settings, blocklist, retries = 3, delay = 1000) {
  if (blocklist.url === 'Internal') {
    console.log(`[TTH Block] Skipping update for ${blocklist.file} (Internal)`);
    return false;
  }
  if (!isValidBlocklistURL(blocklist.url)) {
    console.error(`[TTH Block] Invalid URL for ${blocklist.file}: ${blocklist.url}, skipping update`);
    await socket.post('events', {
      text: `Invalid URL for blocklist ${blocklist.file}: ${blocklist.url}`,
      severity: 'error'
    });
    return false;
  }
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const headers = blocklistETags.has(blocklist.file) ? { 'If-None-Match': blocklistETags.get(blocklist.file) } : {};
      console.log(`[TTH Block] Fetching ${blocklist.file} from ${blocklist.url} (attempt ${attempt}/${retries})`);
      const response = await fetch(blocklist.url, { headers });
      console.log(`[TTH Block] Response headers for ${blocklist.file}:`, Object.fromEntries(response.headers));
      if (response.status === 304) {
        console.log(`[TTH Block] No changes for ${blocklist.file} (HTTP 304: Not Modified)`);
        return false;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json') && !contentType.includes('text/plain')) {
        throw new Error(`Invalid content type: ${contentType}, expected application/json or text/plain`);
      }
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        throw new Error(`Invalid JSON: ${err.message}`);
      }
      if (!Array.isArray(data.tths)) {
        throw new Error('Invalid JSON format: tths not an array');
      }
      const newVersion = data.version || data.updated_at || null;
      const oldVersion = blocklistVersions.get(blocklist.file);
      if (newVersion && oldVersion === newVersion) {
        console.log(`[TTH Block] No version change for ${blocklist.file} (version: ${newVersion})`);
        return false;
      }
      const etag = response.headers.get('ETag') || '';
      blocklistETags.set(blocklist.file, etag);
      blocklistVersions.set(blocklist.file, newVersion);
      lastUpdateWriteTime.set(blocklist.file, Date.now());
      fs.writeFileSync(blocklist.path, formatBlocklistJSON(data), 'utf-8');
      const stats = fs.statSync(blocklist.path);
      console.log(`[TTH Block] Updated ${blocklist.file} from ${blocklist.url} (version: ${newVersion || 'none'}, size: ${stats.size} bytes, description: ${data.description || 'none'})`);
      await socket.post('events', {
        text: `Updated blocklist ${blocklist.file} from ${blocklist.url} with ${data.tths.length} TTH(s) (version: ${newVersion || 'none'}, size: ${stats.size} bytes)`,
        severity: 'info'
      });
      console.log(`[TTH Block] Note: Updates may be delayed up to 5 minutes due to GitHub CDN caching (max-age=300)`);
      return true;
    } catch (err) {
      console.error(`[TTH Block] Failed to update ${blocklist.file} from ${blocklist.url} (attempt ${attempt}/${retries}): ${err.message}`);
      if (attempt < retries && !err.message.includes('HTTP 304')) {
        console.log(`[TTH Block] Retrying ${blocklist.file} in ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        await socket.post('events', {
          text: `Failed to update blocklist ${blocklist.file}: ${err.message}`,
          severity: 'error'
        });
        return false;
      }
    }
  }
}

// Schedules periodic updates for remote blocklists based on the update_interval setting.
// Clears previous intervals to prevent memory leaks.
// Linked to: fetchAndUpdateBlocklist(), extension.onStop()
function scheduleBlocklistUpdates(socket, settings, extension) {
  if (updateIntervalId) {
    clearInterval(updateIntervalId);
    console.log('[TTH Block] Cleared previous update interval');
  }
  const interval = (settings.getValue('update_interval') || 60) * 60 * 1000;
  updateIntervalId = setInterval(async () => {
    console.log('[TTH Block] Checking for remote blocklist updates');
    for (const blocklist of blocklistFiles) {
      if (blocklist.url && blocklist.url !== 'Internal' && isValidBlocklistURL(blocklist.url)) {
        const updated = await fetchAndUpdateBlocklist(socket, settings, blocklist);
        if (updated) {
          updateSingleBlocklist(socket, settings, blocklist.file, true);
        }
      }
    }
  }, interval);
  console.log(`[TTH Block] Scheduled blocklist updates every ${interval / 60000} minutes`);
  // Seen in logs: [TTH Block] Scheduled blocklist updates every 60 minutes
}

// Retrieves TTH from a search result by checking if the ID is a TTH or fetching via API.
// Handles cases where search results may not have TTHs directly.
// Linked to: addToBlocklist()
async function addTTHFromSearch(socket, entityId, resultId) {
  if (isValidTTH(resultId)) {
    console.log(`[TTH Block] Search result ID ${resultId} is a valid TTH, using directly`);
    return resultId;
  } else {
    console.log(`[TTH Block] Search result ID ${resultId} is not a valid TTH, attempting API fetch`);
    try {
      const results = await socket.get(`search/instances/${entityId}/results`);
      console.log(`[TTH Block] Search results for instance ${entityId}:`, JSON.stringify(results, null, 2));
      const result = results.find(r => r.id === resultId);
      if (result) {
        console.log(`[TTH Block] Found search result for ID ${resultId}:`, JSON.stringify(result, null, 2));
        if (result.type === 'file' && result.tth) {
          return result.tth;
        } else {
          console.log(`[TTH Block] Search result ${resultId} is not a file or has no TTH`);
        }
      } else {
        console.log(`[TTH Block] Search result ${resultId} not found in results list`);
      }
    } catch (err) {
      console.error(`[TTH Block] Failed to fetch search results for instance ${entityId}:`, JSON.stringify(err, null, 2));
    }
  }
  return null;
}

// Retrieves TTH from a filelist item, ensuring it’s a file (not a directory) and has a valid TTH.
// Requires the filelist directory to be fully loaded in the AirDC++ UI.
// Linked to: addToBlocklist()
async function addTTHFromFilelist(socket, entityId, itemId) {
  console.log(`[TTH Block] Entering addTTHFromFilelist with entityId: ${entityId}, itemId: ${itemId}`);
  let filelistPath = 'unknown';
  try {
    const filelistSession = await socket.get(`filelists/${entityId}`);
    filelistPath = filelistSession.location?.path || 'unknown';
    console.log(`[TTH Block] Filelist session for ${entityId} at path ${filelistPath}:`, JSON.stringify(filelistSession, null, 2));
  } catch (err) {
    console.error(`[TTH Block] Failed to fetch filelist session for ${entityId}:`, JSON.stringify(err, null, 2));
  }
  try {
    console.log(`[TTH Block] Attempting API call: GET filelists/${entityId}/items/${itemId}`);
    const item = await socket.get(`filelists/${entityId}/items/${itemId}`);
    console.log(`[TTH Block] Retrieved item ${itemId} from filelist ${entityId} at path ${item.path || filelistPath}:`, JSON.stringify(item, null, 2));
    if (item && item.type && item.type.id === 'directory') {
      console.log(`[TTH Block] Selected item ${itemId} is a directory, skipping TTH addition`);
      await socket.post('events', {
        text: `Cannot add TTH for item ${itemId} in filelist ${entityId} (path: ${item.path || filelistPath}): selected item is a directory`,
        severity: 'warning',
      });
      return null;
    }
    if (item && item.type && item.type.id === 'file' && item.tth) {
      console.log(`[TTH Block] Found valid TTH for item ${itemId}: ${item.tth}`);
      return item.tth;
    } else {
      console.log(`[TTH Block] Filelist item ${itemId} has no TTH or is invalid:`, JSON.stringify(item, null, 2));
    }
  } catch (err) {
    console.error(`[TTH Block] Failed to fetch filelist item ${itemId}:`, JSON.stringify(err, null, 2));
    console.warn(`[TTH Block] Failed to fetch item ${itemId} in filelist ${entityId} (path: ${filelistPath}). Ensure you have navigated into the directory containing the file and it is fully loaded in the AirDC++ UI`);
    await socket.post('events', {
      text: `Failed to add TTH for item ${itemId} in filelist ${entityId} (path: ${filelistPath}). Ensure you have navigated into the directory containing the file and it is fully loaded in the AirDC++ UI`,
      severity: 'warning',
    });
    return null;
  }
}

// Adds TTHs to internal_blocklist.json from search results or filelists via context menu actions.
// Validates settings and TTHs, updating blockedTTHSet and blocklistTTHMap.
// Linked to: addTTHFromSearch(), addTTHFromFilelist(), formatBlocklistJSON()
async function addToBlocklist(socket, settings, selectedIds, entityId, menuType) {
  if (!settings || typeof settings.getValue !== 'function') {
    console.error(`[TTH Block] Settings object is invalid, cannot add to blocklist`);
    await socket.post('events', {
      text: `Cannot add TTHs to blocklist: settings are invalid`,
      severity: 'error',
    });
    return;
  }
  if (!settings.getValue('internal_block_list')) {
    console.log(`[TTH Block] Internal blocklist is disabled, skipping TTH addition`);
    await socket.post('events', {
      text: `Internal blocklist is disabled. Enable it in the extension settings to add TTHs`,
      severity: 'warning',
    });
    return;
  }
  console.log(`[TTH Block] Adding to blocklist from ${menuType} with entityId ${entityId} and selectedIds:`, selectedIds);
  const addedTTHs = [];
  for (const id of selectedIds) {
    let tth = null;
    if (menuType === 'grouped_search_result') {
      tth = await addTTHFromSearch(socket, entityId, id);
    } else if (menuType === 'filelist_item') {
      tth = await addTTHFromFilelist(socket, entityId, id);
    }
    if (tth && !blockedTTHSet.has(tth)) {
      blockedTTHSet.add(tth);
      const tthSet = blocklistTTHMap.get(path.basename(INTERNAL_BLOCKLIST_FILE)) || new Set();
      tthSet.add(tth);
      blocklistTTHMap.set(path.basename(INTERNAL_BLOCKLIST_FILE), tthSet);
      addedTTHs.push({ tth, comment: '', timestamp: new Date().toISOString() });
    } else if (tth) {
      console.log(`[TTH Block] TTH ${tth} already in blocklist, skipping`);
    }
  }
  if (addedTTHs.length > 0) {
    try {
      let blocklist = {
        url: 'Internal',
        version: 'Internal',
        updated_at: new Date().toISOString(),
        description: 'Internal',
        tths: []
      };
      if (fs.existsSync(INTERNAL_BLOCKLIST_FILE)) {
        const data = fs.readFileSync(INTERNAL_BLOCKLIST_FILE, 'utf-8');
        if (data.trim() !== '') {
          blocklist = JSON.parse(data);
          if (!Array.isArray(blocklist.tths)) {
            console.warn(`[TTH Block] Invalid blocklist format in ${INTERNAL_BLOCKLIST_FILE}, resetting tths`);
            blocklist.tths = [];
          }
        }
      }
      blocklist.tths.push(...addedTTHs);
      blocklist.updated_at = new Date().toISOString();
      fs.writeFileSync(INTERNAL_BLOCKLIST_FILE, formatBlocklistJSON(blocklist), 'utf-8');
      lastUpdateWriteTime.set(path.basename(INTERNAL_BLOCKLIST_FILE), Date.now());
      console.log(`[TTH Block] Added ${addedTTHs.length} TTH(s) to ${INTERNAL_BLOCKLIST_FILE}`);
      await socket.post('events', {
        text: `Added ${addedTTHs.length} TTH(s) to internal blocklist: ${addedTTHs.map(item => item.tth).join(', ')}`,
        severity: 'info',
      });
    } catch (err) {
      console.error(`[TTH Block] Failed to write blocklist file: ${err.message}`);
      await socket.post('events', {
        text: `Failed to write to internal blocklist: ${err.message}`,
        severity: 'error',
      });
    }
  } else {
    console.log(`[TTH Block] No valid TTHs to add from ${menuType}`);
    await socket.post('events', {
      text: `No valid TTHs to add from ${menuType === 'grouped_search_result' ? 'search results' : 'filelist'}. Ensure selected items are files and fully loaded in the UI`,
      severity: 'warning',
    });
  }
}

// Watches BLOCKLIST_DIR for changes to JSON files, updating settings and TTHs as needed.
// Uses debouncing to handle rapid file changes and prevent redundant reloads.
// Linked to: getBlocklistFiles(), updateSingleBlocklist(), updateSettingsDefinitions()
async function watchBlocklistDir(socket, settings, extension) {
  let debounceTimeout;
  let pendingNewBlocklists = [];
  try {
    fs.watch(BLOCKLIST_DIR, (eventType, filename) => {
      if (filename && filename.endsWith('.json')) {
        clearTimeout(debounceTimeout);
        debounceTimeout = setTimeout(async () => {
          console.log(`[TTH Block] Detected change in blocklist directory: ${filename} (${eventType})`);
          const filePath = path.join(BLOCKLIST_DIR, filename);
          try {
            const stats = fs.statSync(filePath);
            if (lastUpdateWriteTime.get(filename) === stats.mtimeMs) {
              console.log(`[TTH Block] Skipping reload for ${filename}: no change since last update (mtime: ${stats.mtimeMs})`);
              return;
            }
            if (Date.now() - (lastUpdateWriteTime.get(filename) || 0) < 2000) {
              console.log(`[TTH Block] Skipping reload for ${filename} due to recent fetch update`);
              return;
            }
            const oldBlocklists = [...blocklistFiles];
            blocklistFiles = getBlocklistFiles(socket);
            const localBlocklists = blocklistFiles.filter(b => !b.url || b.url === 'Internal' || !isValidBlocklistURL(b.url));
            const remoteBlocklists = blocklistFiles.filter(b => b.url && b.url !== 'Internal' && isValidBlocklistURL(b.url));
            pendingNewBlocklists = blocklistFiles.filter(b => !oldBlocklists.some(ob => ob.file === b.file));
            const updatedBlocklist = blocklistFiles.find(b => b.file === filename);
            if (pendingNewBlocklists.length > 0) {
              console.log(`[TTH Block] New blocklists detected: ${pendingNewBlocklists.map(b => b.file).join(', ')}`);
              await updateSettingsDefinitions(socket, extension, localBlocklists, remoteBlocklists, settings);
              await socket.post('events', {
                text: `New blocklists detected: ${pendingNewBlocklists.map(b => b.file).join(', ')}. Enable them in Settings > Extensions > Configure`,
                severity: 'info'
              });
              console.log(`[TTH Block] Notified user: New blocklists ${pendingNewBlocklists.map(b => b.file).join(', ')} detected, settings updated`);
              pendingNewBlocklists.forEach(b => updateSingleBlocklist(socket, settings, b.file));
              pendingNewBlocklists = [];
            } else if (updatedBlocklist) {
              const oldBlocklist = oldBlocklists.find(b => b.file === filename);
              if (oldBlocklist && oldBlocklist.mtime !== updatedBlocklist.mtime) {
                updateSingleBlocklist(socket, settings, filename);
              }
            }
          } catch (err) {
            console.error(`[TTH Block] Error in watchBlocklistDir handler: ${err.message}`);
            socket.post('events', {
              text: `Error processing blocklist change for ${filename}: ${err.message}`,
              severity: 'error'
            });
          }
        }, 2000);
      }
    });
    console.log(`[TTH Block] Watching blocklist directory: ${BLOCKLIST_DIR}`);
    // Seen in logs: [TTH Block] Watching blocklist directory: L:\AirDC_Test\Settings\extensions\airdcpp-tthblock-extension\package\blocklists
  } catch (err) {
    console.error(`[TTH Block] Failed to start blocklist directory watcher: ${err.message}`);
    socket.post('events', {
      text: `Failed to start blocklist directory watcher: ${err.message}`,
      severity: 'error'
    });
  }
}

// Catches unhandled promise rejections to log errors and prevent crashes, addressing the UnhandledPromiseRejection seen in logs.
// Linked to: addContextMenuItems() in extension.onStart
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Promise Rejection:', reason);
});

// Main extension module, integrating with AirDC++ via socket and extension objects.
// Initializes settings, blocklists, context menus, and hooks.
// Reference: https://airdcpp-docs.lowpri.de/extensions/developing.html
module.exports = function (socket, extension) {
  console.log('[TTH Block] Module exported, initializing extension');
  ensureBlocklistDir();
  blocklistFiles = getBlocklistFiles(socket);

  let settings;
  try {
    const configFile = path.join(extension.configPath, 'config.json');
    // Example: L:\AirDC_Test\Settings\extensions\airdcpp-tthblock-extension\settings\config.json
    if (fs.existsSync(configFile)) {
      const data = fs.readFileSync(configFile, 'utf-8');
      if (data.trim() === '') {
        console.warn(`[TTH Block] Config file ${configFile} is empty, recreating with defaults`);
        fs.writeFileSync(configFile, JSON.stringify({ internal_block_list: true, update_interval: 60 }, null, 2), 'utf-8');
        socket.post('events', {
          text: `Config file was empty and has been initialized`,
          severity: 'info'
        });
      } else {
        try {
          JSON.parse(data); // Validate JSON
        } catch (err) {
          console.error(`[TTH Block] Invalid JSON in config file ${configFile}: ${err.message}, recreating with defaults`);
          fs.writeFileSync(configFile, JSON.stringify({ internal_block_list: true, update_interval: 60 }, null, 2), 'utf-8');
          socket.post('events', {
            text: `Invalid JSON in config file, reset to default`,
            severity: 'error'
          });
        }
      }
    } else {
      console.log(`[TTH Block] Config file ${configFile} not found, creating with defaults`);
      fs.writeFileSync(configFile, JSON.stringify({ internal_block_list: true, update_interval: 60 }, null, 2), 'utf-8');
      socket.post('events', {
        text: `Config file not found, created default`,
        severity: 'info'
      });
    }
    console.log(`[TTH Block] Initializing SettingsManager with config file: ${configFile}`);
    // Seen in logs: [TTH Block] Initializing SettingsManager with config file: L:\AirDC_Test\Settings\extensions\airdcpp-tthblock-extension\settings\config.json
    settings = SettingsManager(socket, {
      extensionName: extension.name,
      configFile: configFile,
      configVersion: CONFIG_VERSION,
      definitions: [
        {
          key: 'internal_block_list',
          title: 'Internal blocklist',
          default_value: true,
          type: 'boolean'
        },
        ...blocklistFiles
          .filter(blocklist => blocklist.file !== path.basename(INTERNAL_BLOCKLIST_FILE) && (!blocklist.url || !isValidBlocklistURL(blocklist.url) || blocklist.url === null))
          .map(blocklist => ({
            key: `blocklist_${blocklist.file}`,
            title: `Local: ${blocklist.file}`,
            default_value: true,
            type: 'boolean'
          })),
        {
          key: 'update_interval',
          title: 'Update interval for remote blocklists (minutes)',
          default_value: 60,
          type: 'number',
          min: 1
        },
        ...blocklistFiles
          .filter(blocklist => blocklist.url && blocklist.url !== 'Internal' && isValidBlocklistURL(blocklist.url))
          .map(blocklist => ({
            key: `blocklist_${blocklist.file}`,
            title: `Remote: ${blocklist.file}${blocklist.description ? ` (${blocklist.description})` : ''}`,
            default_value: true,
            type: 'boolean'
          }))
      ],
    });
    console.log(`[TTH Block] SettingsManager initialized successfully`);
    // Seen in logs: [TTH Block] SettingsManager initialized successfully
  } catch (err) {
    console.error(`[TTH Block] Failed to initialize SettingsManager: ${err.message}, falling back to default settings`);
    socket.post('events', {
      text: `Failed to initialize settings: ${err.message}, using default settings`,
      severity: 'error'
    });
    settings = {
      getValue: (key) => {
        console.warn(`[TTH Block] Using fallback settings for key ${key}`);
        const def = [
          { key: 'internal_block_list', default_value: true },
          { key: 'update_interval', default_value: 60 },
          ...blocklistFiles
            .filter(b => b.file !== path.basename(INTERNAL_BLOCKLIST_FILE))
            .map(b => ({ key: `blocklist_${b.file}`, default_value: true }))
        ].find(d => d.key === key);
        return def ? def.default_value : null;
      }
    };
  }

  extension.onStart = async (sessionInfo) => {
    console.log('[TTH Block] Entering onStart');
    // Seen in logs: [TTH Block] Entering onStart
    try {
      await settings.load();
      console.log(`[TTH Block] Settings loaded successfully`);
      blocklistFiles = getBlocklistFiles(socket);
      const localBlocklists = blocklistFiles.filter(b => !b.url || b.url === 'Internal' || !isValidBlocklistURL(b.url));
      const remoteBlocklists = blocklistFiles.filter(b => b.url && b.url !== 'Internal' && isValidBlocklistURL(b.url));
      await updateSettingsDefinitions(socket, extension, localBlocklists, remoteBlocklists, settings);
      loadBlockedTTHs(socket, settings);
      watchBlocklistDir(socket, settings, extension);
      scheduleBlocklistUpdates(socket, settings, extension);

      await socket.post('events', {
        text: `TTH Blocker Extension ${EXTENSION_VERSION} started. Ensure filelist directories are fully loaded in the UI before using the "Add TTH to blocklist" menu`,
        severity: 'info',
      });

      const subscriberInfo = {
        id: 'airdcpp-tthblock-extension',
        name: 'TTH Blocker Extension'
      };

      if (sessionInfo.system_info.api_feature_level >= 4) {
        console.log(`[TTH Block] Registering grouped_search_result menu items`);
        // Note: This causes the `No such hook: grouped_search_result_menu_items` error in AirDC++ 4.22b-246-g54cf8.
        // The correct hook is `search_result_menu_items`, leading to a 404 error and potential crash (UnhandledPromiseRejection).
        // Reference: https://airdcpp-docs.lowpri.de/extensions/api.html#search_result_menu_items
        addContextMenuItems(
          socket,
          [
            {
              id: 'add_tth_to_blocklist',
              title: 'Add TTH to blocklist',
              icon: { semantic: 'ban' },
              onClick: async (data) => {
                console.log('[TTH Block] Search menu item "add_tth_to_blocklist" clicked with data:', data);
                const { selectedIds, entityId } = data;
                await addToBlocklist(socket, settings, selectedIds, entityId, 'grouped_search_result');
              },
              access: 'search',
              filter: (data) => {
                console.log(`[TTH Block] Search menu filter result: true, data:`, data);
                return true;
              }
            }
          ],
          'grouped_search_result',
          subscriberInfo,
        );

        console.log(`[TTH Block] Registering filelist_item menu items`);
        addContextMenuItems(
          socket,
          [
            {
              id: 'add_tth_to_blocklist',
              title: 'Add TTH to blocklist',
              icon: { semantic: 'ban' },
              onClick: async (data) => {
                console.log('[TTH Block] Filelist menu item "add_tth_to_blocklist" clicked with data:', data);
                const { selectedIds, entityId } = data;
                await addToBlocklist(socket, settings, selectedIds, entityId, 'filelist_item');
              },
              access: 'filelists_view',
              filter: (data) => {
                console.log(`[TTH Block] Filelist menu filter result: true, data:`, data);
                return true;
              }
            }
          ],
          'filelist_item',
          subscriberInfo,
        );
      } else {
        console.warn(`[TTH Block] API feature level too low for menu items, need at least 4, current: ${sessionInfo.system_info.api_feature_level}`);
      }

      const queueSubscriberInfo = {
        id: 'airdcpp-tthblock-extension',
        name: 'TTH Blocker Extension',
        priority: 0
      };

      async function queueBundleFileAddHook(data, accept, reject) {
        try {
          console.log(`[TTH Block] Full data: ${JSON.stringify(data)}`);
          const fileData = data.file_data || {};
          console.log(`[TTH Block] Checking file: ${fileData.name || 'unknown'} with TTH: ${fileData.tth || 'none'}`);
          if (!settings || typeof settings.getValue !== 'function') {
            console.error(`[TTH Block] Settings object is invalid, allowing file by default`);
            accept();
            return;
          }
          if (fileData.tth && blockedTTHSet.has(fileData.tth)) {
            console.log(`[TTH Block] Blocked TTH found: ${fileData.tth}`);
            await socket.post('events', {
              text: `Blocked download for file '${fileData.name || 'unknown'}' (TTH: ${fileData.tth})`,
              severity: 'warning',
            });
            reject('blocked_tth', 'Download skipped: TTH is blocked by extension');
          } else {
            console.log(`[TTH Block] Allowing file: ${fileData.name || 'unknown'}`);
            accept();
          }
        } catch (err) {
          console.error(`[TTH Block] Error in queue_add_bundle_file_hook:`, err);
          accept();
        }
      }

      if (sessionInfo.system_info.api_feature_level >= 6) {
        socket.addHook('queue', 'queue_add_bundle_file_hook', queueBundleFileAddHook, queueSubscriberInfo);
        console.log('[TTH Block] Registered queue_add_bundle_file_hook');
        // Seen in logs: [TTH Block] Registered queue_add_bundle_file_hook
      } else {
        console.warn('[TTH Block] API feature level too low for queue_add_bundle_file_hook, need at least 6, current:', sessionInfo.system_info.api_feature_level);
      }

      console.log('[TTH Block] Extension started successfully');
      // Seen in logs: [TTH Block] Extension started successfully
    } catch (err) {
      console.error(`[TTH Block] Error in onStart: ${err.message}`);
      socket.post('events', {
        text: `Extension failed to start: ${err.message}`,
        severity: 'error'
      });
      throw err;
    }
  };

  extension.onStop = () => {
    console.log('[TTH Block] Extension stopped, cleaning up');
    if (updateIntervalId) {
      clearInterval(updateIntervalId);
      console.log('[TTH Block] Cleared update interval on stop');
    }
  };
};