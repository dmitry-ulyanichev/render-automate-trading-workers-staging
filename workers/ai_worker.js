// automate_trading_workers/workers/ai_worker.js
const createQueueManager = require('../utils/queue_factory');
const AIClient = require('../utils/ai_client');
const HttpClient = require('../utils/http_client');
const InventoryAssessmentManager = require('./managers/inventory_assessment_manager');

/**
 * AIWorker - Processes ai_queue tasks with real AI integration (Mistral)
 * - Implements gateway routing based on promptScenario prefix
 * - Real implementation for "translate_" scenarios
 * - Dummy implementation for other scenarios (future work)
 */
class AIWorker {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;

    // Worker configuration
    this.workerName = 'AIWorker';
    this.isRunning = false;
    this.isPaused = false;
    this.processInterval = config.ai?.processInterval || 3000; // 3 seconds default
    this.batchSize = config.ai?.batchSize || 1; // Process 1 task per cycle (AI calls are slow)

    // Initialize HTTP client for pushing notifications to Redis via node_api_service
    this.httpClient = new HttpClient(config, logger);

    // Initialize queue managers
    this.aiQueue = createQueueManager('ai_queue', config, logger, this.httpClient);
    this.orchestrationQueue = createQueueManager('orchestration_queue', config, logger, this.httpClient);
    this.messageQueue = createQueueManager('message_queue', config, logger, this.httpClient);

    // Initialize inventory assessment manager for calculating inventory value
    this.inventoryAssessmentManager = new InventoryAssessmentManager(config, logger, this.httpClient);

    // Initialize AI client (Mistral)
    try {
      this.aiClient = new AIClient(config, logger);
      this.logger.info(`${this.workerName} AI client initialized successfully`);
    } catch (error) {
      this.logger.error(`${this.workerName} Failed to initialize AI client: ${error.message}`);
      this.aiClient = null;
    }

    // Statistics tracking
    this.stats = {
      tasksProcessed: 0,
      tasksSkipped: 0,
      errors: 0,
      lastProcessedAt: null,
      startedAt: null,
      cycleCount: 0
    };
    
    // Timers
    this.processTimer = null;
    this.statsTimer = null;
    
    this.logger.info(`${this.workerName} initialized - Process interval: ${this.processInterval}ms, Batch size: ${this.batchSize}`);
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
        await this.processBatch();
        this.stats.cycleCount++;
      } catch (error) {
        this.logger.error(`${this.workerName} processing error: ${error.message}`);
        this.stats.errors++;
      }
    }, this.processInterval);
  }

  /**
   * Start statistics reporting
   */
  startStatsReporting() {
    // Report stats every 60 seconds
    this.statsTimer = setInterval(() => {
      if (this.stats.tasksProcessed > 0 || this.stats.errors > 0) {
        this.logger.info(`${this.workerName} Stats - Processed: ${this.stats.tasksProcessed}, Skipped: ${this.stats.tasksSkipped}, Errors: ${this.stats.errors}, Cycles: ${this.stats.cycleCount}`);
      }
    }, 60000);
  }

  /**
   * Process a batch of tasks from the AI queue
   * FIXED: Remove tasks BEFORE processing to prevent race condition where
   * the same task is picked up by the next cycle while still being processed
   */
  async processBatch() {
    try {
      // Get next batch of tasks to process (WITH removing - prevents race condition)
      // AI tasks can take longer than the 3-second cycle interval, so we must
      // remove them immediately to prevent duplicate processing
      const tasks = await this.aiQueue.getNextTasks(this.batchSize, true);

      if (tasks.length === 0) {
        return; // No tasks to process
      }

      this.logger.info(`${this.workerName} processing ${tasks.length} tasks`);

      // Process each task (already removed from queue)
      for (const task of tasks) {
        try {
          await this.processTask(task);

          this.stats.tasksProcessed++;
          this.stats.lastProcessedAt = new Date().toISOString();
        } catch (error) {
          this.logger.error(`${this.workerName} failed to process task ${task.taskID}: ${error.message}`);
          this.logger.info(`${this.workerName} Task ${task.taskID} was already removed from queue (won't retry)`);

          this.stats.errors++;
        }
      }
    } catch (error) {
      this.logger.error(`${this.workerName} batch processing error: ${error.message}`);
      this.stats.errors++;
    }
  }

  /**
   * Process a single AI task - GATEWAY ROUTING METHOD
   * Routes to real AI for translation tasks, placeholder for others
   */
  async processTask(task) {
    const { taskID, prompt, priority, promptScenario, variables, context } = task;

    this.logger.info(`${this.workerName} Processing AI task for ${taskID}`);
    this.logger.info(`${this.workerName} Scenario: ${promptScenario || 'unknown'}, Prompt length: ${prompt?.length || 0}`);

    // Parse task ID to get Steam IDs
    const steamIds = this.parseTaskID(taskID);

    let aiResponse;
    let isTranslationTask = false;

    // GATEWAY ROUTING: Check scenario prefix to determine processing method
    if (promptScenario && promptScenario.startsWith('translate_')) {
      // Real AI processing for translation tasks
      this.logger.info(`${this.workerName} 🔄 Routing to REAL translation processing (Mistral AI)`);
      aiResponse = await this.processTranslationTask(task);
      isTranslationTask = true;
    } else {
      // Placeholder processing for other scenarios (future implementation)
      this.logger.info(`${this.workerName} 📝 Routing to PLACEHOLDER processing (scenario: ${promptScenario || 'unknown'})`);
      aiResponse = await this.processPlaceholderTask(task);
      isTranslationTask = false;
    }

    // Process AI response and create appropriate tasks
    if (isTranslationTask && aiResponse.status === 'ready_to_respond' && aiResponse.messages) {
      // Translation task with messages -> create message task
      const messageCreated = await this.createMessageTask(taskID, aiResponse);

      if (messageCreated) {
        // Replace 'consult_ai' with 'send_message'
        await this.updateOrchestrationPendingTasks(taskID, 'consult_ai', 'send_message');
      } else {
        this.logger.error(`${this.workerName} Failed to create message task for translation - removing consult_ai`);
        await this.updateOrchestrationPendingTasks(taskID, 'consult_ai');
      }
    } else if (!isTranslationTask && aiResponse.status === 'placeholder') {
      // Placeholder task -> create notification task
      const notificationCreated = await this.createNotificationTask(taskID, aiResponse, task);

      if (notificationCreated) {
        // Remove orchestration task - notification service will handle it independently
        await this.removeOrchestrationTask(taskID);
      } else {
        this.logger.error(`${this.workerName} Failed to create notification task - removing orchestration task anyway`);
        await this.removeOrchestrationTask(taskID);
      }
    } else {
      // Unexpected case - just remove consult_ai
      this.logger.warn(`${this.workerName} Unexpected AI response state - removing consult_ai`);
      await this.updateOrchestrationPendingTasks(taskID, 'consult_ai');
    }

    this.logger.info(`${this.workerName} ✅ Completed AI task processing for ${taskID}`);
  }

  /**
   * Process translation task with REAL Mistral AI
   * @param {Object} task - AI task with prompt, variables, etc.
   * @returns {Promise<Object>} AI response with status and messages
   */
  async processTranslationTask(task) {
    const { taskID, prompt, promptScenario, variables } = task;

    try {
      // Check if AI client is available
      if (!this.aiClient) {
        this.logger.error(`${this.workerName} AI client not initialized - falling back to placeholder`);
        return await this.processPlaceholderTask(task);
      }

      this.logger.info(`${this.workerName} 🚀 Calling Mistral AI for translation...`);
      this.logger.info(`${this.workerName} Target language: ${variables?.LANGUAGE || 'unknown'}`);

      // Call Mistral AI
      const result = await this.aiClient.chat(prompt);

      if (!result.success) {
        this.logger.error(`${this.workerName} ❌ Mistral AI call failed: ${result.error}`);
        // Fall back to placeholder on error
        return await this.processPlaceholderTask(task);
      }

      this.logger.info(`${this.workerName} ✅ Mistral AI response received (${result.elapsed}ms, ${result.usage.totalTokens} tokens)`);

      // Parse translation response
      const messages = this.aiClient.parseTranslationResponse(result.content);

      if (!messages || messages.length === 0) {
        this.logger.error(`${this.workerName} Failed to parse messages from AI response`);
        return await this.processPlaceholderTask(task);
      }

      this.logger.info(`${this.workerName} 📝 Extracted ${messages.length} translated messages`);
      messages.forEach((msg, i) => {
        this.logger.info(`${this.workerName}   [${i + 1}] ${msg.substring(0, 80)}${msg.length > 80 ? '...' : ''}`);
      });

      return {
        status: 'ready_to_respond',
        messages: messages,
        actions: null,
        metadata: {
          ai_provider: 'mistral',
          model: result.model,
          scenario: promptScenario,
          tokens: result.usage.totalTokens,
          elapsed_ms: result.elapsed
        }
      };

    } catch (error) {
      this.logger.error(`${this.workerName} Error in translation processing: ${error.message}`);
      // Fall back to placeholder on error
      return await this.processPlaceholderTask(task);
    }
  }

  /**
   * Process task with PLACEHOLDER implementation (for non-translation scenarios)
   * Simply logs the task as performed without actual AI processing
   * @param {Object} task - AI task
   * @returns {Promise<Object>} Placeholder response indicating task was logged
   */
  async processPlaceholderTask(task) {
    const { taskID, prompt, priority, promptScenario, variables } = task;

    // Parse task ID to get Steam IDs
    const steamIds = this.parseTaskID(taskID);

    // Log the placeholder execution with all relevant details
    this.logger.info(`${this.workerName} [PLACEHOLDER] Task logged as performed:`);
    this.logger.info(`  - Task ID: ${taskID}`);
    this.logger.info(`  - Our Steam ID: ${steamIds.ourSteamId}`);
    this.logger.info(`  - Friend Steam ID: ${steamIds.friendSteamId}`);
    this.logger.info(`  - Scenario: ${promptScenario || 'unknown'}`);
    this.logger.info(`  - Priority: ${priority || 'normal'}`);
    this.logger.info(`  - Prompt length: ${prompt ? prompt.length : 0} characters`);
    if (variables && Object.keys(variables).length > 0) {
      this.logger.info(`  - Variables: ${JSON.stringify(variables)}`);
    }

    // Return placeholder response indicating no real processing occurred
    return {
      status: 'placeholder',
      messages: null,
      actions: null,
      metadata: {
        placeholder: true,
        scenario: promptScenario,
        note: 'Task logged but not processed - awaiting future implementation'
      }
    };
  }


  /**
   * Create a message task from AI translation response
   * @param {string} taskID - Task ID
   * @param {Object} aiResponse - AI response object with messages
   * @returns {Promise<boolean>} True if message task was created, false otherwise
   */
  async createMessageTask(taskID, aiResponse) {
    try {
      const messageTask = {
        taskID: taskID,
        execute: new Date().toISOString(),
        priority: 'normal',
        message: aiResponse.messages // Can be array or string
      };

      const messageAdded = await this.messageQueue.addTask(messageTask);
      if (messageAdded) {
        const messageCount = Array.isArray(aiResponse.messages) ? aiResponse.messages.length : 1;
        this.logger.info(`${this.workerName} [TRANSLATION] Created message task for ${taskID} with ${messageCount} message(s)`);
      } else {
        this.logger.info(`${this.workerName} [TRANSLATION] Message task for ${taskID} already exists in queue - will still be sent`);
      }

      return true;
    } catch (error) {
      this.logger.error(`${this.workerName} Failed to create message task: ${error.message}`);
      return false;
    }
  }

  /**
   * Create a notification task for placeholder AI response
   * Pushes to Redis via node_api_service HTTP endpoint
   * @param {string} taskID - Task ID
   * @param {Object} aiResponse - Placeholder AI response object
   * @param {Object} originalTask - Original AI task with full context
   * @returns {Promise<boolean>} True if notification task was created, false otherwise
   */
  async createNotificationTask(taskID, aiResponse, originalTask) {
    try {
      // Calculate friend's inventory value (items of interest: cases + skins of interest)
      let inventoryValue = null;
      let inventoryPrivate = false;

      if (originalTask.context?.inventory_private === true) {
        // Private inventory - can't calculate value
        inventoryPrivate = true;
        this.logger.info(`${this.workerName} Friend has private inventory`);
      } else if (originalTask.context?.inventory) {
        const metrics = this.inventoryAssessmentManager.calculateInventoryMetrics(originalTask.context.inventory);
        inventoryValue = metrics.itemsOfInterestValue;
        this.logger.info(`${this.workerName} Calculated inventory value for notification: $${inventoryValue.toFixed(2)}`);
      } else {
        this.logger.info(`${this.workerName} No inventory data in context`);
      }

      const notificationTask = {
        id: taskID,
        taskID: taskID,
        execute: new Date().toISOString(),
        priority: 'normal',
        notificationType: 'ai_task_placeholder',
        inventoryValue: inventoryValue,
        inventoryPrivate: inventoryPrivate,
        metadata: {
          scenario: originalTask.promptScenario || 'unknown',
          promptLength: originalTask.prompt ? originalTask.prompt.length : 0,
          variables: originalTask.variables || {},
          note: aiResponse.metadata?.note || 'Task requires manual attention'
        },
        created_at: new Date().toISOString()
      };

      // Push to Redis via HTTP endpoint
      const response = await this.httpClient.post('/queue/notification_queue/add', notificationTask);

      if (response.success) {
        this.logger.info(`${this.workerName} [PLACEHOLDER] Created notification task for ${taskID} (scenario: ${notificationTask.metadata.scenario})`);
        return true;
      }

      this.logger.error(`${this.workerName} Failed to add notification task to Redis: ${response.error || 'Unknown error'}`);
      return false;
    } catch (error) {
      this.logger.error(`${this.workerName} Failed to create notification task: ${error.message}`);
      return false;
    }
  }

  /**
   * Update orchestration task by removing completed pending task and optionally adding a new one
   * @param {string} taskID - Task ID
   * @param {string} completedTask - Task to remove from pending_tasks
   * @param {string} newTask - Optional new task to add to pending_tasks
   */
  async updateOrchestrationPendingTasks(taskID, completedTask, newTask = null) {
    try {
      const action = newTask ? `replacing '${completedTask}' with '${newTask}'` : `removing '${completedTask}'`;
      this.logger.info(`${this.workerName} Attempting to update orchestration task ${taskID} - ${action}`);

      // Get all orchestration tasks
      const allOrchestrationTasks = await this.orchestrationQueue.getTasks();

      // Find the specific task
      const orchestrationTask = allOrchestrationTasks.find(task => task.taskID === taskID);

      if (!orchestrationTask) {
        this.logger.error(`${this.workerName} No orchestration task found with taskID ${taskID}`);
        return;
      }

      // Remove the completed task from pending_tasks
      let updatedPendingTasks = (orchestrationTask.pending_tasks || [])
        .filter(pendingTask => pendingTask !== completedTask);

      // Add new task if specified (ATOMICALLY replace old with new)
      if (newTask) {
        updatedPendingTasks.push(newTask);
      }

      // Update the orchestration task
      const updateResult = await this.orchestrationQueue.updateTask(taskID, {
        pending_tasks: updatedPendingTasks,
        updated_at: new Date().toISOString()
      });

      if (updateResult) {
        this.logger.info(`${this.workerName} ✅ Successfully updated orchestration task ${taskID} - ${action}`);
      } else {
        this.logger.error(`${this.workerName} ❌ Failed to update orchestration task ${taskID}`);
      }

    } catch (error) {
      this.logger.error(`${this.workerName} Failed to update orchestration pending_tasks for ${taskID}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Remove orchestration task after notification is created
   * Since admin_notification_service handles notifications independently,
   * we remove the orchestration task here rather than updating pending_tasks
   * @param {string} taskID - Task ID to remove
   */
  async removeOrchestrationTask(taskID) {
    try {
      const removed = await this.orchestrationQueue.removeTask(taskID);

      if (removed) {
        this.logger.info(`${this.workerName} ✅ Removed orchestration task ${taskID} after creating notification`);
      } else {
        this.logger.warn(`${this.workerName} Orchestration task ${taskID} not found or already removed`);
      }
    } catch (error) {
      this.logger.error(`${this.workerName} Failed to remove orchestration task ${taskID}: ${error.message}`);
      // Don't throw - notification was created successfully, this is cleanup
    }
  }

  /**
   * Parse taskID to extract Steam IDs
   */
  parseTaskID(taskID) {
    const parts = taskID.split('_');
    if (parts.length !== 2) {
      throw new Error(`Invalid taskID format: ${taskID}`);
    }
    return {
      ourSteamId: parts[0],
      friendSteamId: parts[1]
    };
  }

  /**
   * Get worker statistics
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      queueStats: {
        ai: this.aiQueue.getStats(),
        message: this.messageQueue.getStats(),
        orchestration: this.orchestrationQueue.getStats()
      }
    };
  }
}

module.exports = AIWorker;