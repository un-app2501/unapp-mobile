import { requireNativeModule } from 'expo-modules-core';

const UnAppCoreML = requireNativeModule('UnAppCoreML');

/**
 * Predict user's next action using on-device CoreML model.
 * @param {number[]} features - Array of 13 feature values
 * @returns {Promise<{prediction: string, confidence: number, all_scores: Object}>}
 */
export async function predict(features) {
  return await UnAppCoreML.predict(features);
}

/**
 * Build feature vector from current time context and pattern counts.
 * @param {Object} patternCounts - { stocks: 5, food: 3, cab: 2, calendar: 1, cricket: 4 }
 * @returns {Promise<number[]>} Array of 13 features
 */
export async function buildFeatures(patternCounts) {
  return await UnAppCoreML.buildFeatures(patternCounts);
}

/**
 * Check if the CoreML model is loaded.
 * @returns {boolean}
 */
export function isModelLoaded() {
  return UnAppCoreML.isModelLoaded();
}

/**
 * Get model metadata.
 * @returns {Object} { loaded, version, description, input_features, output_classes }
 */
export function getModelInfo() {
  return UnAppCoreML.getModelInfo();
}

/**
 * Write data to iOS widget via App Groups shared UserDefaults.
 * @param {Object} widgetData - { prediction, confidence, greeting, cards, lastUpdated }
 * @returns {Promise<boolean>} success
 */
export async function updateWidgetData(widgetData) {
  const jsonString = JSON.stringify(widgetData);
  return await UnAppCoreML.updateWidgetData(jsonString);
}

export default UnAppCoreML;
