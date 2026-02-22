// automate_trading/utils/http_client.js
const axios = require('axios');

/**
 * HTTP client for communicating with node_api_service
 * Handles negotiations and other file operations via API
 */
class HttpClient {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;

    // Get API settings from config or environment
    this.baseUrl = config.nodeApiService?.baseUrl || process.env.NODE_API_SERVICE_URL || 'http://127.0.0.1:3001';
    this.apiKey = config.nodeApiService?.apiKey || process.env.LINK_HARVESTER_API_KEY;
    this.timeout = config.nodeApiService?.timeout || 30000;

    // Retry configuration: 3 retries with 1s, 2s, 4s delays (max ~7 seconds)
    this.retryDelays = config.nodeApiService?.retryDelays || [1000, 2000, 4000];

    if (!this.apiKey) {
      throw new Error('Node API Service API key not configured');
    }

    // Create axios instance with default configuration
    this.axios = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey
      }
    });
    
    // Add request interceptor for logging
    this.axios.interceptors.request.use(
      (config) => {
        // this.logger.debug(`HTTP Request: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        this.logger.error(`HTTP Request Error: ${error.message}`);
        return Promise.reject(error);
      }
    );
    
    // Add response interceptor for logging
    this.axios.interceptors.response.use(
      (response) => {
        // this.logger.debug(`HTTP Response: ${response.status} ${response.config.method?.toUpperCase()} ${response.config.url} - ${response.data?.success ? 'SUCCESS' : 'FAILED'}`);
        return response;
      },
      (error) => {
        const status = error.response?.status || 'NO_RESPONSE';
        const method = error.config?.method?.toUpperCase() || 'UNKNOWN';
        const url = error.config?.url || 'UNKNOWN';
        this.logger.error(`HTTP Response Error: ${status} ${method} ${url} - ${error.message}`);
        return Promise.reject(error);
      }
    );
    
    // this.logger.info(`HTTP Client initialized - Base URL: ${this.baseUrl}`);

    // Request metrics tracking
    this.metrics = {
      total: 0,           // Total requests initiated
      active: 0,          // Currently active requests
      peak: 0,            // Peak concurrent requests
      completed: 0,       // Successfully completed requests
      failed: 0,          // Failed requests (after all retries)
      startTime: Date.now()
    };

    // Start periodic metrics logging if enabled
    if (process.env.AUTOMATE_TRADING_METRICS_LOGGING === 'true') {
      const logInterval = parseInt(process.env.AUTOMATE_TRADING_METRICS_INTERVAL) || 60000; // Default 60s
      this.metricsTimer = setInterval(() => {
        this.logMetrics();
      }, logInterval);
      this.logger.info(`HTTP Client metrics logging enabled (interval: ${logInterval / 1000}s)`);
    }
  }
  
  /**
   * Test connection to node_api_service
   */
  async testConnection() {
    try {
      const response = await this.axios.get('/health');
      this.logger.info('Node API Service connection test successful');
      return {
        success: true,
        status: response.data.status,
        service: response.data.service
      };
    } catch (error) {
      this.logger.error(`Node API Service connection test failed: ${error.message}`);
      throw new Error(`Cannot connect to Node API Service at ${this.baseUrl}: ${error.message}`);
    }
  }

  // ==================== RETRY UTILITIES ====================

  /**
   * Check if an error is retryable (transient network issues)
   * @param {Error} error - The error to check
   * @returns {boolean} - True if the error is retryable
   */
  isRetryableError(error) {
    // No response from server (socket hang up, connection reset, etc.)
    if (error.request && !error.response) {
      return true;
    }

    // Specific error codes that indicate transient network issues
    const retryableErrorCodes = [
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'ENOTFOUND',
      'ENETUNREACH',
      'EAI_AGAIN'
    ];

    if (retryableErrorCodes.includes(error.code)) {
      return true;
    }

    // HTTP 5xx errors (server errors) - might be transient
    if (error.response && error.response.status >= 500) {
      return true;
    }

    // Not retryable (4xx errors, validation errors, etc.)
    return false;
  }

  /**
   * Retry a function with exponential backoff on retryable errors
   * @param {Function} fn - Async function to retry
   * @param {string} operationName - Name of operation for logging
   * @returns {Promise} - Result of the function
   */
  async withRetry(fn, operationName) {
    // Track metrics
    this.metrics.total++;
    this.metrics.active++;
    this.metrics.peak = Math.max(this.metrics.peak, this.metrics.active);

    let lastError;

    try {
      for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
        try {
          const result = await fn();
          this.metrics.completed++;
          return result;
        } catch (error) {
          lastError = error;

          // Check if we should retry
          const isRetryable = this.isRetryableError(error);
          const hasRetriesLeft = attempt < this.retryDelays.length;

          if (!isRetryable) {
            // Fail fast on non-retryable errors (auth, validation, etc.)
            throw error;
          }

          if (!hasRetriesLeft) {
            // Exhausted all retries
            this.logger.error(`${operationName} failed after ${attempt} retries: ${error.message}`);
            throw error;
          }

          // Log retry attempt
          const delay = this.retryDelays[attempt];
          this.logger.warn(`${operationName} failed (attempt ${attempt + 1}/${this.retryDelays.length + 1}): ${error.message}. Retrying in ${delay}ms...`);

          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }

      // Should never reach here, but just in case
      throw lastError;
    } catch (error) {
      this.metrics.failed++;
      throw error;
    } finally {
      this.metrics.active--;
    }
  }

  // ==================== NEGOTIATIONS API ====================
  
  /**
   * Load negotiations for a Steam account (with retry on transient errors)
   */
  async loadNegotiations(steamId) {
    return this.withRetry(async () => {
      this.logger.debug(`Loading negotiations for Steam ID: ${steamId}`);

      const response = await this.axios.get(`/negotiations/${steamId}`);

      if (!response.data || !response.data.success) {
        const errorMsg = (response.data && response.data.error) || 'Failed to load negotiations';
        throw new Error(errorMsg);
      }

      // Return the negotiations data directly, not wrapped
      const negotiations = response.data.data;

      this.logger.debug(`Negotiations loaded for ${steamId}: ${Object.keys(negotiations.negotiations || {}).length} negotiations${response.data.created_new ? ' (new file created)' : ''}`);

      return negotiations;

    }, `Load negotiations for ${steamId}`);
  }
  
  /**
   * Save negotiations for a Steam account (with retry on transient errors)
   */
  async saveNegotiations(steamId, negotiations) {
    return this.withRetry(async () => {
      this.logger.debug(`Saving negotiations for Steam ID: ${steamId}`);

      // Validate negotiations data
      if (!negotiations || typeof negotiations !== 'object') {
        throw new Error('Invalid negotiations data format');
      }

      if (!negotiations.account_steam_id || negotiations.account_steam_id !== steamId) {
        // Fix the account_steam_id if it's missing or incorrect
        negotiations.account_steam_id = steamId;
      }

      const response = await this.axios.post(`/negotiations/${steamId}`, negotiations);

      if (!response.data || !response.data.success) {
        const errorMsg = (response.data && response.data.error) || 'Failed to save negotiations';
        throw new Error(errorMsg);
      }

      this.logger.debug(`Negotiations saved for ${steamId}: ${response.data.negotiations_count} negotiations`);

      return {
        success: true,
        message: response.data.message,
        negotiations_count: response.data.negotiations_count,
        updated_at: response.data.updated_at
      };

    }, `Save negotiations for ${steamId}`);
  }
  
  /**
   * Check if negotiations file exists for a Steam account
   */
  async checkNegotiationsHealth(steamId) {
    try {
      this.logger.debug(`Checking negotiations health for Steam ID: ${steamId}`);
      
      const response = await this.axios.get(`/negotiations/${steamId}/health`);
      
      if (!response.data.success) {
        throw new Error(response.data.error || 'Failed to check negotiations health');
      }
      
      return {
        success: true,
        steam_id: response.data.steam_id,
        file_exists: response.data.file_exists,
        file_stats: response.data.file_stats
      };
      
    } catch (error) {
      this.logger.error(`Error checking negotiations health for ${steamId}: ${error.message}`);
      return {
        success: false,
        steam_id: steamId,
        file_exists: false,
        error: error.message
      };
    }
  }
  
  /**
   * Get negotiations statistics across all accounts
   */
  async getNegotiationsStats() {
    try {
      this.logger.debug('Getting negotiations statistics');
      
      const response = await this.axios.get('/negotiations/');
      
      return {
        success: true,
        stats: response.data
      };
      
    } catch (error) {
      this.logger.error(`Error getting negotiations statistics: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Atomically upsert trade offer (read-modify-write in single lock)
   * This prevents race conditions when multiple events update the same file simultaneously
   */
  async atomicUpsertTradeOffer(steamId, tradeOfferData) {
    try {
      this.logger.debug(`Atomically upserting trade offer ${tradeOfferData.trade_offer_id} for ${steamId}`);

      const response = await this.axios.post(`/negotiations/${steamId}/atomic-upsert-trade-offer`, {
        trade_offer_data: tradeOfferData
      });

      if (!response.data || !response.data.success) {
        const errorMsg = (response.data && response.data.error) || 'Failed to atomically upsert trade offer';
        throw new Error(errorMsg);
      }

      this.logger.debug(`Atomically ${response.data.operation} trade offer ${tradeOfferData.trade_offer_id} → ${tradeOfferData.state}`);

      return {
        success: true,
        operation: response.data.operation,
        trade_offer_id: response.data.trade_offer_id,
        state: response.data.state,
        updated_at: response.data.updated_at
      };

    } catch (error) {
      // Better axios error handling
      if (error.response) {
        const errorMsg = error.response.data?.error || error.response.statusText || 'Server error';
        this.logger.error(`Error atomically upserting trade offer: ${errorMsg} (status: ${error.response.status})`);
        throw new Error(errorMsg);
      } else if (error.request) {
        this.logger.error(`Error atomically upserting trade offer: No response from server`);
        throw new Error('No response from server');
      } else {
        this.logger.error(`Error atomically upserting trade offer: ${error.message}`);
        throw error;
      }
    }
  }

  // ==================== TASK QUEUE API ====================

  async taskQueueAdd(queueName, task) {
    return this.withRetry(async () => {
      const response = await this.axios.post(`/taskqueue/${queueName}/add`, task);
      if (!response.data?.success) {
        throw new Error(response.data?.error || 'Failed to add task to queue');
      }
      return { added: response.data.added, duplicate: response.data.duplicate };
    }, `taskQueueAdd ${queueName}:${task.taskID}`);
  }

  async taskQueueGetNext(queueName, count = 1, remove = false) {
    return this.withRetry(async () => {
      const response = await this.axios.post(`/taskqueue/${queueName}/next`, { count, remove });
      if (!response.data?.success) {
        throw new Error(response.data?.error || 'Failed to get next tasks');
      }
      return response.data.tasks;
    }, `taskQueueGetNext ${queueName}`);
  }

  async taskQueueUpdate(queueName, taskID, updates) {
    try {
      return await this.withRetry(async () => {
        const response = await this.axios.post(`/taskqueue/${queueName}/update`, { taskID, updates });
        if (!response.data?.success) {
          throw new Error(response.data?.error || 'Failed to update task');
        }
        return true;
      }, `taskQueueUpdate ${queueName}:${taskID}`);
    } catch (error) {
      // 404 means task not found — return false instead of throwing
      if (error.response?.status === 404) return false;
      throw error;
    }
  }

  async taskQueueRemove(queueName, taskID) {
    return this.withRetry(async () => {
      const response = await this.axios.post(`/taskqueue/${queueName}/remove`, { taskID });
      if (!response.data?.success) {
        throw new Error(response.data?.error || 'Failed to remove task');
      }
      return response.data.removed;
    }, `taskQueueRemove ${queueName}:${taskID}`);
  }

  async taskQueueGetAll(queueName) {
    return this.withRetry(async () => {
      const response = await this.axios.get(`/taskqueue/${queueName}/tasks`);
      if (!response.data?.success) {
        throw new Error(response.data?.error || 'Failed to get tasks');
      }
      return response.data.tasks;
    }, `taskQueueGetAll ${queueName}`);
  }

  async taskQueueStats(queueName) {
    return this.withRetry(async () => {
      const response = await this.axios.get(`/taskqueue/${queueName}/stats`);
      if (!response.data?.success) {
        throw new Error(response.data?.error || 'Failed to get queue stats');
      }
      return response.data.stats;
    }, `taskQueueStats ${queueName}`);
  }

  async taskQueueBulkRemove(queueName, taskIDs) {
    return this.withRetry(async () => {
      const response = await this.axios.post(`/taskqueue/${queueName}/bulk-remove`, { taskIDs });
      if (!response.data?.success) {
        throw new Error(response.data?.error || 'Failed to bulk remove tasks');
      }
      return response.data.removed;
    }, `taskQueueBulkRemove ${queueName}`);
  }
  
  // ==================== CONNECTION CONTROL API ====================

  /**
   * Poll connection control settings (called each sync cycle).
   * Returns the sync interval override (non-destructive) and the full
   * priority accounts set (non-destructive). Each instance then calls
   * claimPriorityAccounts() for only the accounts it has credentials for.
   * @returns {Promise<{syncIntervalSeconds: number|null, priorityAccounts: string[]}>}
   */
  async pollConnectionControl() {
    return this.withRetry(async () => {
      const response = await this.axios.post('/connection-control/poll');
      if (!response.data?.success) {
        throw new Error(response.data?.error || 'Failed to poll connection control');
      }
      return {
        syncIntervalSeconds: response.data.syncIntervalSeconds,
        priorityAccounts: response.data.priorityAccounts || []
      };
    }, 'pollConnectionControl');
  }

  /**
   * Claim priority accounts this instance is responsible for.
   * Atomically removes the given steam_logins from the Redis set via SREM,
   * leaving unclaimed entries for other instances.
   * @param {string[]} steamLogins
   */
  async claimPriorityAccounts(steamLogins) {
    return this.withRetry(async () => {
      const response = await this.axios.post('/connection-control/priority/claim', { steamLogins });
      if (!response.data?.success) {
        throw new Error(response.data?.error || 'Failed to claim priority accounts');
      }
      return response.data;
    }, 'claimPriorityAccounts');
  }

  /**
   * Set the sync interval override (persists until explicitly cleared).
   * @param {number} seconds
   */
  async setConnectionSyncInterval(seconds) {
    return this.withRetry(async () => {
      const response = await this.axios.put('/connection-control/sync-interval', { seconds });
      if (!response.data?.success) {
        throw new Error(response.data?.error || 'Failed to set sync interval');
      }
      return response.data;
    }, `setConnectionSyncInterval(${seconds})`);
  }

  /**
   * Clear the sync interval override (worker reverts to hardcoded default).
   */
  async clearConnectionSyncInterval() {
    return this.withRetry(async () => {
      const response = await this.axios.delete('/connection-control/sync-interval');
      if (!response.data?.success) {
        throw new Error(response.data?.error || 'Failed to clear sync interval');
      }
      return response.data;
    }, 'clearConnectionSyncInterval');
  }

  /**
   * Add priority connection requests.
   * @param {string[]} steamLogins
   */
  async addPriorityAccounts(steamLogins) {
    return this.withRetry(async () => {
      const response = await this.axios.post('/connection-control/priority', { steamLogins });
      if (!response.data?.success) {
        throw new Error(response.data?.error || 'Failed to add priority accounts');
      }
      return response.data;
    }, 'addPriorityAccounts');
  }

  /**
   * Clear all pending priority connection requests.
   */
  async clearPriorityAccounts() {
    return this.withRetry(async () => {
      const response = await this.axios.delete('/connection-control/priority');
      if (!response.data?.success) {
        throw new Error(response.data?.error || 'Failed to clear priority accounts');
      }
      return response.data;
    }, 'clearPriorityAccounts');
  }

  // ==================== UTILITY METHODS ====================
  
  /**
   * Generic GET request with error handling
   */
  async get(endpoint, options = {}) {
    try {
      const response = await this.axios.get(endpoint, options);
      return response.data;
    } catch (error) {
      this.logger.error(`GET ${endpoint} failed: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Generic POST request with error handling
   */
  async post(endpoint, data, options = {}) {
    try {
      const response = await this.axios.post(endpoint, data, options);
      return response.data;
    } catch (error) {
      this.logger.error(`POST ${endpoint} failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * DELETE request
   */
  async delete(endpoint) {
    try {
      const response = await this.axios.delete(endpoint);
      return response.data;
    } catch (error) {
      this.logger.error(`HTTP DELETE error on ${endpoint}: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Update configuration at runtime
   */
  updateConfig(newConfig) {
    if (newConfig.baseUrl) {
      this.baseUrl = newConfig.baseUrl;
      this.axios.defaults.baseURL = this.baseUrl;
    }
    
    if (newConfig.apiKey) {
      this.apiKey = newConfig.apiKey;
      this.axios.defaults.headers['X-API-Key'] = this.apiKey;
    }
    
    if (newConfig.timeout) {
      this.timeout = newConfig.timeout;
      this.axios.defaults.timeout = this.timeout;
    }
    
    this.logger.info('HTTP Client configuration updated');
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
    this.logger.info(`[NodeAPI Metrics] Active: ${metrics.active}, Peak: ${metrics.peak}, Total: ${metrics.total}, Completed: ${metrics.completed}, Failed: ${metrics.failed}, RPM: ${metrics.requestsPerMinute}`);
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    // Clear metrics timer if running
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
      this.logger.info('HTTP Client metrics timer stopped');
    }

    this.logger.info('HTTP Client cleanup completed');
  }
}

module.exports = HttpClient;