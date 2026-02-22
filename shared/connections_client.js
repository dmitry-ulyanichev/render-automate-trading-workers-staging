// automate_trading_workers/shared/connections_client.js
//
// Thin HTTP wrapper around node_api_service GET /sessions/:steamId.
// Replaces the direct SteamSessionManager.listActiveSessions() call that
// InventoryWorker used when running inside the same process as HandleFriendsWorker.
//
// Return shape mirrors SteamSessionManager.listActiveSessions() so that
// checkSteamConnectionStatus() in InventoryWorker needs no other changes.
//
// This class is intentionally kept minimal: it is the foundation for future
// workers (e.g. MessageWorker) that will also need cross-service session queries.

const axios = require('axios');

class ConnectionsClient {
  constructor(config, logger) {
    this.logger  = logger;
    this.baseUrl = config.nodeApiService?.baseUrl || process.env.NODE_API_SERVICE_URL || 'http://127.0.0.1:3001';
    this.apiKey  = config.nodeApiService?.apiKey  || process.env.LINK_HARVESTER_API_KEY;
    this.timeout = 5000; // Short timeout: this is a health-check call, not a data fetch

    if (!this.apiKey) {
      throw new Error('ConnectionsClient: Node API Service API key not configured');
    }

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key':    this.apiKey
      }
    });
  }

  /**
   * Query the last-published Steam session status for a given Steam ID.
   *
   * Returns the same shape that SteamSessionManager.listActiveSessions() +
   * the staleness logic in InventoryWorker.checkSteamConnectionStatus() produced,
   * so the calling code is unchanged:
   *
   *   { connected: true|false|'stale'|'unknown', reason, shouldReconnect, sessionAge? }
   *
   * Returns the 'unknown' variant on any network / Redis failure so callers
   * can decide whether to treat it as a hard block or proceed optimistically.
   */
  async getSessionStatus(steamId) {
    try {
      const response = await this.client.get(`/sessions/${steamId}`);

      if (!response.data?.success) {
        return {
          connected:       'unknown',
          reason:          `Unexpected response: ${JSON.stringify(response.data)}`,
          shouldReconnect: false
        };
      }

      const { isOnline, sessionAge, removed } = response.data;

      if (removed) {
        return {
          connected:       false,
          reason:          'Session was explicitly removed from connections service',
          shouldReconnect: true,
          sessionAge
        };
      }

      if (!isOnline) {
        return {
          connected:       false,
          reason:          'Session exists but is offline',
          shouldReconnect: true,
          sessionAge
        };
      }

      // Mirror the 10-minute stale threshold from the original implementation
      if (sessionAge !== null && sessionAge > 600) {
        return {
          connected:       'stale',
          reason:          `Session is stale (${sessionAge}s since last update)`,
          shouldReconnect: true,
          sessionAge
        };
      }

      return {
        connected:       true,
        reason:          'Session is active and fresh',
        shouldReconnect: false,
        sessionAge
      };

    } catch (error) {
      // 404 = no status published yet (connections service never registered this account,
      // or the 30-minute TTL expired)
      if (error.response?.status === 404) {
        return {
          connected:       false,
          reason:          'No session status found in connections service',
          shouldReconnect: true
        };
      }

      // Any other error (network, Redis down, etc.) — be non-blocking
      this.logger.warn(`ConnectionsClient: could not reach node_api_service for session status of ${steamId}: ${error.message}`);
      return {
        connected:       'unknown',
        reason:          `Failed to reach connections service: ${error.message}`,
        shouldReconnect: false
      };
    }
  }
}

module.exports = ConnectionsClient;
