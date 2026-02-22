// automate_trading_workers/workers/language_worker.js

const createQueueManager = require('../utils/queue_factory');
const SteamApiManager = require('../utils/steam_api_manager');
const HttpClient = require('../utils/http_client');
const SteamLoginExtractor = require('../utils/steam_login_extractor');
const { detectLanguageFromName } = require('../utils/player_name_language_detector');
const { detectLanguageFromMessages } = require('../utils/message_language_detector');


/**
 * LanguageWorker - Real implementation for Step 5
 * Detects friend's language using Steam API country analysis
 * 
 * Features:
 * - Primary method: player_summaries (Steam API based)
 * - Country-to-language mapping with scoring system
 * - Rate limiting and retry handling via SteamApiManager
 * - Persistent partial_data for resume capability
 * - Stubs for future detection methods
 */
class LanguageWorker {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    
    // Worker configuration
    this.workerName = 'LanguageWorker';
    this.isRunning = false;
    this.isPaused = false;
    this.processInterval = config.language?.processInterval || 3000; // 3 seconds
    this.batchSize = config.language?.batchSize || 2; // Process 2 tasks per cycle
    
    // Initialize Steam API manager
    this.steamApi = new SteamApiManager(config, logger);

    // Initialize HTTP client for negotiation updates
    this.httpClient = new HttpClient(config, logger);

    // Initialize Steam login extractor
    this.steamLoginExtractor = new SteamLoginExtractor(config.persistentConnections?.credentialsFile);
    
    // Initialize queue managers
    this.languageQueue = createQueueManager('language_queue', config, logger, this.httpClient);
    this.orchestrationQueue = createQueueManager('orchestration_queue', config, logger, this.httpClient);
    
    // Country to language mapping with weights (from document)
    this.COUNTRY_LANGUAGE_MAP = this.initializeCountryLanguageMap();
    
    // Statistics tracking
    this.stats = {
      tasksProcessed: 0,
      tasksSkipped: 0,
      errors: 0,
      retries: 0,
      steamApiCalls: 0,
      languagesDetected: {},
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
    
    // Start stats logging
    this.startStatsLogging();
    
    this.logger.info(`${this.workerName} started successfully`);
  }

  /**
   * Stop the worker
   */
  async stop() {
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
   * Start the main processing loop
   */
  startProcessingLoop() {
    this.processTimer = setInterval(async () => {
      if (this.isPaused || !this.isRunning) {
        return;
      }

      this.stats.cycleCount++;
      
      try {
        await this.processBatch();
      } catch (error) {
        this.logger.error(`${this.workerName} processing error: ${error.message}`);
        this.stats.errors++;
      }
    }, this.processInterval);
  }

  /**
   * Sanitize nickname by removing Unicode control characters
   * Removes bidirectional formatting, zero-width characters, etc.
   */
  sanitizeNickname(nickname) {
    if (!nickname) return nickname;

    // Remove Unicode control characters (U+0000 to U+001F, U+007F to U+009F)
    // Remove bidirectional formatting (U+200E, U+200F, U+202A-U+202E, U+2066-U+2069)
    // Remove zero-width characters (U+200B-U+200D, U+FEFF)
    return nickname.replace(/[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]/g, '');
  }

  /**
   * Start statistics logging
   */
  startStatsLogging() {
    this.statsTimer = setInterval(() => {
      if (this.stats.tasksProcessed > 0 || this.stats.errors > 0) {
        const steamStats = this.steamApi.getStats();
        const friendsListStats = steamStats.endpoints.getFriendsList;
        const summariesStats = steamStats.endpoints.getPlayerSummaries;
        
        this.logger.info(`${this.workerName} Stats - Processed: ${this.stats.tasksProcessed}, Errors: ${this.stats.errors}, Steam API calls: ${this.stats.steamApiCalls}, Cycles: ${this.stats.cycleCount}`);
        this.logger.info(`${this.workerName} Steam API - Friends: ${friendsListStats.totalRequests} calls (${friendsListStats.currentInterval/1000}s interval), Summaries: ${summariesStats.totalRequests} calls (${summariesStats.currentInterval/1000}s interval)`);
      }
    }, 60000); // Every minute
  }

  /**
   * Process a batch of tasks from the language queue
   */
  async processBatch() {
    try {
      // Get next batch of tasks to process
      const tasks = await this.languageQueue.getNextTasks(this.batchSize, true);
      
      if (tasks.length === 0) {
        return; // No tasks to process
      }

      this.logger.info(`${this.workerName} processing ${tasks.length} tasks`);

      // Process each task
      for (const task of tasks) {
        try {
          await this.processTask(task);
          this.stats.tasksProcessed++;
          this.stats.lastProcessedAt = new Date().toISOString();
        } catch (error) {
          this.logger.error(`${this.workerName} failed to process task ${task.taskID}: ${error.message}`);
          this.stats.errors++;
          
          // Check if we should retry this task
          if (this.shouldRetryTask(error, task.attempts || 0)) {
            await this.requeueTaskForRetry(task, error);
          } else {
            // Max retries reached or non-retryable error - still update orchestration
            await this.handleFailedTask(task, error);
          }
        }
      }
    } catch (error) {
      this.logger.error(`${this.workerName} batch processing error: ${error.message}`);
      this.stats.errors++;
    }
  }

  /**
   * Process a single language task
   */
  async processTask(task) {
    const { taskID, method, priority, attempts = 0, partial_data = {} } = task;
    
    this.logger.info(`${this.workerName} Processing language detection for ${taskID} (method: ${method}, attempts: ${attempts})`);
    
    // Parse task ID to get Steam IDs
    const steamIds = this.parseTaskID(taskID);
    
    // Route to appropriate method handler
    let result;
    switch (method) {
      case 'player_summaries':
        result = await this.processPlayerSummariesMethod(steamIds, attempts, partial_data);
        break;
        
      case 'text_analysis':
        result = await this.processTextAnalysisMethod(steamIds, attempts, partial_data);
        break;
        
      case 'ai_analysis':
        result = await this.processAiAnalysisMethod(steamIds, attempts, partial_data);
        break;
        
      case 'selenium_scraping':
        result = await this.processSeleniumScrapingMethod(steamIds, attempts, partial_data);
        break;
        
      default:
        throw new Error(`Unknown language detection method: ${method}`);
    }
    
    // Log the execution
    this.logger.info(`${this.workerName} Completed language detection:`, {
      taskID,
      method,
      attempts: attempts + 1,
      language: result.current_language,
      score: result.candidates?.[0]?.score || 0
    });

    // Update statistics
    const detectedLang = result.current_language;
    this.stats.languagesDetected[detectedLang] = (this.stats.languagesDetected[detectedLang] || 0) + 1;

    // Update orchestration task
    await this.updateOrchestrationPendingTasks(taskID, 'check_language');
    await this.updateOrchestrationLanguageContext(taskID, result, method);
    await this.updateNegotiationLanguage(steamIds, result);
    
    this.logger.info(`${this.workerName} Updated orchestration context for ${taskID}`);
  }

  /**
   * Primary method: Analyze Steam player summaries and friend countries
   * REAL IMPLEMENTATION using Steam APIs
   *
   * Flow:
   * 1. Get player summary for target friend (always works, even for private profiles)
   * 2. Extract nickname and do player name detection
   * 3. Try to get friend's friends list (may fail with 401 for private profiles)
   * 4. If friends list available, get their summaries for country analysis
   * 5. Combine country data (if any) with player name detection
   */
  async processPlayerSummariesMethod(steamIds, attempts, partial_data) {
    this.logger.info(`${this.workerName} [PLAYER_SUMMARIES] Starting language detection`);

    const { ourSteamId, friendSteamId } = steamIds;
    let { friends_list, friends_obtained_at, friend_nickname, player_name_detection } = partial_data;

    let friendNickname = friend_nickname;
    let playerNameDetection = player_name_detection;
    let friendCountryCode = null;
    let apiCallCount = 0;

    // Step 1: Get player summary for the target friend (always works, even for private profiles)
    if (!friendNickname) {
      this.logger.info(`${this.workerName} Getting player summary for target friend ${friendSteamId}`);

      try {
        const summaryResult = await this.steamApi.getPlayerSummaries([friendSteamId]);
        this.stats.steamApiCalls++;
        apiCallCount++;

        if (summaryResult.success && summaryResult.players.length > 0) {
          const friendPlayer = summaryResult.players[0];
          // Sanitize nickname immediately to remove control characters before any usage
          friendNickname = this.sanitizeNickname(friendPlayer.personaname || friendSteamId);
          friendCountryCode = friendPlayer.loccountrycode;

          this.logger.info(`${this.workerName} Friend's nickname: ${friendNickname}`);
          this.logger.info(`${this.workerName} Friend's country: ${friendCountryCode || 'NOT AVAILABLE'}`);

          // Step 2: Do player name detection immediately (use sanitized nickname)
          if (friendNickname) {
            playerNameDetection = detectLanguageFromName(friendNickname);
            if (playerNameDetection.language) {
              this.logger.info(`${this.workerName} Player name detection: ${playerNameDetection.language} (${(playerNameDetection.confidence * 100).toFixed(0)}% via ${playerNameDetection.method})`);
            }
          }

          // Save progress in case next steps fail
          await this.updateTaskPartialData(steamIds.taskID, {
            friend_nickname: friendNickname,
            friend_country: friendCountryCode,
            player_name_detection: playerNameDetection,
            method_progress: { nickname_obtained: true }
          });
        } else {
          this.logger.warn(`${this.workerName} Could not get player summary for ${friendSteamId}`);
          friendNickname = friendSteamId; // Fallback to Steam ID
        }
      } catch (error) {
        this.logger.error(`${this.workerName} Failed to get player summary: ${error.message}`);
        // Don't throw - we can still try to get friends list
        friendNickname = friendSteamId;
      }
    } else {
      this.logger.info(`${this.workerName} Using cached nickname: ${friendNickname}`);
    }

    // Step 3: Try to get friend's friends list (may fail for private profiles)
    let friendsListAvailable = false;
    if (!friends_list || friends_list.length === 0) {
      this.logger.info(`${this.workerName} Attempting to get friends list for ${friendSteamId}`);

      try {
        const friendsResult = await this.steamApi.getFriendsList(friendSteamId);
        this.stats.steamApiCalls++;
        apiCallCount++;

        if (friendsResult.success) {
          friends_list = friendsResult.friends.map(friend => friend.steamid);
          friends_obtained_at = new Date().toISOString();
          friendsListAvailable = true;

          this.logger.info(`${this.workerName} Retrieved ${friends_list.length} friends for ${friendSteamId}`);

          // Update partial_data
          await this.updateTaskPartialData(steamIds.taskID, {
            friends_list,
            friends_obtained_at,
            method_progress: { friends_completed: true }
          });
        }
      } catch (error) {
        // Handle 401 gracefully - private profile, friends list not accessible
        if (error.message.includes('401') || error.message.includes('private')) {
          this.logger.info(`${this.workerName} Friends list not accessible (private profile) - will use player name detection`);
        } else {
          this.logger.warn(`${this.workerName} Failed to get friends list: ${error.message}`);
        }
        friends_list = [];
      }
    } else {
      this.logger.info(`${this.workerName} Using cached friends list (${friends_list.length} friends)`);
      friendsListAvailable = true;
    }

    // Step 4: If friends list available, get summaries for country analysis
    let languageScores = [];
    let analyzedPlayers = 1; // At minimum we analyzed the target friend

    if (friendsListAvailable && friends_list.length > 0) {
      const steamIdsToAnalyze = [friendSteamId, ...friends_list.slice(0, 99)];

      this.logger.info(`${this.workerName} Getting player summaries for ${steamIdsToAnalyze.length} Steam IDs`);

      try {
        const summariesResult = await this.steamApi.getPlayerSummaries(steamIdsToAnalyze);
        this.stats.steamApiCalls++;
        apiCallCount++;

        if (summariesResult.success) {
          const players = summariesResult.players;
          analyzedPlayers = players.length;
          this.logger.info(`${this.workerName} Retrieved summaries for ${players.length} players`);

          // Update friend's country code if we didn't get it before
          if (!friendCountryCode) {
            const friendPlayer = players.find(p => p.steamid === friendSteamId);
            friendCountryCode = friendPlayer?.loccountrycode;
          }

          // Analyze countries and map to languages
          languageScores = this.analyzeCountriesForLanguages(players, friendSteamId);
        }
      } catch (error) {
        this.logger.warn(`${this.workerName} Failed to get friends summaries: ${error.message}`);
        // Continue with what we have
      }
    } else {
      this.logger.info(`${this.workerName} No friends list available - relying on player name detection`);

      // If we have friend's country from initial summary, still use it
      if (friendCountryCode) {
        const countryLanguages = this.COUNTRY_LANGUAGE_MAP[friendCountryCode];
        if (countryLanguages) {
          for (const langInfo of countryLanguages) {
            languageScores.push({ language: langInfo.language, score: langInfo.weight });
          }
          languageScores.sort((a, b) => b.score - a.score);
        }
      }
    }

    // Step 5: Analyze messages if available
    let messageDetection = null;
    try {
      const negotiationsData = await this.httpClient.loadNegotiations(ourSteamId);
      const negotiation = negotiationsData?.negotiations?.[friendSteamId];
      const messages = negotiation?.messages || [];

      if (messages.length > 0) {
        messageDetection = detectLanguageFromMessages(messages);
        if (messageDetection.language) {
          this.logger.info(`${this.workerName} Message analysis: ${messageDetection.language} (score: ${messageDetection.score.toFixed(1)}, analyzed: ${messageDetection.analyzedCount}/${messageDetection.totalMessages})`);
        } else {
          this.logger.info(`${this.workerName} Message analysis: no language detected (analyzed: ${messageDetection.analyzedCount}/${messageDetection.totalMessages})`);
        }
      } else {
        this.logger.info(`${this.workerName} Message analysis: no messages to analyze`);
      }
    } catch (error) {
      this.logger.warn(`${this.workerName} Could not load messages for analysis: ${error.message}`);
    }

    // Step 6: Determine final language (combining all detection methods)
    const finalLanguage = this.resolveFinalLanguage(languageScores, playerNameDetection, messageDetection);

    this.logger.info(`${this.workerName} Final language: ${finalLanguage.language} (via ${finalLanguage.method})`);

    // Build methods_used array
    const methodsUsed = ['player_summaries'];
    if (finalLanguage.method === 'player_name' || playerNameDetection?.language) {
      methodsUsed.push('player_name');
    }
    if (finalLanguage.method === 'message_analysis' || messageDetection?.language) {
      methodsUsed.push('message_analysis');
    }

    return {
      current_language: finalLanguage.language,
      candidates: languageScores,
      methods_used: methodsUsed,
      last_updated: new Date().toISOString(),
      steam_api_calls: apiCallCount,
      analyzed_players: analyzedPlayers,
      friend_analysis: {
        total_friends: friends_list?.length || 0,
        analyzed_friends: friendsListAvailable ? Math.min(friends_list?.length || 0, 99) : 0,
        friends_list_accessible: friendsListAvailable
      },
      friend_steam_username: friendNickname,
      friend_country: friendCountryCode || null,
      player_name_detection: playerNameDetection?.language ? {
        detected_language: playerNameDetection.language,
        confidence: playerNameDetection.confidence,
        method: playerNameDetection.method
      } : null,
      message_detection: messageDetection?.language ? {
        detected_language: messageDetection.language,
        score: messageDetection.score,
        confidence: messageDetection.confidence,
        analyzed_count: messageDetection.analyzedCount,
        total_messages: messageDetection.totalMessages,
        incoming_count: messageDetection.incomingCount,
        outgoing_count: messageDetection.outgoingCount
      } : null,
      detection_method: finalLanguage.method || 'country_analysis'
    };
  }

  /**
   * Analyze countries from player summaries and map to languages with scoring
   */
  analyzeCountriesForLanguages(players, friendSteamId) {
    const languageScores = {};
    
    for (const player of players) {
      const countryCode = player.loccountrycode;
      
      if (!countryCode) {
        continue; // Skip players without country info
      }
      
      const countryLanguages = this.COUNTRY_LANGUAGE_MAP[countryCode];
      
      if (!countryLanguages) {
        this.logger.debug(`${this.workerName} Unknown country code: ${countryCode}`);
        continue;
      }
      
      // Determine weight multiplier (friend gets full weight, others get reduced)
      const isMainFriend = player.steamid === friendSteamId;
      const weightMultiplier = isMainFriend ? 1 : 0.75; // Friend's friends get 75% weight
      
      // Add scores for each language in this country
      for (const langInfo of countryLanguages) {
        const { language, weight } = langInfo;
        const adjustedWeight = Math.round(weight * weightMultiplier);
        
        if (!languageScores[language]) {
          languageScores[language] = { language, score: 0 };
        }
        
        languageScores[language].score += adjustedWeight;
      }
      
      this.logger.debug(`${this.workerName} Player ${player.steamid}: ${countryCode} → languages with ${isMainFriend ? 'full' : 'reduced'} weight`);
    }
    
    // Convert to array and sort by score
    return Object.values(languageScores)
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Resolve final language using priority rules:
   * 1. Strong message detection (score >= 3) takes priority
   * 2. Tie between country and message data: messages win
   * 3. Strong country data with matching message data
   * 4. Country data with player name fallback
   * 5. Fallback to English
   *
   * @param {Array} languageScores - Scores from country analysis
   * @param {Object|null} playerNameDetection - Result from player name detection
   * @param {Object|null} messageDetection - Result from message analysis
   */
  resolveFinalLanguage(languageScores, playerNameDetection = null, messageDetection = null) {
    const hasCountryData = languageScores.length > 0 && languageScores[0].score > 0;
    const hasMessageData = messageDetection?.language && messageDetection.score > 0;
    const hasPlayerNameData = playerNameDetection?.language;

    const topCountryScore = hasCountryData ? languageScores[0].score : 0;
    const topCountryLanguage = hasCountryData ? languageScores[0].language : null;

    // PRIORITY 1: Strong message detection (direct evidence from conversation)
    // If message analysis has significant evidence, use it
    if (hasMessageData && messageDetection.score >= 3) {
      // Check if country data strongly disagrees
      if (hasCountryData && topCountryLanguage !== messageDetection.language && topCountryScore >= 8) {
        // Strong conflict - log but still prefer messages (per user requirement)
        this.logger.info(`${this.workerName} Message (${messageDetection.language}) conflicts with strong country data (${topCountryLanguage}:${topCountryScore}) - preferring messages`);
      }

      this.logger.info(`${this.workerName} Using message analysis: ${messageDetection.language} (score: ${messageDetection.score.toFixed(1)})`);
      return {
        language: messageDetection.language,
        score: Math.round(messageDetection.score),
        method: 'message_analysis'
      };
    }

    // PRIORITY 2: Tie-breaker - if country and message data exist and conflict, messages win
    if (hasMessageData && hasCountryData) {
      if (topCountryLanguage !== messageDetection.language) {
        // Conflict between country and message - messages take priority
        this.logger.info(`${this.workerName} Tie between country (${topCountryLanguage}:${topCountryScore}) and message (${messageDetection.language}:${messageDetection.score.toFixed(1)}) - preferring messages`);
        return {
          language: messageDetection.language,
          score: Math.round(messageDetection.score),
          method: 'message_analysis'
        };
      } else {
        // Agreement between country and message - use country (higher confidence)
        this.logger.info(`${this.workerName} Country and message analysis agree: ${topCountryLanguage}`);
        return { ...languageScores[0], method: 'country_analysis' };
      }
    }

    // PRIORITY 3: Weak message data (score < 3) but no country data
    if (hasMessageData && !hasCountryData) {
      this.logger.info(`${this.workerName} No country data - using weak message analysis: ${messageDetection.language}`);
      return {
        language: messageDetection.language,
        score: Math.round(messageDetection.score),
        method: 'message_analysis'
      };
    }

    // PRIORITY 4: Country data with player name fallback (original logic)
    if (!hasCountryData && hasPlayerNameData) {
      this.logger.info(`${this.workerName} No country data - using player name detection: ${playerNameDetection.language}`);
      return {
        language: playerNameDetection.language,
        score: Math.round(playerNameDetection.confidence * 10),
        method: 'player_name'
      };
    }

    // If country data is weak but player name has high-confidence non-English detection
    if (hasPlayerNameData &&
        playerNameDetection.language !== 'English' &&
        playerNameDetection.confidence >= 0.85 &&
        topCountryScore < 5) {
      this.logger.info(`${this.workerName} Weak country data (${topCountryScore}) - using high-confidence player name: ${playerNameDetection.language}`);
      return {
        language: playerNameDetection.language,
        score: Math.round(playerNameDetection.confidence * 10),
        method: 'player_name'
      };
    }

    // PRIORITY 5: Standard country-based resolution
    if (languageScores.length === 0) {
      return { language: 'English', score: 0, method: 'fallback' };
    }

    // If multiple languages have same top score, apply specificity rule
    const topScore = languageScores[0].score;
    const topLanguages = languageScores.filter(lang => lang.score === topScore);

    if (topLanguages.length === 1) {
      return { ...topLanguages[0], method: 'country_analysis' };
    }

    // Specificity rule: non-English languages are more specific
    const nonEnglish = topLanguages.find(lang => lang.language !== 'English');
    if (nonEnglish) {
      this.logger.info(`${this.workerName} Tie-breaker: choosing ${nonEnglish.language} over English (specificity rule)`);
      return { ...nonEnglish, method: 'country_analysis' };
    }

    return { ...topLanguages[0], method: 'country_analysis' };
  }

  /**
   * Update task partial_data for resume capability
   */
  async updateTaskPartialData(taskID, newPartialData) {
    try {
      // Get current task
      const allTasks = await this.languageQueue.getTasks();
      const currentTask = allTasks.find(task => task.taskID === taskID);
      
      if (currentTask) {
        const updatedTask = {
          ...currentTask,
          partial_data: {
            ...currentTask.partial_data,
            ...newPartialData
          },
          updated_at: new Date().toISOString()
        };
        
        await this.languageQueue.updateTask(taskID, updatedTask);
        this.logger.debug(`${this.workerName} Updated partial data for ${taskID}`);
      }
    } catch (error) {
      this.logger.warn(`${this.workerName} Failed to update partial data for ${taskID}: ${error.message}`);
    }
  }

  /**
   * Future method: Analyze profile text and message content
   * STUB: For future implementation
   */
  async processTextAnalysisMethod(steamIds, attempts, partial_data) {
    this.logger.info(`${this.workerName} [TEXT_ANALYSIS] Analyzing text content (STUB)`);
    
    // Simulate processing time for text analysis
    await this.sleep(1000);
    
    // STUB: Return English with lower confidence
    return {
      current_language: 'English',
      candidates: [
        { language: 'English', score: 2 }
      ],
      methods_used: ['text_analysis'],
      last_updated: new Date().toISOString(),
      note: 'STUB: Text analysis not yet implemented'
    };
  }

  /**
   * Future method: Use AI to analyze language patterns
   * STUB: For future implementation
   */
  async processAiAnalysisMethod(steamIds, attempts, partial_data) {
    this.logger.info(`${this.workerName} [AI_ANALYSIS] AI-powered language detection (STUB)`);
    
    // Simulate AI processing time
    await this.sleep(2000);
    
    // STUB: Return English with AI confidence
    return {
      current_language: 'English',
      candidates: [
        { language: 'English', score: 3 }
      ],
      methods_used: ['ai_analysis'],
      last_updated: new Date().toISOString(),
      note: 'STUB: AI analysis not yet implemented'
    };
  }

  /**
   * Future method: Browser automation for detailed profile scraping
   * STUB: For future implementation
   */
  async processSeleniumScrapingMethod(steamIds, attempts, partial_data) {
    this.logger.info(`${this.workerName} [SELENIUM_SCRAPING] Browser-based profile scraping (STUB)`);
    
    // Simulate longer Selenium processing time
    await this.sleep(3000);
    
    // STUB: Return English with high confidence
    return {
      current_language: 'English',
      candidates: [
        { language: 'English', score: 4 }
      ],
      methods_used: ['selenium_scraping'],
      last_updated: new Date().toISOString(),
      note: 'STUB: Selenium scraping not yet implemented'
    };
  }

  /**
   * Update orchestration task by removing completed pending task
   */
  async updateOrchestrationPendingTasks(taskID, completedTask) {
    try {
      this.logger.info(`${this.workerName} Updating orchestration task ${taskID} - removing '${completedTask}'`);
      
      // Get all orchestration tasks
      const allOrchestrationTasks = await this.orchestrationQueue.getTasks();
      const orchestrationTask = allOrchestrationTasks.find(task => task.taskID === taskID);
      
      if (!orchestrationTask) {
        this.logger.error(`${this.workerName} No orchestration task found with taskID ${taskID}`);
        return;
      }

      // Remove the completed task from pending_tasks
      const updatedPendingTasks = (orchestrationTask.pending_tasks || [])
        .filter(pendingTask => pendingTask !== completedTask);
      
      // Update the orchestration task
      const updateResult = await this.orchestrationQueue.updateTask(taskID, {
        pending_tasks: updatedPendingTasks,
        updated_at: new Date().toISOString()
      });

      if (updateResult) {
        this.logger.info(`${this.workerName} ✅ Successfully updated orchestration task ${taskID} - removed '${completedTask}'`);
      } else {
        this.logger.error(`${this.workerName} ❌ Failed to update orchestration task ${taskID}`);
      }

    } catch (error) {
      this.logger.error(`${this.workerName} Failed to update orchestration pending_tasks for ${taskID}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Update orchestration context with detected language
   */
  async updateOrchestrationLanguageContext(taskID, languageResult, method) {
    try {
      this.logger.info(`${this.workerName} Updating language context for ${taskID}`);
      
      // Get current orchestration task
      const allOrchestrationTasks = await this.orchestrationQueue.getTasks();
      const orchestrationTask = allOrchestrationTasks.find(task => task.taskID === taskID);
      
      if (!orchestrationTask || !orchestrationTask.context) {
        this.logger.warn(`${this.workerName} No orchestration task or context found for ${taskID}`);
        return;
      }

      const contextUpdates = {
        // Set detected language object
        language: languageResult,
        
        // Mark language detection as completed
        language_detected_at: new Date().toISOString(),
        
        // Add method tracking
        language_detection_method: method
      };

      // Update the orchestration task context
      const updateResult = await this.orchestrationQueue.updateTask(taskID, {
        context: {
          ...orchestrationTask.context,
          ...contextUpdates
        },
        updated_at: new Date().toISOString()
      });

      if (updateResult) {
        this.logger.info(`${this.workerName} ✅ Language detected as '${languageResult.current_language}' for ${taskID} using ${method}`);
      } else {
        this.logger.error(`${this.workerName} ❌ Failed to update language context for ${taskID}`);
      }

    } catch (error) {
      this.logger.error(`${this.workerName} Failed to update language context: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check if we should retry a failed task
   */
  shouldRetryTask(error, attempts) {
    const maxRetries = 3;
    
    if (attempts >= maxRetries) {
      return false; // Max retries reached
    }
    
    // Check if error is retryable (Steam API rate limits, network issues)
    const retryableErrors = [
      'ETIMEDOUT',
      'ECONNRESET', 
      'ENOTFOUND',
      'ECONNREFUSED',
      'Rate limit',
      'Steam API temporary error',
      '429', // Too Many Requests
      '502', // Bad Gateway
      '503', // Service Unavailable
      '504'  // Gateway Timeout
    ];
    
    return retryableErrors.some(pattern => 
      error.message.includes(pattern) || error.code === pattern
    );
  }

  /**
   * Requeue task for retry with exponential backoff
   */
  async requeueTaskForRetry(originalTask, error) {
    const newAttempts = (originalTask.attempts || 0) + 1;
    const backoffMinutes = Math.pow(2, newAttempts - 1); // 1, 2, 4 minutes
    const executeTime = new Date(Date.now() + (backoffMinutes * 60 * 1000));
    
    const retryTask = {
      ...originalTask,
      execute: executeTime.toISOString(),
      attempts: newAttempts,
      retry_reason: error.message,
      updated_at: new Date().toISOString()
    };
    
    // Add retry task to queue
    await this.languageQueue.addTask(retryTask);
    this.stats.retries++;
    
    this.logger.warn(`${this.workerName} Requeuing task ${originalTask.taskID} for retry ${newAttempts}/3 in ${backoffMinutes} minutes (reason: ${error.message})`);
  }

  /**
   * Update negotiation JSON with detected language
   * This ensures the language persists between sessions
   */
  async updateNegotiationLanguage(steamIds, languageResult) {
    const { ourSteamId, friendSteamId } = steamIds;
    
    try {
      this.logger.info(`${this.workerName} Updating negotiation JSON language for ${ourSteamId} -> ${friendSteamId}`);
      
      // Load current negotiation data
      const negotiationsData = await this.httpClient.loadNegotiations(ourSteamId);
      
      if (!negotiationsData || !negotiationsData.negotiations) {
        this.logger.error(`${this.workerName} No negotiations data found for ${ourSteamId}`);
        return;
      }
      
      const negotiation = negotiationsData.negotiations[friendSteamId];
      if (!negotiation) {
        this.logger.error(`${this.workerName} No negotiation found for friend ${friendSteamId}`);
        return;
      }
      
      // Update the language field and friend's username in the negotiation
      const updatedNegotiation = {
        ...negotiation,
        language: languageResult,
        friend_steam_username: languageResult.friend_steam_username || friendSteamId, // Store friend's nickname
        updated_at: new Date().toISOString()
      };

      // Check if our_steam_login is missing at root level and add it
      let ourSteamLogin = negotiationsData.our_steam_login;
      if (!ourSteamLogin) {
        // Extract our Steam login from credentials file
        ourSteamLogin = this.steamLoginExtractor.getSteamLogin(ourSteamId);
        if (ourSteamLogin) {
          this.logger.info(`${this.workerName} Extracted our Steam login: ${ourSteamLogin} for ${ourSteamId}`);
        } else {
          this.logger.warn(`${this.workerName} Could not extract Steam login for ${ourSteamId} - using Steam ID as fallback`);
          ourSteamLogin = ourSteamId; // Fallback to Steam ID
        }
      }

      // Update the negotiations data with both negotiation updates and our_steam_login at root
      const updatedNegotiationsData = {
        ...negotiationsData,
        our_steam_login: ourSteamLogin, // Store at root level
        negotiations: {
          ...negotiationsData.negotiations,
          [friendSteamId]: updatedNegotiation
        },
        updated_at: new Date().toISOString()
      };
      
      // Save back to negotiation JSON
      const saveResult = await this.httpClient.saveNegotiations(ourSteamId, updatedNegotiationsData);
      
      if (saveResult) {
        this.logger.info(`${this.workerName} ✅ Successfully updated negotiation JSON for ${friendSteamId}:`);
        this.logger.info(`  - Language: ${languageResult.current_language}`);
        this.logger.info(`  - Friend username: ${languageResult.friend_steam_username || friendSteamId}`);
        this.logger.info(`  - Our Steam login: ${ourSteamLogin}`);
      } else {
        this.logger.error(`${this.workerName} ❌ Failed to save negotiation JSON for ${ourSteamId}`);
      }
      
    } catch (error) {
      this.logger.error(`${this.workerName} Error updating negotiation language: ${error.message}`);
      // Don't throw - this is not critical enough to fail the entire task
    }
  }

  /**
   * Handle failed task that won't be retried
   */
  async handleFailedTask(task, error) {
    this.logger.error(`${this.workerName} Task ${task.taskID} failed after max retries: ${error.message}`);
    
    // Parse task ID for negotiation update
    const steamIds = this.parseTaskID(task.taskID);
    
    // Still update orchestration to prevent blocking
    await this.updateOrchestrationPendingTasks(task.taskID, 'check_language');
    
    // Set fallback language (English) with error info
    const fallbackResult = {
      current_language: 'English',
      candidates: [{ language: 'English', score: 0 }],
      methods_used: [task.method],
      last_updated: new Date().toISOString(),
      error: error.message,
      attempts: task.attempts || 0
    };
    
    // Update both orchestration context AND negotiation JSON
    await this.updateOrchestrationLanguageContext(task.taskID, fallbackResult, task.method);
    await this.updateNegotiationLanguage(steamIds, fallbackResult);
  }

  /**
   * Initialize country to language mapping
   */
  initializeCountryLanguageMap() {
    return {
      // Europe
      'DE': [{ language: 'German', weight: 4 }],
      'FR': [{ language: 'French', weight: 4 }],
      'ES': [{ language: 'Spanish', weight: 4 }],
      'IT': [{ language: 'Italian', weight: 4 }],
      'GB': [{ language: 'English', weight: 4 }],
      'IE': [{ language: 'English', weight: 4 }],
      'PT': [{ language: 'Portuguese', weight: 4 }],
      'NL': [{ language: 'Dutch', weight: 4 }],
      'BE': [
        { language: 'Dutch', weight: 4 },
        { language: 'French', weight: 3 },
        { language: 'German', weight: 2 }
      ],
      'CH': [
        { language: 'German', weight: 4 },
        { language: 'French', weight: 3 },
        { language: 'Italian', weight: 2 }
      ],
      'AT': [{ language: 'German', weight: 4 }],
      'PL': [{ language: 'Polish', weight: 4 }],
      'CZ': [{ language: 'Czech', weight: 4 }],
      'SK': [{ language: 'Slovak', weight: 4 }],
      'HU': [{ language: 'Hungarian', weight: 4 }],
      'RO': [{ language: 'Romanian', weight: 4 }],
      'BG': [{ language: 'Bulgarian', weight: 4 }],
      'GR': [{ language: 'Greek', weight: 4 }],
      'HR': [{ language: 'Croatian', weight: 4 }],
      'SI': [{ language: 'Slovenian', weight: 4 }],
      'RS': [{ language: 'Serbian', weight: 4 }],
      'BA': [{ language: 'Bosnian', weight: 4 }],
      'MK': [{ language: 'Macedonian', weight: 4 }],
      'AL': [{ language: 'Albanian', weight: 4 }],
      'LT': [{ language: 'Lithuanian', weight: 4 }],
      'LV': [{ language: 'Latvian', weight: 4 }],
      'EE': [{ language: 'Estonian', weight: 4 }],
      'FI': [{ language: 'Finnish', weight: 4 }],
      'SE': [{ language: 'Swedish', weight: 4 }],
      'NO': [{ language: 'Norwegian', weight: 4 }],
      'DK': [{ language: 'Danish', weight: 4 }],
      'IS': [{ language: 'Icelandic', weight: 4 }],
      
      // Americas
      'US': [{ language: 'English', weight: 4 }],
      'CA': [
        { language: 'English', weight: 4 },
        { language: 'French', weight: 3 }
      ],
      'MX': [{ language: 'Spanish', weight: 4 }],
      'BR': [{ language: 'Portuguese', weight: 4 }],
      'AR': [{ language: 'Spanish', weight: 4 }],
      'CL': [{ language: 'Spanish', weight: 4 }],
      'CO': [{ language: 'Spanish', weight: 4 }],
      'PE': [{ language: 'Spanish', weight: 4 }],
      'VE': [{ language: 'Spanish', weight: 4 }],
      'EC': [{ language: 'Spanish', weight: 4 }],
      'BO': [{ language: 'Spanish', weight: 4 }],
      'PY': [
        { language: 'Spanish', weight: 4 },
        { language: 'Guarani', weight: 2 }
      ],
      'UY': [{ language: 'Spanish', weight: 4 }],
      
      // Oceania
      'AU': [{ language: 'English', weight: 4 }],
      'NZ': [{ language: 'English', weight: 4 }],
      
      // Asia & Others
      'RU': [{ language: 'Russian', weight: 4 }],
      'UA': [
        { language: 'Ukrainian', weight: 4 },
        { language: 'Russian', weight: 3 }
      ],
      'BY': [
        { language: 'Belarusian', weight: 4 },
        { language: 'Russian', weight: 3 }
      ],
      'KZ': [
        { language: 'Kazakh', weight: 4 },
        { language: 'Russian', weight: 3 }
      ],
      'TR': [{ language: 'Turkish', weight: 4 }],
      'IN': [
        { language: 'Hindi', weight: 4 },
        { language: 'English', weight: 3 }
      ],
      'CN': [{ language: 'Chinese', weight: 4 }],
      'JP': [{ language: 'Japanese', weight: 4 }],
      'KR': [{ language: 'Korean', weight: 4 }],
      'TH': [{ language: 'Thai', weight: 4 }],
      'VN': [{ language: 'Vietnamese', weight: 4 }],
      'ID': [{ language: 'Indonesian', weight: 4 }],
      'MY': [
        { language: 'Malay', weight: 4 },
        { language: 'English', weight: 3 }
      ],
      'SG': [
        { language: 'English', weight: 4 },
        { language: 'Mandarin', weight: 3 },
        { language: 'Malay', weight: 2 }
      ],
      'PH': [
        { language: 'Filipino', weight: 4 },
        { language: 'English', weight: 3 }
      ]
    };
  }

  /**
   * Parse taskID to extract Steam IDs
   */
  parseTaskID(taskID) {
    const parts = taskID.split('_');
    if (parts.length !== 2) {
      throw new Error(`Invalid taskID format: ${taskID}. Expected format: ourSteamId_friendSteamId`);
    }
    return {
      taskID: taskID,
      ourSteamId: parts[0],
      friendSteamId: parts[1]
    };
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Pause worker
   */
  pause() {
    this.isPaused = true;
    this.logger.info(`${this.workerName} paused`);
  }

  /**
   * Resume worker
   */
  resume() {
    this.isPaused = false;
    this.logger.info(`${this.workerName} resumed`);
  }

  /**
   * Get worker statistics
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      steamApiStats: this.steamApi.getStats(),
      queueStats: {
        language: this.languageQueue.getStats(),
        orchestration: this.orchestrationQueue.getStats()
      }
    };
  }
}

module.exports = LanguageWorker;