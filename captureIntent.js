/**
 * un-app v0.3 — Intent Capture Pipeline
 * 
 * Captures every unmatched user query to:
 *   1. Supabase (captured_intents table) — for founder analytics
 *   2. Local AsyncStorage (unapp_captured_intents) — for future CoreML training
 * 
 * Philosophy: Never let user intent die.
 * 
 * ZERO changes to existing analytics_events, patterns, or card logic.
 * This fires on the else branch only.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Uses same Supabase config already in App.js ────────────────────────────
// SUPABASE_URL and SUPABASE_ANON_KEY are imported from your existing constants.
// If you've moved them to a config file, import from there instead.

const SUPABASE_URL = 'https://gklanhnlzxzfbbawomnd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdrbGFuaG5senh6ZmJiYXdvbW5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAwOTc0MjgsImV4cCI6MjA4NTY3MzQyOH0.XgB6Riy3iCrcLWTt9Wi2IF0m6a6yH9NjMgjRdf-x8Hk';

const STORAGE_KEY = 'unapp_captured_intents';
const MAX_LOCAL_INTENTS = 200; // Keep last 200 for CoreML training data

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns time bucket string like "9am-10am"
 */
const getTimeBucket = (date = new Date()) => {
  const hour = date.getHours();
  const formatHour = (h) => {
    if (h === 0) return '12am';
    if (h < 12) return `${h}am`;
    if (h === 12) return '12pm';
    return `${h - 12}pm`;
  };
  return `${formatHour(hour)}-${formatHour((hour + 1) % 24)}`;
};

/**
 * Returns day of week as integer (0=Sunday ... 6=Saturday)
 */
const getDayOfWeek = (date = new Date()) => date.getDay();

/**
 * Gets or creates the anonymous session ID (same one used by existing analytics)
 */
const getSessionId = async () => {
  try {
    let deviceId = await AsyncStorage.getItem('device_id');
    if (!deviceId) {
      deviceId = `ios_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await AsyncStorage.setItem('device_id', deviceId);
    }
    return deviceId;
  } catch {
    return `ios_fallback_${Date.now()}`;
  }
};

// ─── Core capture function ───────────────────────────────────────────────────

/**
 * Captures an unmatched intent. Call this when detectQueryType returns 'general'
 * or when a query can't be fulfilled by any existing card.
 * 
 * @param {string} rawQuery - The user's original input text
 * @param {string} locationCluster - 'home' | 'work' | 'other' | 'unknown'
 * @returns {Promise<void>} - Silent. Never throws. Never blocks UI.
 */
export const captureIntent = async (rawQuery, locationCluster = 'unknown') => {
  if (!rawQuery || rawQuery.trim().length === 0) return;

  const now = new Date();
  const intentRecord = {
    raw_query: rawQuery.trim().substring(0, 500), // Cap at 500 chars
    time_bucket: getTimeBucket(now),
    day_of_week: getDayOfWeek(now),
    location_cluster: locationCluster,
    captured_at: now.toISOString(), // Local copy has ISO timestamp
  };

  // Fire both writes in parallel. Neither blocks the other.
  await Promise.allSettled([
    writeToSupabase(intentRecord),
    writeToLocal(intentRecord),
  ]);
};

// ─── Supabase write ──────────────────────────────────────────────────────────

const writeToSupabase = async (record) => {
  try {
    const sessionId = await getSessionId();
    
    await fetch(`${SUPABASE_URL}/rest/v1/captured_intents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Prefer': 'return=minimal', // Don't return the inserted row
      },
      body: JSON.stringify({
        anon_session_id: sessionId,
        raw_query: record.raw_query,
        time_bucket: record.time_bucket,
        day_of_week: record.day_of_week,
        location_cluster: record.location_cluster,
      }),
    });
  } catch (e) {
    // Silent fail. Analytics should never break the app.
    console.log('[intent-capture] Supabase write failed:', e.message);
  }
};

// ─── Local storage write (for future CoreML training) ────────────────────────

const writeToLocal = async (record) => {
  try {
    const existing = await AsyncStorage.getItem(STORAGE_KEY);
    const intents = existing ? JSON.parse(existing) : [];
    
    intents.push(record);
    
    // Keep only last MAX_LOCAL_INTENTS entries
    const trimmed = intents.slice(-MAX_LOCAL_INTENTS);
    
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch (e) {
    console.log('[intent-capture] Local write failed:', e.message);
  }
};

// ─── Read local intents (for future CoreML training pipeline) ────────────────

/**
 * Returns all locally captured intents. Used by CoreML training pipeline (v0.3).
 * @returns {Promise<Array>} Array of intent records
 */
export const getLocalIntents = async () => {
  try {
    const data = await AsyncStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
};

/**
 * Returns count of locally captured intents.
 * @returns {Promise<number>}
 */
export const getLocalIntentCount = async () => {
  const intents = await getLocalIntents();
  return intents.length;
};
