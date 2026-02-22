// automate_trading_workers/utils/ai_client.js
const { Mistral } = require('@mistralai/mistralai');
const { GoogleGenAI } = require('@google/genai');

/**
 * AI Client - Handles communication with multiple AI providers with priority-based fallback
 * Supports Gemini (priority 1) and Mistral (priority 2)
 * Provides error handling, retries, and response parsing
 */
class AIClient {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;

    // Validate that we have at least one provider configured
    if (!config.ai.providers || config.ai.providers.length === 0) {
      throw new Error('No AI providers configured');
    }

    // Initialize provider clients
    this.providers = [];

    for (const providerConfig of config.ai.providers) {
      if (!providerConfig.apiKey) {
        this.logger.warn(`AIClient: ${providerConfig.name} API key not configured, skipping`);
        continue;
      }

      try {
        const provider = this.initializeProvider(providerConfig);
        this.providers.push(provider);
        this.logger.info(`AIClient: Initialized ${providerConfig.name} provider - Model: ${providerConfig.model}`);
      } catch (error) {
        this.logger.error(`AIClient: Failed to initialize ${providerConfig.name}: ${error.message}`);
      }
    }

    if (this.providers.length === 0) {
      throw new Error('No AI providers could be initialized (check API keys)');
    }

    this.logger.info(`AIClient: Initialized with ${this.providers.length} provider(s) in priority order: ${this.providers.map(p => p.config.name).join(' → ')}`);
  }

  /**
   * Initialize a provider based on its configuration
   */
  initializeProvider(providerConfig) {
    let client = null;

    switch (providerConfig.name) {
      case 'gemini':
        // GoogleGenAI automatically detects GEMINI_API_KEY from environment
        // But we can pass it explicitly if needed
        client = new GoogleGenAI({
          apiKey: providerConfig.apiKey
        });
        break;

      case 'mistral':
        client = new Mistral({ apiKey: providerConfig.apiKey });
        break;

      default:
        throw new Error(`Unknown AI provider: ${providerConfig.name}`);
    }

    return {
      config: providerConfig,
      client: client
    };
  }

  /**
   * Call AI providers with priority-based fallback
   * Tries each provider in order until one succeeds
   * @param {string} prompt - The prompt to send to AI
   * @param {Object} options - Optional parameters to override defaults
   * @returns {Promise<Object>} Response object with content and metadata
   */
  async chat(prompt, options = {}) {
    const errors = [];

    // Try each provider in priority order
    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      const isLastProvider = i === this.providers.length - 1;

      this.logger.info(`AIClient: Trying provider ${i + 1}/${this.providers.length}: ${provider.config.name}`);

      try {
        const result = await this.chatWithProvider(provider, prompt, options);

        if (result.success) {
          // Success! Log which provider was used
          if (i > 0) {
            this.logger.info(`AIClient: ✅ Succeeded with fallback provider: ${provider.config.name} (after ${i} failed attempt(s))`);
          }
          return result;
        }

        // Provider failed, add to errors
        errors.push({
          provider: provider.config.name,
          error: result.error,
          errorCode: result.errorCode
        });

        this.logger.warn(`AIClient: Provider ${provider.config.name} failed: ${result.error}`);

        // If this is not the last provider, try the next one
        if (!isLastProvider) {
          this.logger.info(`AIClient: Moving to next provider...`);
        }

      } catch (error) {
        // Unexpected error during provider call
        errors.push({
          provider: provider.config.name,
          error: error.message,
          errorCode: 'UNEXPECTED_ERROR'
        });

        this.logger.error(`AIClient: Unexpected error with ${provider.config.name}: ${error.message}`);

        if (!isLastProvider) {
          this.logger.info(`AIClient: Moving to next provider...`);
        }
      }
    }

    // All providers failed
    this.logger.error(`AIClient: ❌ All ${this.providers.length} provider(s) failed`);

    return {
      success: false,
      error: `All AI providers failed`,
      errors: errors
    };
  }

  /**
   * Call a specific provider with retries
   */
  async chatWithProvider(provider, prompt, options = {}) {
    const providerConfig = provider.config;
    const maxRetries = options.maxRetries || providerConfig.maxRetries;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.logger.info(`AIClient: Calling ${providerConfig.name} API (attempt ${attempt}/${maxRetries})...`);

        const startTime = Date.now();
        let result;

        // Call the appropriate provider method
        switch (providerConfig.name) {
          case 'gemini':
            result = await this.callGemini(provider, prompt, options);
            break;

          case 'mistral':
            result = await this.callMistral(provider, prompt, options);
            break;

          default:
            throw new Error(`Unknown provider: ${providerConfig.name}`);
        }

        const elapsed = Date.now() - startTime;

        this.logger.info(`AIClient: ✅ ${providerConfig.name} API call successful (${elapsed}ms, ${result.content.length} chars)`);

        return {
          success: true,
          content: result.content,
          provider: providerConfig.name,
          model: result.model,
          finishReason: result.finishReason,
          usage: result.usage,
          elapsed: elapsed
        };

      } catch (error) {
        lastError = error;

        this.logger.error(`AIClient: ❌ ${providerConfig.name} API call failed (attempt ${attempt}/${maxRetries}): ${error.message}`);

        // Check if we should retry
        if (this.isNonRetryableError(error)) {
          this.logger.error(`AIClient: Non-retryable error detected for ${providerConfig.name}, stopping retries`);
          break;
        }

        // Wait before retry (except on last attempt)
        if (attempt < maxRetries) {
          const delay = providerConfig.retryDelayMs * attempt; // Exponential backoff
          this.logger.info(`AIClient: Retrying in ${delay}ms...`);
          await this.sleep(delay);
        }
      }
    }

    // All retries exhausted for this provider
    this.logger.error(`AIClient: All ${maxRetries} retry attempts failed for ${providerConfig.name}`);

    return {
      success: false,
      error: lastError.message,
      errorCode: lastError.code,
      errorType: lastError.type
    };
  }

  /**
   * Call Gemini API
   */
  async callGemini(provider, prompt, options = {}) {
    const config = provider.config;
    const model = options.model || config.model;
    const maxTokens = options.maxTokens || config.maxTokens;
    const temperature = options.temperature || config.temperature;

    // Gemini 2.5 Flash uses internal "thoughts" that consume tokens
    // Add significant buffer to maxTokens to account for this
    // Thoughts can consume 100-1000+ tokens depending on complexity
    // For complex prompts (like translations), thoughts can use 3-4x the actual output
    const adjustedMaxTokens = Math.max(1000, maxTokens * 4); // Minimum 1000 tokens, 4x the requested amount

    // Call Gemini API using the new SDK
    const response = await provider.client.models.generateContent({
      model: model,
      contents: prompt,
      config: {
        temperature: temperature,
        maxOutputTokens: adjustedMaxTokens,
        stopSequences: [] // Ensure no stop sequences interfere
      }
    });

    // Extract content from response
    let content = null;

    // Try to extract from candidates (most common location)
    if (response.candidates && Array.isArray(response.candidates) && response.candidates.length > 0) {
      const candidate = response.candidates[0];

      // Check if content.parts exists and has text
      if (candidate.content?.parts && Array.isArray(candidate.content.parts) && candidate.content.parts.length > 0) {
        // Concatenate all text parts (there might be multiple)
        content = candidate.content.parts
          .filter(part => part.text)
          .map(part => part.text)
          .join('');
      }
    }

    // Fallback: try other possible locations
    if (!content) {
      content = response.text?.text || response.text || response.content;
    }

    if (!content) {
      // Log detailed error for debugging
      const finishReason = response.candidates?.[0]?.finishReason;
      this.logger.error(`Gemini API returned no content. FinishReason: ${finishReason}`);
      this.logger.error(`Response structure: ${JSON.stringify(response, null, 2)}`);
      throw new Error(`No content in Gemini API response (finishReason: ${finishReason})`);
    }

    return {
      content: content,
      model: model,
      finishReason: response.candidates?.[0]?.finishReason || 'STOP',
      usage: {
        promptTokens: response.usageMetadata?.promptTokenCount || 0,
        completionTokens: (response.usageMetadata?.totalTokenCount || 0) - (response.usageMetadata?.promptTokenCount || 0),
        totalTokens: response.usageMetadata?.totalTokenCount || 0
      }
    };
  }

  /**
   * Call Mistral API
   */
  async callMistral(provider, prompt, options = {}) {
    const config = provider.config;
    const model = options.model || config.model;
    const maxTokens = options.maxTokens || config.maxTokens;
    const temperature = options.temperature || config.temperature;

    // Call Mistral chat completion API
    const response = await provider.client.chat.complete({
      model: model,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      maxTokens: maxTokens,
      temperature: temperature
    });

    // Extract response content
    const content = response.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('No content in Mistral API response');
    }

    return {
      content: content,
      model: model,
      finishReason: response.choices?.[0]?.finishReason,
      usage: {
        promptTokens: response.usage?.promptTokens || 0,
        completionTokens: response.usage?.completionTokens || 0,
        totalTokens: response.usage?.totalTokens || 0
      }
    };
  }

  /**
   * Check if error should not be retried
   */
  isNonRetryableError(error) {
    // Authentication errors
    if (error.message?.includes('API key') || error.message?.includes('authentication')) {
      return true;
    }

    // Invalid request errors (won't be fixed by retry)
    if (error.message?.includes('Invalid') || error.message?.includes('invalid')) {
      return true;
    }

    // HTTP 400, 401, 403, 404 - don't retry
    if (error.status && [400, 401, 403, 404].includes(error.status)) {
      return true;
    }

    // HTTP 429 (Rate Limit / Throttling) - don't retry with short intervals
    // Best practice for rate limiting is to back off immediately, not retry quickly
    if (error.status === 429) {
      this.logger.warn('AIClient: Rate limit (429) detected - backing off immediately');
      return true;
    }

    // Check for throttling errors in message body
    if (error.message?.includes('capacity exceeded') ||
        error.message?.includes('rate limit') ||
        error.message?.includes('quota') ||
        error.message?.includes('too many requests')) {
      this.logger.warn('AIClient: Throttling error detected - backing off immediately');
      return true;
    }

    return false;
  }

  /**
   * Parse AI response to extract structured data (for translations)
   * @param {string} content - Raw AI response content
   * @returns {Array<string>} Array of messages
   */
  parseTranslationResponse(content) {
    try {
      // Remove markdown code blocks if present
      let cleanedContent = content.trim();

      // Remove ```json and ``` markers
      cleanedContent = cleanedContent.replace(/^```json\s*/i, '');
      cleanedContent = cleanedContent.replace(/^```\s*/, '');
      cleanedContent = cleanedContent.replace(/\s*```$/,'');
      cleanedContent = cleanedContent.trim();

      // Try to parse as JSON first (preferred format)
      const parsed = JSON.parse(cleanedContent);

      if (Array.isArray(parsed)) {
        return parsed.filter(msg => typeof msg === 'string' && msg.length > 0);
      }

      if (parsed.messages && Array.isArray(parsed.messages)) {
        return parsed.messages.filter(msg => typeof msg === 'string' && msg.length > 0);
      }

      // If it's an object with numbered keys
      if (typeof parsed === 'object') {
        const messages = Object.values(parsed).filter(v => typeof v === 'string' && v.length > 0);
        if (messages.length > 0) {
          return messages;
        }
      }

    } catch (error) {
      // Not JSON, try to parse as text
      this.logger.warn(`AIClient: Failed to parse JSON response: ${error.message}, falling back to text parsing`);
    }

    // Fallback: Split by newlines and filter empty lines
    const lines = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => {
        // Remove empty lines, numbering, bullets, code block markers
        if (!line) return false;
        if (/^```/.test(line)) return false; // Remove code block markers
        if (/^[\d\.\-\*\s]+$/.test(line)) return false; // Only numbers/bullets

        // Remove common prefixes
        line = line.replace(/^[\d\.\)\]\-\*\s]+/, '').trim();

        return line.length > 0;
      })
      .map(line => {
        // Clean up common prefixes
        return line
          .replace(/^[\d\.\)\]\-\*\s]+/, '')
          .replace(/^["']/, '')
          .replace(/["']$/, '')
          .trim();
      });

    return lines;
  }

  /**
   * Sleep utility for retries
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Test connection to all AI providers
   */
  async testConnection() {
    this.logger.info('AIClient: Testing connection to all AI providers...');

    let successCount = 0;
    const results = [];

    for (const provider of this.providers) {
      try {
        this.logger.info(`AIClient: Testing ${provider.config.name}...`);

        const result = await this.chatWithProvider(provider, 'Say "OK" if you can read this.', {
          maxTokens: 10,
          maxRetries: 1
        });

        if (result.success) {
          this.logger.info(`AIClient: ✅ ${provider.config.name} connection test successful`);
          successCount++;
          results.push({ provider: provider.config.name, success: true });
        } else {
          this.logger.error(`AIClient: ❌ ${provider.config.name} connection test failed: ${result.error}`);
          results.push({ provider: provider.config.name, success: false, error: result.error });
        }

      } catch (error) {
        this.logger.error(`AIClient: ❌ ${provider.config.name} connection test error: ${error.message}`);
        results.push({ provider: provider.config.name, success: false, error: error.message });
      }
    }

    this.logger.info(`AIClient: Connection test complete: ${successCount}/${this.providers.length} provider(s) working`);

    return {
      success: successCount > 0,
      workingProviders: successCount,
      totalProviders: this.providers.length,
      results: results
    };
  }
}

module.exports = AIClient;
