'use strict';

/*
 * TTH Blocker Extension for AirDC++
 * Version: 1.20.44
 * Description: Blocks downloads based on TTH values from JSON blocklists.
 * Adds context menu items in search results and filelists to append selected files' TTHs to internal_blocklist.json.
 * Supports multiple read-only blocklists in /blocklists/ folder with dynamic detection and enable/disable settings.
 * Auto-updates remote blocklists with a 'url' field every X minutes set in configure window, checks version/updated_at.
 * Change Log:
 * - [Previous changes omitted, see 1.20.43]
 * - 1.20.43: Fixed duplicate System Log messages for internal blocklist updates, corrected setting key mismatch (internal_block_list), optimized logging for clarity.
 * - 1.20.44: Removed redundant "Updated blocklist" message for remote blocklist updates, added restart prompt to new blocklist detection message.
 */

const fs = require('fs');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const EXTENSION_VERSION = '1.20.44';
const CONFIG_VERSION = 1;
const BLOCKLIST_DIR = path.resolve(__dirname, '..', 'blocklists');
const INTERNAL_BLOCKLIST_FILE = path.join(BLOCKLIST_DIR, 'internal_blocklist.json');
let blockedTTHSet = new Set();
let blocklistFiles = [];
let blocklistTTHMap = new Map();
let blocklistETags = new Map();
let blocklistVersions = new Map();
let updateIntervalId = null;
let lastUpdateWriteTime = new Map(); // Track mtimeMs per file
const { addContextMenuItems } = require('airdcpp-apisocket');
const SettingsManager = require('airdcpp-extension-settings');

console.log('[TTH Block] Initializing module');

// Suppress deprecation warnings
process.on('warning', (warning) => {
  if (warning.name === 'DeprecationWarning' && (warning.message.includes('node-domexception') || warning.message.includes('punycode'))) {
    return;
  }
  console.warn(warning);
});

function ensureBlocklistDir() {
  try {
    if (!fs.existsSync(BLOCKLIST_DIR)) {
      fs.mkdirSync(BLOCKLIST_DIR, { recursive: true });
      console.log(`[TTH Block] Created blocklist directory: ${BLOCKLIST_DIR}`);
    }
  } catch (err) {
    console.error(`[TTH Block] Failed to create blocklist directory: ${err.message}`);
  }
}

function isValidTTH(id) {
  const tthRegex = /^[A-Z2-7]{39}$/;
  if (!tthRegex.test(id)) {
    console.warn(`[TTH Block] Invalid TTH: ${id} (must be 39 characters, base32 A-Z/2-7)`);
    return false;
  }
  return true;
}

function isValidBlocklistURL(url) {
  if (url === 'Internal') return true;
  try {
    const parsed = new URL(url);
    const isValidProtocol = parsed.protocol === 'https:' || parsed.protocol === 'http:';
    const isRawURL = parsed.hostname.includes('raw.githubusercontent.com') || parsed.pathname.includes('/raw/');
    return isValidProtocol && isRawURL;
  } catch (err) {
    return false;
  }
}

function validateBlocklistFile(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    if (data.trim() === '') {
      console.log(`[TTH Block] Blocklist ${filePath} is empty, initializing`);
      const defaultBlocklist = {
        url: filePath === INTERNAL_BLOCKLIST_FILE ? 'Internal' : null,
        version: filePath === INTERNAL_BLOCKLIST_FILE ? 'Internal' : null,
        updated_at: new Date().toISOString(),
        description: filePath === INTERNAL_BLOCKLIST_FILE ? 'Internal' : '',
        tths: []
      };
      fs.writeFileSync(filePath, JSON.stringify(defaultBlocklist, null, 2), 'utf-8');
      return { valid: true, url: defaultBlocklist.url, version: defaultBlocklist.version, updated_at: defaultBlocklist.updated_at, description: defaultBlocklist.description };
    }
    const blocklist = JSON.parse(data);
    if (!blocklist.url || !isValidBlocklistURL(blocklist.url)) {
      console.error(`[TTH Block] Invalid or missing URL in ${filePath}: ${blocklist.url || 'none'}`);
      return { valid: false, url: null, version: blocklist.version || null, updated_at: blocklist.updated_at || null, description: blocklist.description || '' };
    }
    if (!Array.isArray(blocklist.tths)) {
      console.error(`[TTH Block] Invalid blocklist format in ${filePath}: 'tths' not an array`);
      return { valid: false, url: blocklist.url, version: blocklist.version || null, updated_at: blocklist.updated_at || null, description: blocklist.description || '' };
    }
    const hasValidTTH = blocklist.tths.some(item => item.tth && isValidTTH(item.tth));
    if (!hasValidTTH && blocklist.tths.length > 0) {
      console.error(`[TTH Block] No valid TTHs found in ${filePath}`);
      return { valid: false, url: blocklist.url, version: blocklist.version || null, updated_at: blocklist.updated_at || null, description: blocklist.description || '' };
    }
    return { valid: true, url: blocklist.url, version: blocklist.version || null, updated_at: blocklist.updated_at || null, description: blocklist.description || '' };
  } catch (err) {
    console.error(`[TTH Block] Failed to validate blocklist ${filePath}: ${err.message}`);
    return { valid: false, url: null, version: null, updated_at: null, description: '' };
  }
}

function getBlocklistFiles() {
  try {
    const files = fs.readdirSync(BLOCKLIST_DIR).filter(file => file.endsWith('.json'));
    const blocklists = files
      .map(file => {
        const filePath = path.join(BLOCKLIST_DIR, file);
        const { valid, url, version, updated_at, description } = validateBlocklistFile(filePath);
        if (valid) {
          const stats = fs.statSync(filePath);
          return { file, path: filePath, mtime: stats.mtimeMs, url, version, updated_at, description };
        }
        return null;
      })
      .filter(b => b !== null);
    console.log(`[TTH Block] Found valid blocklist files: ${blocklists.map(b => b.file).join(', ') || 'none'}`);
    return blocklists;
  } catch (err) {
    console.error(`[TTH Block] Failed to read blocklist directory: ${err.message}`);
    return [];
  }
}

async function updateSettingsDefinitions(socket, extensionName, newBlocklists) {
  const SettingDefinitions = [
    {
      key: 'internal_block_list',
      title: 'Enable/Disable internal blocklist',
      default_value: true,
      type: 'boolean'
    },
    {
      key: 'update_interval',
      title: 'Update interval for remote blocklists (minutes)',
      default_value: 60,
      type: 'number',
      min: 1
    },
    ...newBlocklists
      .filter(blocklist => blocklist.file !== path.basename(INTERNAL_BLOCKLIST_FILE))
      .map(blocklist => ({
        key: `blocklist_${blocklist.file}`,
        title: `Enable/Disable blocklist ${blocklist.file}${blocklist.description ? ` (${blocklist.description})` : ''}`,
        default_value: true,
        type: 'boolean'
      }))
  ];
  try {
    await socket.post(`extensions/${extensionName}/settings/definitions`, SettingDefinitions);
    console.log(`[TTH Block] Updated settings definitions with ${newBlocklists.length} blocklists`);
    await socket.post('events', {
      text: `Updated settings with new blocklists: ${newBlocklists.map(b => b.file).join(', ')}`,
      severity: 'info'
    });
  } catch (err) {
    if (err.message.includes('409') || err.message.includes('Setting definitions exist')) {
      console.log(`[TTH Block] Settings definitions already exist for ${extensionName}, skipping update`);
    } else {
      console.error(`[TTH Block] Failed to update settings definitions: ${err.message}`);
    }
  }
}

function loadBlockedTTHs(socket, settings) {
  if (!settings || typeof settings.getValue !== 'function') {
    console.error(`[TTH Block] Settings object is invalid, skipping blocklist load`);
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
          fs.writeFileSync(INTERNAL_BLOCKLIST_FILE, JSON.stringify(defaultBlocklist, null, 2), 'utf-8');
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
            console.log(`[TTH Block] Loaded ${tthSet.size} TTH(s) from ${INTERNAL_BLOCKLIST_FILE} (description: ${blocklist.description || 'none'})`);
          } else {
            console.warn(`[TTH Block] Invalid format in ${INTERNAL_BLOCKLIST_FILE}, initializing`);
            const defaultBlocklist = {
              url: 'Internal',
              version: 'Internal',
              updated_at: new Date().toISOString(),
              description: 'Internal',
              tths: []
            };
            fs.writeFileSync(INTERNAL_BLOCKLIST_FILE, JSON.stringify(defaultBlocklist, null, 2), 'utf-8');
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
        fs.writeFileSync(INTERNAL_BLOCKLIST_FILE, JSON.stringify(defaultBlocklist, null, 2), 'utf-8');
      }
    } catch (err) {
      console.error(`[TTH Block] Failed to load internal blocklist: ${err.message}`);
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
          console.log(`[TTH Block] Loaded ${tthSet.size} TTH(s) from ${blocklist.file} (version: ${blocklistData.version || 'none'}, description: ${blocklistData.description || 'none'})`);
        } else {
          console.error(`[TTH Block] Invalid format in ${blocklist.file}, skipping`);
        }
      } catch (err) {
        console.error(`[TTH Block] Failed to load blocklist ${blocklist.file}: ${err.message}`);
      }
    } else {
      console.log(`[TTH Block] Blocklist ${blocklist.file} disabled in settings, skipping load`);
    }
  });
}

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
    if (validateBlocklistFile(filePath).valid) {
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
        console.log(`[TTH Block] Loaded ${tthSet.size} TTH(s) from ${filename} (version: ${blocklistData.version || 'none'}, description: ${blocklistData.description || 'none'})`);
        return true;
      } catch (err) {
        console.error(`[TTH Block] Failed to reload blocklist ${filename}: ${err.message}`);
      }
    } else {
      console.log(`[TTH Block] Blocklist ${filename} is invalid after update, not reloaded`);
    }
  } else {
    console.log(`[TTH Block] Blocklist ${filename} is disabled, not reloaded`);
  }
  return false;
}

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
        await socket.post('events', {
          text: `Blocklist ${blocklist.file} unchanged (HTTP 304: Not Modified)`,
          severity: 'info'
        });
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
        await socket.post('events', {
          text: `Blocklist ${blocklist.file} unchanged (version: ${newVersion})`,
          severity: 'info'
        });
        return false;
      }
      const etag = response.headers.get('ETag') || '';
      blocklistETags.set(blocklist.file, etag);
      blocklistVersions.set(blocklist.file, newVersion);
      lastUpdateWriteTime.set(blocklist.file, Date.now());
      fs.writeFileSync(blocklist.path, JSON.stringify(data, null, 2), 'utf-8');
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

function scheduleBlocklistUpdates(socket, settings, extension) {
  if (updateIntervalId) {
    clearInterval(updateIntervalId);
    console.log('[TTH Block] Cleared previous update interval');
  }
  const interval = (settings.getValue('update_interval') || 60) * 60 * 1000;
  updateIntervalId = setInterval(async () => {
    console.log('[TTH Block] Checking for remote blocklist updates');
    for (const blocklist of blocklistFiles) {
      if (blocklist.url && blocklist.url !== 'Internal') {
        const updated = await fetchAndUpdateBlocklist(socket, settings, blocklist);
        if (updated) {
          updateSingleBlocklist(socket, settings, blocklist.file, true);
        }
      }
    }
  }, interval);
  console.log(`[TTH Block] Scheduled blocklist updates every ${interval / 60000} minutes`);
}

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
  if (!Array.isArray(selectedIds)) {
    console.error(`[TTH Block] Invalid selectedIds format in ${menuType}: expected array, got ${typeof selectedIds}`);
    await socket.post('events', {
      text: `Failed to add TTHs from ${menuType === 'grouped_search_result' ? 'search results' : 'filelist'}: invalid selection format`,
      severity: 'error',
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
      fs.writeFileSync(INTERNAL_BLOCKLIST_FILE, JSON.stringify(blocklist, null, 2), 'utf-8');
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

async function watchBlocklistDir(socket, settings, extension) {
  let debounceTimeout;
  let pendingNewBlocklists = [];
  try {
    fs.watch(BLOCKLIST_DIR, (eventType, filename) => {
      if (filename && filename.endsWith('.json')) {
        clearTimeout(debounceTimeout);
        debounceTimeout = setTimeout(async () => {
          try {
            console.log(`[TTH Block] Detected change in blocklist directory: ${filename} (${eventType})`);
            const filePath = path.join(BLOCKLIST_DIR, filename);
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
            blocklistFiles = getBlocklistFiles();
            pendingNewBlocklists = blocklistFiles.filter(b => !oldBlocklists.some(ob => ob.file === b.file));
            const updatedBlocklist = blocklistFiles.find(b => b.file === filename);
            if (pendingNewBlocklists.length > 0) {
              console.log(`[TTH Block] New blocklists detected: ${pendingNewBlocklists.map(b => b.file).join(', ')}`);
              await updateSettingsDefinitions(socket, extension.name, pendingNewBlocklists);
              await socket.post('events', {
                text: `New blocklists detected: ${pendingNewBlocklists.map(b => b.file).join(', ')}. Enable them in Settings > Extensions > Configure and restart the extension to activate`,
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
          }
        }, 2000);
      }
    });
    console.log(`[TTH Block] Watching blocklist directory: ${BLOCKLIST_DIR}`);
  } catch (err) {
    console.error(`[TTH Block] Failed to start blocklist directory watcher: ${err.message}`);
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Promise Rejection:', reason);
});

module.exports = function (socket, extension) {
  console.log('[TTH Block] Module exported, initializing extension');
  ensureBlocklistDir();
  blocklistFiles = getBlocklistFiles();

  let settings;
  try {
    const configFile = path.join(extension.configPath, 'config.json');
    if (fs.existsSync(configFile)) {
      const data = fs.readFileSync(configFile, 'utf-8');
      if (data.trim() === '') {
        console.warn(`[TTH Block] Config file ${configFile} is empty, recreating with defaults`);
        fs.writeFileSync(configFile, JSON.stringify({ internal_block_list: true, update_interval: 5 }, null, 2), 'utf-8');
      } else {
        JSON.parse(data); // Validate JSON
      }
    } else {
      console.log(`[TTH Block] Config file ${configFile} not found, creating with defaults`);
      fs.writeFileSync(configFile, JSON.stringify({ internal_block_list: true, update_interval: 5 }, null, 2), 'utf-8');
    }
    settings = SettingsManager(socket, {
      extensionName: extension.name,
      configFile: configFile,
      configVersion: CONFIG_VERSION,
      definitions: [
        {
          key: 'internal_block_list',
          title: 'Enable/Disable internal blocklist',
          default_value: true,
          type: 'boolean'
        },
        {
          key: 'update_interval',
          title: 'Update interval for remote blocklists (minutes)',
          default_value: 60,
          type: 'number',
          min: 1
        },
        ...blocklistFiles
          .filter(blocklist => blocklist.file !== path.basename(INTERNAL_BLOCKLIST_FILE))
          .map(blocklist => ({
            key: `blocklist_${blocklist.file}`,
            title: `Enable/Disable blocklist ${blocklist.file}${blocklist.description ? ` (${blocklist.description})` : ''}`,
            default_value: true,
            type: 'boolean'
          }))
      ],
    });
    console.log(`[TTH Block] SettingsManager initialized successfully`);
  } catch (err) {
    console.error(`[TTH Block] Failed to initialize SettingsManager: ${err.message}`);
    settings = {
      getValue: (key) => {
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
    try {
      await settings.load();
      console.log(`[TTH Block] Settings loaded successfully`);
      blocklistFiles = getBlocklistFiles();
      await updateSettingsDefinitions(socket, extension.name, blocklistFiles);
      loadBlockedTTHs(socket, settings);
      watchBlocklistDir(socket, settings, extension);
      scheduleBlocklistUpdates(socket, settings, extension);

      socket.addListener('extensions', 'extension_settings_updated', async (data) => {
        console.log(`[TTH Block] Settings updated:`, JSON.stringify(data, null, 2));
        if (data.hasOwnProperty('internal_block_list') || blocklistFiles.some(b => data.hasOwnProperty(`blocklist_${b.file}`)) || data.hasOwnProperty('update_interval')) {
          console.log(`[TTH Block] Blocklist or update settings changed, reloading blockedTTHSet`);
          blocklistFiles = getBlocklistFiles();
          await updateSettingsDefinitions(socket, extension.name, blocklistFiles);
          loadBlockedTTHs(socket, settings);
          if (data.hasOwnProperty('update_interval')) {
            console.log(`[TTH Block] Update interval changed to ${data.update_interval}, rescheduling updates`);
            scheduleBlocklistUpdates(socket, settings, extension);
          }
        }
      });

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
      } else {
        console.warn('[TTH Block] API feature level too low for queue_add_bundle_file_hook, need at least 6, current:', sessionInfo.system_info.api_feature_level);
      }

      console.log('[TTH Block] Extension started successfully');
    } catch (err) {
      console.error(`[TTH Block] Error in onStart: ${err.message}`);
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