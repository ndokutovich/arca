/**
 * System-noise filter.
 *
 * Identifies "user messages" that are actually system-injected:
 * task notifications, hook feedback, skill activation banners, etc.
 * These pollute search results and operator-profile statistics.
 *
 * Empirically calibrated against a 5968-turn vault — ~12% of
 * "user" messages turned out to be system-injected (709 of 5968).
 */

const SYSTEM_NOISE_PATTERNS = [
  /^<\w[^>]*>/,                              // <task-notification>, <command-name>, etc
  /^stop hook feedback/i,
  /^tool loaded\.?$/i,
  /^warmup_step:/i,
  /^base directory for this skill:/i,
  /^●\s+ran\s+\d+\s+stop hooks/i,
  /^\[image:\s+source:/i,                    // image-cache injection markers
  /^arguments:/i,
  /^session-?start/i,
  /^\[hook\]/i,
  /^\[SYSTEM NOTIFICATION/i,                 // background task event banners
];

/**
 * Returns true if the message text is system-injected, not user-authored.
 * Inspects only the first non-empty line.
 *
 * @param {string} text - the user message text
 * @returns {boolean}
 */
export function isSystemNoise(text) {
  if (!text || typeof text !== 'string') return false;
  const head = text.trim().split('\n', 1)[0];
  if (!head) return false;
  return SYSTEM_NOISE_PATTERNS.some(re => re.test(head));
}
