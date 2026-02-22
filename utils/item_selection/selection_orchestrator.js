// automate_trading/utils/item_selection/selection_orchestrator.js
// Main orchestrator for item selection with multiple strategies

const fs = require('fs');
const path = require('path');

const {
  calculateRatio,
  calculateTotalValue,
  replaceItem,
  createUsedItemsSet
} = require('./strategy_helpers');

const {
  generateBase,
  generateBudget,
  generateDiverseVariants,
  generatePopularVariants,
  generateKnifeGlovesVariant
} = require('./strategy_generators');

const { calculateScore } = require('./scoring');

// Load item selection configuration
let itemSelectionConfig = null;

function loadConfig() {
  if (itemSelectionConfig) {
    return itemSelectionConfig; // Already loaded
  }

  try {
    const configPath = path.join(__dirname, '..', '..', 'config', 'item_selection_config.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    itemSelectionConfig = JSON.parse(configData);
    return itemSelectionConfig;
  } catch (error) {
    console.error('Error loading item selection config:', error.message);
    // Provide default config if file not found
    itemSelectionConfig = {
      penalties: {
        item_count_mismatch: { value: 10 },
        optimal_ratio_exceeded: { value: 20 }
      },
      bonuses: {
        ak47: { value: 7 },
        awp: { value: 7 },
        knife: { value: 20 },
        gloves: { value: 20 },
        diversity: { value: 5 }
      },
      thresholds: {
        optimal_ratio: { value: 0.125 },
        minimum_ratio: { value: 0.125 },
        maximum_ratio: { value: 0.30 },
        high_value_trade: { value: 100 }
      },
      strategy: {
        max_unique_items: { value: 50 },
        max_popular_replacements: { value: 5 },
        prefer_cheaper_items: { value: true },
        prefer_well_stocked_items: { value: true }
      },
      item_patterns: {
        knife_pattern: "★",
        gloves_pattern: "★.*Gloves",
        case_patterns: ["Case", "Package", "Capsule"]
      }
    };
    return itemSelectionConfig;
  }
}

/**
 * Helper function for logging - uses logger if available, otherwise console.log
 */
function log(message, logger = null) {
  if (logger && typeof logger.info === 'function') {
    logger.info(message);
  } else {
    console.log(message);
  }
}

/**
 * Main function to select items for a trade offer
 * Tests multiple strategies and returns the best one based on scoring
 * 
 * @param {Array} ourTradeableItems - Our available tradeable items
 * @param {number} friendItemsOfInterestValue - Total value of friend's items
 * @param {Array} friendInventory - Friend's inventory items
 * @param {Function} isAK47 - Function to check if item is AK-47
 * @param {Function} isAWP - Function to check if item is AWP
 * @param {Function} isKnife - Function to check if item is a knife
 * @param {Function} isGloves - Function to check if item is gloves
 * @param {Function} isCase - Function to check if item is a case
 * @param {Function} getWeaponType - Function to get weapon type
 * @param {boolean} includeKnife - Whether to include knife in KNIFE_GLOVES strategy
 * @param {boolean} includeGloves - Whether to include gloves in KNIFE_GLOVES strategy
 * @returns {Object} - Best strategy result with scoring
 */
function selectItemsForTradeOffer(
  ourTradeableItems,
  friendItemsOfInterestValue,
  friendInventory,
  isAK47,
  isAWP,
  isKnife,
  isGloves,
  isCase,
  getWeaponType,
  includeKnife = false,
  includeGloves = false,
  logger = null
) {
  // ========== LOAD CONFIGURATION ==========
  
  const config = loadConfig();
  
  // ========== VALIDATION ==========
  
  if (!ourTradeableItems || ourTradeableItems.length === 0) {
    return {
      success: false,
      itemsToGive: null,
      reason: 'No tradeable items available for selection',
      score: 0,
      scoring_breakdown: {},
      strategy_used: 'NONE',
      candidates_tested: 0
    };
  }

  // ========== PREPARE DATA ==========
  
  const friendItemCount = friendInventory.reduce((sum, item) => sum + (item.quantity || 1), 0);
  const maxRatio = config.thresholds.maximum_ratio.value;
  const optimalRatio = config.thresholds.optimal_ratio.value;
  const maximumBudget = friendItemsOfInterestValue * optimalRatio;

  // Deduplicate and filter out cases: take at most 1 unit of each SKIN type
  const itemsByType = new Map();
  for (const item of ourTradeableItems) {
    // Skip cases - we never give cases, only skins
    if (isCase(item.market_hash_name)) {
      continue;
    }
    
    if (!itemsByType.has(item.market_hash_name)) {
      itemsByType.set(item.market_hash_name, item);
    }
  }

  const deduplicatedItems = Array.from(itemsByType.values());
  
  if (deduplicatedItems.length === 0) {
    return {
      success: false,
      itemsToGive: null,
      reason: 'No valid items available (only cases found)',
      score: 0,
      scoring_breakdown: {},
      strategy_used: 'NONE',
      candidates_tested: 0
    };
  }

  // Sort items by price ascending (cheapest first) for BASE/BUDGET strategies
  const sortedItems = [...deduplicatedItems].sort((a, b) => (a.price || 0) - (b.price || 0));

  log(`[ItemSelection] Starting selection for friend value: $${friendItemsOfInterestValue.toFixed(2)}, ${friendItemCount} items`, logger);
  log(`[ItemSelection] Available tradeable items: ${ourTradeableItems.length}, deduplicated: ${deduplicatedItems.length}`, logger);

  // ========== GENERATE ALL STRATEGY CANDIDATES ==========
  
  const candidates = [];

  // 1. Generate BASE strategy
  const baseResult = generateBase(
    sortedItems,
    friendItemCount,
    friendItemsOfInterestValue,
    maxRatio,
    isKnife,
    isGloves
  );

  if (baseResult) {
    candidates.push(baseResult);
    log(`[ItemSelection] ✓ BASE: ${baseResult.items.length} items, value: $${baseResult.giveValue.toFixed(2)}, ratio: ${(baseResult.ratio * 100).toFixed(2)}%, valid: ${baseResult.isValid}`, logger);
  } else {
    log(`[ItemSelection] ✗ BASE: Failed to generate`, logger);
  }

  // 2. Generate BUDGET strategy
  const budgetResult = generateBudget(
    sortedItems,
    maximumBudget,
    friendItemsOfInterestValue,
    maxRatio,
    isKnife,
    isGloves
  );
  
  if (budgetResult) {
    candidates.push(budgetResult);
    log(`[ItemSelection] ✓ BUDGET: ${budgetResult.items.length} items, value: $${budgetResult.giveValue.toFixed(2)}, ratio: ${(budgetResult.ratio * 100).toFixed(2)}%, valid: ${budgetResult.isValid}`, logger);
  } else {
    log(`[ItemSelection] ✗ BUDGET: Failed to generate`, logger);
  }

  // 3. Generate DIVERSE variants (only if BASE succeeded)
  if (baseResult) {
    const diverseVariants = generateDiverseVariants(
      baseResult,
      sortedItems,
      friendItemsOfInterestValue,
      maxRatio,
      isKnife,
      isGloves,
      createUsedItemsSet
    );
    
    candidates.push(...diverseVariants);

    if (diverseVariants && diverseVariants.length > 0) {
      log(`[ItemSelection] ✓ DIVERSE: Generated ${diverseVariants.length} variants`, logger);
    } else {
      log(`[ItemSelection] ✗ DIVERSE: No variants generated`, logger);
  }
  }

  // 4. Generate POPULAR variants (only if BASE succeeded)
  if (baseResult) {
    const popularVariants = generatePopularVariants(
      baseResult,
      sortedItems,
      friendItemsOfInterestValue,
      maxRatio,
      config.strategy.max_popular_replacements.value,
      isKnife,
      isGloves,
      isAK47,
      isAWP,
      replaceItem,
      createUsedItemsSet
    );
    
    candidates.push(...popularVariants);

    if (popularVariants && popularVariants.length > 0) {
      log(`[ItemSelection] ✓ POPULAR: Generated ${popularVariants.length} variants`, logger);
    } else {
      log(`[ItemSelection] ✗ POPULAR: No variants generated`, logger);
    }
  }

  // 5. Generate KNIFE_GLOVES variant (only if requested and BASE succeeded)
  if ((includeKnife || includeGloves) && baseResult) {
    const knifeGlovesResult = generateKnifeGlovesVariant(
      baseResult,
      sortedItems,
      friendItemsOfInterestValue,
      maxRatio,
      includeKnife,
      includeGloves,
      isKnife,
      isGloves,
      isAK47,
      isAWP,
      replaceItem,
      createUsedItemsSet
    );
    
    if (knifeGlovesResult) {
      candidates.push(knifeGlovesResult);
    }
  }

  // ========== FILTER VALID CANDIDATES ==========
  
  // Candidates should already be marked as valid, but double-check
  const validCandidates = candidates.filter(c => c !== null && c.isValid && c.ratio <= maxRatio);

  log(`[ItemSelection] Valid candidates: ${validCandidates.length} of ${candidates.length} generated`, logger);

  if (validCandidates.length === 0) {
    let reason = 'No valid strategies found - all exceeded maximum ratio or failed';
    
    if (includeKnife || includeGloves) {
      reason = 'No valid strategies found - adding required premium items exceeds maximum ratio';
    }

    log(`[ItemSelection] ✗ FAILURE: No valid strategies found - all exceeded maximum ratio or failed`, logger);
    log(`[ItemSelection] Debug: maxRatio=${maxRatio}, candidates generated: ${candidates.length}`, logger);
    
    // Log cada candidato y por qué falló
    candidates.forEach((candidate, idx) => {
      if (candidate) {
        log(`[ItemSelection]   Candidate ${idx + 1}: ${candidate.strategy}, ratio=${(candidate.ratio * 100).toFixed(2)}%, valid=${candidate.isValid}, items=${candidate.items?.length || 0}`, logger);
      }
    });
    
    return {
      success: false,
      itemsToGive: null,
      reason: reason,
      score: 0,
      scoring_breakdown: {},
      strategy_used: 'NONE',
      candidates_tested: candidates.length
    };
  }

  // ========== SCORE ALL VALID CANDIDATES ==========
  
  const scoredCandidates = validCandidates.map(candidate => {
    const scoringBreakdown = calculateScore(
      candidate,
      friendItemCount,
      config,
      isAK47,
      isAWP,
      isKnife,
      isGloves,
      getWeaponType
    );
    
    return {
      ...candidate,
      score: scoringBreakdown.total_score,
      scoring_breakdown: scoringBreakdown
    };
  });

  // ========== SELECT BEST CANDIDATE ==========
  
  // Sort by score descending (highest score first)
  scoredCandidates.sort((a, b) => b.score - a.score);

  log(`[ItemSelection] Scored candidates:`, logger);
  scoredCandidates.forEach((candidate, idx) => {
    log(`[ItemSelection]   ${idx + 1}. ${candidate.strategy}: score=${candidate.score}, ratio=${(candidate.ratio * 100).toFixed(2)}%, items=${candidate.items.length}`, logger);
  });
  
  const best = scoredCandidates[0];

  log(`[ItemSelection] ✓ SUCCESS: Selected ${best.strategy} with score ${best.score}, ratio ${(best.ratio * 100).toFixed(2)}%`, logger);

  return {
    success: true,
    strategy_used: best.strategy,
    itemsToGive: best.items,
    giveValue: best.giveValue,
    receiveValue: best.receiveValue,
    ratio: best.ratio,
    score: best.score,
    scoring_breakdown: best.scoring_breakdown,
    reason: 'Selection successful',
    all_candidates: scoredCandidates // Include all scored candidates for debugging
  };
}

module.exports = {
  selectItemsForTradeOffer
};