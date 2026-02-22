// automate_trading/utils/redis_queue_manager.js
// Drop-in replacement for QueueManager using Redis via node_api_service HTTP API

// Fields that are arrays in the task schema but may arrive as empty objects {}
// due to Redis 6.x cjson encoding empty Lua tables as objects instead of arrays.
const ARRAY_FIELDS = [
  'pending_tasks', 'messages', 'trade_offers',
  'redirected_to', 'referred_from_messages',
  'candidates', 'methods_used',
  'inventory', 'our_inventory'
];

class RedisQueueManager {
  constructor(queueName, config, logger, httpClient) {
    this.queueName = queueName;
    this.config = config;
    this.logger = logger;
    this.httpClient = httpClient;
  }

  /**
   * Normalize task to fix empty objects that should be empty arrays.
   * Handles already-corrupted data stored in Redis before Lua script fix.
   * @param {Object} task - Task object from Redis
   * @returns {Object} Normalized task
   */
  _normalizeTask(task) {
    for (const field of ARRAY_FIELDS) {
      // Fix top-level fields
      if (task[field] && typeof task[field] === 'object' &&
          !Array.isArray(task[field]) && Object.keys(task[field]).length === 0) {
        task[field] = [];
      }
      // Fix context-level fields
      if (task.context && task.context[field] &&
          typeof task.context[field] === 'object' &&
          !Array.isArray(task.context[field]) && Object.keys(task.context[field]).length === 0) {
        task.context[field] = [];
      }
    }
    // Fix nested language fields
    if (task.context && task.context.language) {
      for (const field of ['candidates', 'methods_used']) {
        const val = task.context.language[field];
        if (val && typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length === 0) {
          task.context.language[field] = [];
        }
      }
    }
    return task;
  }

  /**
   * Get all tasks from queue
   * @returns {Promise<Array>} Array of tasks
   */
  async getTasks() {
    const tasks = await this.httpClient.taskQueueGetAll(this.queueName);
    return tasks.map(task => this._normalizeTask(task));
  }

  /**
   * Add a task to the queue
   * @param {Object} task - Task object to add (must have taskID)
   * @returns {Promise<boolean>} True if added, false if duplicate
   */
  async addTask(task) {
    // Ensure created_at
    if (!task.created_at) {
      task.created_at = new Date().toISOString();
    }

    const result = await this.httpClient.taskQueueAdd(this.queueName, task);

    if (result.added) {
      this.logger.info(`Added task ${task.taskID} to ${this.queueName} queue`);
    } else {
      this.logger.debug(`Task ${task.taskID} already exists in ${this.queueName}`);
    }

    return result.added;
  }

  /**
   * Get next task(s) ready for processing
   * @param {number} count - Number of tasks to get
   * @param {boolean} remove - Whether to remove tasks from queue
   * @returns {Promise<Array>} Array of tasks ready for processing
   */
  async getNextTasks(count = 1, remove = false) {
    const tasks = await this.httpClient.taskQueueGetNext(this.queueName, count, remove);

    if (remove && tasks.length > 0) {
      this.logger.debug(`Removed ${tasks.length} tasks from ${this.queueName}`);
    }

    return tasks.map(task => this._normalizeTask(task));
  }

  /**
   * Update a task in the queue
   * @param {string} taskID - Task ID to update
   * @param {Object} updates - Fields to update
   * @returns {Promise<boolean>} Success status
   */
  async updateTask(taskID, updates) {
    const result = await this.httpClient.taskQueueUpdate(this.queueName, taskID, updates);

    if (!result) {
      this.logger.warn(`Task ${taskID} not found in ${this.queueName}`);
    }

    return result;
  }

  /**
   * Remove a task from the queue
   * @param {string} taskID - Task ID to remove
   * @returns {Promise<boolean>} Success status
   */
  async removeTask(taskID) {
    const removed = await this.httpClient.taskQueueRemove(this.queueName, taskID);

    if (removed) {
      this.logger.info(`Removed task ${taskID} from ${this.queueName}`);
    } else {
      this.logger.warn(`Task ${taskID} not found in ${this.queueName}`);
    }

    return removed;
  }

  /**
   * Get queue statistics
   * @returns {Promise<Object>} Queue statistics
   */
  async getStats() {
    return await this.httpClient.taskQueueStats(this.queueName);
  }

  /**
   * Clear all tasks from queue
   * @returns {Promise<boolean>} Success status
   */
  async clearQueue() {
    const tasks = await this.httpClient.taskQueueGetAll(this.queueName);
    if (tasks.length === 0) return true;

    const taskIDs = tasks.map(t => t.taskID).filter(Boolean);
    if (taskIDs.length > 0) {
      await this.httpClient.taskQueueBulkRemove(this.queueName, taskIDs);
      this.logger.warn(`Cleared ${taskIDs.length} tasks from ${this.queueName}`);
    }

    return true;
  }

  /**
   * Check if a task exists in the queue
   * @param {string} taskID - Task ID to check
   * @param {string} action - Optional action to match
   * @returns {Promise<boolean>} True if task exists
   */
  async taskExists(taskID, action = null) {
    const tasks = await this.httpClient.taskQueueGetAll(this.queueName);
    const task = tasks.find(t => t.taskID === taskID);

    if (!task) return false;
    if (action && task.action !== action) return false;

    return true;
  }
}

module.exports = RedisQueueManager;
