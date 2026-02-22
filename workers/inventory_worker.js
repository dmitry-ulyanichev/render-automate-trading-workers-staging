// automate_trading_workers/workers/inventory_worker.js

const createQueueManager = require('../utils/queue_factory');
const HttpClient = require('../utils/http_client');
const SteamApiManager = require('../utils/steam_api_manager');
const DjangoClient = require('../shared/django_client');
const InventoryCooldownManager = require('../utils/inventory_cooldown_manager');
const ConnectionsClient = require('../shared/connections_client');

class TaskPermanentError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TaskPermanentError';
    this.code = code;
  }
}

class TaskTemporaryError extends Error {
  constructor(message, code, retryDelaySeconds) {
    super(message);
    this.name = 'TaskTemporaryError';
    this.code = code;
    this.retryDelaySeconds = retryDelaySeconds;
  }
}

/**
 * InventoryWorker - Processes inventory checks for trade negotiations
 * 
 * Features:
 * - Uses Django API for auth tokens and prices
 * - Direct Steam HTTP endpoint via SteamApiManager
 * - Global IP-based cooldown management with exponential backoffs
 * - Formats inventory data: [{market_hash_name, quantity, price, tradeable}]
 * - Updates orchestration tasks and negotiation data in Redis
 */
class InventoryWorker {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    
    // Worker configuration
    this.workerName = 'InventoryWorker';
    this.isRunning = false;
    this.isPaused = false;
    this.processInterval = config.inventory?.processInterval || 5000; // 5 seconds default
    this.batchSize = 1; // Always process one task at a time due to rate limiting
    
    // Initialize managers
    this.httpClient = new HttpClient(config, logger);
    this.inventoryQueue = createQueueManager('inventory_queue', config, logger, this.httpClient);
    this.orchestrationQueue = createQueueManager('orchestration_queue', config, logger, this.httpClient);
    this.steamApi = new SteamApiManager(config, logger, {
      onProxyExpired: (connection) => this._notifyProxyExpired(connection)
    });
    this.djangoClient = new DjangoClient();
    this.cooldownManager = new InventoryCooldownManager(config, logger);
    this.connectionsClient = new ConnectionsClient(config, logger);
    
    // CS2 configuration
    this.CS2_APP_ID = 730;
    this.CS2_CONTEXT_ID = 2;
    
    // Statistics tracking
    this.stats = {
      tasksProcessed: 0,
      tasksSkipped: 0,
      cooldownSkips: 0,
      errors: 0,
      inventoriesLoaded: 0,
      rateLimitHits: 0,
      lastProcessedAt: null,
      startedAt: null,
      cycleCount: 0
    };
    
    // Timers
    this.processTimer = null;
    this.statsTimer = null;

    // This flag prevents overlapping or double task processing
    this.isProcessingTask = false;
    
    this.logger.info(`${this.workerName} initialized - Process interval: ${this.processInterval}ms`);
  }

  /**
   * Start the worker
   */
  async start() {
    if (this.isRunning) {
      this.logger.warn(`${this.workerName} is already running`);
      return;
    }

    try {
      // Initialize cooldown manager
      await this.cooldownManager.loadCooldownState();

      // Start proxy hot-reload (polls proxy.json every 5 minutes)
      this.steamApi.startProxyReload();

      this.isRunning = true;
      this.stats.startedAt = new Date().toISOString();

      // Start processing timer
      this.processTimer = setInterval(async () => {
        if (!this.isPaused) {
          await this.processingCycle().catch(error => {
            this.logger.error(`${this.workerName} cycle error: ${error.message}`);
          });
        }
      }, this.processInterval);

      // Start stats timer (every minute)
      this.statsTimer = setInterval(() => {
        this.logStats();
      }, 60000);

      this.logger.info(`${this.workerName} started successfully`);

    } catch (error) {
      this.logger.error(`Failed to start ${this.workerName}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Stop the worker
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    this.steamApi.stopProxyReload();

    if (this.processTimer) {
      clearInterval(this.processTimer);
      this.processTimer = null;
    }

    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }

    this.logger.info(`${this.workerName} stopped`);
  }

  async processingCycle() {
    this.stats.cycleCount++;

    try {
      // Skip if already processing a task
      if (this.isProcessingTask) {
        this.logger.debug(`${this.workerName} cycle skipped: already processing a task`);
        return;
      }

      // Check for global cooldown first
      const cooldownStatus = this.cooldownManager.getStatus();
      if (cooldownStatus.active) {
        this.stats.cooldownSkips++;
        await this.updateTaskTimestampsForCooldown();
        this.logger.debug(`${this.workerName} cycle skipped: ${cooldownStatus.message}`);
        return;
      }

      // Get next ready task WITHOUT removing it from queue
      const tasks = await this.inventoryQueue.getNextTasks(1, false);
      
      if (!tasks || tasks.length === 0) {
        return;
      }

      // Process the single task
      const task = tasks[0];

      // Set processing flag
      this.isProcessingTask = true;
      
      try {
        await this.processInventoryTask(task);
        
        // SUCCESS: Remove task from queue only after successful processing
        await this.inventoryQueue.removeTask(task.taskID);
        this.logger.debug(`${this.workerName}: Successfully completed and removed task ${task.taskID}`);
        
      } catch (error) {
        if (error.isRateLimit) {
          await this.handleRateLimit(task);
        } else if (error instanceof TaskPermanentError || error instanceof TaskTemporaryError) {
          await this.handleTaskError(task, error);
        } else {
          const tempError = new TaskTemporaryError(error.message, 'UNKNOWN_ERROR', 300);
          await this.handleTaskError(task, tempError);
        }
      } finally {
        // ✅ FIXED: Always clear processing flag
        this.isProcessingTask = false;
      }

    } catch (error) {
      this.stats.errors++;
      this.logger.error(`${this.workerName} processing cycle error: ${error.message}`);
      this.isProcessingTask = false; // Safety net
    }
  }

  async processInventoryTask(task) {
    const taskStart = Date.now();
    this.logger.info(`${this.workerName} processing task: ${task.taskID}`);

    // Parse task ID to get our Steam ID
    const { ourSteamId } = this.parseTaskID(task.taskID);
    const targetSteamId = task.targetSteamID;
    
    // Get auth token for our account
    const authTokenData = await this.getAuthTokenWithErrorHandling(ourSteamId);
    
    // Validate token before attempting inventory fetch
    await this.validateTokenWithErrorHandling(authTokenData.token, ourSteamId);
    
    // Get inventory from Steam
    const inventoryData = await this.getInventoryWithErrorHandling(
      ourSteamId, targetSteamId, authTokenData.token
    );

    // Handle inventory response
    if (!inventoryData.success) {
      await this.handleInventoryError(task, inventoryData, ourSteamId, targetSteamId);
      return; // handleInventoryError either succeeds or throws
    }

    // SUCCESS: Process the inventory data
    const formattedInventory = await this.formatInventoryData(inventoryData);
    await this.updateTaskResults(task, formattedInventory, ourSteamId, targetSteamId);
    await this.cooldownManager.recordSuccess();

    // Update stats
    this.stats.tasksProcessed++;
    this.stats.inventoriesLoaded++;
    this.stats.lastProcessedAt = new Date().toISOString();

    const duration = Date.now() - taskStart;
    this.logger.info(`${this.workerName} task completed: ${task.taskID} (${duration}ms)`);
  }

  /**
   * Get auth token with proper error classification
   */
  async getAuthTokenWithErrorHandling(ourSteamId) {
    try {
      this.logger.debug(`${this.workerName} requesting auth token for Steam ID: ${ourSteamId}`);
      
      const authTokenData = await this.djangoClient.getAuthTokenBySteamId(ourSteamId);
      
      this.logger.debug(`${this.workerName} Django API response:`, {
        success: authTokenData?.success,
        hasToken: !!authTokenData?.token,
        tokenLength: authTokenData?.token?.length || 0
      });
      
      if (!authTokenData || !authTokenData.success || !authTokenData.token) {
        this.logger.error(`${this.workerName} Invalid auth token response for ${ourSteamId}`);
        throw new TaskPermanentError(
          `No valid auth token found for account ${ourSteamId}`, 
          'AUTH_TOKEN_MISSING'
        );
      }
      
      return authTokenData;
      
    } catch (error) {
      if (error instanceof TaskPermanentError) throw error;
      
      this.logger.error(`${this.workerName} Django API call failed: ${error.message}`);
      throw new TaskTemporaryError(
        `Django API error: ${error.message}`, 
        'DJANGO_API_ERROR', 
        300 // 5min retry
      );
    }
  }

  /**
   * Validate token with connection status awareness using reliable Steam Web API
   */
  async validateTokenWithErrorHandling(token, ourSteamId) {
    this.logger.debug(`${this.workerName} validating Steam token for ${ourSteamId} before inventory fetch`);
    
    // Use the token directly (not steamLoginSecure format) for Web API
    const tokenValidation = await this.steamApi.validateSteamLoginToken(token, ourSteamId);

    if (tokenValidation.valid === false) {
      const connectionStatus = await this.checkSteamConnectionStatus(ourSteamId);
      
      if (!connectionStatus.connected || connectionStatus.connected === 'stale') {
        throw new TaskTemporaryError(
          `Steam token validation failed - session disconnected: ${connectionStatus.reason}`, 
          'AUTH_DISCONNECTED', 
          600
        );
      } else {
        throw new TaskPermanentError(
          `Steam token validation failed: ${tokenValidation.error} (session appears healthy)`, 
          'INVALID_TOKEN'
        );
      }
    }

    if (tokenValidation.valid === null) {
      this.logger.warn(`${this.workerName} token validation inconclusive due to ${tokenValidation.error}, proceeding with inventory fetch`);
    }

    if (tokenValidation.valid === true) {
      this.logger.debug(`${this.workerName} token validation successful for ${ourSteamId}`);
    }
  }

  /**
   * Enhanced getInventoryWithErrorHandling with hybrid classification
   */
  async getInventoryWithErrorHandling(ourSteamId, targetSteamId, token) {
    try {
      const inventoryData = await this.steamApi.getInventory(
        ourSteamId, targetSteamId, token, this.CS2_APP_ID, this.CS2_CONTEXT_ID
      );

      if (inventoryData.success) {
        return inventoryData; // Success
      }

      // If inventory fails with authentication_failed, we need to determine the cause
      if (inventoryData.error === 'authentication_failed') {
        this.logger.debug(`Inventory returned auth_failed, validating token to classify error`);
        
        // Use our reliable token validation
        const tokenValidation = await this.steamApi.validateSteamLoginToken(token, ourSteamId);
        
        if (tokenValidation.valid === false) {
          // Token is definitely invalid
          throw new TaskPermanentError(
            `Steam token validation failed: ${tokenValidation.error}`, 
            'INVALID_TOKEN'
          );
        } else if (tokenValidation.valid === true) {
          // Token is valid, so the 403 from inventory was due to privacy
          this.logger.info(`Token is valid but inventory access denied - treating as private inventory`);
          return {
            success: true, // Convert to success
            inventory: null,  // ✅ FIXED: null instead of []
            inventory_private: true,
            inventory_updated_at: new Date().toISOString()
          };
        } else {
          // Token validation was inconclusive due to network issues
          throw new TaskTemporaryError(
            `Authentication failed, token validation inconclusive: ${tokenValidation.error}`, 
            'AUTH_INCONCLUSIVE', 
            600
          );
        }
      }

      // For other inventory errors (private_inventory, etc.), return as-is
      return inventoryData;
      
    } catch (error) {
      if (error instanceof TaskPermanentError || error instanceof TaskTemporaryError) {
        throw error;
      }
      
      // Handle Steam API errors normally
      if (error.isRateLimit) throw error;
      
      if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
        throw new TaskTemporaryError(`Network timeout: ${error.message}`, 'NETWORK_TIMEOUT', 60);
      }
      
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        throw new TaskTemporaryError(`Network error: ${error.message}`, 'NETWORK_ERROR', 180);
      }
      
      if (error.response?.status >= 500) {
        throw new TaskTemporaryError(`Steam server error: ${error.message}`, 'STEAM_SERVER_ERROR', 300);
      }
      
      throw new TaskTemporaryError(`Steam API error: ${error.message}`, 'STEAM_API_ERROR', 120);
    }
  }

  /**
   * Handle Steam rate limit (429)
   */
  async handleRateLimit(task) {
    this.stats.rateLimitHits++;
    this.logger.warn(`${this.workerName} hit Steam rate limit for task: ${task.taskID}`);

    // Apply exponential backoff cooldown
    const cooldownInfo = await this.cooldownManager.applyRateLimit();

    // Update timestamps for ALL tasks in queue (including current one)
    await this.updateTaskTimestampsForCooldown();

    this.logger.warn(`Applied inventory cooldown: ${cooldownInfo.cooldownDuration / 60000}min (level ${cooldownInfo.backoffLevel})`);
  }

  /**
  * Update timestamps of all tasks in queue to respect current cooldown
  */
  async updateTaskTimestampsForCooldown() {
    try {
      const tasks = await this.inventoryQueue.getTasks();
      if (!tasks || tasks.length === 0) {
        return;
      }

      const nextAllowedTime = this.cooldownManager.getNextAllowedTime();
      let updatedCount = 0;

      for (const task of tasks) {
        // QueueManager uses 'execute' field for timing
        const taskExecuteTime = task.execute ? new Date(task.execute).getTime() : 0;
        
        if (taskExecuteTime < nextAllowedTime) {
          // Update the task's execute time to respect cooldown
          await this.inventoryQueue.updateTask(task.taskID, {
            execute: new Date(nextAllowedTime).toISOString()
          });
          updatedCount++;
        }
      }

      if (updatedCount > 0) {
        this.logger.info(`Updated ${updatedCount} inventory task timestamps for cooldown`);
      }

    } catch (error) {
      this.logger.error(`Error updating task timestamps for cooldown: ${error.message}`);
    }
  }

  /**
   * REFACTORED: Handle inventory errors - now mainly for non-private inventory Steam errors
   * Note: Private inventories are now handled by hybrid logic in getInventoryWithErrorHandling
   */
  async handleInventoryError(task, inventoryData, accountSteamId, targetSteamId) {
    const errorType = inventoryData.error;
    
    this.logger.info(`${this.workerName} handling Steam inventory error for ${targetSteamId}: ${errorType}`);
    
    // Handle remaining private inventory cases (fallback - should be rare with hybrid logic)
    if (errorType === 'private_inventory') {
      this.logger.warn(`${this.workerName}: Private inventory detected via fallback path (hybrid logic bypassed)`);
      
      const inventoryResult = {
        inventory: null,
        inventory_private: true,
        inventory_updated_at: new Date().toISOString()
      };

      await this.updateTaskResults(task, inventoryResult, accountSteamId, targetSteamId);
      this.logger.info(`${this.workerName} completed: private inventory for ${targetSteamId} (fallback path)`);
      return; // Task will be removed in processingCycle
    }

    // Handle authentication failures that bypassed hybrid logic  
    if (errorType === 'authentication_failed') {
      this.logger.error(`Unexpected authentication_failed after token validation for ${accountSteamId}`);
      this.logger.error(`Inventory response: ${JSON.stringify(inventoryData)}`);
      
      throw new TaskTemporaryError(
        `Unexpected authentication failure: ${inventoryData.message}`, 
        'UNEXPECTED_AUTH_FAILURE', 
        300
      );
    }

    // Handle other Steam inventory errors (Steam API success: false responses)
    // These could be: malformed data, Steam server issues, rate limit responses, etc.
    this.logger.warn(`${this.workerName} steam inventory error for ${targetSteamId}: ${errorType}`);
    
    // Check if this might be a Steam server issue that should be retried
    if (errorType === 'unknown_error' || errorType.includes('server') || errorType.includes('timeout')) {
      throw new TaskTemporaryError(
        `Steam inventory server error (${errorType}): ${inventoryData.message}`, 
        'STEAM_SERVER_ERROR', 
        300
      );
    }
    
    // Other errors - treat as general Steam inventory errors
    throw new TaskTemporaryError(
      `Steam inventory error (${errorType}): ${inventoryData.message}`, 
      'STEAM_INVENTORY_ERROR', 
      300
    );
  }

  /**
   * Get progressive retry delay based on task attempts (refined)
   */
  getRetryDelay(task, error) {
    if (!task.retry_attempts) task.retry_attempts = 0;
    task.retry_attempts++;
    
    const baseDelays = {
      // Network errors - progressive backoff
      'NETWORK_TIMEOUT': [60, 300, 600, 1200],       // 1min → 20min
      'NETWORK_ERROR': [180, 600, 1200, 3600],       // 3min → 1hr  
      'STEAM_SERVER_ERROR': [300, 900, 1800, 3600],  // 5min → 1hr
      'STEAM_API_ERROR': [120, 300, 600, 1200],      // 2min → 20min
      
      // Auth errors
      'AUTH_DISCONNECTED': [600, 600, 600, 600],     // Fixed 10min (reconnection time)
      'DJANGO_API_ERROR': [60, 180, 300, 600],       // 1min → 10min
      
      // Inventory-specific errors
      'STEAM_INVENTORY_ERROR': [180, 300, 600, 1200], // 3min → 20min
      
      // Permanent errors - avoid spam
      'AUTH_TOKEN_MISSING': [3600, 3600, 3600, 3600], // Fixed 1hr
      'INVALID_TOKEN': [3600, 3600, 3600, 3600],      // Fixed 1hr
      
      // Unknown errors
      'UNKNOWN_ERROR': [300, 600, 1200, 3600]         // 5min → 1hr
    };
    
    const delays = baseDelays[error.code] || baseDelays['UNKNOWN_ERROR'];
    const attemptIndex = Math.min(task.retry_attempts - 1, delays.length - 1);
    return delays[attemptIndex];
  }

  /**
   * Enhanced delay task with better logging context
   */
  async delayTask(task, error) {
    const delaySeconds = this.getRetryDelay(task, error);
    const newExecuteTime = new Date(Date.now() + (delaySeconds * 1000)).toISOString();
    
    // Enhanced task update with retry tracking
    await this.inventoryQueue.updateTask(task.taskID, {
      execute: newExecuteTime,
      retry_attempts: task.retry_attempts,
      last_error: {
        code: error.code,
        message: error.message,
        timestamp: new Date().toISOString(),
        retry_delay_seconds: delaySeconds
      },
      updated_at: new Date().toISOString()
    });
    
    const nextTryTime = new Date(Date.now() + (delaySeconds * 1000)).toLocaleString();
    this.logger.info(
      `${this.workerName} delayed task ${task.taskID} by ${delaySeconds}s (attempt ${task.retry_attempts}/${this.getMaxRetries(error.code)}, error: ${error.code}, next try: ${nextTryTime})`
    );
  }

  /**
   * Get maximum retry attempts for different error types
   */
  getMaxRetries(errorCode) {
    const maxRetries = {
      'NETWORK_TIMEOUT': 4,
      'NETWORK_ERROR': 4, 
      'STEAM_SERVER_ERROR': 4,
      'AUTH_DISCONNECTED': 'unlimited',
      'STEAM_INVENTORY_ERROR': 4,
      'DJANGO_API_ERROR': 4,
      'AUTH_TOKEN_MISSING': 'unlimited',
      'INVALID_TOKEN': 'unlimited',
      'UNKNOWN_ERROR': 4
    };
    
    return maxRetries[errorCode] || 4;
  }

  /**
   * Format raw Steam inventory data into our required format
   * UPDATED: Now handles private inventories correctly and uses batch price fetching
   */
  async formatInventoryData(rawInventoryData) {
    // ✅ FIXED: Check if this is already a private inventory result from getInventoryWithErrorHandling
    if (rawInventoryData.inventory_private === true && rawInventoryData.inventory === null) {
      this.logger.info(`${this.workerName}: Processing private inventory data - maintaining private status`);
      return {
        inventory: null,              // ✅ Keep null for private inventories
        inventory_private: true,      // ✅ Keep private status
        inventory_updated_at: rawInventoryData.inventory_updated_at
      };
    }

    const { assets, descriptions } = rawInventoryData;
    
    if (!assets || !descriptions) {
      return {
        inventory: [],
        inventory_private: false,
        inventory_updated_at: new Date().toISOString()
      };
    }

    // Words to exclude from inventory
    const excludedWords = ['Coin', 'Charm', 'Graffiti', 'Music Kit', 'Badge', 'Medal'];
    
    // Create lookup map for descriptions
    const descriptionMap = {};
    descriptions.forEach(desc => {
      const key = `${desc.classid}_${desc.instanceid}`;
      descriptionMap[key] = desc;
    });

    // Group items by market_hash_name
    const itemGroups = {};
    
    assets.forEach(asset => {
      const key = `${asset.classid}_${asset.instanceid}`;
      const description = descriptionMap[key];
      
      if (!description) {
        this.logger.warn(`No description found for asset ${asset.assetid}`);
        return;
      }

      const marketHashName = description.market_hash_name || description.name || 'Unknown Item';
      
      // Skip items with excluded words
      const shouldExclude = excludedWords.some(word => 
        marketHashName.includes(word)
      );
      
      if (shouldExclude) {
        this.logger.debug(`Skipping excluded item: ${marketHashName}`);
        return;
      }

      const tradeable = description.tradable === 1;

      if (!itemGroups[marketHashName]) {
        itemGroups[marketHashName] = {
          market_hash_name: marketHashName,
          quantity: 0,
          tradeable: tradeable,
          price: 0, // Will be filled by batch request
          // Additional data for batch request
          classid: description.classid || 'unknown',
          icon_url: description.icon_url || null,
          // Store assetids for trade offers
          assetids: []
        };
      }

      itemGroups[marketHashName].quantity++;
      // Store assetid with appid and contextid for trade offers
      itemGroups[marketHashName].assetids.push({
        assetid: asset.assetid,
        appid: asset.appid || '730',
        contextid: asset.contextid || '2'
      });
    });

    const inventoryItems = Object.values(itemGroups);
    
    if (inventoryItems.length === 0) {
      this.logger.info(`${this.workerName}: No items to process after filtering`);
      return {
        inventory: [],
        inventory_private: false,
        inventory_updated_at: new Date().toISOString()
      };
    }

    this.logger.info(`${this.workerName}: Processing ${inventoryItems.length} unique items with batch price request`);

    // Prepare batch request data
    const batchItems = inventoryItems.map(item => ({
      market_hash_name: item.market_hash_name,
      classid: item.classid,
      icon_url: item.icon_url,
      // est_usd is not available from inventory data, so we don't include it
    }));

    try {
      // Single batch request for all prices
      const priceResults = await this.djangoClient.getInventoryPrices(batchItems);
      
      this.logger.info(`${this.workerName}: Received ${priceResults.length} price results from batch request`);

      // Create price lookup map
      const priceMap = {};
      priceResults.forEach(result => {
        priceMap[result.market_hash_name] = result.price;
      });

      // Apply prices to inventory items
      inventoryItems.forEach(item => {
        const price = priceMap[item.market_hash_name];
        item.price = price !== undefined ? price : 0;
        
        // Remove extra fields not needed in final output
        delete item.classid;
        delete item.icon_url;
      });

      this.logger.info(`${this.workerName}: Successfully processed ${inventoryItems.length} items with batch pricing`);

    } catch (error) {
      this.logger.error(`${this.workerName}: Batch price request failed: ${error.message}`);
      
      // Fallback: set all prices to 0
      inventoryItems.forEach(item => {
        item.price = 0;
        delete item.classid;
        delete item.icon_url;
      });
    }

    return {
      inventory: inventoryItems,
      inventory_private: false,
      inventory_updated_at: new Date().toISOString()
    };
  }

  /**
   * Update orchestration task and negotiation data in Redis with results
   */
  async updateTaskResults(task, inventoryResult, accountSteamId, targetSteamId) {
    try {
      this.logger.info(`${this.workerName}: Starting task results update for ${task.taskID}`);
      
      // Update orchestration task first
      try {
        this.logger.info(`${this.workerName}: Updating orchestration task for ${task.taskID}`);
        await this.updateOrchestrationTask(task, inventoryResult);
        this.logger.info(`${this.workerName}: Successfully updated orchestration task for ${task.taskID}`);
      } catch (error) {
        this.logger.error(`${this.workerName}: Failed to update orchestration task: ${error.message}`);
        // Don't throw yet - try negotiation update
      }

      // Update negotiation data in Redis second
      try {
        this.logger.info(`${this.workerName}: Updating negotiation data for ${task.taskID}; targetID: ${targetSteamId}`);
        await this.updateNegotiationJson(accountSteamId, targetSteamId, inventoryResult);
        this.logger.info(`${this.workerName}: Successfully updated negotiation data for ${task.taskID}`);
      } catch (error) {
        this.logger.error(`${this.workerName}: Failed to update negotiation data: ${error.message}`);
        // Don't throw - we'll log but continue
      }

      this.logger.info(`${this.workerName}: Completed task results update for ${task.taskID}`);

    } catch (error) {
      this.logger.error(`${this.workerName}: Error in updateTaskResults: ${error.message}`);
      this.logger.error(`${this.workerName}: Stack trace: ${error.stack}`);
      // Don't throw - let the task complete even if updates fail partially
    }
  }

  /**
   * ✅ RESTORED: Update orchestration task with proper context management
   */
  async updateOrchestrationTask(task, inventoryResult) {
    try {
      const orchestrationTasks = await this.orchestrationQueue.getTasks();
      const orchTask = orchestrationTasks.find(t => t.taskID === task.taskID);
      
      if (!orchTask) {
        this.logger.warn(`${this.workerName}: Orchestration task not found for ${task.taskID}`);
        return;
      }
      
      // Parse task to get our Steam ID and determine inventory type
      const { ourSteamId } = this.parseTaskID(task.taskID);
      const targetSteamId = task.targetSteamID; // Whose inventory was actually checked
      const isOurInventory = (ourSteamId === targetSteamId);
      
      // Determine inventory key and pending task to remove
      const inventoryKey = isOurInventory ? 'our_inventory' : 'inventory';
      const pendingTaskToRemove = isOurInventory ? 'check_inventory_ours' : 'check_inventory_friend';
      
      this.logger.info(`${this.workerName}: Determined inventory type: ${inventoryKey} (isOur: ${isOurInventory})`);
      
      // Prepare context updates
      // For our own inventory, treat null as [] so downstream logic sees a checked (empty) inventory
      const contextUpdates = {
        [inventoryKey]: isOurInventory ? (inventoryResult.inventory ?? []) : inventoryResult.inventory,
        [`${inventoryKey}_updated_at`]: inventoryResult.inventory_updated_at
      };
      
      // Handle inventory privacy flag - only for friend inventories
      if (!isOurInventory) {
        contextUpdates['inventory_private'] = Boolean(inventoryResult.inventory_private);
      }
      
      // Remove the appropriate pending task
      const updatedPendingTasks = (orchTask.pending_tasks || [])
        .filter(pendingTask => pendingTask !== pendingTaskToRemove);
      
      // Single update call to avoid race conditions
      await this.orchestrationQueue.updateTask(orchTask.taskID, {
        context: {
          ...orchTask.context,
          ...contextUpdates
        },
        pending_tasks: updatedPendingTasks,
        updated_at: new Date().toISOString()
      });
      
    } catch (error) {
      this.logger.error(`${this.workerName}: Error updating orchestration task: ${error.message}`);
      throw error;
    }
  }

  /**
   * Update negotiation data in Redis with inventory results
   */
  async updateNegotiationJson(accountSteamId, targetSteamId, inventoryResult) {
    try {
      // Debug logging for troubleshooting
      this.logger.info(`${this.workerName}: updateNegotiation called with:`, {
        accountSteamId,
        targetSteamId,
        inventoryResult: {
          inventory_length: inventoryResult.inventory?.length || 'null',
          inventory_private: inventoryResult.inventory_private,
          inventory_updated_at: inventoryResult.inventory_updated_at
        }
      });

      // Load current negotiations using HttpClient
      const negotiationsData = await this.httpClient.loadNegotiations(accountSteamId);
      
      this.logger.debug(`${this.workerName}: Loaded negotiations data structure:`, {
        hasNegotiations: !!negotiationsData.negotiations,
        negotiationsCount: Object.keys(negotiationsData.negotiations || {}).length
      });
      
      // Determine which inventory we checked
      const isOurInventory = (accountSteamId === targetSteamId);
      
      if (isOurInventory) {
        // ✅ FIXED: Our inventory goes at root level
        this.logger.info(`${this.workerName}: Updating OUR inventory at root level`);
        
        negotiationsData.our_inventory = inventoryResult.inventory ?? [];
        negotiationsData.our_inventory_updated_at = inventoryResult.inventory_updated_at;
        negotiationsData.updated_at = inventoryResult.inventory_updated_at;
        
        this.logger.info(`${this.workerName}: Set our_inventory with ${inventoryResult.inventory?.length || 'null'} items`);
        
      } else {
        // ✅ FIXED: Friend inventory goes inside the friend's negotiation
        this.logger.info(`${this.workerName}: Updating FRIEND inventory inside negotiations[${targetSteamId}]`);
        
        // Find or create negotiation for this friend
        if (!negotiationsData.negotiations) {
          negotiationsData.negotiations = {};
        }
        
        let friendNegotiation = negotiationsData.negotiations[targetSteamId];
        if (!friendNegotiation) {
          this.logger.info(`${this.workerName}: Creating new negotiation for friend ${targetSteamId}`);
          negotiationsData.negotiations[targetSteamId] = {
            friend_steam_id: targetSteamId,
            state: 'unknown',
            messages: [],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };
          friendNegotiation = negotiationsData.negotiations[targetSteamId];
        }
        
        // ✅ FIXED: Use correct field names and ensure proper values
        friendNegotiation.inventory = inventoryResult.inventory;
        friendNegotiation.inventory_updated_at = inventoryResult.inventory_updated_at;
        friendNegotiation.updated_at = inventoryResult.inventory_updated_at;
        
        // ✅ CRITICAL FIX: Use the actual value from inventoryResult, not a fallback
        friendNegotiation.inventory_private = inventoryResult.inventory_private;

        this.logger.info(`${this.workerName}: Set friend inventory - items: ${inventoryResult.inventory?.length || 'null'}, private: ${inventoryResult.inventory_private}`);
        
        // Debug the final structure before saving
        this.logger.debug(`${this.workerName}: Final friend negotiation before save:`, {
          inventory_length: friendNegotiation.inventory?.length || 'null',
          inventory_private: friendNegotiation.inventory_private,
          inventory_updated_at: friendNegotiation.inventory_updated_at
        });
      }
      
      // Save updated negotiations using HttpClient
      this.logger.info(`${this.workerName}: Saving updated negotiations to Redis`);
      const saveResult = await this.httpClient.saveNegotiations(accountSteamId, negotiationsData);
      
      this.logger.info(`${this.workerName}: HttpClient save result:`, {
        success: !!saveResult,
        isOurInventory
      });
      
      this.logger.info(`${this.workerName}: Successfully updated negotiation data in Redis for ${isOurInventory ? 'our' : 'friend'} inventory`);
      
    } catch (error) {
      this.logger.error(`${this.workerName}: Error updating negotiation data: ${error.message}`);
      this.logger.error(`${this.workerName}: Stack trace:`, error.stack);
      throw error;
    }
  }

  /**
   * Parse taskID to extract Steam IDs
   */
  parseTaskID(taskID) {
    const parts = taskID.split('_');
    if (parts.length !== 2) {
      throw new Error(`Invalid taskID format: ${taskID}. Expected: {ourSteamId}_{friendSteamId}`);
    }
    
    return {
      ourSteamId: parts[0],
      friendSteamId: parts[1]
    };
  }

  /**
   * Check if auth token failure is due to a disconnected Steam session.
   * Queries the connections service (automate_trading) via node_api_service
   * instead of accessing SteamSessionManager directly.
   */
  async checkSteamConnectionStatus(ourSteamId) {
    return this.connectionsClient.getSessionStatus(ourSteamId);
  }

  /**
   * Handle task errors - NEVER remove tasks, only delay for retry
   */
  async handleTaskError(task, error) {
    this.stats.errors++;
    
    if (error instanceof TaskPermanentError) {
      // Log for admin intervention, delay to avoid spam
      this.logger.error(`${this.workerName} PERMANENT ERROR for ${task.taskID}: ${error.message} (Code: ${error.code})`);
      this.logger.error(`Task ${task.taskID} requires manual intervention - keeping in queue with 1hr delay`);
      
      await this.delayTask(task, error);
      return;
      
    } else if (error instanceof TaskTemporaryError) {
      this.logger.warn(`${this.workerName} temporary error for ${task.taskID}: ${error.message} (Code: ${error.code})`);
      await this.delayTask(task, error);
      return;
      
    } else {
      // Legacy error handling - convert to temporary error
      this.logger.error(`${this.workerName} unknown error for ${task.taskID}: ${error.message}`);
      
      // Classify legacy errors
      if (error.message.includes('No valid auth token') || error.message.includes('Django API error')) {
        const tempError = new TaskTemporaryError(error.message, 'DJANGO_API_ERROR', 300);
        await this.delayTask(task, tempError);
      } else {
        const tempError = new TaskTemporaryError(error.message, 'UNKNOWN_ERROR', 300);
        await this.delayTask(task, tempError);
      }
    }
  }

  /**
   * Push an admin notification when a proxy is confirmed expired and removed.
   * Called via the onProxyExpired callback registered with SteamApiManager.
   */
  async _notifyProxyExpired(connection) {
    try {
      const notificationTask = {
        id: `proxy_expired_${connection.id}_${Date.now()}`,
        taskID: `proxy_expired_${connection.id}_${Date.now()}`,
        execute: new Date().toISOString(),
        priority: 'high',
        notificationType: 'proxy_expired',
        metadata: {
          proxyId: connection.id,
          host: connection.host,
          port: connection.port,
          scenario: 'proxy_expired',
          expiredAt: new Date().toISOString()
        }
      };
      await this.httpClient.post('/queue/notification_queue/add', notificationTask);
      this.logger.info(`${this.workerName} Admin notified of expired proxy ${connection.id} (${connection.host}:${connection.port})`);
    } catch (error) {
      this.logger.error(`${this.workerName} Failed to send proxy expiry notification for ${connection.id}: ${error.message}`);
    }
  }

  /**
   * Pause the worker
   */
  pause() {
    this.isPaused = true;
    this.logger.info(`${this.workerName} paused`);
  }

  /**
   * Resume the worker
   */
  resume() {
    this.isPaused = false;
    this.logger.info(`${this.workerName} resumed`);
  }

  /**
   * Get worker statistics
   */
  getStats() {
    const cooldownStatus = this.cooldownManager.getStatus();
    
    return {
      ...this.stats,
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      cooldown: cooldownStatus,
      uptime: this.stats.startedAt ? Date.now() - new Date(this.stats.startedAt).getTime() : 0
    };
  }

  /**
   * Log worker statistics
   */
  logStats() {
    const stats = this.getStats();
    const uptimeHours = (stats.uptime / (1000 * 60 * 60)).toFixed(1);
    
    this.logger.info(`${this.workerName} Stats: ${stats.tasksProcessed} processed, ${stats.cooldownSkips} cooldown skips, ${stats.rateLimitHits} rate limits, ${stats.errors} errors, ${uptimeHours}h uptime`, {
      cooldown: stats.cooldown,
      cycleCount: stats.cycleCount
    });
  }
}

module.exports = InventoryWorker;