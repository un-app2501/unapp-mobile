/**
 * un-app v0.3 — CoreML Card Predictor
 * 
 * Wraps the CoreML module with app-specific logic:
 * - Collects current time/day/usage context
 * - Calls CoreML prediction
 * - Falls back to existing heuristic cards if model unavailable
 * - Respects confidence thresholds by usage phase
 * 
 * Drop this file next to App.js. Import and call getCoreMLPrediction().
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// Try to load native module — won't exist in Expo Go
let predictNow, isModelReady;
try {
  const coreml = require('./modules/unapp-coreml');
  predictNow = coreml.predictNow;
  isModelReady = coreml.isModelReady;
} catch (e) {
  console.log('[un-app] CoreML module not available (Expo Go)');
  predictNow = null;
  isModelReady = null;
}

/**
 * Get minutes since last tap of a given category.
 * Reads from pattern data in AsyncStorage.
 */
const getMinsSinceLastTap = async (category) => {
  try {
    const patternsRaw = await AsyncStorage.getItem('unapp_patterns');
    if (!patternsRaw) return 1440; // 24 hours = no recent tap
    
    const patterns = JSON.parse(patternsRaw);
    // Find pattern matching this category
    const match = patterns.find(p => p.type === category);
    if (!match || !match.lastQueried) return 1440;
    
    const minsAgo = (Date.now() - new Date(match.lastQueried).getTime()) / 60000;
    return Math.min(Math.round(minsAgo), 1440);
  } catch {
    return 1440;
  }
};

/**
 * Determine usage phase based on app open count.
 * cold = weeks 1-2 (< 14 opens)
 * warm = weeks 3-6 (14-42 opens) 
 * hot  = week 7+ (> 42 opens)
 */
const getUsagePhase = async () => {
  try {
    const opens = await AsyncStorage.getItem('unapp_opens');
    const count = parseInt(opens || '0', 10);
    if (count > 42) return 'hot';
    if (count > 14) return 'warm';
    return 'cold';
  } catch {
    return 'cold';
  }
};

/**
 * Main prediction function. Call this when the app opens
 * or when deciding which card to show.
 * 
 * @returns {Object} { cardType, confidence, shouldShow, source }
 *   cardType: 'cab' | 'food' | 'stocks' | 'cricket' | 'calendar' | 'nothing'
 *   confidence: 0.0 - 1.0
 *   shouldShow: boolean (respects threshold for current phase)
 *   source: 'coreml' | 'fallback'
 */
export const getCoreMLPrediction = async () => {
  // If CoreML not available, return fallback
  if (!predictNow || !isModelReady) {
    return { cardType: 'nothing', confidence: 0, shouldShow: false, source: 'fallback' };
  }

  try {
    const ready = await isModelReady();
    if (!ready) {
      return { cardType: 'nothing', confidence: 0, shouldShow: false, source: 'fallback' };
    }

    const phase = await getUsagePhase();

    // Collect context
    const [minsCab, minsFood, minsStocks] = await Promise.all([
      getMinsSinceLastTap('cab'),
      getMinsSinceLastTap('food'),
      getMinsSinceLastTap('stocks'),
    ]);

    const result = await predictNow({
      locationCluster: 0,          // TODO: wire to CoreLocation when available
      batteryLevel: 50,            // TODO: wire to Battery API
      isCharging: false,           // TODO: wire to Battery API
      hasEventWithin60min: false,  // TODO: wire to EventKit check
      eventHasLocation: false,     // TODO: wire to EventKit check
      minsSinceLastCab: minsCab,
      minsSinceLastFood: minsFood,
      minsSinceLastStocks: minsStocks,
    }, phase);

    console.log(`[un-app] CoreML prediction: ${result.cardType} (${(result.confidence * 100).toFixed(1)}%) phase=${phase} source=${result.source}`);

    return result;
  } catch (e) {
    console.log('[un-app] CoreML prediction error:', e.message);
    return { cardType: 'nothing', confidence: 0, shouldShow: false, source: 'fallback' };
  }
};
