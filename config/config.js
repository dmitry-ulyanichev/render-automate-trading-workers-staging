// automate_trading_workers/config/config.js

require('dotenv').config();

module.exports = {
  // Django API configuration (for auth tokens and inventory prices)
  django: {
    baseUrl: process.env.DJANGO_BASE_URL || 'http://localhost:8000/en',
    apiKey:  process.env.LINK_HARVESTER_API_KEY
  },

  // Steam API configuration (for direct inventory HTTP calls)
  steam: {
    apiKey:  process.env.STEAM_API_KEY,
    baseUrl: 'https://api.steampowered.com',
    timeout: parseInt(process.env.AUTOMATE_TRADING_STEAM_API_TIMEOUT) || 10000
  },

  // node_api_service (queues, negotiations, sessions)
  nodeApiService: {
    baseUrl:        process.env.NODE_API_SERVICE_URL || 'http://127.0.0.1:3001',
    apiKey:         process.env.LINK_HARVESTER_API_KEY,
    timeout:        parseInt(process.env.NODE_API_SERVICE_TIMEOUT) || 30000,
    retryAttempts:  parseInt(process.env.NODE_API_SERVICE_RETRY_ATTEMPTS) || 3,
    retryDelayMs:   parseInt(process.env.NODE_API_SERVICE_RETRY_DELAY_MS) || 1000,
    enabled:        true,
    fallbackToLocal: false
  },

  // Logging
  logging: {
    level:       process.env.AUTOMATE_TRADING_WORKERS_LOG_LEVEL || 'debug',
    file:        'logs/workers.log',
    consoleOnly: !!process.env.RENDER || process.env.LOG_CONSOLE_ONLY === 'true'
  },

  // Queue backend.
  // MUST be set to 'true' so both this service and automate_trading share the
  // same Redis-backed queues via node_api_service.  File-based queues are local
  // to each service directory and cannot be shared across process boundaries.
  queues: {
    useRedis:      process.env.QUEUES_USE_REDIS !== 'false', // default true
    lockTimeout:   5000,
    lockRetryDelay: 50,
    maxLockRetries: 100
  },

  // InventoryWorker tuning
  inventory: {
    processInterval: parseInt(process.env.INVENTORY_PROCESS_INTERVAL) || 5000
  },

  // OrchestrationCleanupWorker tuning
  orchestration_cleanup: {
    processInterval: parseInt(process.env.ORCHESTRATION_CLEANUP_PROCESS_INTERVAL) || 300000 // 5 minutes default
  },

  // AIWorker tuning
  ai: {
    processInterval: parseInt(process.env.AI_PROCESS_INTERVAL) || 3000,
    batchSize:       parseInt(process.env.AI_BATCH_SIZE)       || 1,

    providers: [
      {
        name:        'gemini',
        apiKey:      process.env.GEMINI_API_KEY,
        model:       process.env.GEMINI_MODEL        || 'gemini-2.5-flash',
        maxTokens:   parseInt(process.env.GEMINI_MAX_TOKENS)    || 500,
        temperature: parseFloat(process.env.GEMINI_TEMPERATURE) || 0.3,
        timeout:     parseInt(process.env.GEMINI_TIMEOUT)       || 30000,
        maxRetries:  parseInt(process.env.GEMINI_MAX_RETRIES)   || 2,
        retryDelayMs: parseInt(process.env.GEMINI_RETRY_DELAY_MS) || 1000
      },
      {
        name:        'mistral',
        apiKey:      process.env.MISTRAL_API_KEY,
        model:       process.env.MISTRAL_MODEL        || 'mistral-small-latest',
        maxTokens:   parseInt(process.env.MISTRAL_MAX_TOKENS)    || 500,
        temperature: parseFloat(process.env.MISTRAL_TEMPERATURE) || 0.3,
        timeout:     parseInt(process.env.MISTRAL_TIMEOUT)       || 30000,
        maxRetries:  parseInt(process.env.MISTRAL_MAX_RETRIES)   || 3,
        retryDelayMs: parseInt(process.env.MISTRAL_RETRY_DELAY_MS) || 1000
      }
    ]
  },

  // LanguageWorker tuning
  language: {
    processInterval: parseInt(process.env.LANGUAGE_PROCESS_INTERVAL) || 3000,
    batchSize:       parseInt(process.env.LANGUAGE_BATCH_SIZE)        || 2
  },

  // Credentials file (used by SteamLoginExtractor inside LanguageWorker)
  persistentConnections: {
    credentialsFile: process.env.STEAM_CREDENTIALS_FILE || '.env.steam.portion'
  },

  // Proxy file for SteamApiManager SOCKS5 connections.
  // Set PROXY_CONFIG_PATH to the shared proxy.json used by automate_trading,
  // or create a proxy.json symlink in this service's working directory.
  // Example: PROXY_CONFIG_PATH=/path/to/automate_trading/proxy.json
};
