// automate_trading_workers/utils/steam_login_extractor.js
const fs = require('fs');
const path = require('path');

/**
 * SteamLoginExtractor - Extract Steam login from .env.steam.portion
 *
 * Parses the credentials file to find the Steam login (username) for a given Steam ID
 *
 * File format example:
 * STEAM_PASSWORD_IWFTFMNHTM=password # 76561199838693461 Viviiee
 * STEAM_SHAREDSECRET_IWFTFMNHTM="sHaRed_sEcRet"
 */
class SteamLoginExtractor {
  constructor(credentialsFilePath = null) {
    // Default to .env.steam.portion in working directory (project root or /app in Docker)
    this.credentialsFilePath = credentialsFilePath || '.env.steam.portion';
    this.cache = new Map(); // Cache parsed credentials
    this.lastLoadedAt = null;
  }

  /**
   * Get Steam login for a given Steam ID
   * @param {string} steamId - The Steam ID to lookup
   * @returns {string|null} The Steam login (lowercase) or null if not found
   */
  getSteamLogin(steamId) {
    // Load credentials if not cached or cache is stale
    if (!this.lastLoadedAt || Date.now() - this.lastLoadedAt > 60000) {
      this.loadCredentials();
    }

    return this.cache.get(steamId) || null;
  }

  /**
   * Load and parse credentials file
   */
  loadCredentials() {
    try {
      if (!fs.existsSync(this.credentialsFilePath)) {
        console.warn(`SteamLoginExtractor: Credentials file not found at ${this.credentialsFilePath}`);
        return;
      }

      const content = fs.readFileSync(this.credentialsFilePath, 'utf8');
      const lines = content.split('\n');

      this.cache.clear();

      // Parse each line looking for STEAM_PASSWORD_ entries
      for (const line of lines) {
        const trimmedLine = line.trim();

        // Skip empty lines and comments
        if (!trimmedLine || trimmedLine.startsWith('#')) {
          continue;
        }

        // Match pattern: STEAM_PASSWORD_<LOGIN>=<password> # <STEAM_ID> <NICKNAME>
        const match = trimmedLine.match(/^STEAM_PASSWORD_([A-Z0-9_]+)=.*#\s*(\d+)/);

        if (match) {
          const login = match[1].toLowerCase(); // Convert to lowercase
          const steamId = match[2];

          this.cache.set(steamId, login);
        }
      }

      this.lastLoadedAt = Date.now();
      console.log(`SteamLoginExtractor: Loaded ${this.cache.size} Steam account credentials`);

    } catch (error) {
      console.error(`SteamLoginExtractor: Failed to load credentials: ${error.message}`);
    }
  }

  /**
   * Get all Steam IDs and their logins
   * @returns {Object} Map of Steam ID -> login
   */
  getAllLogins() {
    if (!this.lastLoadedAt) {
      this.loadCredentials();
    }

    return Object.fromEntries(this.cache);
  }

  /**
   * Force reload credentials from file
   */
  reload() {
    this.cache.clear();
    this.lastLoadedAt = null;
    this.loadCredentials();
  }
}

module.exports = SteamLoginExtractor;
