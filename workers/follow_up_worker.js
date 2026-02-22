// automate_trading_workers/workers/follow_up_worker.js

const createQueueManager = require('../utils/queue_factory');
const NegotiationTaskCoordinator = require('./managers/negotiation_task_coordinator');
const HttpClient = require('../utils/http_client');
const SteamApiManager = require('../utils/steam_api_manager');

class FollowUpWorker {
  constructor(config, logger) {
    this.name = 'FollowUpWorker';
    this.config = config;
    this.logger = logger;
    this.isRunning = false;
    this.workerName = 'FollowUpWorker';

    // Use NegotiationTaskCoordinator and HttpClient
    this.taskCoordinator = new NegotiationTaskCoordinator(config, logger);
    this.httpClient = new HttpClient(config, logger); // Instantiate once in the constructor

    // Queue managers
    this.followUpQueue = createQueueManager('follow_up_queue', config, logger, this.httpClient);
    this.orchestrationQueue = createQueueManager('orchestration_queue', config, logger, this.httpClient);
    this.removeFriendQueue = createQueueManager('remove_friend_queue', config, logger, this.httpClient);

    // Steam API Manager for checking online status
    this.steamApiManager = new SteamApiManager(config, logger);

    // Worker configuration
    this.checkIntervalMs = config.workers?.followUpWorker?.checkIntervalMs || 5 * 60 * 1000;

    // Online status wait buffer: 1 day (24 hours)
    // After this buffer expires, we follow up regardless of online status
    this.onlineWaitBufferMs = 24 * 60 * 60 * 1000;

    // Worker statistics
    this.stats = {
      tasksProcessed: 0,
      tasksCreated: 0,
      tasksSkipped: 0,
      onlineChecks: 0,
      errors: 0,
      lastProcessedAt: null
    };

    // The timer for the main work loop
    this.processingTimer = null;
  }

  async start() {
    if (this.isRunning) {
      this.logger.warn(`${this.workerName} is already running`);
      return;
    }

    this.isRunning = true;
    this.shouldStop = false;

    this.logger.info(`${this.workerName} started - checking every ${this.checkIntervalMs / 1000}s`);

    this.processingTimer = setInterval(() => this.processExpiredFollowUps(), this.checkIntervalMs);
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    this.shouldStop = true;
    this.isRunning = false;
    clearInterval(this.processingTimer);
    this.processingTimer = null;

    this.logger.info(`${this.workerName} stopped`);
  }

  async processExpiredFollowUps() {
    if (this.shouldStop) return;

    try {
      const allTasks = await this.followUpQueue.getTasks();
      const now = new Date();

      const expiredTasks = allTasks.filter(task => {
        const executeTime = new Date(task.execute);
        return executeTime <= now;
      });

      if (expiredTasks.length === 0) {
        this.logger.debug(`${this.workerName} No expired follow-up tasks found`);
        return;
      }

      // Categorize expired tasks: "overdue" (expired >24h ago) vs "recent" (expired ≤24h ago)
      const overdueTasks = [];
      const recentTasks = [];

      for (const task of expiredTasks) {
        const executeTime = new Date(task.execute);
        const timeSinceExpiry = now - executeTime;

        if (timeSinceExpiry > this.onlineWaitBufferMs) {
          // Expired more than 24h ago - process unconditionally
          overdueTasks.push(task);
        } else {
          // Expired within last 24h - check online status first
          recentTasks.push(task);
        }
      }

      this.logger.info(`${this.workerName} Processing ${expiredTasks.length} expired tasks: ` +
        `${overdueTasks.length} overdue (unconditional), ${recentTasks.length} recent (online check)`);

      // Process overdue tasks unconditionally
      for (const task of overdueTasks) {
        await this.processFollowUpTask(task, true); // true = forceProcess
      }

      // For recent tasks, batch check online status and process accordingly
      if (recentTasks.length > 0) {
        await this.processRecentTasksWithOnlineCheck(recentTasks);
      }

    } catch (error) {
      this.logger.error(`${this.workerName} Error processing expired follow-ups: ${error.message}`);
      this.stats.errors++;
    }
  }

  /**
   * Process recent expired tasks by checking if friends are online
   * Only processes tasks for friends who are currently online
   * @param {Array} tasks - Array of recent expired tasks
   */
  async processRecentTasksWithOnlineCheck(tasks) {
    try {
      // Collect unique friend Steam IDs (up to 100 for Steam API limit)
      const friendSteamIds = [...new Set(tasks.map(t => t.friend_steam_id))];

      // Steam API accepts max 100 IDs per request
      const batchSize = 100;
      const onlineFriends = new Set();

      for (let i = 0; i < friendSteamIds.length; i += batchSize) {
        const batch = friendSteamIds.slice(i, i + batchSize);

        try {
          const result = await this.steamApiManager.getPlayerSummaries(batch);
          this.stats.onlineChecks++;

          if (result.success && result.players) {
            for (const player of result.players) {
              // personastate: 0=Offline, 1=Online, 2=Busy, 3=Away, 4=Snooze, 5=Looking to trade, 6=Looking to play
              // Consider online if personastate >= 1
              if (player.personastate >= 1) {
                onlineFriends.add(player.steamid);
                this.logger.debug(`${this.workerName} Friend ${player.steamid} is online (state: ${player.personastate})`);
              }
            }

            // Handle friends not returned by API (private profiles that hide online status)
            // These friends are NOT in the response at all - treat as "status unknown"
            const returnedIds = new Set(result.players.map(p => p.steamid));
            for (const steamId of batch) {
              if (!returnedIds.has(steamId)) {
                this.logger.debug(`${this.workerName} Friend ${steamId} not in API response (private/hidden status)`);
                // We'll skip these - they'll be processed when they become overdue
              }
            }
          }
        } catch (apiError) {
          this.logger.warn(`${this.workerName} Failed to check online status for batch: ${apiError.message}`);
          // On API error, don't process these tasks - will retry next cycle
          continue;
        }
      }

      this.logger.info(`${this.workerName} Online status check: ${onlineFriends.size}/${friendSteamIds.length} friends online`);

      // Process tasks for online friends
      for (const task of tasks) {
        if (onlineFriends.has(task.friend_steam_id)) {
          this.logger.info(`${this.workerName} Friend ${task.friend_steam_id} is online - processing follow-up`);
          await this.processFollowUpTask(task, true); // forceProcess since we confirmed online
        } else {
          this.logger.debug(`${this.workerName} Skipping task ${task.taskID} - friend offline/hidden, will retry`);
          this.stats.tasksSkipped++;
        }
      }

    } catch (error) {
      this.logger.error(`${this.workerName} Error in online status check: ${error.message}`);
      this.stats.errors++;
    }
  }

  /**
   * Process a single follow-up task
   * @param {Object} task - The follow-up task
   * @param {boolean} forceProcess - If true, skip decision making and process immediately
   */
  async processFollowUpTask(task, forceProcess = false) {
    const taskID = task.taskID;
    const steamIds = {
      ourSteamId: task.our_steam_id,
      friendSteamId: task.friend_steam_id
    };

    try {
      this.logger.info(`${this.workerName} Processing follow-up task: ${taskID}${forceProcess ? ' (forced)' : ''}`);

      // Use the task's action field if present (e.g. retry tasks from RemoveFriendWorker),
      // otherwise default to creating an orchestration task
      const decision = task.action
        ? { action: task.action, reason: task.reason || 'Scheduled retry' }
        : { action: 'create_orchestration_task', reason: forceProcess ? 'Friend online or overdue' : 'Scheduled follow-up' };

      await this.executeFollowUpDecision(taskID, steamIds, decision, task);

      // Only remove task if execution was successful
      await this.followUpQueue.removeTask(taskID);

      this.stats.tasksProcessed++;
      this.stats.lastProcessedAt = new Date().toISOString();

      this.logger.info(`${this.workerName} Completed follow-up task: ${taskID} - ${decision.reason}`);

    } catch (error) {
      this.logger.error(`${this.workerName} Error processing follow-up task ${taskID}: ${error.message}`);
      this.stats.errors++;
      // Do NOT remove the task here, so it can be retried on the next cycle.
    }
  }

  async executeFollowUpDecision(taskID, steamIds, decision, originalTask) {
    try {
      switch (decision.action) {
        case 'create_orchestration_task':
          await this.createOrchestrationTaskViaCoordinator(taskID, steamIds, decision.reason);
          break;

        case 'create_remove_friend_task':
          await this.createRemoveFriendTask(taskID, steamIds, originalTask);
          break;

        case 'extend_follow_up':
          await this.extendFollowUpPeriod(taskID, steamIds, decision.reason, originalTask);
          break;

        case 'no_action':
          this.logger.info(`${this.workerName} No follow-up action needed for ${taskID}: ${decision.reason}`);
          break;

        default:
          this.logger.warn(`${this.workerName} Unknown follow-up action: ${decision.action}`);
      }
    } catch (error) {
      this.logger.error(`${this.workerName} Failed to execute follow-up decision: ${error.message}`);
      throw error;
    }
  }

  async createOrchestrationTaskViaCoordinator(taskID, steamIds, reason) {
    try {
      const { ourSteamId, friendSteamId } = steamIds;

      // CHANGED: Always use "follow_up" as reason when FollowUpWorker creates orchestration task
      const followUpReason = "follow_up";

      this.logger.info(`${this.workerName} Creating orchestration task for ${taskID} with reason: ${followUpReason}`);

      let negotiation = null;
      try {
        // Use loadNegotiations and extract the specific negotiation
        const response = await this.httpClient.loadNegotiations(ourSteamId);

        if (response.negotiations && response.negotiations[friendSteamId]) {
          negotiation = response.negotiations[friendSteamId];
          // Add our_inventory from the response to the negotiation object
          negotiation.our_inventory = response.our_inventory;
          this.logger.debug(`${this.workerName} Loaded negotiation for ${taskID} from API`);
        } else {
          throw new Error('Negotiation not found for friend ' + friendSteamId);
        }

      } catch (apiError) {
        const errorMessage = apiError.message.toLowerCase();

        if (errorMessage.includes('not found') || errorMessage.includes('404')) {
          this.logger.info(`${this.workerName} Negotiation ${taskID} not found - friend likely removed, skipping task`);
          return;
        }

        if (errorMessage.includes('timeout') || errorMessage.includes('network') ||
            errorMessage.includes('connection') || errorMessage.includes('503')) {
          this.logger.warn(`${this.workerName} API temporarily unavailable for ${taskID}, will retry later`);
          throw apiError;
        }

        if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
          this.logger.warn(`${this.workerName} Rate limited for ${taskID}, will retry later`);
          throw apiError;
        }

        if (errorMessage.includes('unauthorized') || errorMessage.includes('401')) {
          this.logger.error(`${this.workerName} API authentication error for ${taskID}: ${apiError.message}`);
          return;
        }

        this.logger.error(`${this.workerName} Unexpected API error for ${taskID}: ${apiError.message}`);
        return;
      }

      // CHANGED: Use "follow_up" reason instead of the generic reason passed as parameter
      await this.taskCoordinator.createOrchestrationTask(negotiation, ourSteamId, followUpReason);

      this.stats.tasksCreated++;
      this.logger.info(`${this.workerName} Successfully created orchestration task for ${taskID} with reason: ${followUpReason}`);

    } catch (error) {
      this.logger.error(`${this.workerName} Failed to create orchestration task via coordinator: ${error.message}`);
      throw error;
    }
  }

  async createRemoveFriendTask(taskID, steamIds, originalTask) {
    try {
      const removeFriendTask = {
        taskID: taskID,
        reason: originalTask.reason || 'Retry: session was unavailable',
        created_at: new Date().toISOString()
      };

      const added = await this.removeFriendQueue.addTask(removeFriendTask);

      if (added) {
        this.logger.info(`${this.workerName} Created remove-friend task for ${taskID} (retry after session unavailable)`);
      } else {
        this.logger.warn(`${this.workerName} Remove-friend task ${taskID} already exists in queue`);
      }
    } catch (error) {
      this.logger.error(`${this.workerName} Failed to create remove-friend task for ${taskID}: ${error.message}`);
      throw error;
    }
  }

  async extendFollowUpPeriod(taskID, steamIds, reason, originalTask) {
    try {
      const extendedFollowUpTask = {
        taskID: taskID,
        execute: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        followUpCount: (originalTask.followUpCount || 0) + 1,
        created_at: originalTask.created_at || new Date().toISOString(),
        our_steam_id: steamIds.ourSteamId,
        friend_steam_id: steamIds.friendSteamId
      };

      const added = await this.followUpQueue.addTask(extendedFollowUpTask);

      if (added) {
        this.logger.info(`${this.workerName} Extended follow-up period for ${taskID}: ${reason} (2 hours)`);
      } else {
        this.logger.warn(`${this.workerName} Failed to extend follow-up period for ${taskID}`);
      }

    } catch (error) {
      this.logger.error(`${this.workerName} Failed to extend follow-up period: ${error.message}`);
      throw error;
    }
  }

  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      queueStats: {
        followUp: this.followUpQueue.getStats()
      }
    };
  }
}

module.exports = FollowUpWorker;
