// automate_trading/utils/item_selection/scoring.js
// Scoring system for item selection strategies

/**
 * Calculate score for a strategy result
 * Applies penalties and bonuses according to configuration
 * 
 * @param {Object} strategyResult - Result from a strategy generator
 * @param {number} friendItemCount - Number of items friend is offering
 * @param {Object} config - Configuration object with penalties/bonuses
 * @param {Function} isAK47 - Function to check if item is AK-47
 * @param {Function} isAWP - Function to check if item is AWP
 * @param {Function} isKnife - Function to check if item is a knife
 * @param {Function} isGloves - Function to check if item is gloves
 * @param {Function} getWeaponType - Function to get weapon type category
 * @returns {Object} - Score breakdown with total score
 */
function calculateScore(
  strategyResult,
  friendItemCount,
  config,
  isAK47,
  isAWP,
  isKnife,
  isGloves,
  getWeaponType
) {
  const { items, ratio, receiveValue } = strategyResult;
  
  // Base score starts at 100
  const baseScore = 100;
  
  const penalties = {};
  const bonuses = {};
  
  let totalPenalty = 0;
  let totalBonus = 0;

  // ========== PENALTIES ==========
  
  // 1. Item count mismatch penalty
  if (items.length < friendItemCount) {
    const mismatch = friendItemCount - items.length;
    const penaltyValue = mismatch * config.penalties.item_count_mismatch.value;
    
    penalties.item_count_mismatch = {
      description: `${mismatch} item(s) short of friend's count`,
      penalty: penaltyValue,
      details: {
        friend_count: friendItemCount,
        our_count: items.length,
        mismatch: mismatch
      }
    };
    
    totalPenalty += penaltyValue;
  }

  // 2. Optimal ratio exceeded penalty
  const optimalRatio = config.thresholds.optimal_ratio.value;
  if (ratio > optimalRatio) {
    const excess = ratio - optimalRatio;
    const steps = Math.floor(excess / 0.025); // Penalty per 0.025 exceeded
    const penaltyValue = steps * config.penalties.optimal_ratio_exceeded.value;
    
    penalties.optimal_ratio_exceeded = {
      description: `Ratio ${ratio.toFixed(3)} exceeds optimal ${optimalRatio.toFixed(3)}`,
      penalty: penaltyValue,
      details: {
        actual_ratio: ratio,
        optimal_ratio: optimalRatio,
        excess: excess,
        steps: steps
      }
    };
    
    totalPenalty += penaltyValue;
  }

  // ========== BONUSES ==========
  
  let ak47Count = 0;
  let awpCount = 0;
  let knifeCount = 0;
  let glovesCount = 0;
  const weaponTypes = new Set();
  
  // Count special items and weapon types
  for (const item of items) {
    const marketName = item.market_hash_name;
    
    if (isAK47(marketName)) {
      ak47Count++;
    }
    if (isAWP(marketName)) {
      awpCount++;
    }
    if (isKnife(marketName)) {
      knifeCount++;
    }
    if (isGloves(marketName)) {
      glovesCount++;
    }
    
    const weaponType = getWeaponType(marketName);
    weaponTypes.add(weaponType);
  }
  
  // 1. AK-47 bonus
  if (ak47Count > 0) {
    const bonusValue = ak47Count * config.bonuses.ak47.value;
    bonuses.ak47 = {
      description: `${ak47Count} AK-47(s) included`,
      bonus: bonusValue,
      details: { count: ak47Count }
    };
    totalBonus += bonusValue;
  }
  
  // 2. AWP bonus
  if (awpCount > 0) {
    const bonusValue = awpCount * config.bonuses.awp.value;
    bonuses.awp = {
      description: `${awpCount} AWP(s) included`,
      bonus: bonusValue,
      details: { count: awpCount }
    };
    totalBonus += bonusValue;
  }
  
  // 3. Knife bonus
  if (knifeCount > 0) {
    const bonusValue = knifeCount * config.bonuses.knife.value;
    bonuses.knife = {
      description: `${knifeCount} knife(s) included`,
      bonus: bonusValue,
      details: { count: knifeCount }
    };
    totalBonus += bonusValue;
  }
  
  // 4. Gloves bonus
  if (glovesCount > 0) {
    const bonusValue = glovesCount * config.bonuses.gloves.value;
    bonuses.gloves = {
      description: `${glovesCount} gloves included`,
      bonus: bonusValue,
      details: { count: glovesCount }
    };
    totalBonus += bonusValue;
  }
  
  // 5. Diversity bonus
  if (weaponTypes.size > 1) {
    const bonusValue = weaponTypes.size * config.bonuses.diversity.value;
    bonuses.diversity = {
      description: `${weaponTypes.size} weapon type(s)`,
      bonus: bonusValue,
      details: { 
        type_count: weaponTypes.size,
        types: Array.from(weaponTypes)
      }
    };
    totalBonus += bonusValue;
  }

  // ========== CALCULATE FINAL SCORE ==========
  
  const totalScore = baseScore - totalPenalty + totalBonus;
  
  return {
    base_score: baseScore,
    total_penalty: totalPenalty,
    total_bonus: totalBonus,
    total_score: totalScore,
    penalties: penalties,
    bonuses: bonuses
  };
}

module.exports = {
  calculateScore
};