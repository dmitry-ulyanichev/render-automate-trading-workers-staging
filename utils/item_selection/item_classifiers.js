// automate_trading/utils/item_selection/item_classifiers.js
// Item classification helper functions

/**
 * Check if item is an AK-47
 * @param {string} marketHashName - Item's market hash name
 * @returns {boolean}
 */
function isAK47(marketHashName) {
  return marketHashName.includes('AK-47');
}

/**
 * Check if item is an AWP
 * @param {string} marketHashName - Item's market hash name
 * @returns {boolean}
 */
function isAWP(marketHashName) {
  return marketHashName.includes('AWP');
}

/**
 * Check if item is a knife
 * @param {string} marketHashName - Item's market hash name
 * @returns {boolean}
 */
function isKnife(marketHashName) {
  // Knives have the ★ symbol in their name
  return marketHashName.includes('★') && !marketHashName.toLowerCase().includes('gloves');
}

/**
 * Check if item is gloves
 * @param {string} marketHashName - Item's market hash name
 * @returns {boolean}
 */
function isGloves(marketHashName) {
  // Gloves have both ★ and "Gloves" in their name
  return marketHashName.includes('★') && marketHashName.toLowerCase().includes('gloves');
}

/**
 * Check if item is a case (we never give cases, only skins)
 * @param {string} marketHashName - Item's market hash name
 * @returns {boolean}
 */
function isCase(marketHashName) {
  return marketHashName.includes('Case') || 
         marketHashName.includes('Package') || 
         marketHashName.includes('Capsule');
}

/**
 * Get weapon type category for an item
 * @param {string} marketHashName - Item's market hash name
 * @returns {string} - Weapon type: 'knife', 'gloves', 'rifle', 'sniper', 'pistol', 'smg', 'other'
 */
function getWeaponType(marketHashName) {
  if (isKnife(marketHashName)) return 'knife';
  if (isGloves(marketHashName)) return 'gloves';
  if (isAK47(marketHashName)) return 'rifle';
  if (isAWP(marketHashName)) return 'sniper';
  
  // Pistols
  if (marketHashName.includes('Glock') || 
      marketHashName.includes('P250') || 
      marketHashName.includes('Desert Eagle') || 
      marketHashName.includes('USP-S') ||
      marketHashName.includes('P2000') ||
      marketHashName.includes('Dual Berettas') ||
      marketHashName.includes('Five-SeveN') ||
      marketHashName.includes('Tec-9') ||
      marketHashName.includes('CZ75-Auto') ||
      marketHashName.includes('R8 Revolver')) {
    return 'pistol';
  }
  
  // SMGs
  if (marketHashName.includes('MP') || 
      marketHashName.includes('UMP') || 
      marketHashName.includes('P90') || 
      marketHashName.includes('PP-Bizon') ||
      marketHashName.includes('MAC-10')) {
    return 'smg';
  }
  
  // Rifles (besides AK-47)
  if (marketHashName.includes('M4A') ||
      marketHashName.includes('AUG') ||
      marketHashName.includes('FAMAS') ||
      marketHashName.includes('Galil') ||
      marketHashName.includes('SG 553')) {
    return 'rifle';
  }
  
  // Snipers (besides AWP)
  if (marketHashName.includes('SSG 08') ||
      marketHashName.includes('SCAR-20') ||
      marketHashName.includes('G3SG1')) {
    return 'sniper';
  }
  
  // Heavy weapons
  if (marketHashName.includes('Nova') ||
      marketHashName.includes('XM1014') ||
      marketHashName.includes('Sawed-Off') ||
      marketHashName.includes('MAG-7') ||
      marketHashName.includes('M249') ||
      marketHashName.includes('Negev')) {
    return 'heavy';
  }
  
  return 'other';
}

module.exports = {
  isAK47,
  isAWP,
  isKnife,
  isGloves,
  isCase,
  getWeaponType
};