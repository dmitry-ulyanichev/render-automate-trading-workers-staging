// automate_trading/utils/inventory_cooldown_manager.js

const fs = require('fs').promises;
const path = require('path');

/**
 * InventoryCooldownManager - Manages global IP-based cooldowns for Steam inventory requests
 * 
 * Steam inventory endpoint is very aggressive with rate limits and applies them by IP.
 * This manager handles exponential backoffs and coordinates across all inventory tasks.
 */
class InventoryCooldownManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    
    // FIXED: Use local service data directory, not global data directory
    // This ensures inventory_cooldown.json is stored alongside queues/ and redirects.json
    const localDataDir = path.join(__dirname, '..', 'data'); // automate_trading/data
    
    // File path for persistent cooldown state
    this.cooldownFilePath = path.join(localDataDir, 'inventory_cooldown.json');
    
    // Exponential backoff intervals (1min → 480min)
    this.backoffIntervals = [
      60000,   // 1min
      120000,  // 2min  
      240000,  // 4min
      480000,  // 8min
      960000,  // 16min
      1920000, // 32min
      3600000, // 60min
      7200000, // 120min
      14400000,// 240min
      28800000 // 480min
    ];
    
    // Current cooldown state (loaded from file)
    this.cooldownState = null;
    
    this.logger.info('InventoryCooldownManager initialized', {
      cooldownFile: this.cooldownFilePath,
      localDataDir: localDataDir,
      maxBackoff: `${this.backoffIntervals[this.backoffIntervals.length - 1] / 60000}min`
    });
  }

  /**
   * Load cooldown state from file
   */
  async loadCooldownState() {
    try {
      const data = await fs.readFile(this.cooldownFilePath, 'utf8');
      this.cooldownState = JSON.parse(data);
      
      this.logger.debug('Cooldown state loaded', {
        backoffLevel: this.cooldownState.backoffLevel,
        cooldownUntil: this.cooldownState.cooldownUntil,
        isActive: this.isCooldownActive()
      });
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File doesn't exist - create initial state
        this.cooldownState = {
          backoffLevel: 0,
          cooldownUntil: 0,
          lastRateLimitTime: 0,
          consecutiveSuccesses: 0,
          created: Date.now()
        };
        await this.saveCooldownState();
        this.logger.info('Created initial cooldown state');
      } else {
        this.logger.error(`Error loading cooldown state: ${error.message}`);
        throw error;
      }
    }
  }

  /**
   * Save cooldown state to file
   */
  async saveCooldownState() {
    try {
      // FIXED: Ensure directory exists before saving
      const dir = path.dirname(this.cooldownFilePath);
      await fs.mkdir(dir, { recursive: true });
      
      const data = JSON.stringify(this.cooldownState, null, 2);
      await fs.writeFile(this.cooldownFilePath, data, 'utf8');
      
      this.logger.debug('Cooldown state saved', {
        backoffLevel: this.cooldownState.backoffLevel,
        cooldownUntil: this.cooldownState.cooldownUntil
      });
      
    } catch (error) {
      this.logger.error(`Error saving cooldown state: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check if we're currently in a cooldown period
   */
  isCooldownActive() {
    if (!this.cooldownState) {
      return false;
    }
    
    const now = Date.now();
    return now < this.cooldownState.cooldownUntil;
  }

  /**
   * Get time remaining in current cooldown (in milliseconds)
   */
  getCooldownRemaining() {
    if (!this.isCooldownActive()) {
      return 0;
    }
    
    return this.cooldownState.cooldownUntil - Date.now();
  }

  /**
   * Get next allowed execution time (now + cooldown remaining)
   */
  getNextAllowedTime() {
    return Date.now() + this.getCooldownRemaining();
  }

  /**
   * Apply rate limit - increase backoff level and set new cooldown
   */
  async applyRateLimit() {
    if (!this.cooldownState) {
      await this.loadCooldownState();
    }

    const now = Date.now();
    const maxBackoffLevel = this.backoffIntervals.length - 1;
    
    // Increase backoff level (up to maximum)
    if (this.cooldownState.backoffLevel < maxBackoffLevel) {
      this.cooldownState.backoffLevel++;
    }
    
    // Set new cooldown period
    const cooldownDuration = this.backoffIntervals[this.cooldownState.backoffLevel];
    this.cooldownState.cooldownUntil = now + cooldownDuration;
    this.cooldownState.lastRateLimitTime = now;
    this.cooldownState.consecutiveSuccesses = 0; // Reset success counter
    
    await this.saveCooldownState();
    
    this.logger.warn('Steam inventory rate limit applied', {
      backoffLevel: this.cooldownState.backoffLevel,
      cooldownDuration: `${cooldownDuration / 60000}min`,
      cooldownUntil: new Date(this.cooldownState.cooldownUntil).toISOString(),
      remaining: `${this.getCooldownRemaining() / 60000}min`
    });
    
    return {
      backoffLevel: this.cooldownState.backoffLevel,
      cooldownDuration,
      cooldownUntil: this.cooldownState.cooldownUntil,
      nextAllowedTime: this.getNextAllowedTime()
    };
  }

  /**
   * Record successful request - reset backoff after first success
   */
  async recordSuccess() {
    if (!this.cooldownState) {
      await this.loadCooldownState();
    }

    this.cooldownState.consecutiveSuccesses++;
    
    // Reset backoff level after first successful request
    if (this.cooldownState.backoffLevel > 0) {
      const oldLevel = this.cooldownState.backoffLevel;
      this.cooldownState.backoffLevel = 0;
      this.cooldownState.cooldownUntil = 0; // Clear any remaining cooldown
      
      await this.saveCooldownState();
      
      this.logger.info('Inventory backoff reset after successful request', {
        oldBackoffLevel: oldLevel,
        newBackoffLevel: 0,
        consecutiveSuccesses: this.cooldownState.consecutiveSuccesses
      });
    }
  }

  /**
   * Get current cooldown status for logging/debugging
   */
  getStatus() {
    if (!this.cooldownState) {
      return { active: false, message: 'Not initialized' };
    }

    const isActive = this.isCooldownActive();
    const remaining = this.getCooldownRemaining();
    
    if (isActive) {
      return {
        active: true,
        backoffLevel: this.cooldownState.backoffLevel,
        remainingMs: remaining,
        remainingMinutes: Math.ceil(remaining / 60000),
        cooldownUntil: new Date(this.cooldownState.cooldownUntil).toISOString(),
        message: `Cooldown active for ${Math.ceil(remaining / 60000)} minutes`
      };
    } else {
      return {
        active: false,
        backoffLevel: this.cooldownState.backoffLevel,
        consecutiveSuccesses: this.cooldownState.consecutiveSuccesses,
        message: 'No active cooldown'
      };
    }
  }
}

module.exports = InventoryCooldownManager;