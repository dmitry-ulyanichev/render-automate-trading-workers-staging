// automate_trading/utils/item_selection/strategy_helpers.js
// Helper functions for item selection strategies

/**
 * Check if ratio is within maximum allowed limit
 * @param {number} giveValue - Total value of items to give
 * @param {number} receiveValue - Total value of items to receive
 * @param {number} maxRatio - Maximum allowed ratio
 * @returns {boolean}
 */
function isWithinMaxRatioLimit(giveValue, receiveValue, maxRatio) {
  if (receiveValue === 0) return false;
  const ratio = giveValue / receiveValue;
  return ratio <= maxRatio;
}

/**
 * Calculate ratio between give and receive values
 * @param {number} giveValue - Total value of items to give
 * @param {number} receiveValue - Total value of items to receive
 * @returns {number}
 */
function calculateRatio(itemsOrValue, receiveValue) {
  if (receiveValue === 0) return Infinity;
  
  // Handle both array of items and numeric value
  let giveValue;
  if (Array.isArray(itemsOrValue)) {
    // Calculate total value from array of items
    giveValue = itemsOrValue.reduce((sum, item) => sum + (item.price || 0), 0);
  } else {
    // Use numeric value directly
    giveValue = itemsOrValue || 0;
  }
  
  return giveValue / receiveValue;
}

/**
 * Calculate total value of an array of items
 * @param {Array} items - Array of items with price property
 * @returns {number}
 */
function calculateTotalValue(items) {
  return items.reduce((sum, item) => sum + (item.price || 0), 0);
}

/**
 * Find item from inventory that best matches target price
 * @param {Array} inventory - Available inventory items
 * @param {number} targetPrice - Target price to match
 * @param {Set} usedItems - Set of already used item market_hash_names
 * @returns {Object|null} - Best matching item or null
 */
function findClosestPriceMatch(inventory, targetPrice, usedItems = new Set()) {
  let bestMatch = null;
  let smallestDiff = Infinity;
  
  for (const item of inventory) {
    // Skip if already used
    if (usedItems.has(item.market_hash_name)) {
      continue;
    }
    
    const priceDiff = Math.abs(item.price - targetPrice);
    
    // Prefer items slightly below or equal to target
    if (item.price <= targetPrice * 1.1 && priceDiff < smallestDiff) {
      bestMatch = item;
      smallestDiff = priceDiff;
    }
  }
  
  return bestMatch;
}

/**
 * Replace an item in the selection with another item from inventory
 * @param {Array} currentSelection - Current selected items
 * @param {Object} itemToRemove - Item to remove from selection
 * @param {Object} itemToAdd - Item to add to selection
 * @returns {Array} - New selection array
 */
function replaceItem(currentSelection, itemToRemove, itemToAdd) {
  const newSelection = currentSelection.filter(
    item => item.market_hash_name !== itemToRemove.market_hash_name
  );
  newSelection.push(itemToAdd);
  return newSelection;
}

/**
 * Analyze popular items (AK-47 and AWP) in selection
 * @param {Array} selectedItems - Current selected items
 * @param {Function} isAK47 - Function to check if item is AK-47
 * @param {Function} isAWP - Function to check if item is AWP
 * @returns {Object} - Analysis with counts and item lists
 */
function analyzePopularItems(selectedItems, isAK47, isAWP) {
  const ak47Items = [];
  const awpItems = [];
  const nonPopularItems = [];
  
  for (const item of selectedItems) {
    if (isAK47(item.market_hash_name)) {
      ak47Items.push(item);
    } else if (isAWP(item.market_hash_name)) {
      awpItems.push(item);
    } else {
      nonPopularItems.push(item);
    }
  }
  
  const ak47Count = ak47Items.length;
  const awpCount = awpItems.length;
  const difference = Math.abs(ak47Count - awpCount);
  
  // Has imbalance if difference is >= 2 (e.g., 2 vs 0, 4 vs 1, 5 vs 2)
  const hasImbalance = difference >= 2;
  
  return {
    ak47Count,
    awpCount,
    difference,
    hasImbalance,
    ak47Items,
    awpItems,
    nonPopularItems
  };
}

/**
 * Get all items of a specific type from inventory
 * @param {Array} inventory - Full inventory
 * @param {Function} checkFunction - Function to check if item matches type
 * @returns {Array} - Filtered items
 */
function getItemsByType(inventory, checkFunction) {
  return inventory.filter(item => checkFunction(item.market_hash_name));
}

/**
 * Create a Set of market_hash_names from an array of items
 * Useful for tracking which items are already used
 * @param {Array} items - Array of items
 * @returns {Set} - Set of market_hash_names
 */
function createUsedItemsSet(items) {
  return new Set(items.map(item => item.market_hash_name));
}

module.exports = {
  isWithinMaxRatioLimit,
  calculateRatio,
  calculateTotalValue,
  findClosestPriceMatch,
  replaceItem,
  analyzePopularItems,
  getItemsByType,
  createUsedItemsSet
};