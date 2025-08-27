# TTH Blocker Extension for AirDC++

**Version**: 1.20.56

**Description**: A extension for AirDC++ that prevents downloading files based on their TTH (Tiger Tree Hash) values. Block specific files by adding their TTHs to a custom blocklist or use pre-curated third-party blocklists from GitHub for advanced content filtering. Ideal for personal use or managing large-scale blocklists.

## Features
- **Block Downloads by TTH**: Automatically prevents queuing files with TTHs listed in enabled blocklists.
- **Custom Blocklist**: Add TTHs manually from search results or filelists to a local, editable `internal_blocklist.json` for personal use.
- **Third-Party Blocklists**: Load and auto-update read-only blocklists (e.g., `remote_blocklist.json`, `external2.json`) from GitHub repositories.
- **Dynamic Blocklist Detection**: Automatically detects JSON blocklists in the `blocklists/` folder and adds toggle settings.
- **Configurable Updates**: Set update intervals for remote blocklists (default: 60 minutes, recommended: 5 minutes due to GitHub caching).
- **Context Menu Integration**: Right-click in AirDC++ search results or filelists to add TTHs to the custom blocklist.
- **Detailed Logging**: Tracks blocklist updates, blocked downloads, and errors in AirDC++ logs.

## Two Ways to Use
1. **Basic User**:
   - Use the local `internal_blocklist.json` to manually add TTHs of files you want to block.
   - Ideal for occasional, personal use to avoid specific files.
2. **Advanced User**:
   - Combine the custom blocklist with third-party blocklists hosted on GitHub (e.g., `https://github.com/AnneDane/tth-blocklists`).
   - Perfect for users needing curated, large-scale blocklists with automatic updates.

## Installation
1. **Prerequisites**:
   - AirDC++ version with API feature level 6 or higher (check in **About**).
   - Node.js and npm installed for building the extension.
2. **Steps**:
   - Download or clone the extension from `https://github.com/AnneDane/airdcpp-tthblock-extension`.
   - Navigate to the extension folder:
     ```bash
     cd path/to/airdcpp-tthblock-extension
     ```
   - Install dependencies and build:
     ```bash
     npm install
     npm run build
     ```
   - Copy the `package` folder to `\Settings\extensions\airdcpp-tthblock-extension` (or your AirDC++ settings directory).
   - Restart AirDC++.
   - Enable the extension in **Settings > Extensions**.

## Configuration
1. **Access Settings**:
   - Go to **Settings > Extensions > Configure** for `TTH Blocker Extension`.
2. **Basic User Setup**:
   - Enable **Enable/Disable custom blocklist** (default: enabled).
   - Add TTHs via right-click in search results or filelists (select **Add TTH to blocklist**).
3. **Advanced User Setup**:
   - Place third-party blocklist files (e.g., `remote_blocklist.json`) in `\Settings\extensions\airdcpp-tthblock-extension\package\blocklists`.
   - Ensure blocklists are valid JSON with a `tths` array, `url`, `version`, and `updated_at` (see [example](#blocklist-format)).
   - Enable each blocklist (e.g., **Enable/Disable blocklist external1.json**) in settings.
   - Set **Update interval for remote blocklists** to 5 minutes for optimal GitHub syncing.
4. **Verify**:
   - Check **System Log** for startup messages and blocklist loading.
   - Example: `Loaded 8 TTH(s) from remote_blocklist.json (version: 1.0.10)`.

## Usage
- **Blocking Downloads**:
  - Files with TTHs in enabled blocklists are automatically blocked from queuing.
  - Check **System Log** for messages like: `Blocked download for file 'example.mp4' (TTH: ...)`.

- **Adding TTHs (Basic Users)**:
  - In **Search**, right-click a file and select **Add TTH to blocklist**.
  - In **Filelists**, navigate to a file, right-click, and select **Add TTH to blocklist**.
  - Note: Ensure filelist directories are fully loaded in the UI before adding TTHs.
  - TTHs are saved to `internal_blocklist.json`.

- **Managing Third-Party Blocklists (Advanced Users)**:
  - Add blocklists to the `blocklists/` folder or use defaults from `https://github.com/AnneDane/tth-blocklists`.
  - Blocklists auto-update based on the configured interval.
  - Monitor **System Log** for updates: `Updated blocklist external1.json with 8 TTH(s)`.

## Blocklist Format
Blocklists are JSON files in `\Settings\extensions\airdcpp-tthblock-extension\package\blocklists`. Example (`remote_blocklist.json`):
```json
{
  "url": "https://raw.githubusercontent.com/AnneDane/tth-blocklists/main/blocklists/remote_blocklist.json",
  "version": "1.0.15",
  "updated_at": "2025-08-27T19:00:00Z",
  "description": "Curated by AnneDane",
  "tths": [
    {"tth": "QDJ3QLGZWKAHVA6S44WKPHAGJJ7XY57X33RGQMQ", "comment": "bogus filename", "timestamp": "2025-08-26T17:20:00Z"},
    {"tth": "IQXFFB3Q4JT2VS7VKGUILA6TQYO2AJ6CI6UF37I", "comment": "Test file 1", "timestamp": "2025-08-26T17:20:00Z"},
    {"tth": "KIFA6LK2X6PHJDM3KX2IMVSF7ZMWJG3BCZNXDOY", "comment": "Test file 2", "timestamp": "2025-08-26T17:20:00Z"}
  ]
}