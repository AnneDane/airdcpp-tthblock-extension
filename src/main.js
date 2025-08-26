/*
 * TTH Blocker Extension for AirDC++
 * Version: 1.20.32
 * Description: Blocks downloads based on TTH values from JSON blocklists.
 * Adds context menu items in search results and filelists to append selected files' TTHs to custom.blocklist.json.
 * Supports multiple read-only blocklists in /blocklists/ folder with dynamic detection and enable/disable settings.
 * Change Log:
 * - [Previous changes omitted for brevity, see 1.20.22]
 * - 1.20.23: Added programmatic restart using POST /extensions/:id/restart, fixed TTH count in event log.
 * - 1.20.24: Changed to POST /extensions/:id/stop to fix 400 error.
 * - 1.20.25: Added POST /extensions install for restart, but failed due to process termination.
 * - 1.20.26: Use throw Error for restart, relying on auto_start: true, with info event for clarity.
 * - 1.20.31: Replaced throw Error with POST /events notification for new blocklists.
 * - 1.20.32: Added debug logs, enhanced error handling to fix configure window.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const EXTENSION_VERSION = '1.20.32';

const CONFIG_VERSION = 1;
const BLOCKLIST_DIR = path.resolve(__dirname, '..', 'blocklists');
const CUSTOM_BLOCKLIST_FILE = path.join(BLOCKLIST_DIR, 'custom.blocklist.json');
let blockedTTHSet = new Set();
let blocklistFiles = [];
let blocklistTTHMap = new Map();
const { addContextMenuItems } = require('airdcpp-apisocket');
const SettingsManager = require('airdcpp-extension-settings');

console.log('[TTH Block] Initializing module');

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
  return tthRegex.test(id);
}

function validateBlocklistFile(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    if (data.trim() === '') {
      console.log(`[TTH Block] Blocklist ${filePath} is empty, ignoring`);
      return false;
    }
    const blocklist = JSON.parse(data);
    if (!Array.isArray(blocklist)) {
      console.error(`[TTH Block] Invalid blocklist format in ${filePath}: not an array`);
      return false;
    }
    const hasValidTTH = blocklist.some(item => item.tth && isValidTTH(item.tth));
    if (!hasValidTTH) {
      console.error(`[TTH Block] No valid TTHs found in ${filePath}, ignoring`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[TTH Block] Failed to validate blocklist ${filePath}: ${err.message}`);
    return false;
  }
}

function getBlocklistFiles() {
  try {
    const files = fs.readdirSync(BLOCKLIST_DIR).filter(file => file.endsWith('.json') && file !== path.basename(CUSTOM_BLOCKLIST_FILE));
    const blocklists = files
      .map(file => {
        const filePath = path.join(BLOCKLIST_DIR, file);
        if (validateBlocklistFile(filePath)) {
          const stats = fs.statSync(filePath);
          return { file, path: filePath, mtime: stats.mtimeMs };
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

function loadBlockedTTHs(socket, settings) {
  if (!settings || typeof settings.getValue !== 'function') {
    console.error(`[TTH Block] Settings object is invalid, skipping blocklist load`);
    return;
  }

  blockedTTHSet.clear();
  blocklistTTHMap.clear();

  if (settings.getValue('custom_block_list')) {
    try {
      if (fs.existsSync(CUSTOM_BLOCKLIST_FILE)) {
        const data = fs.readFileSync(CUSTOM_BLOCKLIST_FILE, 'utf-8');
        if (data.trim() === '') {
          console.log(`[TTH Block] Custom blocklist is empty, initializing with empty array`);
          fs.writeFileSync(CUSTOM_BLOCKLIST_FILE, JSON.stringify([], null, 2), 'utf-8');
        } else {
          const blocklist = JSON.parse(data);
          if (Array.isArray(blocklist)) {
            const tthSet = new Set();
            blocklist.forEach(item => {
              if (item.tth && isValidTTH(item.tth)) {
                blockedTTHSet.add(item.tth);
                tthSet.add(item.tth);
              }
            });
            blocklistTTHMap.set(path.basename(CUSTOM_BLOCKLIST_FILE), tthSet);
            console.log(`[TTH Block] Loaded ${blocklist.length} TTH(s) from ${CUSTOM_BLOCKLIST_FILE}`);
          } else {
            console.warn(`[TTH Block] Invalid format in ${CUSTOM_BLOCKLIST_FILE}, initializing with empty array`);
            fs.writeFileSync(CUSTOM_BLOCKLIST_FILE, JSON.stringify([], null, 2), 'utf-8');
          }
        }
      } else {
        console.log(`[TTH Block] Custom blocklist not found, creating empty ${CUSTOM_BLOCKLIST_FILE}`);
        fs.writeFileSync(CUSTOM_BLOCKLIST_FILE, JSON.stringify([], null, 2), 'utf-8');
      }
    } catch (err) {
      console.error(`[TTH Block] Failed to load custom blocklist: ${err.message}, initializing with empty array`);
      fs.writeFileSync(CUSTOM_BLOCKLIST_FILE, JSON.stringify([], null, 2), 'utf-8');
    }
  } else {
    console.log(`[TTH Block] Custom blocklist disabled in settings, skipping load`);
  }

  blocklistFiles.forEach(blocklist => {
    const settingKey = `blocklist_${blocklist.file}`;
    if (settings.getValue(settingKey)) {
      try {
        const data = fs.readFileSync(blocklist.path, 'utf-8');
        if (data.trim() === '') {
          console.log(`[TTH Block] Blocklist ${blocklist.file} is empty, skipping`);
          return;
        }
        const blocklistData = JSON.parse(data);
        if (Array.isArray(blocklistData)) {
          const tthSet = new Set();
          blocklistData.forEach(item => {
            if (item.tth && isValidTTH(item.tth)) {
              blockedTTHSet.add(item.tth);
              tthSet.add(item.tth);
            }
          });
          blocklistTTHMap.set(blocklist.file, tthSet);
          console.log(`[TTH Block] Loaded ${blocklistData.length} TTH(s) from ${blocklist.file}`);
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

function updateSingleBlocklist(socket, settings, filename) {
  const blocklist = blocklistFiles.find(b => b.file === filename);
  if (!blocklist) {
    console.log(`[TTH Block] Blocklist ${filename} not found in blocklistFiles, treating as new`);
    return false;
  }
  const settingKey = `blocklist_${filename}`;
  const filePath = blocklist.path;

  const oldTTHs = blocklistTTHMap.get(filename) || new Set();
  oldTTHs.forEach(tth => blockedTTHSet.delete(tth));
  blocklistTTHMap.delete(filename);
  console.log(`[TTH Block] Unloaded ${oldTTHs.size} TTH(s) from ${filename}`);

  if (settings.getValue(settingKey)) {
    if (validateBlocklistFile(filePath)) {
      try {
        const data = fs.readFileSync(filePath, 'utf-8');
        const blocklistData = JSON.parse(data);
        const tthSet = new Set();
        blocklistData.forEach(item => {
          if (item.tth && isValidTTH(item.tth)) {
            blockedTTHSet.add(item.tth);
            tthSet.add(item.tth);
          }
        });
        blocklistTTHMap.set(filename, tthSet);
        console.log(`[TTH Block] Loaded ${blocklistData.length} TTH(s) from ${filename}`);
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
    console.warn(`[TTH Block] Failed to fetch item ${itemId} in filelist ${entityId} (path: ${filelistPath}). Ensure you have navigated into the directory containing the file and it is fully loaded in the AirDC++ UI (double-click the directory and wait for its contents to load completely with no loading indicator before right-clicking the file)`);
    await socket.post('events', {
      text: `Failed to add TTH for item ${itemId} in filelist ${entityId} (path: ${filelistPath}). Ensure you have navigated into the directory containing the file and it is fully loaded in the AirDC++ UI (double-click the directory and wait for its contents to load completely with no loading indicator before right-clicking the file)`,
      severity: 'warning',
    });
    return null;
  }
}

async function addToBlocklist(socket, settings, selectedIds, entityId, menuType) {
  if (!settings || typeof settings.getValue !== 'function') {
    console.error(`[TTH Block] Settings object is invalid, cannot add to blocklist`);
    await socket.post('events', {
      text: `Cannot add TTHs to blocklist: settings are invalid. Check extension logs for details`,
      severity: 'error',
    });
    return;
  }

  if (!settings.getValue('custom_block_list')) {
    console.log(`[TTH Block] Custom blocklist is disabled, skipping TTH addition`);
    await socket.post('events', {
      text: `Custom blocklist is disabled. Enable it in the extension settings to add TTHs`,
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
      const tthSet = blocklistTTHMap.get(path.basename(CUSTOM_BLOCKLIST_FILE)) || new Set();
      tthSet.add(tth);
      blocklistTTHMap.set(path.basename(CUSTOM_BLOCKLIST_FILE), tthSet);
      addedTTHs.push({ tth, comment: '' });
    } else if (tth) {
      console.log(`[TTH Block] TTH ${tth} already in blocklist, skipping`);
    }
  }

  if (addedTTHs.length > 0) {
    try {
      let blocklist = [];
      if (fs.existsSync(CUSTOM_BLOCKLIST_FILE)) {
        const data = fs.readFileSync(CUSTOM_BLOCKLIST_FILE, 'utf-8');
        if (data.trim() !== '') {
          blocklist = JSON.parse(data);
          if (!Array.isArray(blocklist)) {
            console.warn(`[TTH Block] Invalid blocklist format in ${CUSTOM_BLOCKLIST_FILE}, resetting to empty array`);
            blocklist = [];
          }
        }
      }
      blocklist.push(...addedTTHs);
      fs.writeFileSync(CUSTOM_BLOCKLIST_FILE, JSON.stringify(blocklist, null, 2), 'utf-8');
      console.log(`[TTH Block] Added ${addedTTHs.length} TTH(s) to ${CUSTOM_BLOCKLIST_FILE}`);
      await socket.post('events', {
        text: `Added ${addedTTHs.length} TTH(s) to custom blocklist: ${addedTTHs.map(item => item.tth).join(', ')}`,
        severity: 'info',
      });
    } catch (err) {
      console.error(`[TTH Block] Failed to write blocklist file: ${err.message}`);
      await socket.post('events', {
        text: `Failed to write to custom blocklist: ${err.message}`,
        severity: 'error',
      });
    }
  } else {
    console.log(`[TTH Block] No valid TTHs to add from ${menuType}`);
    await socket.post('events', {
      text: `No valid TTHs to add from ${menuType === 'grouped_search_result' ? 'search results' : 'filelist'}. Ensure selected items are files and, for filelists, their directories are fully loaded in the UI (double-click the directory and wait for its contents to load completely with no loading indicator before right-clicking the file)`,
      severity: 'warning',
    });
  }
}

async function watchBlocklistDir(socket, settings, extension) {
  let debounceTimeout;
  try {
    fs.watch(BLOCKLIST_DIR, (eventType, filename) => {
      if (filename && filename.endsWith('.json')) {
        clearTimeout(debounceTimeout);
        debounceTimeout = setTimeout(async () => {
          try {
            console.log(`[TTH Block] Detected change in blocklist directory: ${filename} (${eventType})`);
            const oldBlocklists = [...blocklistFiles];
            blocklistFiles = getBlocklistFiles();
            
            const isNewBlocklist = !oldBlocklists.some(b => b.file === filename);
            const updatedBlocklist = blocklistFiles.find(b => b.file === filename);
            
            if (isNewBlocklist) {
              console.log(`[TTH Block] New blocklist detected: ${filename}`);
              await socket.post('events', {
                text: `New blocklist '${filename}' detected. Please stop and start the TTH Blocker Extension in Settings > Extensions to enable it. Updates to existing blocklists apply automatically without a restart.`,
                severity: 'info'
              });
              console.log(`[TTH Block] Notified user: New blocklist ${filename} detected, manual restart required`);
            } else if (updatedBlocklist) {
              const oldBlocklist = oldBlocklists.find(b => b.file === filename);
              if (oldBlocklist && oldBlocklist.mtime !== updatedBlocklist.mtime) {
                const reloaded = updateSingleBlocklist(socket, settings, filename);
                if (reloaded) {
                  const tthCount = blocklistTTHMap.get(filename)?.size || 0;
                  await socket.post('events', {
                    text: `Updated blocklist ${filename} with ${tthCount} TTH(s).`,
                    severity: 'info'
                  });
                }
              }
            }
          } catch (err) {
            console.error(`[TTH Block] Error in watchBlocklistDir handler: ${err.message}`);
          }
        }, 1000);
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

  const SettingDefinitions = [
    {
      key: 'custom_block_list',
      title: 'Enable/Disable custom blocklist',
      default_value: true,
      type: 'boolean'
    },
    ...blocklistFiles.map(blocklist => ({
      key: `blocklist_${blocklist.file}`,
      title: `Enable/Disable blocklist ${blocklist.file}`,
      default_value: true,
      type: 'boolean'
    }))
  ];

  let settings;
  try {
    settings = SettingsManager(socket, {
      extensionName: extension.name,
      configFile: path.join(extension.configPath, 'config.json'),
      configVersion: CONFIG_VERSION,
      definitions: SettingDefinitions,
    });
    console.log(`[TTH Block] SettingsManager initialized successfully`);
  } catch (err) {
    console.error(`[TTH Block] Failed to initialize SettingsManager: ${err.message}`);
    settings = {
      getValue: (key) => {
        const def = SettingDefinitions.find(d => d.key === key);
        return def ? def.default_value : null;
      }
    };
  }

  extension.onStart = async (sessionInfo) => {
    console.log('[TTH Block] Entering onStart');
    try {
      await settings.load();
      console.log(`[TTH Block] Settings loaded successfully`);
      loadBlockedTTHs(socket, settings);
      watchBlocklistDir(socket, settings, extension);

      socket.addListener('extensions', 'extension_settings_updated', (data) => {
        console.log(`[TTH Block] Settings updated:`, JSON.stringify(data, null, 2));
        if (!settings || typeof settings.getValue !== 'function') {
          console.error(`[TTH Block] Settings object is invalid during settings update, using defaults`);
          blockedTTHSet.clear();
          blocklistTTHMap.clear();
          if (data.custom_block_list || blocklistFiles.some(b => data[`blocklist_${b.file}`])) {
            loadBlockedTTHs(socket, settings);
          }
          return;
        }
        if (data.hasOwnProperty('custom_block_list') || blocklistFiles.some(b => data.hasOwnProperty(`blocklist_${b.file}`))) {
          console.log(`[TTH Block] Blocklist settings changed, reloading blockedTTHSet`);
          loadBlockedTTHs(socket, settings);
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
              icon: {
                semantic: 'ban'
              },
              onClick: async (selectedIds, entityId) => {
                console.log('[TTH Block] Search menu item "add_tth_to_blocklist" clicked with selectedIds:', selectedIds, 'entityId:', entityId);
                await addToBlocklist(socket, settings, selectedIds, entityId, 'grouped_search_result');
              },
              access: 'search',
              filter: (selectedIds) => {
                console.log(`[TTH Block] Search menu filter result: true, selectedIds:`, selectedIds);
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
              icon: {
                semantic: 'ban'
              },
              onClick: async (selectedIds, entityId) => {
                console.log('[TTH Block] Filelist menu item "add_tth_to_blocklist" clicked with selectedIds:', selectedIds, 'entityId:', entityId);
                await addToBlocklist(socket, settings, selectedIds, entityId, 'filelist_item');
              },
              access: 'filelists_view',
              filter: (selectedIds, entityId) => {
                console.log(`[TTH Block] Filelist menu filter result: true, selectedIds: ${selectedIds}, entityId: ${entityId}`);
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
  };
};