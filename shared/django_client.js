// automate_trading/shared/django_client.js

const axios = require('axios');
const config = require('../config/config');

class DjangoClient {
  constructor() {
    this.baseUrl = config.django.baseUrl;
    this.apiKey = config.django.apiKey;

    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'X-API-Key': this.apiKey,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    // Request metrics tracking
    this.metrics = {
      total: 0,           // Total requests initiated
      active: 0,          // Currently active requests
      peak: 0,            // Peak concurrent requests
      completed: 0,       // Successfully completed requests
      failed: 0,          // Failed requests
      startTime: Date.now()
    };

    // Get logger from config (or create console fallback)
    this.logger = config.logger || console;

    // Start periodic metrics logging if enabled
    if (process.env.AUTOMATE_TRADING_METRICS_LOGGING === 'true') {
      const logInterval = parseInt(process.env.AUTOMATE_TRADING_METRICS_INTERVAL) || 60000; // Default 60s
      this.metricsTimer = setInterval(() => {
        this.logMetrics();
      }, logInterval);
      this.logger.info(`Django Client metrics logging enabled (interval: ${logInterval / 1000}s)`);
    }
  }

  /**
   * Internal wrapper to track request metrics
   * @param {Function} requestFn - Async function that makes the request
   * @returns {Promise} - Result of the request
   */
  async _trackRequest(requestFn) {
    this.metrics.total++;
    this.metrics.active++;
    this.metrics.peak = Math.max(this.metrics.peak, this.metrics.active);

    try {
      const result = await requestFn();
      this.metrics.completed++;
      return result;
    } catch (error) {
      this.metrics.failed++;
      throw error;
    } finally {
      this.metrics.active--;
    }
  }

  // Existing methods
  async getAccountsWithInviteSlots() {
    try {
      const response = await this.client.get('/links/api/accounts-with-invite-slots/');
      return response.data;
    } catch (error) {
      throw new Error(`Failed to get accounts: ${error.message}`);
    }
  }

  async getNewLinksBatch() {
    try {
      const response = await this.client.get('/links/api/new-links-batch/');
      return response.data;
    } catch (error) {
      throw new Error(`Failed to get links batch: ${error.message}`);
    }
  }

  async updateInviteLimit(accountId) {
    try {
      const response = await this.client.post('/links/api/update-invite-limit/', {
        account_id: accountId
      });
      return response.data;
    } catch (error) {
      throw new Error(`Failed to update invite limit: ${error.message}`);
    }
  }

  async markLinkInviteSent(linkId, accountId) {
    try {
      const response = await this.client.post('/links/api/mark-link-invite-sent/', {
        link_id: linkId,
        account_id: accountId
      });
      return response.data;
    } catch (error) {
      throw new Error(`Failed to mark link as invite sent: ${error.message}`);
    }
  }

  // NEW methods for HandleFriendsWorker

  async getActiveAccounts() {
    try {
      const response = await this.client.get('/links/api/active-accounts/');
      return response.data;
    } catch (error) {
      throw new Error(`Failed to get active accounts: ${error.message}`);
    }
  }

  async getAuthToken(steamId) {
    try {
      // Cambiar a usar el nuevo endpoint que busca por Steam ID
      const response = await this.client.get(`/links/api/get-auth-token-by-steam-id/${steamId}/`);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to get auth token: ${error.message}`);
    }
  }

  /**
   * Get auth token by Steam ID (new endpoint)
   * Returns only the token part (eyAid....), not the full Cookie header
   */
  async getAuthTokenBySteamId(steamId) {
    try {
      const response = await this.client.get(`/links/api/get-auth-token-by-steam-id/${steamId}/`);
      
      // Check if response has the expected structure
      if (response.data && response.data.success && response.data.token_value) {
        return {
          success: true,
          token: response.data.token_value  // Map token_value to token
        };
      } else {
        return {
          success: false,
          token: null
        };
      }
    } catch (error) {
      throw new Error(`Failed to get auth token by Steam ID: ${error.message}`);
    }
  }

  async updateAuthToken(steamAccountId, tokenValue, isValid) {
    try {
      const response = await this.client.post('/links/api/update-auth-token/', {
        steam_account_id: steamAccountId,
        token_value: tokenValue,
        is_valid: isValid
      });
      return response.data;
    } catch (error) {
      throw new Error(`Failed to update auth token: ${error.message}`);
    }
  }

  async updateFriendsList(steamAccountId, friendUpdates) {
    return this._trackRequest(async () => {
      try {
        const response = await this.client.post('/links/api/update-friends-list/', {
          steam_account_id: steamAccountId,
          friends: friendUpdates
        });
        return response.data;
      } catch (error) {
        throw new Error(`Failed to update friends list: ${error.message}`);
      }
    });
  }

  async updateFriendRelationship(steamAccountId, friendSteamId, relationship) {
    return this._trackRequest(async () => {
      try {
        const response = await this.client.post('/links/api/update-friend-relationship/', {
          steam_account_id: steamAccountId,
          friend_steam_id: friendSteamId,
          relationship: relationship
        });
        return response.data;
      } catch (error) {
        throw new Error(`Failed to update friend relationship: ${error.message}`);
      }
    });
  }

  /**
   * Remove a SteamFriend relationship from the database
   * @param {number} steamAccountId - Database ID of the Steam account
   * @param {string} friendSteamId - Steam ID of the friend to remove
   * @returns {Object} { success: boolean, removed: boolean, message: string }
   */
  async removeSteamFriend(steamAccountId, friendSteamId) {
    try {
      const response = await this.client.post('/links/api/remove-steam-friend/', {
        steam_account_id: steamAccountId,
        friend_steam_id: friendSteamId
      });
      
      if (response.data && response.data.success) {
        return {
          success: true,
          removed: response.data.removed,
          message: response.data.message,
          steam_account_id: response.data.steam_account_id,
          friend_steam_id: response.data.friend_steam_id
        };
      } else {
        return {
          success: false,
          error: response.data?.error || 'Unknown error'
        };
      }
    } catch (error) {
      throw new Error(`Failed to remove steam friend: ${error.message}`);
    }
  }

  async updateLinkStatus(friendSteamId, steamAccountId, status) {
    try {
      const response = await this.client.post('/links/api/update-link-status/', {
        steam_id: friendSteamId,
        steam_account_id: steamAccountId,
        status: status
      });
      return response.data;
    } catch (error) {
      throw new Error(`Failed to update link status: ${error.message}`);
    }
  }

  /**
   * Batch update link status for multiple friends
   * @param {Array} updates - Array of {friendSteamId, steamAccountId, status} objects
   * @returns {Object} { success: boolean, results: Array, stats: Object }
   */
  async batchUpdateLinkStatus(updates) {
    return this._trackRequest(async () => {
      try {
        // Transform the updates array to match Django API format
        const formattedUpdates = updates.map(update => ({
          steam_id: update.friendSteamId,
          steam_account_id: update.steamAccountId,
          status: update.status
        }));

        const response = await this.client.post('/links/api/batch-update-link-status/', {
          updates: formattedUpdates
        });
        return response.data;
      } catch (error) {
        throw new Error(`Failed to batch update link status: ${error.message}`);
      }
    });
  }

  /**
   * Get Steam account ID by Steam ID (slug)
   * @param {string} steamId - Steam ID to look up
   * @returns {Object} { success: boolean, steam_account_id: number, steam_id: string, username: string }
   */
  async getSteamAccountIdBySteamId(steamId) {
    try {
      const response = await this.client.get(`/links/api/get-steam-account-id-by-steam-id/${steamId}/`);
      
      if (response.data && response.data.success) {
        return {
          success: true,
          steam_account_id: response.data.steam_account_id,
          steam_id: response.data.steam_id,
          username: response.data.username,
          steam_login: response.data.steam_login,
          active: response.data.active
        };
      } else {
        return {
          success: false,
          error: response.data?.error || 'Unknown error'
        };
      }
    } catch (error) {
      throw new Error(`Failed to get Steam account ID by Steam ID: ${error.message}`);
    }
  }

  async markInvitesExpired() {
    try {
      const response = await this.client.post('/links/api/mark-invites-expired/');
      return response.data;
    } catch (error) {
      throw new Error(`Failed to mark expired invites: ${error.message}`);
    }
  }

  /**
   * Get prices for multiple items in batch
   * New optimized endpoint that handles cooldown coordination
   *
   * @param {Array} items - Array of item objects with structure:
   *   [{market_hash_name, classid?, icon_url?, est_usd?}, ...]
   * @param {number} maxRetries - Maximum number of retries for initial cooldown only
   * @returns {Array} Array of {market_hash_name, price} objects
   */
  async getInventoryPrices(items, maxRetries = 3) {
    return this._trackRequest(async () => {
      if (!items || !Array.isArray(items) || items.length === 0) {
        return [];
      }

      // Calculate dynamic timeout based on number of items
      const batchTimeout = Math.max(300000, items.length * 10000); // Min 5min, +10s per item

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const response = await this.client.post('/finances/api/dashboard/steam-inventory-prices/', {
            items: items
          }, {
            timeout: batchTimeout
          });

          if (response.data.success && Array.isArray(response.data.prices)) {
            return response.data.prices;
          } else {
            // Unexpected response format
            throw new Error(`Invalid response format: ${JSON.stringify(response.data)}`);
          }

        } catch (error) {
          // Only retry if Django is already in cooldown at the start (not during processing)
          if (error.response && error.response.status === 429) {
            const cooldownInfo = error.response.data;

            // Check if this is "initial cooldown" vs "processing error"
            if (cooldownInfo.cooldown_remaining !== undefined) {
              // Django was already in cooldown when we called - we should wait and retry
              const cooldownTime = cooldownInfo.cooldown_remaining;

              if (attempt < maxRetries) {
                // Wait for the cooldown and retry
                await new Promise(resolve => setTimeout(resolve, cooldownTime * 1000));
                continue;
              } else {
                // Max retries reached, return empty array
                return [];
              }
            } else {
              // This shouldn't happen anymore - Django handles processing cooldowns internally
              // But if it does, don't retry - return empty array
              return [];
            }
          } else if (error.response && error.response.status >= 500) {
            // Server error - retry with exponential backoff
            if (attempt < maxRetries) {
              const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
              await new Promise(resolve => setTimeout(resolve, delay));
              continue;
            }
          }

          // For last attempt or non-retryable errors, return empty array
          if (attempt === maxRetries) {
            return [];
          }

          throw error;
        }
      }

      return [];
    });
  }

  /**
   * Determine negotiation source based on friend's Steam ID
   * @param {string} friendSteamId - Friend's Steam ID
   * @returns {Object} { success: boolean, source: 'match'|'reserve_pipeline', user_id: number|null }
   */
  async determineNegotiationSource(friendSteamId) {
    return this._trackRequest(async () => {
      try {
        const response = await this.client.post('/links/api/determine-negotiation-source/', {
          friend_steam_id: friendSteamId
        });
        return response.data;
      } catch (error) {
        throw new Error(`Failed to determine negotiation source: ${error.message}`);
      }
    });
  }

  // ==================== TRADE MODEL OPERATIONS ====================

  /**
   * Create or update a Trade offer in Django database
   * @param {Object} tradeData - Trade offer data
   * @param {string} tradeData.steam_id - Our Steam account ID (will be mapped to database ID)
   * @param {string} tradeData.trade_offer_id - Steam trade offer ID
   * @param {number} tradeData.state - Trade state code (1-11)
   * @param {string} tradeData.trade_partner_steam_id - Partner's Steam ID
   * @param {boolean} tradeData.is_our_offer - Whether we sent the offer
   * @param {boolean} tradeData.intra - Whether trade is between our own accounts
   * @param {number} tradeData.total_items_to_give - Total value of items we're giving
   * @param {number} tradeData.total_items_to_receive - Total value of items we're receiving
   * @returns {Object} { success: boolean, trade_id: number, created: boolean }
   */
  async upsertTrade(tradeData) {
    return this._trackRequest(async () => {
      try {
        const response = await this.client.post('/links/api/upsert-trade/', tradeData);
        return response.data;
      } catch (error) {
        throw new Error(`Failed to upsert trade: ${error.message}`);
      }
    });
  }

  /**
   * Update trade offer state
   * @param {string} tradeOfferId - Steam trade offer ID
   * @param {number} newState - New state code (1-11)
   * @returns {Object} { success: boolean, trade_id: number, previous_state: number }
   */
  async updateTradeState(tradeOfferId, newState) {
    try {
      const response = await this.client.post('/links/api/update-trade-state/', {
        trade_offer_id: tradeOfferId,
        state: newState
      });
      return response.data;
    } catch (error) {
      throw new Error(`Failed to update trade state: ${error.message}`);
    }
  }

  /**
   * Get trade by trade offer ID
   * @param {string} tradeOfferId - Steam trade offer ID
   * @returns {Object} { success: boolean, trade: object }
   */
  async getTrade(tradeOfferId) {
    try {
      const response = await this.client.get(`/links/api/get-trade/${tradeOfferId}/`);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to get trade: ${error.message}`);
    }
  }

  /**
   * Get active trades by steam ID
   * Returns trades in "active" states (Active, InEscrow, Accepted, CreatedNeedsConfirmation)
   * @param {string} steamId - Steam ID to look up
   * @returns {Object} { success: boolean, trades: Array, count: number }
   */
  async getActiveTradesBySteamId(steamId) {
    try {
      const response = await this.client.get(`/links/api/get-active-trades-by-steam-id/${steamId}/`);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to get active trades by steam ID: ${error.message}`);
    }
  }

  /**
   * Get current metrics
   */
  getMetrics() {
    const uptime = Date.now() - this.metrics.startTime;
    const uptimeMinutes = uptime / 60000;
    const requestsPerMinute = uptimeMinutes > 0 ? this.metrics.total / uptimeMinutes : 0;

    return {
      total: this.metrics.total,
      active: this.metrics.active,
      peak: this.metrics.peak,
      completed: this.metrics.completed,
      failed: this.metrics.failed,
      requestsPerMinute: requestsPerMinute.toFixed(2),
      uptimeMinutes: uptimeMinutes.toFixed(2)
    };
  }

  /**
   * Log current metrics
   */
  logMetrics() {
    const metrics = this.getMetrics();
    this.logger.info(`[Django API Metrics] Active: ${metrics.active}, Peak: ${metrics.peak}, Total: ${metrics.total}, Completed: ${metrics.completed}, Failed: ${metrics.failed}, RPM: ${metrics.requestsPerMinute}`);
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    // Clear metrics timer if running
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
      this.logger.info('Django Client metrics timer stopped');
    }
  }
}

module.exports = DjangoClient;