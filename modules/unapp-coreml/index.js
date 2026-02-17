/**
 * un-app v0.3 — CoreML Prediction Bridge
 * 
 * Normalizes raw device signals into model features,
 * calls native CoreML module, returns card_type + confidence.
 * 
 * Falls back to 'nothing' if model isn't loaded or on error.
 * Never throws. Never blocks UI.
 */

import { requireNativeModule } from 'expo-modules-core';

// Will throw if native module not available (pre-EAS build)
let UnAppPredictor;
try {
  UnAppPredictor = requireNativeModule('UnAppPredictor');
} catch (e) {
  console.log('[coreml] Native module not available — using fallback');
  UnAppPredictor = null;
}

// Card types (must match training order)
export const CARD_TYPES = ['cab', 'food', 'stocks', 'cricket', 'calendar', 'nothing'];

// Confidence thresholds by usage phase
const THRESHOLDS = {
  cold:   0.4,  // Week 1-2: show card if > 40% confident
  warm:   0.6,  // Week 3-6: show if > 60%
  hot:    0.7,  // Week 7+: show if > 70%
};

/**
 * Check if CoreML model is loaded and ready
 */
export const isModelReady = async () => {
  if (!UnAppPredictor) return false;
  try {
    return await UnAppPredictor.isModelReady();
  } catch {
    return false;
  }
};

/**
 * Run a prediction with raw (unnormalized) inputs.
 * 
 * @param {Object} raw - Raw device signals
 * @param {number} raw.hour - 0-23
 * @param {number} raw.minute - 0-59
 * @param {number} raw.dayOfWeek - 0-6 (0=Sunday)
 * @param {boolean} raw.isWeekend
 * @param {boolean} raw.isHoliday
 * @param {number} raw.locationCluster - 0=home, 1=work, 2=other
 * @param {number} raw.batteryLevel - 0-100
 * @param {boolean} raw.isCharging
 * @param {boolean} raw.hasEventWithin60min
 * @param {boolean} raw.eventHasLocation
 * @param {number} raw.minsSinceLastCab - 0-1440
 * @param {number} raw.minsSinceLastFood - 0-1440
 * @param {number} raw.minsSinceLastStocks - 0-1440
 * @param {string} phase - 'cold' | 'warm' | 'hot'
 * @returns {Object} { cardType, confidence, shouldShow, allProbs }
 */
export const predict = async (raw, phase = 'cold') => {
  const fallback = { 
    cardType: 'nothing', confidence: 0, shouldShow: false, 
    allProbs: {}, source: 'fallback' 
  };

  if (!UnAppPredictor) return fallback;

  try {
    // Normalize to 0-1 range (must match training normalization)
    const features = [
      (raw.hour || 0) / 23,
      (raw.minute || 0) / 59,
      (raw.dayOfWeek || 0) / 6,
      raw.isWeekend ? 1 : 0,
      raw.isHoliday ? 1 : 0,
      (raw.locationCluster || 0) / 2,
      (raw.batteryLevel || 50) / 100,
      raw.isCharging ? 1 : 0,
      raw.hasEventWithin60min ? 1 : 0,
      raw.eventHasLocation ? 1 : 0,
      Math.min((raw.minsSinceLastCab || 1440), 1440) / 1440,
      Math.min((raw.minsSinceLastFood || 1440), 1440) / 1440,
      Math.min((raw.minsSinceLastStocks || 1440), 1440) / 1440,
    ];

    const result = await UnAppPredictor.predict(features);

    if (result.error) {
      console.log('[coreml] Prediction error:', result.error);
      return fallback;
    }

    const threshold = THRESHOLDS[phase] || THRESHOLDS.cold;

    return {
      cardType: result.card_type,
      confidence: result.confidence,
      shouldShow: result.confidence >= threshold && result.card_type !== 'nothing',
      allProbs: result.all_probs || {},
      source: 'coreml',
    };
  } catch (e) {
    console.log('[coreml] Prediction failed:', e.message);
    return fallback;
  }
};

/**
 * Convenience: get prediction using current device state.
 * Collects hour, minute, day etc. automatically.
 * 
 * @param {Object} context - Additional context from app state
 * @param {number} context.locationCluster - 0/1/2
 * @param {boolean} context.hasEventWithin60min
 * @param {boolean} context.eventHasLocation
 * @param {number} context.minsSinceLastCab
 * @param {number} context.minsSinceLastFood
 * @param {number} context.minsSinceLastStocks
 * @param {string} phase - 'cold' | 'warm' | 'hot'
 */
export const predictNow = async (context = {}, phase = 'cold') => {
  const now = new Date();
  const dow = now.getDay();

  return predict({
    hour: now.getHours(),
    minute: now.getMinutes(),
    dayOfWeek: dow,
    isWeekend: dow === 0 || dow === 6,
    isHoliday: false, // TODO: integrate holiday calendar
    locationCluster: context.locationCluster || 0,
    batteryLevel: context.batteryLevel || 50,
    isCharging: context.isCharging || false,
    hasEventWithin60min: context.hasEventWithin60min || false,
    eventHasLocation: context.eventHasLocation || false,
    minsSinceLastCab: context.minsSinceLastCab || 1440,
    minsSinceLastFood: context.minsSinceLastFood || 1440,
    minsSinceLastStocks: context.minsSinceLastStocks || 1440,
  }, phase);
};
