// automate_trading_workers/workers/managers/negotiation_task_coordinator.js

const createQueueManager = require('../../utils/queue_factory');
const HttpClient = require('../../utils/http_client');

/**
 * Coordinates task creation for negotiations based on conversation state
 * Centralizes orchestration and follow-up task logic
 */
class NegotiationTaskCoordinator {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;

    // Initialize HTTP client for loading account-level data
    this.httpClient = new HttpClient(config, logger);

    // Initialize queue managers
    this.orchestrationQueue = createQueueManager('orchestration_queue', config, logger, this.httpClient);
    this.followUpQueue = createQueueManager('follow_up_queue', config, logger, this.httpClient);
  }

  /**
   * Main entry point - analyzes negotiation state and decides action
   * @param {Object} negotiation - Complete individual negotiation object
   * @param {string} ourSteamID - Our Steam ID (from parent level)
   */
  /**
   * Check if a message is a game invite
   */
  isGameInvite(message) {
    return message && message.message &&
           message.message.includes('[gameinvite') &&
           message.message.includes('[/gameinvite]');
  }

  async handleLastMessage(negotiation, ourSteamID) {
    try {
      const friendSteamID = negotiation.friend_steam_id;
      const messages = negotiation.messages || [];

      // Get last message from negotiation
      const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;

      this.logger.debug(`Handling last message for ${ourSteamID} -> ${friendSteamID}: ${lastMessage ? lastMessage.direction : 'no messages'}`);

      // Check if the last message is a trade offer notification
      if (lastMessage && lastMessage.message) {
        const tradeOfferPattern = /\[tradeoffer\s+sender=\d+\s+id=\d+\]\[\/tradeoffer\]/;
        if (tradeOfferPattern.test(lastMessage.message)) {
          this.logger.info(`[${ourSteamID}] Trade offer notification detected from ${friendSteamID}: ${lastMessage.message}`);

          // TODO: Implement smart trade offer update trigger
          // - Extract trade offer ID from the message
          // - Trigger trade offer refresh for this account
          // - Update negotiation state based on trade offer status

          return; // Skip normal message handling for trade offers
        }
      }

      if (!lastMessage) {
        // New friend with empty messages - initiate contact
        await this.createOrchestrationTask(negotiation, ourSteamID, 'new_friend');

      } else if (lastMessage.direction === 'incoming') {
        // Check if it's a game invite - treat like no message
        if (this.isGameInvite(lastMessage)) {
          this.logger.debug(`Last message is game invite for ${friendSteamID} - treating as new friend`);
          await this.createOrchestrationTask(negotiation, ourSteamID, 'new_friend');
        } else {
          // Real incoming message - friend messaged us, need to reply
          // IMPORTANT: Remove any pending follow-up task since the friend has responded
          await this.removeFollowUpTask(ourSteamID, friendSteamID);

          await this.createOrchestrationTask(negotiation, ourSteamID, 'reply_needed');
        }

      } else if (lastMessage.direction === 'outgoing') {
        // We messaged friend - create follow-up according to SCENARIO 16 rules
        await this.createFollowUpTask(negotiation, ourSteamID);
      } else {
        this.logger.warn(`Unknown message direction: ${lastMessage.direction} for ${friendSteamID}`);
      }

    } catch (error) {
      this.logger.error(`Error handling last message for ${negotiation.friend_steam_id}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Create orchestration task for immediate or delayed processing
   * UPDATED: Loads account-level data for trade_offers filtering
   * @param {Object} negotiation - Complete individual negotiation object
   * @param {string} ourSteamID - Our Steam ID
   * @param {string} reason - Reason for task creation
   */
  async createOrchestrationTask(negotiation, ourSteamID, reason) {
    try {
      const friendSteamID = negotiation.friend_steam_id;
      const taskID = `${ourSteamID}_${friendSteamID}`;

      // Load account-level data (trade_offers, our_inventory)
      const accountLevelData = await this.loadAccountLevelData(ourSteamID);

      // Check if orchestration task already exists
      const existingTasks = await this.orchestrationQueue.getTasks();
      const existingTask = existingTasks.find(t => t.taskID === taskID);

      if (existingTask) {
        this.logger.debug(`Orchestration task already exists for ${taskID}, updating context if needed`);

        // Update existing task with fresh context and reset execution time for batching
        const updatedContext = this.buildContextFromNegotiation(negotiation, ourSteamID, accountLevelData);
        const executeTime = reason === 'reply_needed' ?
          new Date(Date.now() + 60000).toISOString() : // 60s delay for message batching
          null; // Immediate execution for new friends

        await this.orchestrationQueue.updateTask(taskID, {
          context: updatedContext,
          execute: executeTime,
          updated_at: new Date().toISOString(),
          reason: reason
        });

        this.logger.info(`Updated orchestration task ${taskID} - reason: ${reason}`);
        return;
      }

      // Create new orchestration task
      const context = this.buildContextFromNegotiation(negotiation, ourSteamID, accountLevelData);

      // Set execution delay based on reason
      const executeTime = reason === 'reply_needed' ?
        new Date(Date.now() + 60000).toISOString() : // 60s delay for message batching
        null; // Immediate execution for new friends and follow-ups

      const orchestrationTask = {
        taskID: taskID,
        pending_tasks: [], // Start empty, OrchestrationWorker will populate based on context
        priority: 'normal',
        execute: executeTime,
        created_at: new Date().toISOString(),
        context: context,
        reason: reason
      };

      const added = await this.orchestrationQueue.addTask(orchestrationTask);

      if (added) {
        this.logger.info(`Created orchestration task ${taskID} - reason: ${reason}${executeTime ? ' (delayed 60s)' : ' (immediate)'}`);
      } else {
        this.logger.warn(`Failed to create orchestration task ${taskID} (may already exist)`);
      }

    } catch (error) {
      this.logger.error(`Failed to create orchestration task for ${negotiation.friend_steam_id}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Load account-level data (trade_offers, our_inventory) for context building
   * @param {string} ourSteamID - Our Steam ID
   * @returns {Object} Account-level data
   */
  async loadAccountLevelData(ourSteamID) {
    try {
      const negotiations = await this.httpClient.loadNegotiations(ourSteamID);

      return {
        trade_offers: negotiations?.trade_offers || [],
        trade_offers_updated_at: negotiations?.trade_offers_updated_at || null,
        our_inventory: negotiations?.our_inventory || null,
        our_inventory_updated_at: negotiations?.our_inventory_updated_at || null
      };
    } catch (error) {
      this.logger.warn(`Failed to load account-level data for ${ourSteamID}: ${error.message}`);
      // Return empty data on error
      return {
        trade_offers: [],
        trade_offers_updated_at: null,
        our_inventory: null,
        our_inventory_updated_at: null
      };
    }
  }

  /**
   * Create follow-up task according to SCENARIO 16 rules
   * @param {Object} negotiation - Complete individual negotiation object  
   * @param {string} ourSteamID - Our Steam ID
   */
  async createFollowUpTask(negotiation, ourSteamID) {
    try {
      const friendSteamID = negotiation.friend_steam_id;
      const taskID = `${ourSteamID}_${friendSteamID}`;
      const followUpCount = negotiation.followUpCount || 0;

      // Calculate follow-up delay based on SCENARIO 16 rules
      const delay = this.calculateFollowUpDelay(followUpCount);

      if (delay === null) {
        this.logger.info(`No more follow-ups needed for ${taskID} (followUpCount: ${followUpCount})`);
        return;
      }

      // Calculate executeTime based on last unanswered outgoing message timestamp
      const baseTimestamp = this.getLastUnansweredOutgoingMessageTime(negotiation) || Date.now();
      const executeTime = new Date(baseTimestamp + delay).toISOString();

      // DEBUG: Log timing details
      const now = Date.now();
      const timeUntilExecution = new Date(executeTime).getTime() - now;
      const hoursUntilExecution = (timeUntilExecution / (60 * 60 * 1000)).toFixed(1);
      this.logger.info(`Follow-up timing for ${taskID}: baseTimestamp=${new Date(baseTimestamp).toISOString()}, executeTime=${executeTime}, hoursUntilExecution=${hoursUntilExecution}h`);
      
      // Check if follow-up task already exists
      const existingTasks = await this.followUpQueue.getTasks();
      const existingTask = existingTasks.find(t => (t.id || t.taskID) === taskID);
      
      if (existingTask) {
        // Update existing follow-up with new timing
        await this.followUpQueue.updateTask(taskID, {
          execute: executeTime,
          followUpCount: followUpCount,
          updated_at: new Date().toISOString()
        });
        
        this.logger.info(`Updated follow-up task ${taskID} - count: ${followUpCount}, delay: ${this.formatDelay(delay)}`);
      } else {
        // Create new follow-up task
        const followUpTask = {
          taskID: taskID,
          execute: executeTime,
          followUpCount: followUpCount,
          created_at: new Date().toISOString(),
          our_steam_id: ourSteamID,
          friend_steam_id: friendSteamID
        };
        
        const added = await this.followUpQueue.addTask(followUpTask);
        
        if (added) {
          this.logger.info(`Created follow-up task ${taskID} - count: ${followUpCount}, delay: ${this.formatDelay(delay)}`);
        } else {
          this.logger.warn(`Failed to create follow-up task ${taskID}`);
        }
      }
      
    } catch (error) {
      this.logger.error(`Failed to create follow-up task for ${negotiation.friend_steam_id}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Remove follow-up task for a friend (called when friend responds)
   * This prevents sending unnecessary follow-up messages after the friend has already replied
   * @param {string} ourSteamID - Our Steam ID
   * @param {string} friendSteamID - Friend's Steam ID
   */
  async removeFollowUpTask(ourSteamID, friendSteamID) {
    try {
      const taskID = `${ourSteamID}_${friendSteamID}`;

      // Check if follow-up task exists
      const existingTasks = await this.followUpQueue.getTasks();
      const existingTask = existingTasks.find(t => (t.id || t.taskID) === taskID);

      if (existingTask) {
        const removed = await this.followUpQueue.removeTask(taskID);
        if (removed) {
          this.logger.info(`Removed follow-up task ${taskID} - friend has responded`);
        } else {
          this.logger.warn(`Failed to remove follow-up task ${taskID}`);
        }
      } else {
        this.logger.debug(`No follow-up task found for ${taskID} - nothing to remove`);
      }

    } catch (error) {
      // Don't throw - follow-up removal failure shouldn't block message processing
      this.logger.error(`Error removing follow-up task for ${ourSteamID}_${friendSteamID}: ${error.message}`);
    }
  }

  /**
   * Build orchestration context from negotiation object
   * UPDATED: Loads account-level trade_offers and filters by friend
   * @param {Object} negotiation - Individual negotiation object
   * @param {string} ourSteamID - Our Steam ID
   * @param {Object} accountLevelData - Optional account-level data (trade_offers, our_inventory)
   * @returns {Object} Context object for orchestration task
   */
  buildContextFromNegotiation(negotiation, ourSteamID, accountLevelData = null) {
    const friendSteamID = negotiation.friend_steam_id;

    // Filter trade offers to only those involving this friend
    let friendTradeOffers = [];
    if (accountLevelData && accountLevelData.trade_offers) {
      friendTradeOffers = accountLevelData.trade_offers.filter(offer => {
        // Check if offer involves this friend (either as partner or as accountid_other)
        return offer.partner === friendSteamID ||
               offer.accountid_other === friendSteamID ||
               offer.friend_steam_id === friendSteamID;
      });
    }

    return {
      // Core identifiers
      our_steam_id: ourSteamID,
      friend_steam_id: friendSteamID,

      // Current state
      state: negotiation.state || 'initiating',

      // Negotiation data
      objective: negotiation.objective || null,
      source: negotiation.source || null,
      language: negotiation.language || {
        current_language: null,
        candidates: [],
        methods_used: [],
        last_updated: null
      },

      // Inventory information
      inventory: negotiation.inventory || null,
      inventory_private: negotiation.inventory_private ?? null, // Use ?? to preserve false values
      inventory_updated_at: negotiation.inventory_updated_at || null,
      our_inventory: accountLevelData?.our_inventory || null,
      our_inventory_updated_at: accountLevelData?.our_inventory_updated_at || null,

      // Messages
      messages: negotiation.messages || [],

      // Trade offers - FILTERED to only this friend
      trade_offers: friendTradeOffers,
      trade_offers_updated_at: accountLevelData?.trade_offers_updated_at || null,

      // AI actions
      ai_requested_actions: negotiation.ai_requested_actions || null,

      // Redirects and referrals
      redirected_to: negotiation.redirected_to || [],
      referred_from_messages: negotiation.referred_from_messages || [],
      referrer_checked: negotiation.referrer_checked || false,
      base_accounts_checked_at: negotiation.base_accounts_checked_at || null,

      // Follow-up tracking
      followUpCount: negotiation.followUpCount || 0,

      // Metadata
      created_at: negotiation.created_at || new Date().toISOString(),
      updated_at: negotiation.updated_at || new Date().toISOString(),

      // Task metadata
      trigger: 'conversation_state_analysis'
    };
  }

  /**
   * Get timestamp of the last unanswered outgoing message
   * @param {Object} negotiation - Negotiation object
   * @returns {number|null} Timestamp in milliseconds, or null if no unanswered outgoing messages
   */
  getLastUnansweredOutgoingMessageTime(negotiation) {
    const messages = negotiation.messages || [];
    
    if (messages.length === 0) {
      return null;
    }
    
    // Find the last outgoing message that hasn't been answered
    // We iterate backwards to find the most recent outgoing message
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      
      if (message.direction === 'outgoing') {
        // This outgoing message is unanswered if there are no incoming messages after it
        const hasResponseAfter = messages
          .slice(i + 1)
          .some(laterMessage => laterMessage.direction === 'incoming');
        
        if (!hasResponseAfter) {
          return new Date(message.timestamp).getTime();
        }
      }
    }
    
    // No unanswered outgoing messages found
    return null;
  }

  /**
   * Calculate follow-up delay based on updated rules
   * Note: Each follow-up has +1 day buffer for waiting for friend to appear online
   * Total timeline: 13 days before marking as unresponsive
   * @param {number} followUpCount - Current follow-up count
   * @returns {number|null} Delay in milliseconds, or null if no more follow-ups
   */
  calculateFollowUpDelay(followUpCount) {
    // Follow-up schedule (with +1 day online-wait buffer handled by FollowUpWorker):
    // 1st follow-up: 1 day
    // 2nd follow-up: 1 day
    // 3rd follow-up: 6 days
    // 4th follow-up: 1 day
    // After 4th: mark as unresponsive (no more follow-ups)
    // Total: 1+1+6+1 = 9 days base + 4 days buffer = 13 days max

    switch (followUpCount) {
      case 0: // 1st follow-up
      case 1: // 2nd follow-up
      case 3: // 4th follow-up
        return 1 * 24 * 60 * 60 * 1000; // 1 day
      case 2: // 3rd follow-up
        return 6 * 24 * 60 * 60 * 1000; // 6 days
      default:
        return null; // No more follow-ups
    }
  }

  /**
   * Format delay for logging
   * @param {number} delayMs - Delay in milliseconds
   * @returns {string} Human readable delay
   */
  formatDelay(delayMs) {
    const hours = Math.floor(delayMs / (60 * 60 * 1000));
    if (hours < 24) {
      return `${hours}h`;
    }
    const days = Math.floor(hours / 24);
    return `${days}d`;
  }
}

module.exports = NegotiationTaskCoordinator;