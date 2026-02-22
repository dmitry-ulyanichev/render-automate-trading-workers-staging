// automate_trading/utils/item_selection/strategy_generators.js
// Strategy generators for item selection

const {
  calculateRatio,
  calculateTotalValue
} = require('./strategy_helpers');

/**
 * Generate BASE strategy result
 * Selects cheapest regular (non-knife, non-gloves) items up to friend's item count
 * Always returns a result, even if it exceeds maxRatio (marked as invalid)
 * 
 * @param {Array} availableItems - All available items (already sorted by price)
 * @param {number} friendItemCount - Number of items friend is offering
 * @param {number} friendValue - Total value of friend's items
 * @param {number} maxRatio - Maximum allowed ratio (e.g., 0.30)
 * @param {Function} isKnife - Function to check if item is a knife
 * @param {Function} isGloves - Function to check if item is gloves
 * @returns {Object|null} - Strategy result or null if no items available
 */
function generateBase(
  availableItems,
  friendItemCount,
  friendValue,
  maxRatio,
  isKnife,
  isGloves
) {
  // Filter out knives and gloves - we only want regular skins for BASE
  const regularItems = availableItems.filter(item => 
    !isKnife(item.market_hash_name) && !isGloves(item.market_hash_name)
  );

  if (regularItems.length === 0) {
    return null; // No regular items available
  }

  // Select items up to friend's count - natural limit by available items
  const targetCount = Math.min(friendItemCount, regularItems.length);
  const selectedItems = regularItems.slice(0, targetCount);

  const giveValue = calculateTotalValue(selectedItems);
  const ratio = calculateRatio(selectedItems, friendValue);
  
  // Check if within maximum ratio, but still return result even if not
  const isValid = ratio <= maxRatio;

  return {
    strategy: 'BASE',
    items: selectedItems,
    giveValue,
    receiveValue: friendValue,
    ratio,
    itemCount: selectedItems.length,
    isValid
  };
}

/**
 * Generate BUDGET strategy result
 * Like BASE but tries to match the BUDGET exactly (optimal ratio * friend value)
 * 
 * @param {Array} availableItems - All available items (already sorted by price)
 * @param {number} maximumBudget - Target budget to match (optimal ratio * friend value)
 * @param {number} friendValue - Total value of friend's items
 * @param {number} maxRatio - Maximum allowed ratio
 * @param {Function} isKnife - Function to check if item is a knife
 * @param {Function} isGloves - Function to check if item is gloves
 * @returns {Object|null} - Strategy result or null if failed
 */
function generateBudget(
  availableItems,
  maximumBudget,
  friendValue,
  maxRatio,
  isKnife,
  isGloves
) {
  // Filter out knives and gloves
  const regularItems = availableItems.filter(item => 
    !isKnife(item.market_hash_name) && !isGloves(item.market_hash_name)
  );

  if (regularItems.length === 0) {
    return null;
  }

  const selectedItems = [];
  let currentValue = 0;

  // Greedy selection: add items until we reach or slightly exceed budget
  for (const item of regularItems) {
    const newValue = currentValue + item.price;
    
    if (newValue <= maximumBudget * 1.1) { // Allow 10% overshoot
      selectedItems.push(item);
      currentValue = newValue;
      
      // If we're within 5% of budget, that's good enough
      if (currentValue >= maximumBudget * 0.95) {
        break;
      }
    }
  }

  if (selectedItems.length === 0) {
    return null;
  }

  const giveValue = calculateTotalValue(selectedItems);
  const ratio = calculateRatio(selectedItems, friendValue);
  const isValid = ratio <= maxRatio;

  return {
    strategy: 'BUDGET',
    items: selectedItems,
    giveValue,
    receiveValue: friendValue,
    ratio,
    itemCount: selectedItems.length,
    isValid
  };
}

/**
 * Generate DIVERSE strategy variants
 * Starts with BASE, then tries adding 1-3 more expensive items for diversity
 * 
 * @param {Object} baseResult - BASE strategy result (can be invalid)
 * @param {Array} availableItems - All available items (already sorted by price)
 * @param {number} friendValue - Total value of friend's items
 * @param {number} maxRatio - Maximum allowed ratio
 * @param {Function} isKnife - Function to check if item is a knife
 * @param {Function} isGloves - Function to check if item is gloves
 * @param {Function} createUsedItemsSet - Function to create set of used item names
 * @returns {Array} - Array of strategy results (can be empty if no variants possible)
 */
function generateDiverseVariants(
  baseResult,
  availableItems,
  friendValue,
  maxRatio,
  isKnife,
  isGloves,
  createUsedItemsSet
) {
  const variants = [];

  if (!baseResult) {
    return variants; // No BASE result, no variants possible
  }

  // Filter regular items only (no knives/gloves)
  const regularItems = availableItems.filter(item => 
    !isKnife(item.market_hash_name) && !isGloves(item.market_hash_name)
  );

  // Get items already used in BASE
  const usedItems = createUsedItemsSet(baseResult.items);

  // Get available items not in BASE (sorted by price descending for expensive items)
  const availableExpensive = regularItems
    .filter(item => !usedItems.has(item.market_hash_name))
    .sort((a, b) => b.price - a.price); // Most expensive first

  if (availableExpensive.length === 0) {
    return variants; // No new items available
  }

  // Try adding 1, 2, or 3 more expensive items
  for (let addCount = 1; addCount <= 3 && addCount <= availableExpensive.length; addCount++) {
    const itemsToAdd = availableExpensive.slice(0, addCount);
    const newSelection = [...baseResult.items, ...itemsToAdd];

    const giveValue = calculateTotalValue(newSelection);
    const ratio = calculateRatio(newSelection, friendValue);

    if (ratio <= maxRatio) {
      variants.push({
        strategy: `DIVERSE_${addCount}`,
        items: newSelection,
        giveValue,
        receiveValue: friendValue,
        ratio,
        itemCount: newSelection.length,
        isValid: true
      });
    } else {
      // Stop if adding more would exceed max ratio
      break;
    }
  }

  return variants;
}

/**
 * Generate POPULAR strategy variants
 * Starts with BASE, then replaces cheapest non-popular items with popular ones (AK-47, AWP)
 * 
 * @param {Object} baseResult - BASE strategy result (can be invalid)
 * @param {Array} availableItems - All available items (already sorted by price)
 * @param {number} friendValue - Total value of friend's items
 * @param {number} maxRatio - Maximum allowed ratio (e.g., 0.30)
 * @param {number} maxReplacements - Maximum number of replacements to attempt (e.g., 5)
 * @param {Function} isKnife - Function to check if item is a knife
 * @param {Function} isGloves - Function to check if item is gloves
 * @param {Function} isAK47 - Function to check if item is AK-47
 * @param {Function} isAWP - Function to check if item is AWP
 * @param {Function} replaceItem - Function to replace an item
 * @param {Function} createUsedItemsSet - Function to create set of used item names
 * @returns {Array} - Array of strategy results (can be empty if no variants possible)
 */
function generatePopularVariants(
  baseResult,
  availableItems,
  friendValue,
  maxRatio,
  maxReplacements,
  isKnife,
  isGloves,
  isAK47,
  isAWP,
  replaceItem,
  createUsedItemsSet
) {
  const variants = [];

  if (!baseResult) {
    return variants; // No BASE result, no variants possible
  }

  let currentSelection = [...baseResult.items];

  // Get all available popular items (AK-47 and AWP) from inventory
  const usedItems = createUsedItemsSet(currentSelection);
  const availablePopular = availableItems.filter(item => 
    (isAK47(item.market_hash_name) || isAWP(item.market_hash_name)) &&
    !usedItems.has(item.market_hash_name)
  );

  // If no popular items available, no variants possible
  if (availablePopular.length === 0) {
    return variants;
  }

  // Try up to maxReplacements iterations
  let variantNumber = 1;

  for (let i = 0; i < maxReplacements && availablePopular.length > 0; i++) {
    // Sort current selection by price ascending to replace cheapest first
    const sortedByPrice = [...currentSelection].sort((a, b) => a.price - b.price);

    // Find the cheapest non-popular item in current selection
    let cheapestNonPopular = null;

    for (const item of sortedByPrice) {
      const isPopular = isAK47(item.market_hash_name) || isAWP(item.market_hash_name);
      
      if (!isPopular) {
        cheapestNonPopular = item;
        break; // Found the cheapest non-popular
      }
    }

    // If no non-popular items left, stop
    if (!cheapestNonPopular) {
      break;
    }

    // Get the next available popular item (cheapest among available)
    const popularItem = availablePopular[0];

    // Make the replacement
    const newSelection = replaceItem(currentSelection, cheapestNonPopular, popularItem);

    // Check if still within max ratio
    const newRatio = calculateRatio(newSelection, friendValue);

    if (newRatio <= maxRatio) {
      const giveValue = calculateTotalValue(newSelection);

      variants.push({
        strategy: `POPULAR_${variantNumber}`,
        items: newSelection,
        giveValue,
        receiveValue: friendValue,
        ratio: newRatio,
        itemCount: newSelection.length,
        isValid: true
      });

      // Update current selection for next iteration
      currentSelection = [...newSelection];
      variantNumber++;

      // Remove the used popular item from available pool
      availablePopular.shift();
    } else {
      // Would exceed max ratio, stop trying more replacements
      break;
    }
  }

  return variants;
}

/**
 * Generate KNIFE_GLOVES strategy
 * Starts with BASE, replaces cheapest non-popular items with popular ones,
 * then adds knife and/or gloves as requested
 * 
 * @param {Object} baseResult - BASE strategy result (can be invalid)
 * @param {Array} availableItems - All available items
 * @param {number} friendValue - Total value of friend's items
 * @param {number} maxRatio - Maximum allowed ratio
 * @param {boolean} includeKnife - Whether to include knife
 * @param {boolean} includeGloves - Whether to include gloves
 * @param {Function} isKnife - Function to check if item is a knife
 * @param {Function} isGloves - Function to check if item is gloves
 * @param {Function} isAK47 - Function to check if item is AK-47
 * @param {Function} isAWP - Function to check if item is AWP
 * @param {Function} replaceItem - Function to replace an item
 * @param {Function} createUsedItemsSet - Function to create set of used item names
 * @returns {Object|null} - Strategy result or null if failed
 */
function generateKnifeGlovesVariant(
  baseResult,
  availableItems,
  friendValue,
  maxRatio,
  includeKnife,
  includeGloves,
  isKnife,
  isGloves,
  isAK47,
  isAWP,
  replaceItem,
  createUsedItemsSet
) {
  if (!baseResult) {
    return null; // No BASE result
  }

  let currentSelection = [...baseResult.items];

  // Step 2: Replace cheapest non-popular items with popular ones
  let usedItems = createUsedItemsSet(currentSelection);
  let availablePopular = availableItems.filter(item => 
    (isAK47(item.market_hash_name) || isAWP(item.market_hash_name)) &&
    !usedItems.has(item.market_hash_name)
  );

  // Sort current selection by price ascending to replace cheapest first
  const sortedByPrice = [...currentSelection].sort((a, b) => a.price - b.price);

  // Try to use all unique popular items available
  for (const popularItem of availablePopular) {
    // Find the cheapest non-popular item in current selection
    let cheapestNonPopular = null;

    for (const item of sortedByPrice) {
      const isPopular = isAK47(item.market_hash_name) || isAWP(item.market_hash_name);
      
      if (!isPopular) {
        cheapestNonPopular = item;
        break; // Found the cheapest non-popular
      }
    }

    // If no non-popular items left, stop replacing
    if (!cheapestNonPopular) {
      break;
    }

    // Make the replacement
    const newSelection = replaceItem(currentSelection, cheapestNonPopular, popularItem);

    // Check if still within max ratio
    const newRatio = calculateRatio(newSelection, friendValue);

    if (newRatio <= maxRatio) {
      // Valid replacement
      currentSelection = [...newSelection];
      
      // Update sorted list for next iteration
      const indexToRemove = sortedByPrice.indexOf(cheapestNonPopular);
      if (indexToRemove !== -1) {
        sortedByPrice.splice(indexToRemove, 1);
      }
    } else {
      // Would exceed max ratio, stop trying more replacements
      break;
    }
  }

  // Step 3: Add knife and/or gloves as requested
  usedItems = createUsedItemsSet(currentSelection);
  
  // Get available knives and gloves from inventory (sorted by price ascending)
  const availableKnives = availableItems
    .filter(item => isKnife(item.market_hash_name) && !usedItems.has(item.market_hash_name))
    .sort((a, b) => a.price - b.price);
    
  const availableGlovesItems = availableItems
    .filter(item => isGloves(item.market_hash_name) && !usedItems.has(item.market_hash_name))
    .sort((a, b) => a.price - b.price);

  // Check if we have the required items
  if (includeKnife && availableKnives.length === 0) {
    return null; // Required knife not available - FAILURE
  }

  if (includeGloves && availableGlovesItems.length === 0) {
    return null; // Required gloves not available - FAILURE
  }

  // Add knife if requested
  if (includeKnife && availableKnives.length > 0) {
    // Take the cheapest knife available
    const knifeToAdd = availableKnives[0];
    currentSelection.push(knifeToAdd);

    // Check if still within max ratio
    const newRatio = calculateRatio(currentSelection, friendValue);
    if (newRatio > maxRatio) {
      return null; // Exceeds max ratio - FAILURE
    }
  }

  // Add gloves if requested
  if (includeGloves && availableGlovesItems.length > 0) {
    // Take the cheapest gloves available
    const glovesToAdd = availableGlovesItems[0];
    currentSelection.push(glovesToAdd);

    // Check if still within max ratio
    const newRatio = calculateRatio(currentSelection, friendValue);
    if (newRatio > maxRatio) {
      return null; // Exceeds max ratio - FAILURE
    }
  }

  // Success! Create the result
  const giveValue = calculateTotalValue(currentSelection);
  const ratio = calculateRatio(currentSelection, friendValue);

  return {
    strategy: 'KNIFE_GLOVES',
    items: currentSelection,
    giveValue,
    receiveValue: friendValue,
    ratio,
    itemCount: currentSelection.length,
    isValid: ratio <= maxRatio
  };
}

module.exports = {
  generateBase,
  generateBudget,
  generateDiverseVariants,
  generatePopularVariants,
  generateKnifeGlovesVariant
};