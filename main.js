// automate_trading_workers/main.js
//
// Worker service for Steam trading automation.
// Runs stateless business-logic workers that process Redis-backed task queues.
// Steam connections are managed by automate_trading (connections service).
//
// Safe to restart at any time without disrupting live Steam sessions.

const config = require('./config/config');
const InventoryWorker = require('./workers/inventory_worker');
const OrchestrationCleanupWorker = require('./workers/orchestration_cleanup_worker');
const LanguageWorker = require('./workers/language_worker');
const AIWorker = require('./workers/ai_worker');
const FollowUpWorker = require('./workers/follow_up_worker');

const fs   = require('fs-extra');
const path = require('path');
const http = require('http');

// ---------------------------------------------------------------------------
// Logging (matches the style used by automate_trading/main.js)
// ---------------------------------------------------------------------------

function logToFile(message, level = 'info') {
  const timestamp  = new Date().toISOString();
  const logMessage = `[${timestamp}] [MAIN] ${level.toUpperCase()}: ${message}\n`;

  if (!shouldLog(level)) return;

  console.log(logMessage.trim());

  if (!config.logging.consoleOnly) {
    const logDir = path.dirname(config.logging.file);
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(config.logging.file, logMessage);
  }
}

function shouldLog(messageLevel) {
  const levels    = { error: 0, warn: 1, info: 2, debug: 3 };
  const configLevel = config.logging.level;
  return (levels[messageLevel] ?? 3) <= (levels[configLevel] ?? 2);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class WorkerService {
  constructor() {
    this.workers         = new Map();
    this.isShuttingDown  = false;
    this.monitoringTimer = null;

    this.logger = this._createLogger();
  }

  _createLogger() {
    const levels = ['error', 'warn', 'info', 'debug', 'trace'];
    const logger = {};
    levels.forEach(level => {
      logger[level] = (msg, ...args) => {
        let message = msg;
        if (args.length > 0) {
          message = `${msg} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`;
        }
        logToFile(message, level);
      };
    });
    logger.log     = logger.info;
    logger.verbose = logger.debug;
    return logger;
  }

  async start() {
    this.logger.info('Starting automate_trading_workers service');

    try {
      await this._validateConfig();
      await this._initializeWorkers();
      await this._startWorkers();
      this._startMonitoring();

      if (process.env.RENDER) {
        this._startHealthServer();
      }

      this._setupShutdownHandlers();
      this.logger.info('automate_trading_workers service started successfully');

    } catch (error) {
      this.logger.error(`Failed to start service: ${error.message}`);
      process.exit(1);
    }
  }

  async _validateConfig() {
    const required = ['DJANGO_BASE_URL', 'LINK_HARVESTER_API_KEY', 'STEAM_API_KEY'];
    const missing  = required.filter(k => !process.env[k]);
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    if (!config.nodeApiService.baseUrl || !config.nodeApiService.apiKey) {
      throw new Error('Node API Service configuration incomplete');
    }

    if (config.queues.useRedis === false) {
      this.logger.warn('QUEUES_USE_REDIS is false — workers will use local file queues.');
      this.logger.warn('This is only safe if automate_trading also uses file queues with a shared path.');
    }

    const requiredDirs = [
      path.join(__dirname, 'data', 'queues'),
      path.join(__dirname, 'data', 'logs')
    ];
    for (const dir of requiredDirs) {
      await fs.ensureDir(dir);
    }
  }

  async _initializeWorkers() {
    this.logger.info('Initializing workers...');

    const inventoryWorker = new InventoryWorker(config, this.logger);
    this.workers.set('inventory', inventoryWorker);

    const orchestrationCleanupWorker = new OrchestrationCleanupWorker(config, this.logger);
    this.workers.set('orchestration_cleanup', orchestrationCleanupWorker);

    const languageWorker = new LanguageWorker(config, this.logger);
    this.workers.set('language', languageWorker);

    const aiWorker = new AIWorker(config, this.logger);
    this.workers.set('ai', aiWorker);

    const followUpWorker = new FollowUpWorker(config, this.logger);
    this.workers.set('followUp', followUpWorker);

    this.logger.info('✓ Workers initialized: InventoryWorker, OrchestrationCleanupWorker, LanguageWorker, AIWorker, FollowUpWorker');
  }

  async _startWorkers() {
    for (const [name, worker] of this.workers) {
      try {
        await worker.start();
        this.logger.info(`✓ ${name} worker started`);
      } catch (error) {
        this.logger.error(`✗ Failed to start ${name} worker: ${error.message}`);
        throw error;
      }
    }
  }

  _startMonitoring() {
    this.monitoringTimer = setInterval(() => {
      if (this.isShuttingDown) return;
      const now = new Date();
      if (now.getMinutes() % 5 === 0 && now.getSeconds() < 5) {
        for (const [name, worker] of this.workers) {
          try {
            const stats = typeof worker.getStats === 'function' ? worker.getStats() : null;
            if (stats?.tasksProcessed > 0) {
              this.logger.info(`${name}: ${stats.tasksProcessed} tasks processed, ${stats.errors || 0} errors`);
            }
          } catch { /* ignore */ }
        }
      }
    }, 5000);
  }

  _startHealthServer() {
    const port = process.env.PORT || 10001;
    this.healthServer = http.createServer((req, res) => {
      if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'automate_trading_workers', uptime: process.uptime() }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    this.healthServer.listen(port, '0.0.0.0', () => {
      this.logger.info(`Health endpoint listening on port ${port}`);
    });
  }

  _setupShutdownHandlers() {
    const shutdown = async (signal) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;
      this.logger.info(`Received ${signal} - shutting down gracefully...`);

      if (this.monitoringTimer) clearInterval(this.monitoringTimer);

      for (const [name, worker] of [...this.workers].reverse()) {
        if (typeof worker.stop === 'function') {
          try {
            await worker.stop();
            this.logger.info(`✓ ${name} worker stopped`);
          } catch (error) {
            this.logger.error(`✗ Error stopping ${name} worker: ${error.message}`);
          }
        }
      }

      this.logger.info('Shutdown complete');
      process.exit(0);
    };

    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    process.on('uncaughtException', (error) => {
      this.logger.error(`Uncaught exception: ${error.message}`);
      this.logger.error(error.stack);
      shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason) => {
      this.logger.error(`Unhandled rejection: ${reason}`);
      shutdown('unhandledRejection');
    });
  }
}

if (require.main === module) {
  const service = new WorkerService();
  service.start().catch(error => {
    console.error('Failed to start automate_trading_workers:', error);
    process.exit(1);
  });
}

module.exports = WorkerService;
