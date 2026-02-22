// automate_trading_workers/workers/managers/inventory_assessment_manager.js

const { 
  selectItemsForTradeOffer,
  itemClassifiers 
} = require('../../utils/item_selection');

class InventoryAssessmentManager {
  constructor(config, logger, httpClient) {
    this.config = config;
    this.logger = logger;
    this.httpClient = httpClient;
    this.workerName = 'InventoryAssessmentManager';
    this.skinsOfInterest = this.parseSkinsOfInterest();
  }

  /**
   * Assess inventory and determine objective
   * REFACTORED: Simplified for new_friend scenarios only
   * - Checks source for gift requests
   * - Handles completely empty inventory
   * - Single pass through inventory for all calculations
   */
  assessInventory(ctx) {
    // ✅ STEP 1: Handle completely empty inventory
    if (!ctx.inventory || ctx.inventory.length === 0) {
      return {
        objective: 'remove',
        itemsOfInterestValue: 0,
        totalInventoryValue: 0,
        casesCount: 0,
        casesValue: 0,
        skinsOfInterestCount: 0,
        skinsOfInterestValue: 0,
        details: 'Completely empty inventory',
        reason: 'Empty inventory - immediate removal'
      };
    }

    // ✅ STEP 2: Calculate items of interest and total inventory value in single pass
    const metrics = this.calculateInventoryMetrics(ctx.inventory);
    const itemsOfInterestValue = metrics.itemsOfInterestValue;
    const totalInventoryValue = metrics.totalInventoryValue;

    // ✅ STEP 3: Determine objective based on inventory analysis and source
    let objective;
    let reason;

    if (itemsOfInterestValue === 0) {
      // No items of interest - remove friend
      // CHANGED: Previously would request_skins_as_gift for reserve_pipeline, now remove all
      objective = 'remove';
      reason = 'No items of interest - not worth pursuing';
    } else if (itemsOfInterestValue < 2) {
      // Items of interest exist but value < $2.00 -> remove friend
      // CHANGED: Previously would request_cases_as_gift, now remove to avoid report risk
      objective = 'remove';
      reason = `Items of interest value (${itemsOfInterestValue.toFixed(2)}) below $2 threshold - not worth the risk`;
    } else {
      // Items of interest >= $2.00 -> trade
      objective = 'trade';
      reason = `Items of interest value (${itemsOfInterestValue.toFixed(2)}) meets $2 threshold`;
    }

    // ✅ STEP 4: Return complete assessment
    return {
      objective,
      itemsOfInterestValue,
      totalInventoryValue,
      casesCount: metrics.casesCount,
      casesValue: metrics.casesValue,
      skinsOfInterestCount: metrics.skinsOfInterestCount,
      skinsOfInterestValue: metrics.skinsOfInterestValue,
      reason,
      details: reason
    };
  }

  /**
   * Calculate detailed breakdown of items of interest and total inventory value
   * Returns: { itemsOfInterestValue, casesCount, casesValue, skinsOfInterestCount, skinsOfInterestValue, totalInventoryValue }
   */
  calculateInventoryMetrics(inventory) {
    if (!inventory || inventory.length === 0) {
      return {
        itemsOfInterestValue: 0,
        casesCount: 0,
        casesValue: 0,
        skinsOfInterestCount: 0,
        skinsOfInterestValue: 0,
        totalInventoryValue: 0
      };
    }
    
    let itemsOfInterestValue = 0;
    let totalInventoryValue = 0;
    let casesCount = 0;
    let casesValue = 0;
    let skinsOfInterestCount = 0;
    let skinsOfInterestValue = 0;
    
    for (const item of inventory) {
      const itemPrice = item.price || 0;
      const itemQuantity = item.quantity || 1;
      const itemValue = itemPrice * itemQuantity;
      
      totalInventoryValue += itemValue;
      
      if (item.market_hash_name && item.market_hash_name.toLowerCase().includes('case')) {
        casesCount += itemQuantity;
        casesValue += itemValue;
        itemsOfInterestValue += itemValue;
      } else if (this.isSkinOfInterest(item, itemPrice)) {
        skinsOfInterestCount += itemQuantity;
        skinsOfInterestValue += itemValue;
        itemsOfInterestValue += itemValue;
      }
    }
    
    return {
      itemsOfInterestValue,
      casesCount,
      casesValue,
      skinsOfInterestCount,
      skinsOfInterestValue,
      totalInventoryValue
    };
  }

  /**
   * Check base accounts inventory for redirect
   */
  async checkBaseAccountsInventory(ctx) {
    // Get base account IDs from config (format: BASE_ACCOUNTS_IDS=76561197993394680,76561198018848793)
    const baseAccountIds = this.config.baseAccounts?.ids || [];
    
    if (baseAccountIds.length === 0) {
      this.logger.warn(`${this.workerName}: No base accounts configured in BASE_ACCOUNTS_IDS`);
      return { suitableAccounts: [], checkedAccounts: 0 };
    }
    
    // Randomize order to distribute load evenly
    const shuffledAccountIds = [...baseAccountIds].sort(() => Math.random() - 0.5);
    
    // Calculate friend value (only items of interest)
    const friendValue = this.calculateInventoryMetrics(ctx.inventory).itemsOfInterestValue;
    
    this.logger.info(`${this.workerName}: Checking ${shuffledAccountIds.length} base accounts (friend value: $${friendValue.toFixed(2)})`);
    
    const suitableAccounts = [];
    let checkedAccounts = 0;
    
    // Check each base account's inventory (in randomized order)
    for (const accountId of shuffledAccountIds) {
      try {
        checkedAccounts++;
        
        // ✅ FIX: Use HttpClient API instead of direct filesystem access
        this.logger.info(`${this.workerName}: Loading negotiations for base account ${accountId} via API`);
        const negotiationsData = await this.httpClient.loadNegotiations(accountId);
        
        if (!negotiationsData) {
          this.logger.warn(`${this.workerName}: No negotiations data found for base account ${accountId}`);
          continue;
        }
        
        // ✅ FIX: Treat null/undefined inventories as empty arrays
        const baseInventory = negotiationsData.our_inventory || [];
        
        // Log inventory status
        if (baseInventory.length === 0) {
          this.logger.info(`${this.workerName}: Base account ${accountId} has empty inventory (our_inventory: ${negotiationsData.our_inventory === null ? 'null' : negotiationsData.our_inventory === undefined ? 'undefined' : '[]'})`);
          continue; // Skip accounts with empty inventories
        }
        
        this.logger.info(`${this.workerName}: Base account ${accountId} has ${baseInventory.length} items in inventory`);
        
        // ✅ FIX: Only validate if inventory has items
        if (baseInventory.length > 0) {
          // Use real selection logic to validate this base account
          const selectionResult = this.validateTradeViability(
            baseInventory,
            friendValue,
            ctx.inventory
          );
          
          if (selectionResult.success) {
            suitableAccounts.push(accountId);
            this.logger.info(`${this.workerName}: ✓ Base account ${accountId} has sufficient inventory for valid trade (strategy: ${selectionResult.strategy_used}, score: ${selectionResult.score})`);
            break; // Stop at first suitable account (now randomized)
          } else {
            this.logger.info(`${this.workerName}: ✗ Base account ${accountId} insufficient - ${selectionResult.reason}`);
          }
        }
        
      } catch (error) {
        this.logger.error(`${this.workerName}: Error checking base account ${accountId}: ${error.message}`);
        // Continue checking other accounts even if one fails
      }
    }
    
    this.logger.info(`${this.workerName}: Checked ${checkedAccounts}/${shuffledAccountIds.length} base accounts, found ${suitableAccounts.length} suitable account(s)`);
    
    return {
      suitableAccounts: suitableAccounts,
      checkedAccounts: checkedAccounts,
      totalAccounts: shuffledAccountIds.length
    };
  }

  /**
   * Validate trade viability using real item selection logic
   * @param {Array} ourInventory - Our complete inventory
   * @param {number} friendValue - Total value of friend's items of interest
   * @param {Array} friendInventory - Friend's inventory
   * @returns {Object} - Selection result with success flag
   */
  validateTradeViability(ourInventory, friendValue, friendInventory) {
    // Filter only tradeable items
    const ourTradeableItems = ourInventory.filter(item => item.tradeable);
    
    if (ourTradeableItems.length === 0) {
      return {
        success: false,
        reason: 'No tradeable items in inventory'
      };
    }
    
    // Call the item selection orchestrator
    const result = selectItemsForTradeOffer(
      ourTradeableItems,
      friendValue,
      friendInventory,
      itemClassifiers.isAK47,
      itemClassifiers.isAWP,
      itemClassifiers.isKnife,
      itemClassifiers.isGloves,
      itemClassifiers.isCase,
      itemClassifiers.getWeaponType,
      false, // includeKnife
      false,  // includeGloves
      this.logger 
    );
    
    return result;
  }
  
  /**
   * Select the best skin for request_skins_as_gift objective
   * Strategy: Most expensive under $1, or cheapest overall
   * @param {Array} inventory - Array of inventory items
   * @returns {Object} Selected item
   */
  selectBestSkin(inventory) {
    if (!inventory || inventory.length === 0) {
      this.logger.warn(`${this.workerName}: selectBestSkin called with empty inventory`);
      return null;
    }

    let selectedItem = null;

    // Filter items under $1
    const itemsUnder1Dollar = inventory.filter(item =>
      (item.price || 0) < 1.0
    );

    if (itemsUnder1Dollar.length > 0) {
      // Select most expensive under $1
      selectedItem = itemsUnder1Dollar.reduce((max, item) =>
        ((item.price || 0) > (max.price || 0)) ? item : max
      );
      this.logger.info(`${this.workerName}: Selected most expensive item under $1: ${selectedItem.market_hash_name} ($${(selectedItem.price || 0).toFixed(2)})`);
    } else {
      // No items under $1, select cheapest overall
      selectedItem = inventory.reduce((min, item) =>
        ((item.price || 0) < (min.price || 0)) ? item : min
      );
      this.logger.info(`${this.workerName}: No items under $1, selected cheapest item: ${selectedItem.market_hash_name} ($${(selectedItem.price || 0).toFixed(2)})`);
    }

    return selectedItem;
  }
  
  /**
   * Check if a skin matches any of the skins of interest criteria
   */
  isSkinOfInterest(item, itemPrice) {
    if (!item.market_hash_name || itemPrice === null || itemPrice === undefined) {
      return false;
    }

    for (const targetSkin of this.skinsOfInterest) {
      if (targetSkin.pattern.test(item.market_hash_name)) {
        // Found matching pattern, check if price meets minimum threshold
        return itemPrice >= targetSkin.minPrice;
      }
    }

    return false;
  }
  
  /**
   * Parse SKINS_OF_INTEREST from environment variable with hardcoded fallback
   */
  parseSkinsOfInterest() {
    // Hardcoded fallback list
    const fallbackSkinsOfInterest = [
      { pattern: /SG 553.*Ultraviolet/i, minPrice: 20, name: 'SG 553 | Ultraviolet' },
      { pattern: /AUG/i, minPrice: 30, name: 'AUG (any variant)' },
      { pattern: /Glock-18.*Dragon Tattoo/i, minPrice: 60, name: 'Glock-18 | Dragon Tattoo' },
      { pattern: /AK-47.*Redline/i, minPrice: 50, name: 'AK-47 | Redline' },
      { pattern: /AWP.*Redline/i, minPrice: 50, name: 'AWP | Redline' }
    ];

    try {
      const envValue = process.env.SKINS_OF_INTEREST;
      
      if (!envValue) {
        this.logger.info(`${this.workerName}: SKINS_OF_INTEREST not found in .env, using fallback list`);
        return fallbackSkinsOfInterest;
      }

      // Parse JSON from environment variable
      const parsedSkins = JSON.parse(envValue);
      
      if (!Array.isArray(parsedSkins)) {
        throw new Error('SKINS_OF_INTEREST must be an array');
      }

      // Convert string patterns to RegExp objects
      const processedSkins = parsedSkins.map(skin => {
        if (!skin.pattern || !skin.minPrice || !skin.name) {
          throw new Error('Each skin must have pattern, minPrice, and name properties');
        }

        return {
          pattern: new RegExp(skin.pattern, skin.flags || 'i'),
          minPrice: parseFloat(skin.minPrice),
          name: skin.name
        };
      });

      this.logger.info(`${this.workerName}: Loaded ${processedSkins.length} skins of interest from .env`);
      return processedSkins;

    } catch (error) {
      this.logger.warn(`${this.workerName}: Failed to parse SKINS_OF_INTEREST from .env: ${error.message}. Using fallback list.`);
      return fallbackSkinsOfInterest;
    }
  }
  
  /**
   * Extract generic skin name from market_hash_name
   * Example: "MAG-7 | SWAG-7 (Well-Worn)" -> "MAG-7"
   * @param {string} marketHashName - Full market hash name
   * @returns {string} Generic skin name (weapon part)
   */
  extractGenericSkinName(marketHashName) {
    if (!marketHashName) {
      return '';
    }

    // Split by pipe and take the first part (weapon name)
    const parts = marketHashName.split('|');
    if (parts.length > 0) {
      return parts[0].trim();
    }

    return marketHashName;
  }

  /**
   * Get skin name for template variable substitution
   * If trade offer exists, extract from it; otherwise return placeholder
   * @param {Object} ctx - Context with trade_offers
   * @returns {string} Generic skin name for use in messages
   */
  getSkinNameForTemplate(ctx) {
    // If trade offer exists, extract the skin name from it
    if (ctx.trade_offers && ctx.trade_offers.length > 0) {
      const latestOffer = ctx.trade_offers[ctx.trade_offers.length - 1];

      if (latestOffer.items_to_receive && latestOffer.items_to_receive.length > 0) {
        const firstItem = latestOffer.items_to_receive[0];
        const genericName = this.extractGenericSkinName(firstItem.market_hash_name);
        this.logger.info(`${this.workerName}: Extracted skin name from trade offer: ${genericName}`);
        return genericName;
      }
    }

    // Fallback: if inventory exists, select from it
    if (ctx.inventory && ctx.inventory.length > 0) {
      const selectedItem = this.selectBestSkin(ctx.inventory);
      if (selectedItem) {
        return this.extractGenericSkinName(selectedItem.market_hash_name);
      }
    }

    // Last resort fallback
    this.logger.warn(`${this.workerName}: No trade offer or inventory found, using generic placeholder`);
    return 'skin';
  }

  /**
   * Extract all items of interest from friend's inventory
   * Used for creating immediate trade offers for low-value trades
   * @param {Array} inventory - Friend's inventory
   * @returns {Array} Array of items to receive (cases + skins of interest)
   */
  extractAllItemsOfInterest(inventory) {
    const itemsOfInterest = [];

    if (!inventory || inventory.length === 0) {
      return itemsOfInterest;
    }

    for (const item of inventory) {
      const itemPrice = item.price || 0;

      // Cases
      if (item.market_hash_name && item.market_hash_name.toLowerCase().includes('case')) {
        itemsOfInterest.push({
          market_hash_name: item.market_hash_name,
          quantity: item.quantity || 1,
          price: itemPrice
        });
      }
      // Skins of interest
      else if (this.isSkinOfInterest(item, itemPrice)) {
        itemsOfInterest.push({
          market_hash_name: item.market_hash_name,
          quantity: item.quantity || 1,
          price: itemPrice
        });
      }
    }

    this.logger.info(`${this.workerName}: Extracted ${itemsOfInterest.length} items of interest from friend's inventory`);
    return itemsOfInterest;
  }
}

module.exports = InventoryAssessmentManager;