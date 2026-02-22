// automate_trading/utils/queue_factory.js
const QueueManager = require('./queue_manager');
const RedisQueueManager = require('./redis_queue_manager');

/**
 * Create a queue manager instance based on config
 * Returns RedisQueueManager if config.queues.useRedis is true and httpClient is available,
 * otherwise returns file-based QueueManager
 *
 * @param {string} queueName - Queue name
 * @param {object} config - Config object
 * @param {object} logger - Logger instance
 * @param {object} [httpClient] - HttpClient instance (required for Redis mode)
 * @returns {QueueManager|RedisQueueManager}
 */
function createQueueManager(queueName, config, logger, httpClient) {
  if (config.queues?.useRedis && httpClient) {
    return new RedisQueueManager(queueName, config, logger, httpClient);
  }
  return new QueueManager(queueName, config, logger);
}

module.exports = createQueueManager;