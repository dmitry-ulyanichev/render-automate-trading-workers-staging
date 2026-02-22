// automate_trading_workers/workers/orchestration_cleanup_worker.js

const createQueueManager = require('../utils/queue_factory');
const HttpClient = require('../utils/http_client');

/**
 * OrchestrationCleanupWorker - Detects and fixes orphaned orchestration tasks
 *
 * Problem: Orchestration tasks can get stuck with pending_tasks that reference
 * non-existent tasks in other queues (due to crashes, manual queue clearing, etc.)
 *
 * Solution: Periodically scan orchestration queue and validate all pending_tasks
 * against their respective queues. Remove invalid references.
 */
class OrchestrationCleanupWorker {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;

    // Worker configuration
    this.workerName = 'OrchestrationCleanupWorker';
    this.isRunning = false;
    this.isPaused = false;
    this.processInterval = config.orchestration_cleanup?.processInterval || 300000; // 5 minutes default

    // Initialize HTTP client for queue operations
    this.httpClient = new HttpClient(config, logger);

    // Initialize queue managers
    this.orchestrationQueue = createQueueManager('orchestration_queue', config, logger, this.httpClient);
    this.queues = {};

    // Map of pending_task types to their queue names
    this.taskTypeToQueue = {
      'send_message': 'message_queue',
      'consult_ai': 'ai_queue',
      'check_inventory_friend': 'inventory_queue',
      'check_inventory_ours': 'inventory_queue',
      'check_language': 'language_queue',
      'create_trade_offer': 'trade_offer_queue',
      'remove_friend': 'remove_friend_queue',
      'notify_admin': 'admin_notification_queue'
    };

    // Statistics tracking
    this.stats = {
      totalScans: 0,
      tasksScanned: 0,
      orphanedTasksFound: 0,
      orphanedTasksFixed: 0,
      invalidReferencesRemoved: 0,
      lastScanAt: null,
      startedAt: null,
      errors: 0
    };

    // Timers
    this.processTimer = null;
    this.statsTimer = null;

    this.logger.info(`${this.workerName} initialized - Process interval: ${this.processInterval}ms (${this.processInterval/60000} minutes)`);
  }

  /**
   * Get or create queue manager for a specific queue
   */
  getQueueManager(queueName) {
    if (!this.queues[queueName]) {
      this.queues[queueName] = createQueueManager(queueName, this.config, this.logger, this.httpClient);
    }
    return this.queues[queueName];
  }

  /**
   * Start the worker
   */
  async start() {
    if (this.isRunning) {
      this.logger.warn(`${this.workerName} is already running`);
      return;
    }

    this.logger.info(`Starting ${this.workerName}...`);

    this.isRunning = true;
    this.stats.startedAt = new Date().toISOString();

    // Start processing loop
    this.startProcessingLoop();

    // Start statistics reporting
    this.startStatsReporting();

    this.logger.info(`${this.workerName} started successfully`);
  }

  /**
   * Stop the worker
   */
  stop() {
    if (!this.isRunning) {
      this.logger.warn(`${this.workerName} is not running`);
      return;
    }

    this.logger.info(`Stopping ${this.workerName}...`);

    this.isRunning = false;

    // Clear timers
    if (this.processTimer) {
      clearInterval(this.processTimer);
      this.processTimer = null;
    }

    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }

    // Log final stats
    this.logStatistics();

    this.logger.info(`${this.workerName} stopped`);
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
   * Start the main processing loop
   */
  startProcessingLoop() {
    this.processTimer = setInterval(async () => {
      if (!this.isRunning || this.isPaused) {
        return;
      }

      try {
        await this.scanAndCleanup();
      } catch (error) {
        this.logger.error(`${this.workerName} scan cycle error: ${error.message}`);
        this.stats.errors++;
      }
    }, this.processInterval);

    // Run immediately on start
    if (!this.isPaused) {
      this.scanAndCleanup().catch(error => {
        this.logger.error(`${this.workerName} initial scan error: ${error.message}`);
      });
    }
  }

  /**
   * Main scan and cleanup logic
   */
  async scanAndCleanup() {
    const startTime = Date.now();
    this.stats.totalScans++;

    this.logger.info(`${this.workerName} Starting cleanup scan #${this.stats.totalScans}`);

    try {
      // Get all orchestration tasks
      const orchestrationTasks = await this.orchestrationQueue.getTasks();

      if (orchestrationTasks.length === 0) {
        this.logger.info(`${this.workerName} No orchestration tasks to scan`);
        this.stats.lastScanAt = new Date().toISOString();
        return;
      }

      // Filter tasks that have pending_tasks
      const tasksWithPending = orchestrationTasks.filter(task =>
        task.pending_tasks && task.pending_tasks.length > 0
      );

      if (tasksWithPending.length === 0) {
        this.logger.info(`${this.workerName} Scanned ${orchestrationTasks.length} tasks - none have pending_tasks`);
        this.stats.lastScanAt = new Date().toISOString();
        return;
      }

      this.logger.info(`${this.workerName} Found ${tasksWithPending.length} tasks with pending_tasks out of ${orchestrationTasks.length} total`);

      // Load all relevant queues into memory for efficiency
      const queueTaskIDs = await this.loadAllQueueTaskIDs();

      // Check each task with pending_tasks
      let fixedCount = 0;

      for (const task of tasksWithPending) {
        this.stats.tasksScanned++;

        const result = await this.validateAndCleanPendingTasks(task, queueTaskIDs);

        if (result.fixed) {
          fixedCount++;
          this.stats.orphanedTasksFound++;
          this.stats.orphanedTasksFixed++;
          this.stats.invalidReferencesRemoved += result.removedCount;
        }
      }

      const duration = Date.now() - startTime;
      this.stats.lastScanAt = new Date().toISOString();

      if (fixedCount > 0) {
        this.logger.info(`${this.workerName} Scan #${this.stats.totalScans} complete: Fixed ${fixedCount} orphaned tasks in ${duration}ms`);
      } else {
        this.logger.info(`${this.workerName} Scan #${this.stats.totalScans} complete: All ${tasksWithPending.length} tasks are valid (${duration}ms)`);
      }

    } catch (error) {
      this.logger.error(`${this.workerName} Scan failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Load all task IDs from all relevant queues into memory
   * Returns a Map of queueName -> Set of taskIDs
   */
  async loadAllQueueTaskIDs() {
    const queueTaskIDs = new Map();

    // Get unique queue names
    const queueNames = new Set(Object.values(this.taskTypeToQueue));

    for (const queueName of queueNames) {
      try {
        const queueManager = this.getQueueManager(queueName);
        const tasks = await queueManager.getTasks();

        // Store task IDs in a Set for O(1) lookup
        const taskIDSet = new Set(tasks.map(task => task.taskID || task.id));
        queueTaskIDs.set(queueName, taskIDSet);

        this.logger.debug(`${this.workerName} Loaded ${taskIDSet.size} task IDs from ${queueName}`);

      } catch (error) {
        this.logger.warn(`${this.workerName} Failed to load ${queueName}: ${error.message} - assuming empty`);
        queueTaskIDs.set(queueName, new Set());
      }
    }

    return queueTaskIDs;
  }

  /**
   * Validate pending_tasks for a single orchestration task
   * Remove any references to tasks that don't exist in their queues
   *
   * @param {Object} task - Orchestration task
   * @param {Map} queueTaskIDs - Map of queueName -> Set of taskIDs
   * @returns {Object} { fixed: boolean, removedCount: number, details: Array }
   */
  async validateAndCleanPendingTasks(task, queueTaskIDs) {
    const taskID = task.taskID;
    const originalPendingTasks = [...task.pending_tasks];
    const invalidReferences = [];

    // Check each pending task type
    for (const pendingType of task.pending_tasks) {
      const queueName = this.taskTypeToQueue[pendingType];

      if (!queueName) {
        // Unknown pending task type - log warning but don't remove
        this.logger.warn(`${this.workerName} Unknown pending_task type '${pendingType}' in task ${taskID}`);
        continue;
      }

      const taskIDsInQueue = queueTaskIDs.get(queueName);

      if (!taskIDsInQueue) {
        // Queue doesn't exist or failed to load - assume task is missing
        this.logger.warn(`${this.workerName} Queue ${queueName} not loaded - assuming task ${taskID} is orphaned`);
        invalidReferences.push({
          type: pendingType,
          queue: queueName,
          reason: 'queue_not_loaded'
        });
        continue;
      }

      // Check if task exists in the queue
      if (!taskIDsInQueue.has(taskID)) {
        // Task doesn't exist in queue - orphaned reference
        invalidReferences.push({
          type: pendingType,
          queue: queueName,
          reason: 'task_not_found_in_queue'
        });
      }
    }

    // If we found invalid references, clean them up
    if (invalidReferences.length > 0) {
      this.logger.warn(`${this.workerName} Found ${invalidReferences.length} orphaned reference(s) in task ${taskID}:`);

      for (const ref of invalidReferences) {
        this.logger.warn(`${this.workerName}   - '${ref.type}' (${ref.queue}): ${ref.reason}`);
      }

      // Remove invalid references from pending_tasks
      const invalidTypes = new Set(invalidReferences.map(ref => ref.type));
      const newPendingTasks = task.pending_tasks.filter(type => !invalidTypes.has(type));

      // Update the orchestration task
      const updated = await this.orchestrationQueue.updateTask(taskID, {
        pending_tasks: newPendingTasks
      });

      if (!updated) {
        this.logger.info(`${this.workerName} Task ${taskID} already gone from orchestration_queue — no update needed`);
        return {
          fixed: false,
          removedCount: 0,
          details: invalidReferences
        };
      }

      this.logger.info(`${this.workerName} ✅ Fixed task ${taskID}: pending_tasks [${originalPendingTasks.join(', ')}] → [${newPendingTasks.join(', ')}]`);

      return {
        fixed: true,
        removedCount: invalidReferences.length,
        details: invalidReferences
      };
    }

    // No invalid references found
    return {
      fixed: false,
      removedCount: 0,
      details: []
    };
  }

  /**
   * Start statistics reporting
   */
  startStatsReporting() {
    // Report stats every 30 minutes
    this.statsTimer = setInterval(() => {
      this.logStatistics();
    }, 1800000); // 30 minutes
  }

  /**
   * Log current statistics
   */
  logStatistics() {
    this.logger.info(`${this.workerName} Statistics:`);
    this.logger.info(`  - Status: ${this.isRunning ? (this.isPaused ? 'PAUSED' : 'RUNNING') : 'STOPPED'}`);
    this.logger.info(`  - Started at: ${this.stats.startedAt || 'Never'}`);
    this.logger.info(`  - Total scans: ${this.stats.totalScans}`);
    this.logger.info(`  - Tasks scanned: ${this.stats.tasksScanned}`);
    this.logger.info(`  - Orphaned tasks found: ${this.stats.orphanedTasksFound}`);
    this.logger.info(`  - Orphaned tasks fixed: ${this.stats.orphanedTasksFixed}`);
    this.logger.info(`  - Invalid references removed: ${this.stats.invalidReferencesRemoved}`);
    this.logger.info(`  - Errors: ${this.stats.errors}`);
    this.logger.info(`  - Last scan: ${this.stats.lastScanAt || 'Never'}`);
  }

  /**
   * Get worker status
   */
  getStatus() {
    return {
      name: this.workerName,
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      stats: this.stats,
      config: {
        processInterval: this.processInterval,
        processIntervalMinutes: this.processInterval / 60000
      }
    };
  }
}

module.exports = OrchestrationCleanupWorker;
