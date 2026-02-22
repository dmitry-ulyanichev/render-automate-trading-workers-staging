// automate_trading/utils/steam_api_manager.js

const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * SteamApiManager - Extensible Steam API client with per-endpoint rate limiting
 * 
 * Features:
 * - Separate rate limiting per endpoint (getFriendsList, getPlayerSummaries)
 * - Direct inventory endpoint with special handling (uses InventoryCooldownManager)
 * - Configurable intervals via config or environment variables
 * - Adaptive backoff with exponential increase (15s → 4min)
 * - Statistics tracking per endpoint
 */
class SteamApiManager {
  constructor(config, logger, options = {}) {
    this.config = config;
    this.logger = logger;
    
    // Steam API configuration
    this.steamConfig = {
      apiKey: config.steam?.apiKey || process.env.STEAM_API_KEY,
      baseUrl: 'https://api.steampowered.com',
      timeout: config.steam?.timeout || 10000,
      maxRetries: config.steam?.maxRetries || 3
    };

    if (!this.steamConfig.apiKey) {
      throw new Error('Steam API key is required (STEAM_API_KEY environment variable)');
    }

    // Initialize HTTP client
    this.client = axios.create({
      baseURL: this.steamConfig.baseUrl,
      timeout: this.steamConfig.timeout,
      headers: {
        'User-Agent': 'automate_trading/1.0'
      }
    });

    // Per-endpoint rate limiting configuration (excludes inventory - uses InventoryCooldownManager)
    this.endpointConfigs = this.initializeEndpointConfigs(config);
    
    // Per-endpoint rate limiting state
    this.endpointStates = {};
    this.initializeEndpointStates();

    // Global statistics
    this.globalStats = {
      totalRequests: 0,
      totalErrors: 0,
      totalRateLimitHits: 0,
      startTime: Date.now()
    };

    // Proxy management
    this.onProxyExpired = options.onProxyExpired || null;
    this.proxyFilePath = null; // Set during proxy loading; used for hot-reload and write-back
    this.proxyReloadTimer = null;

    // Inventory connection rotation (direct + SOCKS5 proxies with per-connection cooldowns)
    this.inventoryConnections = this.initializeInventoryConnections();
    this.inventoryRoundRobinIndex = 0;
    // Per-connection cooldown state: { cooldownUntil, backoffLevel, reason }
    this.inventoryConnectionCooldowns = new Map();
    // Backoff sequence for 429s (minutes)
    this.inventoryBackoffSequence = [1, 2, 4, 8, 16, 32, 60, 120];

    this.logger.info('SteamApiManager initialized with per-endpoint rate limiting', {
      baseUrl: this.steamConfig.baseUrl,
      endpoints: Object.keys(this.endpointConfigs),
      inventoryConnections: this.inventoryConnections.length
    });
  }

  /**
   * Initialize inventory connections: direct + any SOCKS5 proxies from proxy.json
   * Searches: PROXY_CONFIG_PATH env, ./proxy.json, /etc/secrets/proxy.json
   */
  initializeInventoryConnections() {
    const connections = [{ id: 'direct', type: 'direct' }];

    const candidates = [];
    if (process.env.PROXY_CONFIG_PATH) candidates.push(process.env.PROXY_CONFIG_PATH);
    candidates.push(path.resolve('./proxy.json'));
    candidates.push('/etc/secrets/proxy.json');

    for (const filePath of candidates) {
      try {
        if (!fs.existsSync(filePath)) continue;
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!Array.isArray(data.proxies) || data.proxies.length === 0) continue;

        const { SocksProxyAgent } = require('socks-proxy-agent');
        data.proxies.forEach((p) => {
          const proxyUrl = p.username
            ? `socks5://${p.username}:${p.password}@${p.host}:${p.port}`
            : `socks5://${p.host}:${p.port}`;
          connections.push({
            id: `proxy-${p.host}-${p.port}`,
            type: 'socks5',
            agent: new SocksProxyAgent(proxyUrl),
            host: p.host,
            port: p.port
          });
        });
        this.proxyFilePath = filePath;
        this.logger.info(`Loaded ${data.proxies.length} SOCKS5 proxies from ${filePath}`);
        this.logger.info(`Total inventory connections: ${connections.length} (1 direct + ${data.proxies.length} proxies)`);
        return connections;
      } catch (error) {
        this.logger.warn(`Failed to load proxies from ${filePath}: ${error.message}`);
      }
    }

    this.logger.info('No proxy configuration found - using direct connection only for inventory');
    return connections;
  }

  /**
   * Check if an inventory connection is available (not in cooldown)
   */
  isInventoryConnectionAvailable(connectionId) {
    const cooldown = this.inventoryConnectionCooldowns.get(connectionId);
    if (!cooldown) return true;
    return Date.now() >= cooldown.cooldownUntil;
  }

  /**
   * Mark an inventory connection as in cooldown
   */
  markInventoryConnectionCooldown(connectionId, reason) {
    const existing = this.inventoryConnectionCooldowns.get(connectionId) || { backoffLevel: -1 };
    const newLevel = reason === '429'
      ? Math.min((existing.backoffLevel || 0) + 1, this.inventoryBackoffSequence.length - 1)
      : 0;
    const durationMs = reason === '429'
      ? this.inventoryBackoffSequence[newLevel] * 60000
      : 60000; // 1 min for connection errors

    this.inventoryConnectionCooldowns.set(connectionId, {
      cooldownUntil: Date.now() + durationMs,
      backoffLevel: newLevel,
      reason
    });

    this.logger.warn(`Inventory connection ${connectionId} cooldown: ${reason}, ${durationMs / 60000}min (level ${newLevel})`);
  }

  /**
   * Reset cooldown for an inventory connection after success
   */
  resetInventoryConnectionCooldown(connectionId) {
    if (this.inventoryConnectionCooldowns.has(connectionId)) {
      this.inventoryConnectionCooldowns.delete(connectionId);
      this.logger.debug(`Inventory connection ${connectionId} cooldown reset`);
    }
  }

  /**
   * Get ordered list of available inventory connections (direct first, then round-robin proxies)
   */
  getOrderedInventoryConnections() {
    const ordered = [];

    // Direct first if available
    const direct = this.inventoryConnections.find(c => c.type === 'direct');
    if (direct && this.isInventoryConnectionAvailable(direct.id)) {
      ordered.push(direct);
    }

    // Proxies in round-robin order
    const proxies = this.inventoryConnections.filter(c => c.type === 'socks5');
    if (proxies.length > 0) {
      for (let i = 0; i < proxies.length; i++) {
        const idx = (this.inventoryRoundRobinIndex + i) % proxies.length;
        if (this.isInventoryConnectionAvailable(proxies[idx].id)) {
          ordered.push(proxies[idx]);
        }
      }
      this.inventoryRoundRobinIndex = (this.inventoryRoundRobinIndex + 1) % proxies.length;
    }

    return ordered;
  }

  /**
   * Start polling proxy.json for changes every intervalMs milliseconds.
   * New proxies are added without service restart; proxies removed from the file are
   * dropped from the in-memory pool (cooldown state for existing proxies is preserved).
   */
  startProxyReload(intervalMs = 5 * 60 * 1000) {
    if (this.proxyReloadTimer) clearInterval(this.proxyReloadTimer);
    this.proxyReloadTimer = setInterval(() => {
      this.reloadProxies().catch(e => this.logger.error(`Proxy reload error: ${e.message}`));
    }, intervalMs);
    this.logger.info(`Proxy hot-reload enabled, checking every ${intervalMs / 60000}min`);
  }

  stopProxyReload() {
    if (this.proxyReloadTimer) {
      clearInterval(this.proxyReloadTimer);
      this.proxyReloadTimer = null;
    }
  }

  /**
   * Re-read proxy.json and reconcile with the in-memory connection pool.
   * - Proxies new in the file are added with fresh SocksProxyAgents.
   * - Proxies no longer in the file are removed (and their cooldown state cleared).
   * - Cooldown state for proxies that remain is untouched.
   */
  async reloadProxies() {
    const candidates = [];
    if (process.env.PROXY_CONFIG_PATH) candidates.push(process.env.PROXY_CONFIG_PATH);
    candidates.push(require('path').resolve('./proxy.json'));
    candidates.push('/etc/secrets/proxy.json');

    let newProxyConfigs = [];
    let foundFilePath = null;

    for (const filePath of candidates) {
      try {
        if (!require('fs').existsSync(filePath)) continue;
        const data = JSON.parse(require('fs').readFileSync(filePath, 'utf8'));
        if (!Array.isArray(data.proxies) || data.proxies.length === 0) continue;
        newProxyConfigs = data.proxies;
        foundFilePath = filePath;
        break;
      } catch (e) {
        this.logger.warn(`Proxy reload: could not read ${filePath}: ${e.message}`);
      }
    }

    if (foundFilePath && foundFilePath !== this.proxyFilePath) {
      this.proxyFilePath = foundFilePath;
    }

    const newIds = new Set(newProxyConfigs.map(p => `proxy-${p.host}-${p.port}`));
    const existingIds = new Set(
      this.inventoryConnections.filter(c => c.type === 'socks5').map(c => c.id)
    );

    // Add new proxies
    let added = 0;
    const { SocksProxyAgent } = require('socks-proxy-agent');
    for (const p of newProxyConfigs) {
      const id = `proxy-${p.host}-${p.port}`;
      if (!existingIds.has(id)) {
        const proxyUrl = p.username
          ? `socks5://${p.username}:${p.password}@${p.host}:${p.port}`
          : `socks5://${p.host}:${p.port}`;
        this.inventoryConnections.push({ id, type: 'socks5', agent: new SocksProxyAgent(proxyUrl), host: p.host, port: p.port });
        added++;
      }
    }

    // Remove proxies no longer in the file
    let removed = 0;
    this.inventoryConnections = this.inventoryConnections.filter(c => {
      if (c.type === 'direct') return true;
      if (!newIds.has(c.id)) {
        this.inventoryConnectionCooldowns.delete(c.id);
        removed++;
        return false;
      }
      return true;
    });

    if (added > 0 || removed > 0) {
      this.logger.info(`Proxy reload: +${added} added, -${removed} removed. Total connections: ${this.inventoryConnections.length}`);
    }
  }

  /**
   * Verify a SOCKS5 proxy by making a lightweight request to a neutral endpoint.
   * Returns { alive: true } on success, or { alive: false, reason } on failure.
   * Distinguishes auth failures (proxy expired) from transient issues.
   */
  async verifyProxy(connection) {
    const axios = require('axios');
    const requestConfig = {
      timeout: 5000,
      validateStatus: () => true,
      httpsAgent: connection.agent,
      httpAgent: connection.agent
    };

    try {
      const response = await axios.get('https://api.ipify.org/?format=json', requestConfig);
      if (response.status === 200) {
        return { alive: true };
      }
      return { alive: false, reason: 'bad_status', status: response.status };
    } catch (error) {
      const msg = (error.message || '').toLowerCase();
      // SOCKS5 auth failure: credentials rejected before tunnel is established
      if (
        msg.includes('authentication') ||
        msg.includes('socks5') ||
        msg.includes('auth') ||
        error.code === 'ERR_PROXY_CONNECTION_FAILED'
      ) {
        return { alive: false, reason: 'auth_failure' };
      }
      if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
        return { alive: false, reason: 'timeout' };
      }
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND' || error.code === 'EHOSTUNREACH') {
        return { alive: false, reason: 'unreachable' };
      }
      return { alive: false, reason: 'unknown', error: error.message };
    }
  }

  /**
   * Remove an expired proxy from the in-memory pool and from proxy.json,
   * then invoke the onProxyExpired callback so the worker can notify the admin.
   */
  async _removeExpiredProxy(connection) {
    // Remove from in-memory pool and cooldown state
    this.inventoryConnections = this.inventoryConnections.filter(c => c.id !== connection.id);
    this.inventoryConnectionCooldowns.delete(connection.id);

    // Write updated proxy.json atomically (temp file + rename)
    if (this.proxyFilePath) {
      try {
        const fs = require('fs');
        const data = JSON.parse(fs.readFileSync(this.proxyFilePath, 'utf8'));
        data.proxies = data.proxies.filter(p => !(p.host === connection.host && p.port === connection.port));
        const tmpPath = this.proxyFilePath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmpPath, this.proxyFilePath);
        this.logger.info(`Removed expired proxy ${connection.id} from ${this.proxyFilePath}`);
      } catch (e) {
        this.logger.error(`Failed to update proxy.json after removing ${connection.id}: ${e.message}`);
      }
    }

    // Notify via callback
    if (this.onProxyExpired) {
      try {
        await this.onProxyExpired(connection);
      } catch (e) {
        this.logger.error(`onProxyExpired callback error for ${connection.id}: ${e.message}`);
      }
    }
  }

  /**
   * Initialize rate limiting configuration for each endpoint
   * Note: Inventory endpoint is NOT included - it uses InventoryCooldownManager
   */
  initializeEndpointConfigs(config) {
    // Base configuration (similar to invite_friends steamApiEnrichment)
    const baseConfig = {
      baseInterval: 15000, // 15 seconds
      intervals: [15000, 30000, 60000, 120000, 240000], // 15s → 4min
      resetTimeoutMinutes: 4,
      maxConsecutiveErrors: 5
    };

    return {
      // Friends list endpoint
      getFriendsList: {
        ...baseConfig,
        baseInterval: config.steamApi?.getFriendsList?.baseInterval || 
                     parseInt(process.env.AUTOMATE_TRADING_STEAM_API_FRIENDS_BASE_INTERVAL) || 
                     baseConfig.baseInterval,
        intervals: config.steamApi?.getFriendsList?.intervals || [
          parseInt(process.env.AUTOMATE_TRADING_STEAM_API_FRIENDS_INTERVAL_1) || 15000,
          parseInt(process.env.AUTOMATE_TRADING_STEAM_API_FRIENDS_INTERVAL_2) || 30000,
          parseInt(process.env.AUTOMATE_TRADING_STEAM_API_FRIENDS_INTERVAL_3) || 60000,
          parseInt(process.env.AUTOMATE_TRADING_STEAM_API_FRIENDS_INTERVAL_4) || 120000,
          parseInt(process.env.AUTOMATE_TRADING_STEAM_API_FRIENDS_INTERVAL_5) || 240000
        ],
        maxConsecutiveErrors: config.steamApi?.getFriendsList?.maxConsecutiveErrors || 
                             parseInt(process.env.AUTOMATE_TRADING_STEAM_API_FRIENDS_MAX_ERRORS) || 
                             baseConfig.maxConsecutiveErrors
      },
      
      // Player summaries endpoint
      getPlayerSummaries: {
        ...baseConfig,
        baseInterval: config.steamApi?.getPlayerSummaries?.baseInterval || 
                     parseInt(process.env.AUTOMATE_TRADING_STEAM_API_SUMMARIES_BASE_INTERVAL) || 
                     baseConfig.baseInterval,
        intervals: config.steamApi?.getPlayerSummaries?.intervals || [
          parseInt(process.env.AUTOMATE_TRADING_STEAM_API_SUMMARIES_INTERVAL_1) || 15000,
          parseInt(process.env.AUTOMATE_TRADING_STEAM_API_SUMMARIES_INTERVAL_2) || 30000,
          parseInt(process.env.AUTOMATE_TRADING_STEAM_API_SUMMARIES_INTERVAL_3) || 60000,
          parseInt(process.env.AUTOMATE_TRADING_STEAM_API_SUMMARIES_INTERVAL_4) || 120000,
          parseInt(process.env.AUTOMATE_TRADING_STEAM_API_SUMMARIES_INTERVAL_5) || 240000
        ],
        maxConsecutiveErrors: config.steamApi?.getPlayerSummaries?.maxConsecutiveErrors || 
                             parseInt(process.env.AUTOMATE_TRADING_STEAM_API_SUMMARIES_MAX_ERRORS) || 
                             baseConfig.maxConsecutiveErrors
      },
      
      // Future: Trade offers endpoint
      getTradeOffers: {
        ...baseConfig,
        baseInterval: config.steamApi?.getTradeOffers?.baseInterval || 
                     parseInt(process.env.AUTOMATE_TRADING_STEAM_API_TRADES_BASE_INTERVAL) || 
                     10000, // Faster for trade monitoring
        intervals: [10000, 20000, 40000, 80000, 160000], // 10s → 2.7min
        maxConsecutiveErrors: config.steamApi?.getTradeOffers?.maxConsecutiveErrors || 5
      }
    };
  }

  /**
   * Initialize rate limiting state for each endpoint
   */
  initializeEndpointStates() {
    for (const [endpointName, config] of Object.entries(this.endpointConfigs)) {
      this.endpointStates[endpointName] = {
        currentIntervalIndex: 0,
        lastRequestTime: 0,
        consecutiveErrors: 0,
        resetTimeout: null,
        stats: {
          totalRequests: 0,
          totalErrors: 0,
          totalRateLimitHits: 0,
          lastRequestTime: null,
          lastErrorTime: null,
          avgResponseTime: 0
        }
      };
    }
  }

  /**
   * Core method: Make Steam API request with per-endpoint rate limiting
   */
  async makeRequest(endpoint, params, endpointName) {
    if (!this.endpointStates[endpointName]) {
      throw new Error(`Unknown endpoint: ${endpointName}`);
    }

    await this.enforceEndpointRateLimit(endpointName);
    
    const startTime = Date.now();
    
    try {
      this.logger.debug(`Steam API request: ${endpoint}`, { params, endpoint: endpointName });
      
      const response = await this.client.get(endpoint, {
        params: {
          key: this.steamConfig.apiKey,
          format: 'json',
          ...params
        }
      });

      // Success - reset error tracking for this endpoint
      this.handleSuccessfulRequest(endpointName, startTime);
      
      return response;
      
    } catch (error) {
      this.handleRequestError(error, endpointName, startTime);
      throw error;
    }
  }

  /**
   * Get Steam friends list for a user
   */
  async getFriendsList(steamId, relationship = 'friend') {
    const endpointName = 'getFriendsList';
    
    try {
      const response = await this.makeRequest('/ISteamUser/GetFriendList/v0001/', {
        steamid: steamId,
        relationship: relationship
      }, endpointName);

      if (response.data && response.data.friendslist && response.data.friendslist.friends) {
        const friends = response.data.friendslist.friends;
        this.logger.debug(`Retrieved ${friends.length} friends for ${steamId}`);
        
        return {
          success: true,
          friends: friends,
          steamId: steamId
        };
      } else {
        throw new Error('Invalid response format from Steam API');
      }
      
    } catch (error) {
      // 401 = private profile, not a system error
      if (error.response && error.response.status === 401) {
        this.logger.info(`Friends list private for ${steamId}`);
      } else {
        this.logger.error(`Failed to get friends list for ${steamId}: ${error.message}`);
      }

      if (this.isRetryableError(error)) {
        throw new Error(`Steam API temporary error: ${error.message}`);
      } else {
        throw new Error(`Steam API error: ${error.message}`);
      }
    }
  }

  /**
   * Get player summaries for multiple Steam IDs
   */
  async getPlayerSummaries(steamIds) {
    const endpointName = 'getPlayerSummaries';
    
    if (steamIds.length > 100) {
      throw new Error('Steam API GetPlayerSummaries accepts maximum 100 Steam IDs');
    }
    
    try {
      const steamIdsString = steamIds.join(',');
      
      const response = await this.makeRequest('/ISteamUser/GetPlayerSummaries/v0002/', {
        steamids: steamIdsString
      }, endpointName);

      if (response.data && response.data.response && response.data.response.players) {
        const players = response.data.response.players;
        this.logger.debug(`Retrieved player summaries for ${players.length}/${steamIds.length} Steam IDs`);
        
        return {
          success: true,
          players: players,
          requestedCount: steamIds.length,
          returnedCount: players.length
        };
      } else {
        throw new Error('Invalid response format from Steam API');
      }
      
    } catch (error) {
      this.logger.error(`Failed to get player summaries: ${error.message}`);
      
      if (this.isRetryableError(error)) {
        throw new Error(`Steam API temporary error: ${error.message}`);
      } else {
        throw new Error(`Steam API error: ${error.message}`);
      }
    }
  }

  /**
   * Validate Steam login token using Steam Web API GetTradeOffers endpoint
   * This is highly reliable - 200 OK = valid token, 403 Forbidden = invalid token
   */
  async validateSteamLoginToken(authToken, steamId = 'unknown') {
    try {
      this.logger.debug(`Validating Steam auth token for Steam ID ${steamId}`);
      
      // Use IEconService/GetTradeOffers endpoint with minimal parameters
      const response = await axios.get('https://api.steampowered.com/IEconService/GetTradeOffers/v1/', {
        params: {
          get_received_offers: 1,
          get_sent_offers: 0,
          active_only: 0,
          historical_only: 0,
          get_descriptions: 0,
          language: 'english',
          time_historical_cutoff: Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60), // 30 days ago
          access_token: authToken  // Use token directly from DB
        },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 10000 // 10 second timeout
      });

      // Check for successful response
      if (response.status === 200 && response.data && response.data.response !== undefined) {
        this.logger.debug(`Steam token validation successful for Steam ID ${steamId}`);
        return { valid: true };
      }

      // Unexpected response format
      this.logger.warn(`Steam token validation - unexpected response format for Steam ID ${steamId}`);
      return { valid: false, error: 'unexpected_response' };

    } catch (error) {
      if (error.response?.status === 403) {
        // Clear indication of invalid token
        this.logger.debug(`Steam token validation failed - invalid token for Steam ID ${steamId}`);
        return { valid: false, error: 'invalid_token' };
      }
      
      if (error.response?.status === 401) {
        // Also invalid token
        this.logger.debug(`Steam token validation failed - unauthorized for Steam ID ${steamId}`);
        return { valid: false, error: 'invalid_token' };
      }

      if (error.response?.status >= 500) {
        // Steam server error
        this.logger.warn(`Steam server error during token validation for Steam ID ${steamId}: ${error.response?.status}`);
        return { valid: null, error: 'server_error' };
      }

      // Network errors
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        this.logger.warn(`Token validation timeout for Steam ID ${steamId}`);
        return { valid: null, error: 'timeout' };
      }

      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        this.logger.warn(`Token validation network error for Steam ID ${steamId}: ${error.message}`);
        return { valid: null, error: 'network_error' };
      }

      // Other errors
      this.logger.warn(`Token validation unknown error for Steam ID ${steamId}: ${error.message}`);
      return { valid: null, error: 'unknown_error' };
    }
  }

  /**
   * Get Steam inventory using direct HTTP endpoint (not Steam Web API)
   * This bypasses the traditional Steam API and uses steamcommunity.com directly
   * 
   * @param {string} ourSteamId - Our Steam ID (for authentication cookie)
   * @param {string} targetSteamId - Target Steam ID (whose inventory we want to check)
   * @param {string} authToken - Auth token from database (just the token part, not full cookie)
   * @param {number} appId - Steam App ID (default: 730 for CS2)
   * @param {number} contextId - Context ID (default: 2 for CS2)
   * @returns {Promise<Object>} Raw inventory data from Steam
   */
  async getInventory(ourSteamId, targetSteamId, authToken, appId = 730, contextId = 2) {
    if (!ourSteamId || !targetSteamId || !authToken) {
      throw new Error('ourSteamId, targetSteamId and authToken are required for inventory requests');
    }

    const inventoryUrl = `https://steamcommunity.com/inventory/${targetSteamId}/${appId}/${contextId}`;
    const cookieHeader = `steamLoginSecure=${ourSteamId}%7C%7C${authToken}`;
    const orderedConnections = this.getOrderedInventoryConnections();

    if (orderedConnections.length === 0) {
      this.logger.error('All inventory connections in cooldown');
      const rateLimitError = new Error('STEAM_RATE_LIMITED');
      rateLimitError.isRateLimit = true;
      throw rateLimitError;
    }

    for (const connection of orderedConnections) {
      try {
        this.logger.debug(`Steam inventory request via ${connection.id}: ${inventoryUrl}`, {
          ourSteamId, targetSteamId, appId, contextId
        });

        const requestConfig = {
          headers: {
            'Cookie': cookieHeader,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': `https://steamcommunity.com/profiles/${ourSteamId}/inventory/`
          },
          timeout: this.steamConfig.timeout,
          validateStatus: (status) => status === 200 || status === 403 || status === 401 || status === 500
        };

        if (connection.type === 'socks5') {
          requestConfig.httpAgent = connection.agent;
          requestConfig.httpsAgent = connection.agent;
        }

        const response = await axios.get(inventoryUrl, requestConfig);

        // 401/403 are not connection problems — reset cooldown and return result
        if (response.status === 401) {
          this.resetInventoryConnectionCooldown(connection.id);
          return {
            success: false, error: 'private_inventory',
            message: 'Inventory is private (not friends or hidden from friends)',
            assets: [], descriptions: [], total_inventory_count: 0
          };
        }

        if (response.status === 403) {
          this.resetInventoryConnectionCooldown(connection.id);
          return {
            success: false, error: 'authentication_failed',
            message: 'Authentication failed - invalid or expired auth token',
            assets: [], descriptions: [], total_inventory_count: 0
          };
        }

        if (response.status === 500) {
          this.markInventoryConnectionCooldown(connection.id, 'server_error');
          continue;
        }

        // Status 200 — parse response
        const data = response.data;

        if (data.success === false) {
          this.resetInventoryConnectionCooldown(connection.id);
          const error = data.error || 'unknown_error';
          if (error.toLowerCase().includes('private')) {
            return {
              success: false, error: 'private_inventory',
              message: 'Inventory is private (hidden from friends)',
              assets: [], descriptions: [], total_inventory_count: 0
            };
          }
          return {
            success: false, error: error,
            message: data.error || 'Steam returned success: false',
            assets: [], descriptions: [], total_inventory_count: 0
          };
        }

        // Success
        this.resetInventoryConnectionCooldown(connection.id);
        const result = {
          success: true,
          assets: data.assets || [],
          descriptions: data.descriptions || [],
          total_inventory_count: data.total_inventory_count || 0,
          more_items: data.more_items || false,
          last_assetid: data.last_assetid || null
        };

        this.logger.debug(`Steam inventory loaded via ${connection.id}: ${result.assets.length} items`, {
          ourSteamId, targetSteamId, total: result.total_inventory_count, hasMore: result.more_items
        });
        return result;

      } catch (error) {
        const status = error.response?.status;

        if (status === 429) {
          this.logger.warn(`Inventory rate limit (429) via ${connection.id}, trying next connection`);
          this.markInventoryConnectionCooldown(connection.id, '429');
          continue;
        }

        // For SOCKS5 proxies, verify before deciding action so we can distinguish
        // expired credentials (permanent) from transient network issues (temporary).
        if (connection.type === 'socks5') {
          const verification = await this.verifyProxy(connection);
          if (!verification.alive && verification.reason === 'auth_failure') {
            this.logger.warn(`Proxy ${connection.id} auth rejected on verification — confirmed expired, removing`);
            await this._removeExpiredProxy(connection);
          } else {
            const reason = verification.alive ? 'transient request error' : verification.reason;
            this.logger.warn(`Inventory request failed via ${connection.id} (${reason}): ${error.message}`);
            this.markInventoryConnectionCooldown(connection.id, 'connection_error');
          }
          continue;
        }

        // Direct connection: standard cooldown
        this.logger.warn(`Inventory request failed via ${connection.id}: ${error.message}`);
        this.markInventoryConnectionCooldown(connection.id, 'connection_error');
        continue;
      }
    }

    // All connections exhausted
    this.logger.error('All inventory connections exhausted by rate limits/errors');
    const rateLimitError = new Error('STEAM_RATE_LIMITED');
    rateLimitError.isRateLimit = true;
    throw rateLimitError;
  }

  /**
   * FUTURE: Get trade offers (stub for future implementation)  
   */
  async getTradeOffers(activeOnly = true) {
    const endpointName = 'getTradeOffers';
    throw new Error('getTradeOffers not yet implemented - placeholder for future use');
  }

  /**
   * Enforce rate limiting for specific endpoint
   */
  async enforceEndpointRateLimit(endpointName) {
    const state = this.endpointStates[endpointName];
    const config = this.endpointConfigs[endpointName];
    
    const now = Date.now();
    const currentInterval = config.intervals[state.currentIntervalIndex];
    const timeSinceLastRequest = now - state.lastRequestTime;

    if (timeSinceLastRequest < currentInterval) {
      const waitTime = currentInterval - timeSinceLastRequest;
      this.logger.debug(`Rate limiting ${endpointName}: waiting ${waitTime}ms (interval: ${currentInterval}ms)`);
      
      state.stats.totalRateLimitHits++;
      this.globalStats.totalRateLimitHits++;
      
      await this.sleep(waitTime);
    }

    state.lastRequestTime = Date.now();
  }

  /**
   * Handle successful request for specific endpoint
   */
  handleSuccessfulRequest(endpointName, startTime) {
    const responseTime = Date.now() - startTime;
    const state = this.endpointStates[endpointName];
    
    // Update endpoint stats
    state.stats.totalRequests++;
    state.stats.lastRequestTime = new Date().toISOString();
    
    // Update average response time
    if (state.stats.avgResponseTime === 0) {
      state.stats.avgResponseTime = responseTime;
    } else {
      state.stats.avgResponseTime = (state.stats.avgResponseTime + responseTime) / 2;
    }

    // Update global stats
    this.globalStats.totalRequests++;

    // Reset error tracking on success
    if (state.consecutiveErrors > 0) {
      this.logger.info(`${endpointName} recovered after ${state.consecutiveErrors} consecutive errors`);
      state.consecutiveErrors = 0;
      
      // Consider reducing interval if we've been at higher intervals
      if (state.currentIntervalIndex > 0) {
        this.scheduleEndpointIntervalReset(endpointName);
      }
    }
  }

  /**
   * Handle request error for specific endpoint
   */
  handleRequestError(error, endpointName, startTime) {
    const state = this.endpointStates[endpointName];
    const config = this.endpointConfigs[endpointName];
    
    // Update endpoint stats
    state.stats.totalErrors++;
    state.stats.lastErrorTime = new Date().toISOString();
    
    // Update global stats
    this.globalStats.totalErrors++;

    // Increase consecutive error count
    state.consecutiveErrors++;
    
    this.logger.warn(`${endpointName} error (${state.consecutiveErrors}/${config.maxConsecutiveErrors}): ${error.message}`);

    // Apply exponential backoff if retryable error
    if (this.isRetryableError(error) && state.consecutiveErrors >= 2) {
      this.increaseEndpointInterval(endpointName);
    }
  }

  /**
   * Increase rate limiting interval for specific endpoint
   */
  increaseEndpointInterval(endpointName) {
    const state = this.endpointStates[endpointName];
    const config = this.endpointConfigs[endpointName];
    const maxIndex = config.intervals.length - 1;
    
    if (state.currentIntervalIndex < maxIndex) {
      state.currentIntervalIndex++;
      
      const newInterval = config.intervals[state.currentIntervalIndex];
      this.logger.warn(`${endpointName} rate limit increased to ${newInterval/1000}s due to errors`);
    }
  }

  /**
   * Schedule interval reset for specific endpoint
   */
  scheduleEndpointIntervalReset(endpointName) {
    const state = this.endpointStates[endpointName];
    const config = this.endpointConfigs[endpointName];
    const resetTimeout = config.resetTimeoutMinutes * 60 * 1000;
    
    // Clear existing timeout
    if (state.resetTimeout) {
      clearTimeout(state.resetTimeout);
    }
    
    state.resetTimeout = setTimeout(() => {
      if (state.consecutiveErrors === 0) {
        state.currentIntervalIndex = 0;
        this.logger.info(`${endpointName} rate limit reset to ${config.intervals[0]/1000}s`);
      }
      state.resetTimeout = null;
    }, resetTimeout);
  }

  /**
   * Check if error is retryable
   */
  isRetryableError(error) {
    if (!error) return false;
    
    const retryableConditions = [
      // Network/timeout errors
      error.code === 'ECONNRESET',
      error.code === 'ETIMEDOUT',
      error.code === 'ENOTFOUND',
      error.code === 'ECONNREFUSED',
      
      // HTTP status codes
      error.response?.status === 429,
      error.response?.status === 502,
      error.response?.status === 503,
      error.response?.status === 504,
      
      // Steam API specific
      error.message?.includes('rate limit'),
      error.message?.includes('Service Unavailable'),
      error.message?.includes('timeout')
    ];
    
    return retryableConditions.some(condition => condition);
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get comprehensive statistics
   */
  getStats() {
    const endpointStats = {};
    
    for (const [endpointName, state] of Object.entries(this.endpointStates)) {
      const config = this.endpointConfigs[endpointName];
      endpointStats[endpointName] = {
        ...state.stats,
        currentInterval: config.intervals[state.currentIntervalIndex],
        intervalIndex: state.currentIntervalIndex,
        consecutiveErrors: state.consecutiveErrors
      };
    }
    
    return {
      global: {
        ...this.globalStats,
        uptimeMs: Date.now() - this.globalStats.startTime
      },
      endpoints: endpointStats
    };
  }

  /**
   * Reset all statistics
   */
  resetStats() {
    this.globalStats = {
      totalRequests: 0,
      totalErrors: 0,
      totalRateLimitHits: 0,
      startTime: Date.now()
    };
    
    for (const [endpointName, state] of Object.entries(this.endpointStates)) {
      state.currentIntervalIndex = 0;
      state.consecutiveErrors = 0;
      state.stats = {
        totalRequests: 0,
        totalErrors: 0,
        totalRateLimitHits: 0,
        lastRequestTime: null,
        lastErrorTime: null,
        avgResponseTime: 0
      };
      
      if (state.resetTimeout) {
        clearTimeout(state.resetTimeout);
        state.resetTimeout = null;
      }
    }
    
    this.logger.info('SteamApiManager stats reset for all endpoints');
  }
}

module.exports = SteamApiManager;