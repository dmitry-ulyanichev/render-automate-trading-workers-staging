// automate_trading/utils/queue_manager.js
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

/**
 * QueueManager - Manages task queues for automate_trading workers
 * Handles file-based queues with locking for thread-safe operations
 */
class QueueManager {
  constructor(queueName, config, logger) {
    this.queueName = queueName;
    this.config = config;
    this.logger = logger;
    
    // Queue configuration
    this.queuesDir = path.join(__dirname, '..', 'data', 'queues');
    this.queuePath = path.join(this.queuesDir, `${queueName}.json`);
    this.lockPath = `${this.queuePath}.lock`;
    
    // Lock configuration
    this.lockTimeout = config.queues?.lockTimeout || 5000; // 5 seconds default
    this.lockRetryDelay = config.queues?.lockRetryDelay || 50; // 50ms retry delay
    this.maxLockRetries = config.queues?.maxLockRetries || 100; // Max retries for lock
    
    // Active locks tracking
    this.activeLocks = new Set();
    
    // Initialize queue file
    this.ensureQueueExists();
    
    // Setup cleanup handlers
    this.setupCleanupHandlers();
    
    // this.logger.debug(`QueueManager initialized for queue: ${queueName}`);
  }

  /**
   * Ensure queue directory and file exist
   */
  ensureQueueExists() {
    try {
      // Create queues directory if it doesn't exist
      fs.ensureDirSync(this.queuesDir);
      
      // Create queue file if it doesn't exist
      if (!fs.existsSync(this.queuePath)) {
        fs.writeFileSync(this.queuePath, '[]', 'utf8');
        // this.logger.debug(`Created queue file: ${this.queuePath}`);
      }
    } catch (error) {
      this.logger.error(`Failed to ensure queue exists: ${error.message}`);
      throw error;
    }
  }

  /**
   * Setup cleanup handlers for process termination
   */
  setupCleanupHandlers() {
    // Track if handlers are already set globally
    if (!QueueManager.cleanupHandlersInstalled) {
      QueueManager.cleanupHandlersInstalled = true;
      QueueManager.instances = new Set();
      
      // Increase max listeners to avoid warnings
      process.setMaxListeners(process.getMaxListeners() + 10);
      
      const globalCleanup = () => {
        // Clean up all queue manager instances
        for (const instance of QueueManager.instances) {
          instance.cleanupInstance();
        }
      };
      
      process.once('SIGINT', globalCleanup);
      process.once('SIGTERM', globalCleanup);
      process.once('exit', globalCleanup);
    }
    
    // Register this instance
    QueueManager.instances = QueueManager.instances || new Set();
    QueueManager.instances.add(this);
  }
  
  /**
   * Clean up this specific instance
   */
  cleanupInstance() {
    try {
      // Clean up any locks this instance holds
      for (const lockId of this.activeLocks) {
        this.releaseLock(lockId);
      }
      
      // Clean up stale lock files
      if (fs.existsSync(this.lockPath)) {
        const lockData = fs.readFileSync(this.lockPath, 'utf8');
        const lock = JSON.parse(lockData);
        
        // Only remove if it's our lock (by process ID)
        if (lock.pid === process.pid) {
          fs.unlinkSync(this.lockPath);
          this.logger.debug(`Cleaned up lock file on exit: ${this.lockPath}`);
        }
      }
    } catch (error) {
      // Silent cleanup failures on exit
    }
  }

  /**
   * Execute an operation with file lock protection
   * @param {Function} operation - Async function to execute with lock
   * @param {Object} options - Lock options
   * @returns {Promise<*>} Result of the operation
   */
  async withFileLock(operation, options = {}) {
    const operationName = options.operationName || 'unknown';
    const lockId = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    let lockAcquired = false;
    let retries = 0;

    try {
      // Acquire lock
      while (!lockAcquired && retries < this.maxLockRetries) {
        lockAcquired = await this.acquireLock(lockId);
        
        if (!lockAcquired) {
          await this.sleep(this.lockRetryDelay);
          retries++;
        }
      }

      if (!lockAcquired) {
        throw new Error(`Failed to acquire lock for ${operationName} after ${retries} retries`);
      }

      // this.logger.debug(`Lock acquired for ${operationName} on ${this.queueName}`);
      
      // Execute the operation
      const result = await operation();
      
      return result;

    } finally {
      // Always release lock
      if (lockAcquired) {
        this.releaseLock(lockId);
        // this.logger.debug(`Lock released for ${operationName} on ${this.queueName}`);
      }
    }
  }

  /**
   * Acquire a file lock
   * @param {string} lockId - Unique lock identifier
   * @returns {boolean} True if lock acquired
   */
  acquireLock(lockId) {
    try {
      // Check for stale locks
      if (fs.existsSync(this.lockPath)) {
        try {
          const lockData = fs.readFileSync(this.lockPath, 'utf8');
          const existingLock = JSON.parse(lockData);
          
          // Check if lock is stale (older than timeout)
          const lockAge = Date.now() - existingLock.timestamp;
          if (lockAge > this.lockTimeout) {
            this.logger.warn(`Removing stale lock (age: ${lockAge}ms) on ${this.queueName}`);
            fs.unlinkSync(this.lockPath);
          } else {
            return false; // Lock is held by another process
          }
        } catch (error) {
          // Invalid lock file, remove it
          fs.unlinkSync(this.lockPath);
        }
      }

      // Create lock file atomically
      const lockData = {
        id: lockId,
        pid: process.pid,
        timestamp: Date.now(),
        queue: this.queueName
      };

      // Use exclusive flag to ensure atomic creation
      fs.writeFileSync(this.lockPath, JSON.stringify(lockData), { flag: 'wx' });
      
      this.activeLocks.add(lockId);
      return true;

    } catch (error) {
      if (error.code === 'EEXIST') {
        return false; // Lock already exists
      }
      this.logger.error(`Error acquiring lock: ${error.message}`);
      return false;
    }
  }

  /**
   * Release a file lock
   * @param {string} lockId - Lock identifier to release
   */
  releaseLock(lockId) {
    try {
      if (fs.existsSync(this.lockPath)) {
        const lockData = fs.readFileSync(this.lockPath, 'utf8');
        const lock = JSON.parse(lockData);
        
        // Only release if it's our lock
        if (lock.id === lockId) {
          fs.unlinkSync(this.lockPath);
          this.activeLocks.delete(lockId);
        }
      }
    } catch (error) {
      this.logger.error(`Error releasing lock: ${error.message}`);
    }
  }

  /**
   * Read all tasks from queue (internal, use within lock)
   */
  async _readTasksInternal() {
    try {
      const data = await fs.readFile(this.queuePath, 'utf8');
      const tasks = JSON.parse(data);
      return Array.isArray(tasks) ? tasks : [];
    } catch (error) {
      this.logger.error(`Error reading queue internally: ${error.message}`);
      return [];
    }
  }

  /**
   * Write tasks to queue (internal, use within lock)
   */
  async _writeTasksInternal(tasks) {
    try {
      if (!Array.isArray(tasks)) {
        throw new Error(`Invalid tasks data: expected array, got ${typeof tasks}`);
      }
      
      // Write to temp file first (atomic operation)
      const tempPath = `${this.queuePath}.tmp.${Date.now()}`;
      await fs.writeFile(tempPath, JSON.stringify(tasks, null, 2), 'utf8');
      
      // Rename atomically
      await fs.rename(tempPath, this.queuePath);
      
      return true;
    } catch (error) {
      this.logger.error(`Error writing queue internally: ${error.message}`);
      
      // Clean up temp files
      try {
        const tempPattern = `${this.queuePath}.tmp.`;
        const dir = path.dirname(this.queuePath);
        const files = await fs.readdir(dir);
        
        for (const file of files) {
          if (file.startsWith(path.basename(tempPattern))) {
            const tempFile = path.join(dir, file);
            await fs.unlink(tempFile);
          }
        }
      } catch (cleanupError) {
        // Silent cleanup failure
      }
      
      return false;
    }
  }

  /**
   * Get all tasks from queue
   * @returns {Promise<Array>} Array of tasks
   */
  async getTasks() {
    return this.withFileLock(async () => {
      return await this._readTasksInternal();
    }, { operationName: 'getTasks' });
  }

  /**
   * Add a task to the queue
   * @param {Object} task - Task object to add
   * @returns {Promise<boolean>} Success status
   */
  async addTask(task) {
    return this.withFileLock(async () => {
      const tasks = await this._readTasksInternal();
      
      // Check if task already exists (by taskID)
      if (task.taskID) {
        const existing = tasks.find(t => t.taskID === task.taskID);
        if (existing) {
          // Check if it's the same action (for queues that support multiple actions per taskID)
          if (task.action && existing.action === task.action) {
            this.logger.debug(`Task ${task.taskID} with action ${task.action} already exists in ${this.queueName}`);
            return false;
          } else if (!task.action) {
            this.logger.debug(`Task ${task.taskID} already exists in ${this.queueName}`);
            return false;
          }
        }
      }
      
      // Add timestamp if not present
      if (!task.created_at) {
        task.created_at = new Date().toISOString();
      }
      
      // Add task to queue
      tasks.push(task);
      
      const success = await this._writeTasksInternal(tasks);
      
      if (success) {
        this.logger.info(`Added task ${task.taskID || 'unknown'} to ${this.queueName} queue`);
      }
      
      return success;
    }, { operationName: 'addTask' });
  }

  /**
   * Get next task(s) ready for processing
   * @param {number} count - Number of tasks to get
   * @param {boolean} remove - Whether to remove tasks from queue
   * @returns {Promise<Array>} Array of tasks ready for processing
   */
  async getNextTasks(count = 1, remove = false) {
    return this.withFileLock(async () => {
      const tasks = await this._readTasksInternal();
      const now = Date.now();
      
      // Filter tasks ready for execution
      const readyTasks = tasks.filter(task => {
        if (task.execute) {
          const executeTime = new Date(task.execute).getTime();
          return executeTime <= now;
        }
        return true; // No execute time means ready immediately
      });
      
      // Sort by priority and creation time
      readyTasks.sort((a, b) => {
        // Priority order: high > normal > low
        const priorityOrder = { high: 0, normal: 1, low: 2 };
        const aPriority = priorityOrder[a.priority] ?? 1;
        const bPriority = priorityOrder[b.priority] ?? 1;
        
        if (aPriority !== bPriority) {
          return aPriority - bPriority;
        }
        
        // If same priority, sort by creation time (FIFO)
        return new Date(a.created_at) - new Date(b.created_at);
      });
      
      // Get requested number of tasks
      const selectedTasks = readyTasks.slice(0, count);
      
      // Remove from queue if requested
      if (remove && selectedTasks.length > 0) {
        const selectedIds = new Set(selectedTasks.map(t => t.taskID));
        const remainingTasks = tasks.filter(t => !selectedIds.has(t.taskID));
        await this._writeTasksInternal(remainingTasks);
        
        this.logger.debug(`Removed ${selectedTasks.length} tasks from ${this.queueName}`);
      }
      
      return selectedTasks;
    }, { operationName: 'getNextTasks' });
  }

  /**
   * Update a task in the queue
   * @param {string} taskID - Task ID to update
   * @param {Object} updates - Fields to update
   * @returns {Promise<boolean>} Success status
   */
  async updateTask(taskID, updates) {
    return this.withFileLock(async () => {
      const tasks = await this._readTasksInternal();
      
      const taskIndex = tasks.findIndex(t => t.taskID === taskID);
      if (taskIndex === -1) {
        this.logger.warn(`Task ${taskID} not found in ${this.queueName}`);
        return false;
      }
      
      // Update task fields
      tasks[taskIndex] = {
        ...tasks[taskIndex],
        ...updates,
        updated_at: new Date().toISOString()
      };
      
      const success = await this._writeTasksInternal(tasks);
      
      // if (success) {
      //   this.logger.debug(`Updated task ${taskID} in ${this.queueName}`);
      // }
      
      return success;
    }, { operationName: 'updateTask' });
  }

  /**
   * Remove a task from the queue
   * @param {string} taskID - Task ID to remove
   * @returns {Promise<boolean>} Success status
   */
  async removeTask(taskID) {
    return this.withFileLock(async () => {
      const tasks = await this._readTasksInternal();
      
      const filteredTasks = tasks.filter(t => t.taskID !== taskID);
      
      if (filteredTasks.length === tasks.length) {
        this.logger.warn(`Task ${taskID} not found in ${this.queueName}`);
        return false;
      }
      
      const success = await this._writeTasksInternal(filteredTasks);
      
      if (success) {
        this.logger.info(`Removed task ${taskID} from ${this.queueName}`);
      }
      
      return success;
    }, { operationName: 'removeTask' });
  }

  /**
   * Get queue statistics
   * @returns {Promise<Object>} Queue statistics
   */
  async getStats() {
    return this.withFileLock(async () => {
      const tasks = await this._readTasksInternal();
      const now = Date.now();
      
      const stats = {
        total: tasks.length,
        ready: 0,
        pending: 0,
        byPriority: { high: 0, normal: 0, low: 0 },
        oldest: null,
        newest: null
      };
      
      for (const task of tasks) {
        // Count ready vs pending
        if (task.execute) {
          const executeTime = new Date(task.execute).getTime();
          if (executeTime <= now) {
            stats.ready++;
          } else {
            stats.pending++;
          }
        } else {
          stats.ready++;
        }
        
        // Count by priority
        const priority = task.priority || 'normal';
        if (stats.byPriority[priority] !== undefined) {
          stats.byPriority[priority]++;
        }
        
        // Track oldest and newest
        const createdAt = new Date(task.created_at).getTime();
        if (!stats.oldest || createdAt < stats.oldest) {
          stats.oldest = task.created_at;
        }
        if (!stats.newest || createdAt > stats.newest) {
          stats.newest = task.created_at;
        }
      }
      
      return stats;
    }, { operationName: 'getStats' });
  }

  /**
   * Clear all tasks from queue
   * @returns {Promise<boolean>} Success status
   */
  async clearQueue() {
    return this.withFileLock(async () => {
      const success = await this._writeTasksInternal([]);
      
      if (success) {
        this.logger.warn(`Cleared all tasks from ${this.queueName}`);
      }
      
      return success;
    }, { operationName: 'clearQueue' });
  }

  /**
   * Check if a task exists in the queue
   * @param {string} taskID - Task ID to check
   * @param {string} action - Optional action for multi-action queues
   * @returns {Promise<boolean>} True if task exists
   */
  async taskExists(taskID, action = null) {
    return this.withFileLock(async () => {
      const tasks = await this._readTasksInternal();
      
      const task = tasks.find(t => t.taskID === taskID);
      
      if (!task) {
        return false;
      }
      
      // If action specified, check it matches
      if (action && task.action !== action) {
        return false;
      }
      
      return true;
    }, { operationName: 'taskExists' });
  }

  /**
   * Sleep helper
   * @param {number} ms - Milliseconds to sleep
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = QueueManager;