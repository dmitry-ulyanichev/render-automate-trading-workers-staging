// automate_trading_workers/utils/message_language_detector.js

const { francAll } = require('franc');

/**
 * Message Language Detector
 * Analyzes conversation messages to detect the language being used
 *
 * Uses the franc library for text-based language detection
 * Applies different weights for incoming vs outgoing messages
 */

// Map ISO 639-3 codes to our language names
const ISO_TO_LANGUAGE = {
  // Major European languages
  'eng': 'English',
  'deu': 'German',
  'fra': 'French',
  'spa': 'Spanish',
  'ita': 'Italian',
  'por': 'Portuguese',
  'nld': 'Dutch',
  'pol': 'Polish',
  'ces': 'Czech',
  'slk': 'Slovak',
  'hun': 'Hungarian',
  'ron': 'Romanian',
  'bul': 'Bulgarian',
  'ell': 'Greek',
  'hrv': 'Croatian',
  'slv': 'Slovenian',
  'srp': 'Serbian',
  'bos': 'Bosnian',
  'mkd': 'Macedonian',
  'sqi': 'Albanian',
  'lit': 'Lithuanian',
  'lav': 'Latvian',
  'est': 'Estonian',
  'fin': 'Finnish',
  'swe': 'Swedish',
  'nor': 'Norwegian',
  'nno': 'Norwegian',  // Nynorsk
  'nob': 'Norwegian',  // Bokmål
  'dan': 'Danish',
  'isl': 'Icelandic',

  // Slavic/Cyrillic
  'rus': 'Russian',
  'ukr': 'Ukrainian',
  'bel': 'Belarusian',

  // Asian languages
  'zho': 'Chinese',
  'cmn': 'Chinese',  // Mandarin
  'jpn': 'Japanese',
  'kor': 'Korean',
  'tha': 'Thai',
  'vie': 'Vietnamese',
  'ind': 'Indonesian',
  'msa': 'Malay',
  'fil': 'Filipino',
  'tgl': 'Filipino',  // Tagalog
  'hin': 'Hindi',

  // Middle Eastern
  'tur': 'Turkish',
  'ara': 'Arabic',
  'fas': 'Persian',
  'heb': 'Hebrew',

  // Other
  'kaz': 'Kazakh',
  'cat': 'Catalan',
  'glg': 'Galician',
  'eus': 'Basque',
};

// Configuration
const CONFIG = {
  MIN_MESSAGE_LENGTH: 10,           // Minimum characters for analysis
  INCOMING_WEIGHT: 1.0,             // Weight for incoming messages (direct evidence)
  OUTGOING_WEIGHT: 0.5,             // Weight for outgoing messages (operator's inference)
  HIGH_CONFIDENCE_THRESHOLD: 0.9,   // Score >= this is high confidence
  MEDIUM_CONFIDENCE_THRESHOLD: 0.7, // Score >= this is medium confidence
  LOW_CONFIDENCE_THRESHOLD: 0.5,    // Score >= this is low confidence
  HIGH_CONFIDENCE_SCORE: 3,         // Points for high confidence detection
  MEDIUM_CONFIDENCE_SCORE: 2,       // Points for medium confidence detection
  LOW_CONFIDENCE_SCORE: 1,          // Points for low confidence detection
  LENGTH_BONUS_PER_50_CHARS: 0.2,   // Bonus per 50 characters
  MAX_LENGTH_BONUS: 1.0,            // Maximum length bonus
};

/**
 * Clean message text for analysis
 * Removes URLs, Steam trade offer tags, emojis, etc.
 * @param {string} text - Raw message text
 * @returns {string} Cleaned text
 */
function cleanMessageText(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }

  let cleaned = text;

  // Remove Steam trade offer tags [tradeoffer ...][/tradeoffer]
  cleaned = cleaned.replace(/\[tradeoffer[^\]]*\]\[\/tradeoffer\]/gi, '');

  // Remove URLs
  cleaned = cleaned.replace(/https?:\/\/[^\s]+/gi, '');

  // Remove Steam profile links
  cleaned = cleaned.replace(/steamcommunity\.com[^\s]*/gi, '');

  // Remove common gaming abbreviations that don't indicate language
  // (but keep longer words)

  // Remove multiple spaces
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

/**
 * Calculate confidence score based on franc's probability
 * @param {number} probability - Franc's probability (0-1)
 * @returns {Object} { confidence: string, score: number }
 */
function calculateConfidenceScore(probability) {
  if (probability >= CONFIG.HIGH_CONFIDENCE_THRESHOLD) {
    return { confidence: 'high', score: CONFIG.HIGH_CONFIDENCE_SCORE };
  } else if (probability >= CONFIG.MEDIUM_CONFIDENCE_THRESHOLD) {
    return { confidence: 'medium', score: CONFIG.MEDIUM_CONFIDENCE_SCORE };
  } else if (probability >= CONFIG.LOW_CONFIDENCE_THRESHOLD) {
    return { confidence: 'low', score: CONFIG.LOW_CONFIDENCE_SCORE };
  }
  return { confidence: 'very_low', score: 0 };
}

/**
 * Calculate length bonus for a message
 * Longer messages are more reliable
 * @param {number} length - Message length in characters
 * @returns {number} Length bonus (0 to MAX_LENGTH_BONUS)
 */
function calculateLengthBonus(length) {
  const bonus = Math.floor(length / 50) * CONFIG.LENGTH_BONUS_PER_50_CHARS;
  return Math.min(bonus, CONFIG.MAX_LENGTH_BONUS);
}

/**
 * Analyze a single message for language
 * @param {string} text - Message text
 * @returns {Object|null} { language, probability, isoCode } or null if can't detect
 */
function analyzeMessageText(text) {
  const cleaned = cleanMessageText(text);

  if (cleaned.length < CONFIG.MIN_MESSAGE_LENGTH) {
    return null;
  }

  // Get top language candidates
  const results = francAll(cleaned);

  if (!results || results.length === 0) {
    return null;
  }

  const [topIsoCode, topProbability] = results[0];

  // 'und' means undetermined
  if (topIsoCode === 'und') {
    return null;
  }

  const language = ISO_TO_LANGUAGE[topIsoCode];

  if (!language) {
    // Unknown ISO code - skip
    return null;
  }

  return {
    language,
    probability: topProbability,
    isoCode: topIsoCode,
    textLength: cleaned.length
  };
}

/**
 * Analyze all messages and return aggregated language scores
 * @param {Array} messages - Array of message objects { direction, message, timestamp }
 * @returns {Object} { languageScores: Array, analyzedCount: number, details: Array }
 */
function analyzeMessages(messages) {
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return {
      languageScores: [],
      analyzedCount: 0,
      totalMessages: 0,
      details: []
    };
  }

  const languageScores = {};
  const details = [];
  let analyzedCount = 0;

  for (const msg of messages) {
    if (!msg.message) continue;

    const analysis = analyzeMessageText(msg.message);

    if (!analysis) {
      details.push({
        direction: msg.direction,
        text: msg.message.substring(0, 50) + (msg.message.length > 50 ? '...' : ''),
        result: 'skipped',
        reason: msg.message.length < CONFIG.MIN_MESSAGE_LENGTH ? 'too_short' : 'undetectable'
      });
      continue;
    }

    analyzedCount++;

    // Calculate scores
    const directionWeight = msg.direction === 'incoming'
      ? CONFIG.INCOMING_WEIGHT
      : CONFIG.OUTGOING_WEIGHT;

    const { confidence, score: confidenceScore } = calculateConfidenceScore(analysis.probability);
    const lengthBonus = calculateLengthBonus(analysis.textLength);

    // Final score for this message
    const messageScore = (confidenceScore + lengthBonus) * directionWeight;

    // Aggregate scores by language
    if (!languageScores[analysis.language]) {
      languageScores[analysis.language] = {
        language: analysis.language,
        score: 0,
        incomingCount: 0,
        outgoingCount: 0,
        totalMessages: 0
      };
    }

    languageScores[analysis.language].score += messageScore;
    languageScores[analysis.language].totalMessages++;

    if (msg.direction === 'incoming') {
      languageScores[analysis.language].incomingCount++;
    } else {
      languageScores[analysis.language].outgoingCount++;
    }

    details.push({
      direction: msg.direction,
      text: msg.message.substring(0, 50) + (msg.message.length > 50 ? '...' : ''),
      result: 'detected',
      language: analysis.language,
      confidence,
      probability: analysis.probability.toFixed(3),
      messageScore: messageScore.toFixed(2)
    });
  }

  // Convert to sorted array
  const sortedScores = Object.values(languageScores)
    .sort((a, b) => b.score - a.score);

  return {
    languageScores: sortedScores,
    analyzedCount,
    totalMessages: messages.length,
    details
  };
}

/**
 * Get the top detected language with score
 * @param {Array} messages - Array of message objects
 * @returns {Object|null} { language, score, confidence, method } or null
 */
function detectLanguageFromMessages(messages) {
  const result = analyzeMessages(messages);

  if (result.languageScores.length === 0) {
    return {
      language: null,
      score: 0,
      confidence: 0,
      method: 'none',
      analyzedCount: result.analyzedCount,
      totalMessages: result.totalMessages
    };
  }

  const topLanguage = result.languageScores[0];

  // Calculate confidence based on score and message count
  // Higher score and more messages = higher confidence
  const confidence = Math.min(
    (topLanguage.score / 10) + (topLanguage.incomingCount * 0.1),
    1.0
  );

  return {
    language: topLanguage.language,
    score: topLanguage.score,
    confidence,
    method: 'message_analysis',
    analyzedCount: result.analyzedCount,
    totalMessages: result.totalMessages,
    incomingCount: topLanguage.incomingCount,
    outgoingCount: topLanguage.outgoingCount,
    allCandidates: result.languageScores
  };
}

module.exports = {
  analyzeMessages,
  detectLanguageFromMessages,
  analyzeMessageText,
  cleanMessageText,
  CONFIG,
  ISO_TO_LANGUAGE
};
