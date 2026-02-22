/**
 * Player Name Language Detector
 *
 * Detects language from Steam player names using Unicode character analysis.
 * No AI required - uses deterministic character range and pattern matching.
 *
 * Usage:
 *   const { detectLanguageFromName } = require('./utils/player_name_language_detector');
 *   const result = detectLanguageFromName('Дмитрий');
 *   // { language: 'Russian', confidence: 0.9, method: 'script' }
 *
 * Integration with LanguageWorker:
 *   - Use as a fallback when GetPlayerSummaries doesn't return country data
 *   - Use as primary source when friend's profile is private
 *   - Combine with message-based detection for higher accuracy
 */

// Unicode ranges for different scripts
const SCRIPT_RANGES = {
  cyrillic: [[0x0400, 0x04FF], [0x0500, 0x052F]],
  cjk: [[0x4E00, 0x9FFF], [0x3400, 0x4DBF], [0x20000, 0x2A6DF], [0xF900, 0xFAFF]],
  hiragana: [[0x3040, 0x309F]],
  katakana: [[0x30A0, 0x30FF], [0x31F0, 0x31FF]],
  hangul: [[0xAC00, 0xD7AF], [0x1100, 0x11FF], [0x3130, 0x318F]],
  arabic: [[0x0600, 0x06FF], [0x0750, 0x077F], [0xFB50, 0xFDFF], [0xFE70, 0xFEFF]],
  hebrew: [[0x0590, 0x05FF]],
  thai: [[0x0E00, 0x0E7F]],
  greek: [[0x0370, 0x03FF], [0x1F00, 0x1FFF]],
  devanagari: [[0x0900, 0x097F]],
  tamil: [[0x0B80, 0x0BFF]],
  bengali: [[0x0980, 0x09FF]],
};

// Map scripts to languages
const SCRIPT_TO_LANGUAGE = {
  cyrillic: 'Russian',
  cjk: 'Chinese',
  hiragana: 'Japanese',
  katakana: 'Japanese',
  hangul: 'Korean',
  arabic: 'Arabic',
  hebrew: 'Hebrew',
  thai: 'Thai',
  greek: 'Greek',
  devanagari: 'Hindi',
  tamil: 'Tamil',
  bengali: 'Bengali',
};

// Unique characters that definitively indicate a specific language
const UNIQUE_CHARS = {
  German: ['ß'],
  Spanish: ['ñ', 'Ñ', '¿', '¡'],
  Polish: ['ł', 'Ł', 'ą', 'Ą', 'ę', 'Ę', 'ź', 'Ź', 'ż', 'Ż'],
  Turkish: ['ğ', 'Ğ', 'ı', 'İ', 'ş', 'Ş'],
  Czech: ['ř', 'Ř', 'ů', 'Ů', 'ě', 'Ě'],
  Swedish: ['ø', 'Ø', 'å', 'Å', 'æ', 'Æ'],  // Also Norwegian/Danish
  Vietnamese: ['ă', 'Ă', 'đ', 'Đ', 'ơ', 'Ơ', 'ư', 'Ư',
               'ạ', 'ả', 'ặ', 'ẳ', 'ẵ', 'ắ', 'ằ', 'ậ', 'ẩ', 'ẫ', 'ấ', 'ầ',
               'ẹ', 'ẻ', 'ế', 'ề', 'ệ', 'ể', 'ễ', 'ị', 'ỉ', 'ĩ',
               'ọ', 'ỏ', 'ố', 'ồ', 'ộ', 'ổ', 'ỗ', 'ớ', 'ờ', 'ợ', 'ở', 'ỡ',
               'ụ', 'ủ', 'ứ', 'ừ', 'ự', 'ử', 'ữ', 'ỳ', 'ỵ', 'ỷ', 'ỹ'],
  Hungarian: ['ő', 'Ő', 'ű', 'Ű'],
  Romanian: ['ș', 'Ș', 'ț', 'Ț'],
  Portuguese: ['õ', 'Õ'],
};

// General special characters (less specific, used as fallback)
const SPECIAL_CHARS = {
  German: ['ä', 'ö', 'ü', 'Ä', 'Ö', 'Ü'],
  French: ['é', 'è', 'ê', 'ë', 'à', 'â', 'ù', 'û', 'ô', 'î', 'ï', 'ç', 'œ',
           'É', 'È', 'Ê', 'Ë', 'À', 'Â', 'Ù', 'Û', 'Ô', 'Î', 'Ï', 'Ç', 'Œ'],
  Portuguese: ['ã', 'ç', 'Ã', 'Ç'],
};

/**
 * Check if character code is in any of the given ranges
 */
function isInRanges(charCode, ranges) {
  for (const [start, end] of ranges) {
    if (charCode >= start && charCode <= end) return true;
  }
  return false;
}

/**
 * Analyze which scripts are present in the name
 */
function analyzeScripts(name) {
  const counts = {};
  for (const char of name) {
    const code = char.codePointAt(0);
    for (const [script, ranges] of Object.entries(SCRIPT_RANGES)) {
      if (isInRanges(code, ranges)) {
        counts[script] = (counts[script] || 0) + 1;
      }
    }
  }
  return counts;
}

/**
 * Refine CJK detection to distinguish Chinese/Japanese/Korean
 */
function refineCjkLanguage(scriptCounts) {
  if (scriptCounts.hangul > 0) return 'Korean';
  if (scriptCounts.hiragana > 0 || scriptCounts.katakana > 0) return 'Japanese';
  if (scriptCounts.cjk > 0) return 'Chinese';
  return null;
}

/**
 * Check for unique characters that definitively identify a language
 */
function checkUniqueChars(name) {
  for (const [language, chars] of Object.entries(UNIQUE_CHARS)) {
    for (const char of chars) {
      if (name.includes(char)) {
        return { language, confidence: 0.9, method: 'unique_char', char };
      }
    }
  }
  return null;
}

/**
 * Check for general special characters (lower confidence)
 */
function checkSpecialChars(name) {
  for (const [language, chars] of Object.entries(SPECIAL_CHARS)) {
    for (const char of chars) {
      if (name.includes(char)) {
        return { language, confidence: 0.6, method: 'special_char', char };
      }
    }
  }
  return null;
}

/**
 * Main detection function
 *
 * @param {string} name - The player name to analyze
 * @returns {object} Detection result with language, confidence, and method
 */
function detectLanguageFromName(name) {
  if (!name || name.trim().length === 0) {
    return { language: null, confidence: 0, method: 'none' };
  }

  // Priority 1: Script-based detection (Cyrillic, CJK, Arabic, etc.)
  const scriptCounts = analyzeScripts(name);

  // Check CJK family first (needs refinement)
  const cjkLanguage = refineCjkLanguage(scriptCounts);
  if (cjkLanguage) {
    return { language: cjkLanguage, confidence: 0.95, method: 'script' };
  }

  // Check other scripts
  if (scriptCounts.cyrillic > 0) {
    return { language: 'Russian', confidence: 0.9, method: 'script' };
  }

  for (const [script, count] of Object.entries(scriptCounts)) {
    if (count > 0 && SCRIPT_TO_LANGUAGE[script]) {
      return {
        language: SCRIPT_TO_LANGUAGE[script],
        confidence: 0.85,
        method: 'script'
      };
    }
  }

  // Priority 2: Unique character detection (high confidence)
  const uniqueResult = checkUniqueChars(name);
  if (uniqueResult) {
    return uniqueResult;
  }

  // Priority 3: General special character detection (lower confidence)
  const specialResult = checkSpecialChars(name);
  if (specialResult) {
    return specialResult;
  }

  // No language detected
  return { language: null, confidence: 0, method: 'none' };
}

/**
 * Check if the detected language is non-English
 * Useful for deciding whether to use detected language or fall back
 */
function isNonEnglishDetected(result) {
  return result.language !== null && result.confidence >= 0.6;
}

/**
 * Get language detection stats for a list of names
 */
function analyzeNames(names) {
  const stats = {
    total: names.length,
    detected: 0,
    byLanguage: {},
    byMethod: {}
  };

  for (const name of names) {
    const result = detectLanguageFromName(name);
    if (result.language) {
      stats.detected++;
      stats.byLanguage[result.language] = (stats.byLanguage[result.language] || 0) + 1;
      stats.byMethod[result.method] = (stats.byMethod[result.method] || 0) + 1;
    }
  }

  stats.detectionRate = stats.detected / stats.total;
  return stats;
}

module.exports = {
  detectLanguageFromName,
  isNonEnglishDetected,
  analyzeNames,
  // Export internals for testing
  SCRIPT_RANGES,
  UNIQUE_CHARS,
  SPECIAL_CHARS
};
