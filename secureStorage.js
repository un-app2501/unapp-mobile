/**
 * un-app v0.3 — Encrypted Storage Migration
 * 
 * Migrates sensitive keys from AsyncStorage to expo-secure-store (iOS Keychain).
 * Large behavioral data (patterns, history) stays in AsyncStorage — no PII there.
 * 
 * Runs ONCE on first app launch after update. Silent. No UI change.
 * 
 * ZERO changes to how the rest of the app reads/writes data.
 * After migration, use this module's get/set instead of AsyncStorage directly
 * for the migrated keys.
 */

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Keys that move to SecureStore (small, sensitive-ish) ────────────────────
const SECURE_KEYS = [
  'device_id',                    // Anonymous session ID
  'unapp_privacy_ack',            // Privacy notice acknowledged
  'unapp_connected_services',     // Which services connected (JSON, small)
  'unapp_opens',                  // App open count
  'unapp_prediction_accuracy',    // Correct/total counts
  'unapp_taps_saved',             // Taps saved counter
  'unapp_confidence_phase',       // CoreML threshold phase (future)
];

// ─── Keys that stay in AsyncStorage (large, no PII) ─────────────────────────
// These are explicitly NOT migrated — they contain behavioral counts and
// timestamps only, no personal data. Too large for SecureStore's 2KB limit.
//
// unapp_patterns            — frequency maps per category
// unapp_history             — last 50 queries with timestamps
// unapp_captured_intents    — unmatched queries (up to 200)
// unapp_cricket_check_log   — cricket check timestamps
// unapp_calendar_pattern    — temporal metadata
// unapp_last_stock_check    — last stock prices for delta
// unapp_weekly_insight      — generated insight text

const MIGRATION_FLAG = 'unapp_secure_migration_v1';

// ─── Run migration (call once at app startup) ────────────────────────────────

/**
 * Migrates sensitive keys from AsyncStorage to SecureStore.
 * Safe to call multiple times — skips if already migrated.
 * Never throws. Never blocks UI.
 * 
 * @returns {Promise<{migrated: boolean, keysCount: number}>}
 */
export const runSecureMigration = async () => {
  try {
    // Check if already migrated
    const alreadyDone = await SecureStore.getItemAsync(MIGRATION_FLAG);
    if (alreadyDone === 'true') {
      return { migrated: false, keysCount: 0 };
    }

    let migratedCount = 0;

    for (const key of SECURE_KEYS) {
      try {
        // Read from AsyncStorage
        const value = await AsyncStorage.getItem(key);
        
        if (value !== null) {
          // Check size — SecureStore limit is 2048 bytes
          if (value.length <= 2048) {
            // Write to SecureStore
            await SecureStore.setItemAsync(key, value);
            
            // Verify it's readable
            const verify = await SecureStore.getItemAsync(key);
            if (verify === value) {
              // Remove from AsyncStorage (now in Keychain)
              await AsyncStorage.removeItem(key);
              migratedCount++;
            }
          }
          // If too large, silently skip — stays in AsyncStorage
        }
      } catch (e) {
        // Skip this key, continue with others
        console.log(`[secure-migration] Skipped ${key}:`, e.message);
      }
    }

    // Mark migration complete
    await SecureStore.setItemAsync(MIGRATION_FLAG, 'true');
    
    console.log(`[secure-migration] Done. Migrated ${migratedCount} keys.`);
    return { migrated: true, keysCount: migratedCount };

  } catch (e) {
    console.log('[secure-migration] Migration failed:', e.message);
    return { migrated: false, keysCount: 0 };
  }
};

// ─── Unified get/set that checks SecureStore first ───────────────────────────

/**
 * Get a value — checks SecureStore first (for migrated keys), 
 * falls back to AsyncStorage.
 * Drop-in replacement for AsyncStorage.getItem() for secure keys.
 */
export const secureGet = async (key) => {
  try {
    // If it's a key we migrate, check SecureStore first
    if (SECURE_KEYS.includes(key)) {
      const secureValue = await SecureStore.getItemAsync(key);
      if (secureValue !== null) return secureValue;
    }
    // Fall back to AsyncStorage (pre-migration or large keys)
    return await AsyncStorage.getItem(key);
  } catch (e) {
    // If SecureStore fails, fall back to AsyncStorage
    try {
      return await AsyncStorage.getItem(key);
    } catch {
      return null;
    }
  }
};

/**
 * Set a value — writes to SecureStore for migrated keys,
 * AsyncStorage for everything else.
 * Drop-in replacement for AsyncStorage.setItem() for secure keys.
 */
export const secureSet = async (key, value) => {
  try {
    if (SECURE_KEYS.includes(key) && value.length <= 2048) {
      await SecureStore.setItemAsync(key, value);
    } else {
      await AsyncStorage.setItem(key, value);
    }
  } catch (e) {
    // Fall back to AsyncStorage if SecureStore fails
    try {
      await AsyncStorage.setItem(key, value);
    } catch {
      console.log(`[secure-storage] Failed to write ${key}`);
    }
  }
};

/**
 * Delete a value — removes from both stores to be safe.
 */
export const secureDelete = async (key) => {
  try {
    if (SECURE_KEYS.includes(key)) {
      await SecureStore.deleteItemAsync(key);
    }
    await AsyncStorage.removeItem(key);
  } catch (e) {
    console.log(`[secure-storage] Failed to delete ${key}`);
  }
};
