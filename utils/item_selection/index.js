// automate_trading/utils/item_selection/index.js
// Main export for item selection module

const { selectItemsForTradeOffer } = require('./selection_orchestrator');
const itemClassifiers = require('./item_classifiers');

module.exports = {
  selectItemsForTradeOffer,
  itemClassifiers
};