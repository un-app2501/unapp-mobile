import React, { useState, useEffect, useRef } from 'react';
import { Animated } from 'react-native';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ScrollView,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Image,
  Modal,
  Linking,
  Alert,
  AppState,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { captureIntent } from './captureIntent';
import { getCoreMLPrediction } from './coremlPredictor';
import { runSecureMigration } from './secureStorage';
import { StatusBar } from 'expo-status-bar';
import { WebView } from 'react-native-webview';
import * as Calendar from 'expo-calendar';
import * as Location from 'expo-location';

// OTA Updates (v0.4)
let Updates = null;
try {
  Updates = require('expo-updates');
} catch (e) {
  console.log('[un-app] Updates module not available (dev mode)');
}

// Native modules (only available in EAS builds, not Expo Go)


let Notifications = null;
try {
  Notifications = require('expo-notifications');
} catch (e) {
  console.log('[un-app] Notifications module not available');
}

// ============================================
// v0.2 NEW: CRICKET API (cricketdata.org)
// ============================================
// ============================================
// 🔑 REPLACE THIS WITH YOUR ACTUAL KEY
// ============================================
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

const CRICKET_API_KEY = '865feb36-5923-4661-bb07-adb19c69f648'; // Free tier: https://cricketdata.org
const fetchCricketScores = async () => {
  try {
    const res = await fetch(
      `https://api.cricapi.com/v1/currentMatches?apikey=${CRICKET_API_KEY}&offset=0`
    );
    if (!res.ok) return { type: 'cricket', data: [], error: 'Cricket API unavailable' };
    const json = await res.json();
    if (!json.data || !Array.isArray(json.data)) return { type: 'cricket', data: [], error: 'No matches right now' };

    const matches = json.data.slice(0, 5).map(m => ({
      id: m.id || String(Math.random()),
      status: m.matchStarted && !m.matchEnded ? 'live' : m.matchEnded ? 'completed' : 'upcoming',
      teams: { home: m.teams?.[0] || 'TBD', away: m.teams?.[1] || 'TBD' },
      score: {
        home: m.score?.[0] ? `${m.score[0].r}/${m.score[0].w} (${m.score[0].o})` : null,
        away: m.score?.[1] ? `${m.score[1].r}/${m.score[1].w} (${m.score[1].o})` : null,
      },
      format: (m.matchType || '').toUpperCase() === 'T20' ? 'T20'
            : (m.matchType || '').toUpperCase() === 'ODI' ? 'ODI' : 'Test',
      name: m.name || '',
    }));
    return { type: 'cricket', data: matches, timestamp: new Date().toLocaleTimeString() };
  } catch (e) {
    console.log('Cricket fetch error:', e);
    return { type: 'cricket', data: [], error: 'Could not fetch cricket scores. Check your connection.' };
  }
};

// ============================================
// v0.2 NEW: CALENDAR (EventKit) HANDLER
// ============================================
const fetchCalendarInsights = async () => {
  try {
    const { status } = await Calendar.requestCalendarPermissionsAsync();
    if (status !== 'granted') {
      return { type: 'eventkit_calendar', denied: true };
    }
    const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
    const calendarIds = calendars.map(c => c.id);

    const now = new Date();
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    const events = await Calendar.getEventsAsync(calendarIds, now, endOfDay);

    // Extract temporal data only — no event content stored
    const slots = events.map(ev => {
      const start = new Date(ev.startDate);
      const end = new Date(ev.endDate);
      return {
        hourOfDay: start.getHours(),
        minuteOfHour: start.getMinutes(),
        duration: Math.round((end - start) / 60000),
        title: ev.title || 'Busy', // shown briefly, never persisted
      };
    });

    // Find next free gap (look for 1hr+ gap between events)
    const sortedSlots = slots.sort((a, b) => a.hourOfDay - b.hourOfDay || a.minuteOfHour - b.minuteOfHour);
    let nextFreeGap = null;
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    // Check gaps between consecutive events
    for (let i = 0; i < sortedSlots.length - 1; i++) {
      const endOfCurrent = sortedSlots[i].hourOfDay * 60 + sortedSlots[i].minuteOfHour + sortedSlots[i].duration;
      const startOfNext = sortedSlots[i + 1].hourOfDay * 60 + sortedSlots[i + 1].minuteOfHour;
      if (startOfNext - endOfCurrent >= 60 && endOfCurrent > currentMinutes) {
        const gapHour = Math.floor(endOfCurrent / 60);
        const gapMin = endOfCurrent % 60;
        nextFreeGap = `${gapHour > 12 ? gapHour - 12 : gapHour}:${gapMin.toString().padStart(2, '0')} ${gapHour >= 12 ? 'PM' : 'AM'}`;
        break;
      }
    }

    // If no events left today or gap after last event
    if (!nextFreeGap && sortedSlots.length > 0) {
      const lastEnd = sortedSlots[sortedSlots.length - 1].hourOfDay * 60 + sortedSlots[sortedSlots.length - 1].minuteOfHour + sortedSlots[sortedSlots.length - 1].duration;
      if (lastEnd > currentMinutes && lastEnd < 20 * 60) {
        const h = Math.floor(lastEnd / 60);
        const m = lastEnd % 60;
        nextFreeGap = `${h > 12 ? h - 12 : h}:${m.toString().padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
      }
    }
    if (!nextFreeGap && sortedSlots.length === 0) {
      nextFreeGap = 'All day';
    }

    return {
      type: 'eventkit_calendar',
      events: slots.map(s => ({
        time: `${s.hourOfDay > 12 ? s.hourOfDay - 12 : s.hourOfDay}:${s.minuteOfHour.toString().padStart(2, '0')} ${s.hourOfDay >= 12 ? 'PM' : 'AM'}`,
        title: s.title,
        duration: s.duration,
      })),
      totalToday: slots.length,
      nextFreeGap,
      timestamp: new Date().toLocaleTimeString(),
    };
  } catch (e) {
    console.log('Calendar error:', e);
    return { type: 'eventkit_calendar', error: 'Could not read calendar' };
  }
};
// ============================================
// ANALYTICS (Supabase)
// ============================================
const SUPABASE_URL = 'https://gklanhnlzxzfbbawomnd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdrbGFuaG5senh6ZmJiYXdvbW5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAwOTc0MjgsImV4cCI6MjA4NTY3MzQyOH0.XgB6Riy3iCrcLWTt9Wi2IF0m6a6yH9NjMgjRdf-x8Hk';

const trackEvent = async (eventType, eventData = {}) => {
  try {
    const deviceId = await AsyncStorage.getItem('device_id') || `ios_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await AsyncStorage.setItem('device_id', deviceId);
    
    await fetch(`${SUPABASE_URL}/rest/v1/analytics_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        session_id: deviceId,
        event_type: eventType,
        event_data: eventData,
        user_agent: 'un-app iOS',
      }),
    });
  } catch (e) {
    console.log('Analytics error:', e);
  }
};
// Theme
const THEME = {
  black: '#000000',
  lime: '#CDFF00',
  darkGray: '#1a1a1a',
  mediumGray: '#333333',
  lightGray: '#666666',
  white: '#FFFFFF',
};

// ============================================
// PRIVACY-FIRST STORAGE KEYS
// ============================================
const STORAGE_KEYS = {
  patterns: 'unapp_patterns',
  history: 'unapp_history',
  opens: 'unapp_opens',
  swiggyToken: 'unapp_swiggy_token',
  zomatoToken: 'unapp_zomato_token',
  calendarToken: 'unapp_calendar_token',
  connectedServices: 'unapp_connected_services',
  privacyAcknowledged: 'unapp_privacy_ack',
  dataConsent: 'unapp_data_consent',
  nammaYatriToken: 'unapp_nammayatri_token',
  uberToken: 'unapp_uber_token',
  olaToken: 'unapp_ola_token',
  rapidoToken: 'unapp_rapido_token',
  // v0.2 new keys
  predictionAccuracy: 'unapp_prediction_accuracy',
  tapsSaved: 'unapp_taps_saved',
  lastStockCheck: 'unapp_last_stock_check',
  weeklyInsight: 'unapp_weekly_insight',
  lastInsightDate: 'unapp_last_insight_date',
  // v0.2 new feature keys
  cricketPattern: 'unapp_cricket_pattern',
  cricketCheckLog: 'unapp_cricket_check_log',
  calendarPattern: 'unapp_calendar_pattern',
  sharePattern: 'unapp_share_pattern',
  shareItems: 'unapp_share_items',
  // v0.3 new keys
  mcpCache: 'unapp_mcp_cache',
  cuisinePreference: 'unapp_cuisine_preference',
  lastCabEstimate: 'unapp_last_cab_estimate',
  lastFoodCompare: 'unapp_last_food_compare',
};

// ============================================
// MCP ENDPOINTS
// ============================================
const MCP_ENDPOINTS = {
  swiggy: {
    food: 'https://mcp.swiggy.com/food',
    instamart: 'https://mcp.swiggy.com/im',
    dineout: 'https://mcp.swiggy.com/dineout',
  },
  zomato: 'https://mcp-server.zomato.com/mcp',
};

// ============================================
// v0.3: MCP GATEWAY (our Cloudflare Worker)
// ============================================
const MCP_GATEWAY_URL = 'https://unapp-mcp-gateway.connectswapnil.workers.dev';
const ROUTE_PAIRS = {
  'mumbai': ['pune', 'goa', 'nashik', 'lonavala', 'surat', 'ahmedabad'],
  'pune': ['mumbai', 'goa', 'nashik', 'lonavala'],
  'delhi': ['jaipur', 'chandigarh', 'lucknow', 'shimla'],
  'bangalore': ['mysore', 'chennai', 'hyderabad'],
  'chennai': ['pondicherry', 'bangalore'],
  'hyderabad': ['bangalore'],
  'ahmedabad': ['vadodara', 'mumbai', 'surat'],
  'kolkata': ['lucknow'],
};

const CITY_ALIASES = {
  'mum': 'mumbai', 'bombay': 'mumbai', 'bom': 'mumbai',
  'pun': 'pune', 'puna': 'pune',
  'del': 'delhi', 'dilli': 'delhi',
  'jai': 'jaipur',
  'blr': 'bangalore', 'bengaluru': 'bangalore', 'bang': 'bangalore',
  'mys': 'mysore', 'mysuru': 'mysore',
  'che': 'chennai', 'madras': 'chennai',
  'pondy': 'pondicherry', 'puducherry': 'pondicherry',
  'ahm': 'ahmedabad', 'amd': 'ahmedabad',
  'vad': 'vadodara', 'baroda': 'vadodara',
  'hyd': 'hyderabad',
  'lon': 'lonavala', 'lonav': 'lonavala',
  'nas': 'nashik', 'nasik': 'nashik',
  'cal': 'kolkata', 'calcutta': 'kolkata',
  'lko': 'lucknow', 'chd': 'chandigarh', 'sim': 'shimla', 'sur': 'surat',
};
function detectRouteIntent(input) {
  const clean = input.toLowerCase()
    .replace(/\b(to|se|from|via|road|highway|expressway|route|traffic|how is|hows|how's|what's|whats)\b/g, '')
    .replace(/[^a-z\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 1);

  if (clean.length < 2) return null;

  const ALL_CITIES = new Set(Object.keys(ROUTE_PAIRS));
  for (const dests of Object.values(ROUTE_PAIRS)) {
    for (const d of dests) ALL_CITIES.add(d);
  }

  const cities = [];
  for (const word of clean) {
    const resolved = CITY_ALIASES[word] || (ALL_CITIES.has(word) ? word : null);
    if (resolved && !cities.includes(resolved)) {
      cities.push(resolved);
    }
  }

  if (cities.length < 2) return null;

  const [origin, dest] = cities;
  if (ROUTE_PAIRS[origin] && ROUTE_PAIRS[origin].includes(dest)) {
    return { origin, destination: dest };
  }
  if (ROUTE_PAIRS[dest] && ROUTE_PAIRS[dest].includes(origin)) {
    return { origin: dest, destination: origin };
  }
  return null;
}

async function fetchRouteStatus(origin, destination) {
  try {
    const res = await fetch(`${MCP_GATEWAY_URL}/route-status?origin=${origin}&destination=${destination}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.log('Route fetch failed:', e);
    return null;
  }
}

// ============================================
// NSE STOCKS API (FREE - NO AUTH NEEDED)
// ============================================
const fetchNSEStocks = async (symbol = null, market = 'india') => {
  try {
    let symbols;
    if (symbol) {
      symbols = [symbol];
    } else if (market === 'us') {
      symbols = ['^IXIC', '^DJI', '^GSPC']; // NASDAQ, DOW, S&P 500
    } else {
      symbols = ['^NSEI', '^BSESN']; // NIFTY 50 and SENSEX
    }
    
    const results = [];
    
    for (const sym of symbols) {
      // Bug fix 4+7: Add timeout and retry for reliability
      const fetchWithTimeout = async (url, timeoutMs = 8000) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(url, { signal: controller.signal });
          clearTimeout(timer);
          return res;
        } catch (e) {
          clearTimeout(timer);
          throw e;
        }
      };
      
      let response;
      try {
        response = await fetchWithTimeout(
          `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`
        );
      } catch (firstTryErr) {
        // Retry once after 1 second
        await new Promise(r => setTimeout(r, 1000));
        try {
          response = await fetchWithTimeout(
            `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`
          );
        } catch (retryErr) {
          console.log(`Stock fetch failed for ${sym} after retry:`, retryErr.message);
          continue; // Skip this symbol, try next
        }
      }
      
      const data = await response.json();
      
      if (data.chart && data.chart.result && data.chart.result[0]) {
        const quote = data.chart.result[0];
        const meta = quote.meta;
        const price = meta.regularMarketPrice || 0;
        // Use chartPreviousClose (more reliable than previousClose for change calculation)
        const prevClose = meta.chartPreviousClose || meta.previousClose || 0;
        
        // If price is 0 or same as prevClose, try getting from actual chart data
        let actualPrice = price;
        if ((!actualPrice || actualPrice === prevClose) && quote.indicators?.quote?.[0]) {
          const closes = quote.indicators.quote[0].close;
          if (closes && closes.length > 0) {
            // Get last non-null close price
            for (let ci = closes.length - 1; ci >= 0; ci--) {
              if (closes[ci] !== null) {
                actualPrice = closes[ci];
                break;
              }
            }
          }
        }
        
        const change = prevClose > 0 ? actualPrice - prevClose : 0;
        const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;
        
        const nameMap = {
          '^NSEI': 'NIFTY 50', '^BSESN': 'SENSEX',
          '^IXIC': 'NASDAQ', '^DJI': 'DOW JONES', '^GSPC': 'S&P 500',
        };
        
        // Clean display: "TCS.NS" → "TCS", "RELIANCE.NS" → "RELIANCE"
        const displayName = nameMap[sym] || sym.replace('.NS', '').replace('.BO', '');
        
        results.push({
          symbol: displayName,
          price: actualPrice.toFixed(2),
          change: change.toFixed(2),
          changePercent: changePercent.toFixed(2),
          isUp: change >= 0,
        });
      }
    }
    
    if (results.length === 0) {
      return {
        type: 'stocks',
        data: [],
        error: 'Markets are being shy right now. Check your connection and try again.',
        timestamp: new Date().toLocaleTimeString(),
      };
    }
    
    return {
      type: 'stocks',
      data: results,
      timestamp: new Date().toLocaleTimeString(),
    };
  } catch (error) {
    console.log('Stock fetch error:', error);
    return {
      type: 'stocks',
      data: [],
      error: 'Markets are being shy right now. Check your connection and try again.',
      timestamp: new Date().toLocaleTimeString(),
    };
  }
};

// ============================================
// ============================================
// v0.4: INDIVIDUAL STOCK SYMBOL MAP (Phase 3)
// ============================================
const STOCK_SYMBOL_MAP = {
  'reliance': 'RELIANCE.NS', 'tcs': 'TCS.NS', 'infosys': 'INFY.NS', 'infy': 'INFY.NS',
  'hdfc': 'HDFCBANK.NS', 'hdfc bank': 'HDFCBANK.NS', 'icici': 'ICICIBANK.NS', 'icici bank': 'ICICIBANK.NS',
  'sbi': 'SBIN.NS', 'state bank': 'SBIN.NS', 'kotak': 'KOTAKBANK.NS', 'axis': 'AXISBANK.NS',
  'wipro': 'WIPRO.NS', 'hcl': 'HCLTECH.NS', 'lt': 'LT.NS', 'larsen': 'LT.NS',
  'bajaj': 'BAJFINANCE.NS', 'bajaj finance': 'BAJFINANCE.NS', 'bajaj auto': 'BAJAJ-AUTO.NS',
  'maruti': 'MARUTI.NS', 'tata motors': 'TATAMOTORS.NS', 'tata': 'TATAMOTORS.NS',
  'tata steel': 'TATASTEEL.NS', 'tata power': 'TATAPOWER.NS', 'tata consumer': 'TATACONSUM.NS',
  'adani': 'ADANIENT.NS', 'adani ports': 'ADANIPORTS.NS', 'adani green': 'ADANIGREEN.NS',
  'itc': 'ITC.NS', 'sunpharma': 'SUNPHARMA.NS', 'sun pharma': 'SUNPHARMA.NS',
  'asian paints': 'ASIANPAINT.NS', 'bharti': 'BHARTIARTL.NS', 'airtel': 'BHARTIARTL.NS',
  'titan': 'TITAN.NS', 'ultratech': 'ULTRACEMCO.NS', 'nestle': 'NESTLEIND.NS',
  'power grid': 'POWERGRID.NS', 'ntpc': 'NTPC.NS', 'ongc': 'ONGC.NS', 'coal india': 'COALINDIA.NS',
  'hindalco': 'HINDALCO.NS', 'jswsteel': 'JSWSTEEL.NS', 'jsw steel': 'JSWSTEEL.NS',
  'zomato stock': 'ZOMATO.NS', 'paytm': 'PAYTM.NS', 'dmart': 'DMART.NS',
  // Mid-cap / small-cap commonly searched
  'sterlite': 'STLTECH.NS', 'sterlitetech': 'STLTECH.NS', 'stl': 'STLTECH.NS',
  'vedanta': 'VEDL.NS', 'vedl': 'VEDL.NS', 'jsw energy': 'JSWENERGY.NS',
  'irctc': 'IRCTC.NS', 'irfc': 'IRFC.NS', 'rvnl': 'RVNL.NS',
  'motherson': 'MOTHERSON.NS', 'indigo': 'INDIGO.NS', 'interglobe': 'INDIGO.NS',
  'pidilite': 'PIDILITIND.NS', 'havells': 'HAVELLS.NS', 'dabur': 'DABUR.NS',
  'godrej': 'GODREJCP.NS', 'britannia': 'BRITANNIA.NS', 'marico': 'MARICO.NS',
  'dl': 'DLF.NS', 'dlf': 'DLF.NS', 'cipla': 'CIPLA.NS', 'divis': 'DIVISLAB.NS',
  'siemens': 'SIEMENS.NS', 'abb': 'ABB.NS', 'hal': 'HAL.NS',
  'bel': 'BEL.NS', 'bhel': 'BHEL.NS', 'sail': 'SAIL.NS',
  'idea': 'IDEA.NS', 'vi': 'IDEA.NS', 'vodafone': 'IDEA.NS',
  'trent': 'TRENT.NS', 'zydus': 'ZYDUSLIFE.NS', 'srf': 'SRF.NS',
  'dixon': 'DIXON.NS', 'polycab': 'POLYCAB.NS', 'persistent': 'PERSISTENT.NS',
  'coforge': 'COFORGE.NS', 'mphasis': 'MPHASIS.NS', 'ltim': 'LTIM.NS',
  'ltimindtree': 'LTIM.NS', 'tech mahindra': 'TECHM.NS', 'techm': 'TECHM.NS',
  // Mutual fund keywords → show index
  'mutual fund': null, 'mf': null, 'sip': null,
};

const detectIndividualStock = (queryText) => {
  const low = queryText.toLowerCase().trim();
  const words = low.split(/\s+/);
  
  // First: try multi-word matches (longer phrases first to avoid partial matches)
  const multiWordKeys = Object.keys(STOCK_SYMBOL_MAP).filter(k => k.includes(' '));
  for (const keyword of multiWordKeys) {
    if (low.includes(keyword)) {
      return { keyword, symbol: STOCK_SYMBOL_MAP[keyword] };
    }
  }
  
  // Second: try single-word matches — must be EXACT word match, not substring
  const singleWordKeys = Object.keys(STOCK_SYMBOL_MAP).filter(k => !k.includes(' '));
  for (const keyword of singleWordKeys) {
    // Word must match exactly (not as substring of another word)
    if (words.includes(keyword)) {
      return { keyword, symbol: STOCK_SYMBOL_MAP[keyword] };
    }
  }
  
  // Third: try "XYZ stock" or "XYZ share" pattern
  const match = low.match(/^(\w+)\s+(stock|share|price|nse|bse)$/);
  if (match) {
    const sym = `${match[1].toUpperCase()}.NS`;
    return { keyword: match[1], symbol: sym };
  }
  return null;
};

// ============================================
// v0.4: WEATHER (wttr.in — free, no API key)
// ============================================
const fetchWeather = async (lat, lng, cityName = null) => {
  try {
    const location = cityName || `${lat},${lng}`;
    const res = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=j1`, {
      headers: { 'User-Agent': 'un-app/0.4' },
    });
    if (!res.ok) throw new Error('Weather API unavailable');
    const data = await res.json();
    
    const current = data.current_condition?.[0];
    const area = data.nearest_area?.[0];
    if (!current) throw new Error('No weather data');
    
    return {
      type: 'weather',
      city: area?.areaName?.[0]?.value || cityName || 'Your location',
      temp: current.temp_C,
      feelsLike: current.FeelsLikeC,
      humidity: current.humidity,
      description: current.weatherDesc?.[0]?.value || '',
      windSpeed: current.windspeedKmph,
      windDir: current.winddir16Point,
      uvIndex: current.uvIndex,
      visibility: current.visibility,
      timestamp: new Date().toLocaleTimeString(),
      forecast: (data.weather || []).slice(0, 3).map(d => ({
        date: d.date,
        maxTemp: d.maxtempC,
        minTemp: d.mintempC,
        description: d.hourly?.[4]?.weatherDesc?.[0]?.value || '',
      })),
    };
  } catch (e) {
    console.log('Weather fetch error:', e);
    return { type: 'weather', error: 'Could not fetch weather. Check your connection.' };
  }
};

// ============================================
// v0.4: MEDIA DEEPLINKS (YouTube, Spotify, Netflix)
// ============================================
const MEDIA_APPS = {
  youtube: { scheme: 'youtube://', web: 'https://www.youtube.com', name: 'YouTube', emoji: '▶️' },
  spotify: { scheme: 'spotify://', web: 'https://open.spotify.com', name: 'Spotify', emoji: '🎵' },
  netflix: { scheme: 'netflix://', web: 'https://www.netflix.com', name: 'Netflix', emoji: '🎬' },
  prime: { scheme: 'aiv://', web: 'https://www.primevideo.com', name: 'Prime Video', emoji: '📺' },
  hotstar: { scheme: 'hotstar://', web: 'https://www.hotstar.com', name: 'Hotstar', emoji: '⭐' },
  jiocinema: { scheme: 'jiocinema://', web: 'https://www.jiocinema.com', name: 'JioCinema', emoji: '🎞️' },
};

// ============================================
// v0.4: DAILY ANALYTICS SNAPSHOT (Phase 4)
// ============================================
const pushDailySnapshot = async (patterns, appOpens, tapsSaved, predictionAccuracy, queryHistory) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const lastSnap = await AsyncStorage.getItem('unapp_last_snapshot_date');
    if (lastSnap === today) return; // Already pushed today
    
    const snapshot = {
      date: today,
      app_opens: appOpens,
      taps_saved: tapsSaved,
      prediction_accuracy_correct: predictionAccuracy.correct,
      prediction_accuracy_total: predictionAccuracy.total,
      total_queries: queryHistory.length,
      pattern_count: Object.keys(patterns).length,
      patterns_summary: JSON.stringify(
        Object.fromEntries(
          Object.entries(patterns).map(([k, v]) => [k, { count: v.count, peakHour: v.times?.length > 0 ? Math.round(v.times.reduce((a,b) => a+b, 0) / v.times.length) : null }])
        )
      ),
    };
    
    await fetch(`${SUPABASE_URL}/rest/v1/daily_snapshots`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(snapshot),
    });
    
    await AsyncStorage.setItem('unapp_last_snapshot_date', today);
    console.log('[analytics] Daily snapshot pushed for', today);
  } catch (e) {
    console.log('[analytics] Snapshot push failed:', e.message);
  }
};

// MCP CLIENT (JSON-RPC 2.0)
// ============================================

// ============================================
// v0.3: MCP GATEWAY FETCH FUNCTIONS
// ============================================
const fetchCabEstimate = async (pickupLat, pickupLng, dropoffLat, dropoffLng) => {
  try {
    const res = await fetch(`${MCP_GATEWAY_URL}/mcp/cab-estimate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pickup_lat: pickupLat, pickup_lng: pickupLng, dropoff_lat: dropoffLat, dropoff_lng: dropoffLng }),
    });
    if (!res.ok) throw new Error(`Gateway ${res.status}`);
    return await res.json();
  } catch (e) {
    console.log('MCP cab estimate error:', e);
    return null;
  }
};

const fetchFoodCompare = async (lat, lng, cuisinePreference = null) => {
  try {
    const body = { lat, lng };
    if (cuisinePreference) body.cuisine_preference = cuisinePreference;
    const res = await fetch(`${MCP_GATEWAY_URL}/mcp/food-compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Gateway ${res.status}`);
    return await res.json();
  } catch (e) {
    console.log('MCP food compare error:', e);
    return null;
  }
};

class MCPClient {
  constructor(endpoint, token = null) {
    this.endpoint = endpoint;
    this.token = token;
    this.requestId = 0;
  }

  async call(method, params = {}) {
    this.requestId++;
    
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: this.requestId,
          method,
          params,
        }),
      });
      
      // Check for 401 - need OAuth
      if (response.status === 401) {
        const wwwAuth = response.headers.get('WWW-Authenticate');
        return { needsAuth: true, authHeader: wwwAuth };
      }
      
      const data = await response.json();
      return data;
    } catch (error) {
      console.log('MCP call error:', error);
      return { error: error.message };
    }
  }

  // Discover available tools
  async listTools() {
    return this.call('tools/list');
  }

  // Call a specific tool
  async callTool(toolName, args = {}) {
    return this.call('tools/call', { name: toolName, arguments: args });
  }
}

// ============================================
// MAIN APP COMPONENT
// ============================================
export default function App() {
  // State
  const [query, setQuery] = useState('');
  const [response, setResponse] = useState(null);
  const [loading, setLoading] = useState(false);
  const [patterns, setPatterns] = useState({});
  const [queryHistory, setQueryHistory] = useState([]);
  const [connectedServices, setConnectedServices] = useState({});
  const [showPrivacyNotice, setShowPrivacyNotice] = useState(false);
  const [dataConsentGiven, setDataConsentGiven] = useState(false);
  const [showOAuthModal, setShowOAuthModal] = useState(false);
  const [oauthUrl, setOauthUrl] = useState('');
  const [currentOAuthService, setCurrentOAuthService] = useState(null);
  const [preloadedData, setPreloadedData] = useState(null);
  const [appOpens, setAppOpens] = useState(0);
  const [contextCards, setContextCards] = useState([]);
  // v0.2 new state
  const [predictionAccuracy, setPredictionAccuracy] = useState({ correct: 0, total: 0 });
  const [tapsSaved, setTapsSaved] = useState(0);
  const [lastStockCheck, setLastStockCheck] = useState(null);
  const [weeklyInsight, setWeeklyInsight] = useState(null);
  const [dismissedCategories, setDismissedCategories] = useState(new Set());
  const [userLocation, setUserLocation] = useState(null);
  const currentPredictionRef = useRef(null);
  
  const scrollViewRef = useRef(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const appStateRef = useRef(AppState.currentState);
  
  // Bug fix 2: Refresh state when app comes to foreground
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (appStateRef.current.match(/inactive|background/) && nextAppState === 'active') {
        // App came to foreground — refresh everything
        setDismissedCategories(new Set()); // Reset dismissed cards
        if (dataConsentGiven) {
          generateContextCards();
          fetchUserLocation(); // Refresh location
        }
      }
      appStateRef.current = nextAppState;
    });
    return () => subscription?.remove();
  }, [dataConsentGiven, patterns, connectedServices]);

  // Bug fix 1: Clear response to go "back" to home
  const clearResponse = () => {
    setResponse(null);
    setDismissedCategories(new Set());
    if (dataConsentGiven) generateContextCards();
  };
  
  // Pulse animation for greeting
  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.4, duration: 1000, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, []);

  // ============================================
  // LIFECYCLE
  // ============================================
  useEffect(() => {
    initializeApp();
  }, []);

  // Only track and preload AFTER consent is given
  useEffect(() => {
    if (dataConsentGiven) {
      trackEvent('app_started', { source: 'ios_app' });
      runSecureMigration();
      checkAndPreloadData();
      // v0.4 Phase 4: Push daily analytics snapshot
      pushDailySnapshot(patterns, appOpens, tapsSaved, predictionAccuracy, queryHistory);
    }
  }, [dataConsentGiven]);

  const initializeApp = async () => {
    await loadStoredData();
    // v0.4: Check for OTA updates silently
    try {
      if (Updates && !__DEV__) {
        const update = await Updates.checkForUpdateAsync();
        if (update.isAvailable) {
          await Updates.fetchUpdateAsync();
          await Updates.reloadAsync();
        }
      }
    } catch (e) {
      console.log('[un-app] OTA check skipped:', e.message);
    }
  };

  // Fetch device GPS location
  const fetchUserLocation = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        console.log('Location permission denied');
        return;
      }
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const coords = { lat: loc.coords.latitude, lng: loc.coords.longitude };
      setUserLocation(coords);
      await AsyncStorage.setItem('@unapp_user_location', JSON.stringify(coords));
      trackEvent('location_fetched', { lat: coords.lat.toFixed(2), lng: coords.lng.toFixed(2) });
    } catch (e) {
      // Fallback: try cached location
      try {
        const cached = await AsyncStorage.getItem('@unapp_user_location');
        if (cached) setUserLocation(JSON.parse(cached));
      } catch (ce) {}
    }
  };

  // Fetch location after consent
  useEffect(() => {
    if (dataConsentGiven) {
      fetchUserLocation();
      registerForSilentNotifications();
    }
  }, [dataConsentGiven]);

  // v0.3: Register for silent push notifications (background refresh)
  const registerForSilentNotifications = async () => {
    if (!Notifications) return;
    try {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== 'granted') {
        console.log('[Notifications] Permission denied');
        return;
      }
      
      // Get push token for future server-triggered refreshes
      const token = await Notifications.getExpoPushTokenAsync({
        projectId: '23f6341c-bc7d-4e3d-8b9a-d3c6d3f1234a',
      });
      
      // Store token for analytics
      try {
        await AsyncStorage.setItem('@unapp_push_token', token.data);
        trackEvent('push_token_registered', { token_prefix: token.data.substring(0, 20) });
      } catch (e) {}
      
      // Handle background notification — triggers context refresh
      Notifications.setNotificationHandler({
        handleNotification: async (notification) => {
          const data = notification.request.content.data;
          if (data?.type === 'silent_refresh') {
            // Re-generate context cards in background
            generateContextCards();
            return { shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: false };
          }
          return { shouldShowAlert: true, shouldPlaySound: false, shouldSetBadge: false };
        },
      });
    } catch (e) {
      console.log('[Notifications] Setup error:', e);
    }
  };

  // Trigger weekly insight when patterns are ready AND consent given
  useEffect(() => {
    if (dataConsentGiven && Object.keys(patterns).length >= 2) {
      generateWeeklyInsight();
    }
  }, [patterns, dataConsentGiven]);

  // ============================================
  // CONTEXTUAL CARDS (TIME-BASED, AUTO-SHOW)
  // ============================================
  useEffect(() => {
    if (dataConsentGiven) {
      generateContextCards();
    }
  }, [patterns, connectedServices, dismissedCategories, dataConsentGiven]);

  const generateContextCards = () => {
    const hour = new Date().getHours();
    const minutes = new Date().getMinutes();
    const day = new Date().getDay();
    const isWeekday = day >= 1 && day <= 5;
    const currentTimeInMinutes = hour * 60 + minutes;
    const cards = [];
    const addedCategories = new Set();
    
    // Market hours: NSE 9:15am - 3:30pm IST weekdays only
    const marketOpen = 9 * 60 + 15;  // 9:15
    const marketClose = 15 * 60 + 30; // 15:30
    if (isWeekday && currentTimeInMinutes >= marketOpen && currentTimeInMinutes <= marketClose) {
      cards.push({
        id: 'market_open',
        emoji: '📈',
        title: 'Market is live',
        subtitle: 'Tap for SENSEX & NIFTY',
        action: 'check_stocks',
        category: 'stocks',
      });
      addedCategories.add('stocks');
    }
    
    // US Market hours: NASDAQ 9:30am-4pm ET = 8:00pm-1:30am IST (next day)
    const usMarketOpenIST = 20 * 60;     // 8:00pm IST
    const usMarketCloseIST = 25 * 60 + 30; // 1:30am IST (next day = 25.5 hrs)
    const adjustedTime = currentTimeInMinutes < 2 * 60 ? currentTimeInMinutes + 24 * 60 : currentTimeInMinutes;
    if (isWeekday && adjustedTime >= usMarketOpenIST && adjustedTime <= usMarketCloseIST && !addedCategories.has('stocks')) {
      cards.push({
        id: 'us_market_open',
        emoji: '📈',
        title: 'US market is live',
        subtitle: 'Tap for NASDAQ, DOW & S&P',
        action: 'check_us_stocks',
        category: 'stocks',
      });
      addedCategories.add('stocks');
    }
    
    // Morning commute (7-10 weekdays)
    if (hour >= 7 && hour <= 10 && isWeekday) {
      const hasAnyCab = connectedServices.nammaYatri || connectedServices.uber || connectedServices.ola || connectedServices.rapido;
      cards.push({
        id: 'morning_cab',
        emoji: '🚕',
        title: hasAnyCab ? 'Morning commute' : 'Need a ride?',
        subtitle: hasAnyCab ? 'Tap to book' : 'Connect a cab service',
        action: hasAnyCab ? 'open_cab' : 'connect_cab',
        category: 'cab',
      });
      addedCategories.add('cab');
    }
    
    // Lunch (11-14)
    if (hour >= 11 && hour <= 14) {
      const hasAnyFood = connectedServices.swiggy || connectedServices.zomato;
      cards.push({
        id: 'lunch_time',
        emoji: '🍕',
        title: hasAnyFood ? 'Lunch time' : 'Hungry?',
        subtitle: hasAnyFood ? 'Order now' : 'Connect Swiggy or Zomato',
        action: hasAnyFood ? 'open_food' : 'connect_food',
        category: 'food',
      });
      addedCategories.add('food');
    }
    
    // Evening commute (17-20 weekdays)
    if (hour >= 17 && hour <= 20 && isWeekday) {
      const hasAnyCab = connectedServices.nammaYatri || connectedServices.uber || connectedServices.ola || connectedServices.rapido;
      cards.push({
        id: 'evening_cab',
        emoji: '🚕',
        title: hasAnyCab ? 'Heading home?' : 'Need a ride?',
        subtitle: hasAnyCab ? 'Tap to book' : 'Connect a cab service',
        action: hasAnyCab ? 'open_cab' : 'connect_cab',
        category: 'cab',
      });
      addedCategories.add('cab');
    }
    
    // Dinner (19-22)
    if (hour >= 19 && hour <= 22) {
      const hasAnyFood = connectedServices.swiggy || connectedServices.zomato;
      cards.push({
        id: 'dinner_time',
        emoji: '🍕',
        title: hasAnyFood ? 'Dinner time' : 'Hungry?',
        subtitle: hasAnyFood ? 'Order now' : 'Connect Swiggy or Zomato',
        action: hasAnyFood ? 'open_food' : 'connect_food',
        category: 'food',
      });
      addedCategories.add('food');
    }
    
    // Pattern-based cards: if user has a pattern for THIS hour, show card
    if (patterns) {
      for (const [category, data] of Object.entries(patterns)) {
        if (addedCategories.has(category)) continue; // already have a card for this
        if (!data.times || data.times.length < 2) continue; // need at least 2 data points
        
        const hourCounts = {};
        data.times.forEach(t => { hourCounts[t] = (hourCounts[t] || 0) + 1; });
        const peakHour = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0];
        
        if (peakHour && Math.abs(parseInt(peakHour[0]) - hour) <= 1) {
          // User has a pattern within 1 hour of now
          const cardConfig = {
            stocks: { emoji: '📈', title: 'Check market?', action: 'check_stocks' },
            food: { 
              emoji: '🍕', 
              title: connectedServices.swiggy || connectedServices.zomato ? 'Feeling hungry?' : 'Order food?',
              action: connectedServices.swiggy || connectedServices.zomato ? 'open_food' : 'connect_food',
            },
            cab: {
              emoji: '🚕',
              title: connectedServices.nammaYatri || connectedServices.uber || connectedServices.ola || connectedServices.rapido ? 'Book a ride?' : 'Need a ride?',
              action: connectedServices.nammaYatri || connectedServices.uber || connectedServices.ola || connectedServices.rapido ? 'open_cab' : 'connect_cab',
            },
            calendar: { emoji: '📅', title: 'Check schedule?', action: 'check_calendar' },
            cricket: { emoji: '🏏', title: 'Check cricket?', action: 'check_cricket' },
            weather: { emoji: '🌤️', title: 'Check weather?', action: 'check_weather' },
          };
          
          const config = cardConfig[category];
          if (config) {
            cards.push({
              id: `pattern_${category}`,
              emoji: config.emoji,
              title: config.title,
              subtitle: `You usually do this around ${peakHour[0] > 12 ? peakHour[0] - 12 : peakHour[0]}${peakHour[0] >= 12 ? 'pm' : 'am'}`,
              action: config.action,
              category: category,
            });
            addedCategories.add(category);
          }
        }
      }
    }
    
    setContextCards(cards.filter(c => !dismissedCategories.has(c.category)));
    
    // v0.2: Async context cards (cricket + calendar)
    // These run after initial sync cards are set
    (async () => {
      const asyncCards = [];
      
      // Cricket: show card if there are live matches
      if (!dismissedCategories.has('cricket') && !addedCategories.has('cricket')) {
        try {
          const cricketResult = await fetchCricketScores();
          const liveMatches = (cricketResult.data || []).filter(m => m.status === 'live');
          if (liveMatches.length > 0) {
            asyncCards.push({
              id: 'cricket_live',
              emoji: '🏏',
              title: `${liveMatches.length} match${liveMatches.length > 1 ? 'es' : ''} live`,
              subtitle: `${liveMatches[0].teams.home} vs ${liveMatches[0].teams.away}`,
              action: 'check_cricket',
              category: 'cricket',
            });
          }
        } catch (e) {}
      }
      
      // Calendar free gap: show if user has calendar access
      if (!dismissedCategories.has('calendar_gap') && !addedCategories.has('calendar')) {
        try {
          const calResult = await fetchCalendarInsights();
          if (calResult.nextFreeGap && calResult.totalToday > 0) {
            asyncCards.push({
              id: 'calendar_free',
              emoji: '📅',
              title: `Free at ${calResult.nextFreeGap}`,
              subtitle: `${calResult.totalToday} events today`,
              action: 'check_calendar',
              category: 'calendar',
            });
          }
        } catch (e) {}
      }
      
      if (asyncCards.length > 0) {
        setContextCards(prev => {
          const existingCategories = new Set(prev.map(c => c.category));
          const newCards = asyncCards.filter(c => !dismissedCategories.has(c.category) && !existingCategories.has(c.category));
          return [...prev, ...newCards];
        });
      }
      
      // v0.3: CoreML on-device prediction (EAS build only)
      
      
      // v0.3: Sync widget data via App Groups
      
    })();
  };

  const handleContextCardTap = async (card) => {
    trackEvent('context_card_tap', { card_id: card.id, category: card.category });
    
    switch (card.action) {
      case 'check_stocks':
        setLoading(true);
        const stockResult = await fetchNSEStocks();
        setResponse(stockResult);
        await updatePatterns('stocks');
        if (stockResult?.data?.length > 0) await storeLastStockCheck(stockResult);
        setLoading(false);
        break;
      case 'check_us_stocks':
        setLoading(true);
        const usStockResult = await fetchNSEStocks(null, 'us');
        setResponse(usStockResult);
        await updatePatterns('stocks');
        if (usStockResult?.data?.length > 0) await storeLastStockCheck(usStockResult);
        setLoading(false);
        break;
      case 'open_food':
        setQuery('food');
        const foodResult = await handleFoodQuery();
        setResponse(foodResult);
        await updatePatterns('food');
        setQuery('');
        break;
      case 'connect_food':
        setResponse({ type: 'food', needsConnection: true, message: 'Connect to order food', services: ['swiggy', 'zomato'] });
        break;
      case 'open_cab':
        setQuery('cab');
        const cabResult = await handleCabQuery();
        setResponse(cabResult);
        await updatePatterns('cab');
        setQuery('');
        break;
      case 'connect_cab':
        setResponse({ type: 'cab', needsConnection: true, message: 'Connect to book a ride', services: ['nammaYatri', 'uber', 'ola', 'rapido'] });
        break;
      case 'check_calendar':
        const calResult = await handleCalendarQuery();
        setResponse(calResult);
        await updatePatterns('calendar');
        break;
      case 'check_cricket':
        setLoading(true);
        const cricketResult = await fetchCricketScores();
        setResponse(cricketResult);
        // Track cricket check behavior
        try {
          const cLog = await AsyncStorage.getItem(STORAGE_KEYS.cricketCheckLog);
          const log = cLog ? JSON.parse(cLog) : [];
          log.unshift({ timestamp: Date.now(), hour: new Date().getHours(), day: new Date().getDay() });
          if (log.length > 200) log.length = 200;
          await AsyncStorage.setItem(STORAGE_KEYS.cricketCheckLog, JSON.stringify(log));
        } catch (e) {}
        setLoading(false);
        break;
      case 'check_weather':
        setLoading(true);
        const wLoc = userLocation || { lat: 19.076, lng: 72.8777 };
        const weatherResult = await fetchWeather(wLoc.lat, wLoc.lng);
        setResponse(weatherResult);
        await updatePatterns('weather');
        setLoading(false);
        break;
    }
    
    // Remove tapped card AND prevent regeneration
    setDismissedCategories(prev => new Set([...prev, card.category]));
    setContextCards(prev => prev.filter(c => c.category !== card.category));
    
    // Feature 5: Count tap saved
    await incrementTapsSaved();
  };

  const loadStoredData = async () => {
    try {
      const storedPatterns = await AsyncStorage.getItem(STORAGE_KEYS.patterns);
      const storedHistory = await AsyncStorage.getItem(STORAGE_KEYS.history);
      const storedServices = await AsyncStorage.getItem(STORAGE_KEYS.connectedServices);
      const storedOpens = await AsyncStorage.getItem(STORAGE_KEYS.opens);
      const privacyAck = await AsyncStorage.getItem(STORAGE_KEYS.privacyAcknowledged);
      
      if (storedPatterns) {
        try {
          const parsed = JSON.parse(storedPatterns);
          // Clean invalid pattern keys + remove general/cricket
          const validCategories = ['stocks', 'food', 'cab', 'calendar', 'cricket', 'weather', 'media'];
          const cleaned = {};
          for (const key of Object.keys(parsed)) {
            if (validCategories.includes(key) && parsed[key].count >= 1) {
              cleaned[key] = parsed[key];
            }
          }
          setPatterns(cleaned);
          await AsyncStorage.setItem(STORAGE_KEYS.patterns, JSON.stringify(cleaned));
        } catch (parseError) {
          // Corrupted patterns - reset
          console.log('Pattern data corrupted, resetting');
          await AsyncStorage.removeItem(STORAGE_KEYS.patterns);
          setPatterns({});
        }
      }
      if (storedHistory) {
        try { setQueryHistory(JSON.parse(storedHistory)); } 
        catch (e) { await AsyncStorage.removeItem(STORAGE_KEYS.history); }
      }
      if (storedServices) {
        try { setConnectedServices(JSON.parse(storedServices)); }
        catch (e) { await AsyncStorage.removeItem(STORAGE_KEYS.connectedServices); }
      }
      
      // Track app opens
      const opens = storedOpens ? parseInt(storedOpens) + 1 : 1;
      setAppOpens(opens);
      await AsyncStorage.setItem(STORAGE_KEYS.opens, opens.toString());
      
      // Load v0.2 state
      try {
        const storedAccuracy = await AsyncStorage.getItem(STORAGE_KEYS.predictionAccuracy);
        if (storedAccuracy) setPredictionAccuracy(JSON.parse(storedAccuracy));
        
        const storedTaps = await AsyncStorage.getItem(STORAGE_KEYS.tapsSaved);
        if (storedTaps) setTapsSaved(parseInt(storedTaps));
        
        const storedLastStock = await AsyncStorage.getItem(STORAGE_KEYS.lastStockCheck);
        if (storedLastStock) setLastStockCheck(JSON.parse(storedLastStock));
        
        const storedInsight = await AsyncStorage.getItem(STORAGE_KEYS.weeklyInsight);
        if (storedInsight) setWeeklyInsight(storedInsight);
      } catch (e) {
        console.log('v0.2 state load error:', e);
      }
      
      // Show privacy/data consent on first open (or if not yet consented)
      const consent = await AsyncStorage.getItem(STORAGE_KEYS.dataConsent);
      if (consent === 'granted') {
        setDataConsentGiven(true);
      } else {
        setShowPrivacyNotice(true);
      }
      
      console.log('App opens:', opens);
    } catch (error) {
      console.log('Error loading stored data:', error);
    }
  };

  // ============================================
  // V0.2 FEATURES
  // ============================================
  
  // Feature 3: Prediction accuracy tracking
  const trackPredictionResult = async (predicted, actual) => {
    const isCorrect = predicted === actual;
    const updated = {
      correct: predictionAccuracy.correct + (isCorrect ? 1 : 0),
      total: predictionAccuracy.total + 1,
    };
    setPredictionAccuracy(updated);
    await AsyncStorage.setItem(STORAGE_KEYS.predictionAccuracy, JSON.stringify(updated));
  };
  
  // Feature 5: Taps saved counter
  const incrementTapsSaved = async () => {
    const updated = tapsSaved + 1;
    setTapsSaved(updated);
    await AsyncStorage.setItem(STORAGE_KEYS.tapsSaved, updated.toString());
  };
  
  // Feature 4: Store last stock check
  const storeLastStockCheck = async (stockData) => {
    if (!stockData || !stockData.data || stockData.data.length === 0) return;
    const checkpoint = {
      timestamp: Date.now(),
      timeLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      dateLabel: new Date().toLocaleDateString(),
      prices: {},
    };
    stockData.data.forEach(s => {
      checkpoint.prices[s.symbol] = parseFloat(s.price);
    });
    setLastStockCheck(checkpoint);
    await AsyncStorage.setItem(STORAGE_KEYS.lastStockCheck, JSON.stringify(checkpoint));
  };
  
  // Feature 4: Calculate "since you last checked" delta
  const getSinceLastCheck = (currentData) => {
    if (!lastStockCheck || !currentData || !currentData.data) return null;
    
    const hoursSince = (Date.now() - lastStockCheck.timestamp) / (1000 * 60 * 60);
    if (hoursSince < 0.1) return null; // Don't show if checked less than 6 min ago
    
    const deltas = [];
    currentData.data.forEach(stock => {
      const prevPrice = lastStockCheck.prices[stock.symbol];
      if (prevPrice && prevPrice > 0) {
        const change = ((parseFloat(stock.price) - prevPrice) / prevPrice * 100).toFixed(2);
        deltas.push({ symbol: stock.symbol, change, isUp: parseFloat(change) >= 0 });
      }
    });
    
    if (deltas.length === 0) return null;
    
    const timeAgo = hoursSince < 1 
      ? `${Math.round(hoursSince * 60)}min ago`
      : hoursSince < 24 
        ? `${Math.round(hoursSince)}hr ago` 
        : `${Math.round(hoursSince / 24)} day${Math.round(hoursSince / 24) > 1 ? 's' : ''} ago`;
    
    return { deltas, timeAgo, timeLabel: lastStockCheck.timeLabel };
  };
  
  // Feature 6: Weekly Claude API behavioral insight
  const generateWeeklyInsight = async () => {
    try {
      const lastDate = await AsyncStorage.getItem(STORAGE_KEYS.lastInsightDate);
      const now = Date.now();
      const oneWeek = 7 * 24 * 60 * 60 * 1000;
      
      // Only generate once per week (or first time)
      if (lastDate && (now - parseInt(lastDate)) < oneWeek) return;
      
      // Need at least some patterns
      const patternKeys = Object.keys(patterns).filter(k => patterns[k]?.count >= 2);
      if (patternKeys.length < 2) return;
      
      // Build anonymized pattern summary
      const patternSummary = {};
      patternKeys.forEach(k => {
        patternSummary[k] = {
          count: patterns[k].count,
          times: patterns[k].times || [],
          days: patterns[k].days || [],
        };
      });
      
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 150,
          messages: [{
            role: 'user',
            content: `You are un-app's behavioral AI. Given this user's anonymous app usage patterns from the past week, write ONE short casual behavioral insight (max 2 sentences). Be specific about WHEN patterns — times of day, days of week, frequencies. Be witty, not generic. No emojis. Patterns: ${JSON.stringify(patternSummary)}`,
          }],
        }),
      });
      
      const data = await response.json();
      const insight = data.content?.[0]?.text || null;
      
      if (insight) {
        setWeeklyInsight(insight);
        await AsyncStorage.setItem(STORAGE_KEYS.weeklyInsight, insight);
        await AsyncStorage.setItem(STORAGE_KEYS.lastInsightDate, now.toString());
        trackEvent('weekly_insight_generated', { pattern_count: patternKeys.length });
      }
    } catch (e) {
      console.log('Weekly insight generation skipped:', e.message);
      // Fail silently - insight is a nice-to-have
    }
  };

  // ============================================
  // BEHAVIORAL PRE-LOADING (THE MAGIC!)
  // ============================================
  const checkAndPreloadData = async () => {
    const currentHour = new Date().getHours();
    const currentDay = new Date().getDay();
    
    // Check patterns and pre-load relevant data
    const patternKeys = Object.keys(patterns);
    
    for (const pattern of patternKeys) {
      const patternData = patterns[pattern];
      
      // Stock pattern: Pre-load during market hours (9-4 IST)
      if (pattern === 'stocks' && currentHour >= 9 && currentHour <= 16) {
        if (patternData.count >= 2) {
          console.log('Pre-loading stocks based on pattern...');
          const stockData = await fetchNSEStocks();
          setPreloadedData(prev => ({ ...prev, stocks: stockData }));
        }
      }
      
      // Food pattern: Pre-load during meal times
      if (pattern === 'food') {
        const isLunchTime = currentHour >= 12 && currentHour <= 14;
        const isDinnerTime = currentHour >= 19 && currentHour <= 21;
        
        if ((isLunchTime || isDinnerTime) && patternData.count >= 2) {
          console.log('Pre-loading food suggestions based on pattern...');
          // Will trigger Swiggy/Zomato if connected
        }
      }
    }
    // CoreML prediction (v0.3)
    const prediction = await getCoreMLPrediction();
    if (prediction.shouldShow) {
      console.log(`[un-app] CoreML suggests: ${prediction.cardType} (${(prediction.confidence*100).toFixed(0)}%)`);
    }
  };

  // ============================================
  // QUERY DETECTION
  // ============================================
  const detectQueryType = (text) => {
    const lowered = text.toLowerCase().trim();
    
    // UX 12: Friendly onboarding for greetings and help queries
    if (/^(hi|hello|hey|what'?s up|how to use|help|what can you do|capabilities)$/i.test(lowered)) {
      return 'onboarding';
    }
    
    // === ORDER MATTERS: most specific first, broadest last ===
    
    // 1. WEATHER — check FIRST (before food, to avoid "eat" in "weather")
    //    Includes Hindi: barish, mausam, thand, thandi, garmi, sardi, dhoop
    //    Includes misspellings: temprature, tempreature
    if (lowered.includes('weather') || lowered.includes('temperature') || 
        lowered.includes('temprature') || lowered.includes('tempreature') ||
        lowered.includes('barish') || lowered.includes('baarish') || lowered.includes('mausam') ||
        lowered.includes('thand') || lowered.includes('thandi') ||
        lowered.includes('garmi') || lowered.includes('sardi') || lowered.includes('dhoop') ||
        /\b(rain|rainy|sunny|cloudy|humidity|forecast|temp)\b/.test(lowered) ||
        /will it rain|how('?s| is) (it |the )?(outside|climate)/.test(lowered)) {
      return 'weather';
    }
    
    // 2. SPECIFIC APP NAMES — route to their category before anything else
    //    "swiggy" = food, "zomato" = food, "uber" = cab, etc.
    //    This prevents "zomato" from matching stock symbol map
    if (lowered.includes('swiggy') || lowered.includes('zomato')) return 'food';
    if (lowered.includes('uber') || lowered.includes('ola') || 
        lowered.includes('rapido') || lowered.includes('namma') || lowered.includes('yatri')) return 'cab';
    
    // 3. STOCKS — keywords and individual stock names
    const stockKeywords = [
      'stock', 'sensex', 'nifty', 'market', 'share price', 'nasdaq', 'dow', 's&p', 'us market',
      'mutual fund', 'mf', 'sip', 'groww', 'zerodha',
    ];
    if (stockKeywords.some(k => lowered.includes(k))) return 'stocks';
    if (detectIndividualStock(text)) return 'stocks';
    
    // 4. CRICKET
    if (lowered.includes('cricket') || lowered.includes('ipl') ||
        /\b(score|match)\b/.test(lowered)) {
      return 'cricket';
    }
    
    // 5. CALENDAR
    //    "today" and "tomorrow" are ambiguous — "today lunch" should be food, not calendar
    //    Only use today/tomorrow for calendar if no other category word is present
    if (lowered.includes('calendar') || lowered.includes('meeting') ||
        lowered.includes('schedule')) {
      return 'calendar';
    }
    if ((lowered.includes('today') || lowered.includes('tomorrow') || lowered.includes('event')) &&
        !(/\b(food|hungry|lunch|dinner|eat|khana|cab|ride|uber|ola|taxi|stock|market|nifty|sensex|cricket|ipl|match|score|weather|rain|play|watch|song)\b/.test(lowered))) {
      return 'calendar';
    }
    
    // 6. CAB (generic keywords — specific app names already caught above)
    //    "drop" only in cab context: "drop me", "drop to [place]"
    //    "auto" uses word boundary to avoid "automatic"
    if (lowered.includes('cab') || lowered.includes('ride') ||
        lowered.includes('bike taxi') || lowered.includes('taxi') || 
        lowered.includes('commute') || /\bauto\b/.test(lowered) ||
        /\bdrop\s+(me|to|at|home|office)\b/.test(lowered)) {
      return 'cab';
    }
    
    // 7. FOOD (generic keywords — swiggy/zomato already caught above)
    //    NOTE: "eat" uses word boundary to avoid matching "create", "beat", "great", "theater"
    if (lowered.includes('food') || lowered.includes('hungry') ||
        lowered.includes('biryani') || lowered.includes('pizza') ||
        lowered.includes('dinner') || lowered.includes('lunch') ||
        lowered.includes('restaurant') || lowered.includes('deliver') ||
        lowered.includes('order food') || lowered.includes('khana') ||
        /\b(eat|eating|kha|khane)\b/.test(lowered)) {
      return 'food';
    }
    
    // 8. MEDIA / CONTENT — detect intent via trigger words
    //    "play X", "watch X", "X song", "X trailer", "X highlights"
    if (/\b(play|watch|listen|song|songs|video|movie|show|series|podcast|trailer|highlights|episode|scene|interview|chalisa|bhajan|aarti|qawwali)\b/.test(lowered) ||
        lowered.includes('youtube')) {
      return 'media';
    }
    
    return 'general';
  };

  // ============================================
  // PATTERN TRACKING
  // ============================================
  const updatePatterns = async (queryType) => {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay();
    
    const newPatterns = { ...patterns };
    
    if (!newPatterns[queryType]) {
      newPatterns[queryType] = {
        count: 0,
        times: [],
        days: [],
        lastQueried: null,
      };
    }
    
    newPatterns[queryType].count++;
    newPatterns[queryType].times.push(hour);
    newPatterns[queryType].days.push(day);
    newPatterns[queryType].lastQueried = now.toISOString();
    
    // Keep only last 50 times/days for analysis
    if (newPatterns[queryType].times.length > 50) {
      newPatterns[queryType].times = newPatterns[queryType].times.slice(-50);
      newPatterns[queryType].days = newPatterns[queryType].days.slice(-50);
    }
    
    setPatterns(newPatterns);
    await AsyncStorage.setItem(STORAGE_KEYS.patterns, JSON.stringify(newPatterns));
    
    // Update history
    const newHistory = [
      { query, type: queryType, timestamp: now.toISOString() },
      ...queryHistory.slice(0, 49),
    ];
    setQueryHistory(newHistory);
    await AsyncStorage.setItem(STORAGE_KEYS.history, JSON.stringify(newHistory));
  };

  // ============================================
  // HANDLE SUBMIT
  // ============================================
  const handleSubmit = async () => {
    if (!query.trim()) return;
    
    setLoading(true);
    setResponse(null);
    trackEvent('query_submitted', { query: query.trim().toLowerCase().substring(0, 50) });
    const queryType = detectQueryType(query);
    
    try {
      let result;
      // Route status check (mumbai pune, del jai, etc.)
      const routeIntent = detectRouteIntent(query);
      if (routeIntent) {
        const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
        const data = await fetchRouteStatus(routeIntent.origin, routeIntent.destination);
        if (data && !data.error) {
          result = {
            type: 'route',
            title: `${cap(data.route.origin)} → ${cap(data.route.destination)}`,
            highway: data.route.highway,
            distance: `${data.route.distance_km} km`,
            toll: data.route.toll,
            driveTime: `${data.drive_time_min || data.route.typical_drive_min} min`,
            status: data.status,
            summary: data.summary,
            confidence: data.confidence,
            sourcesChecked: data.sources_checked,
          };
          setResponse(result);
          setLoading(false);
          return;
        }
      }
      switch (queryType) {
        case 'stocks':
          // Check if pre-loaded
          if (preloadedData?.stocks) {
            result = preloadedData.stocks;
            setPreloadedData(prev => ({ ...prev, stocks: null }));
          } else {
            const lowQ = query.toLowerCase();
            const isUS = lowQ.includes('nasdaq') || lowQ.includes('dow') || lowQ.includes('s&p') || lowQ.includes('us market');
            
            // v0.4: Check for individual stock
            const individualStock = detectIndividualStock(query);
            if (individualStock && individualStock.symbol) {
              // Fetch individual stock + indices together
              const [individual, indices] = await Promise.all([
                fetchNSEStocks(individualStock.symbol),
                fetchNSEStocks(null, 'india'),
              ]);
              // Merge: individual stock on top, then indices
              const allData = [
                ...(individual.data || []),
                ...(indices.data || []),
              ];
              result = { type: 'stocks', data: allData, timestamp: new Date().toLocaleTimeString() };
            } else if (individualStock && !individualStock.symbol) {
              // Mutual fund keywords — show indices + note
              result = await fetchNSEStocks(null, 'india');
              result.mutualFundNote = 'Individual mutual fund tracking is coming soon. Showing index performance.';
            } else {
              result = await fetchNSEStocks(null, isUS ? 'us' : 'india');
            }
          }
          break;
          
        case 'food':
          // If user typed a specific food app name, open it directly
          const foodLow = query.toLowerCase();
          if (foodLow.includes('swiggy')) {
            result = { type: 'food', connected: true, source: 'Swiggy', message: 'Open Swiggy', deepLink: 'swiggy://', webUrl: 'https://www.swiggy.com' };
          } else if (foodLow.includes('zomato')) {
            result = { type: 'food', connected: true, source: 'Zomato', message: 'Open Zomato', deepLink: 'zomato://', webUrl: 'https://www.zomato.com' };
          } else {
            result = await handleFoodQuery();
          }
          break;
          
        case 'calendar':
          result = await handleCalendarQuery();
          break;
          
        case 'cricket':
          result = await fetchCricketScores();
          // Track cricket check behavior
          try {
            const cLog = await AsyncStorage.getItem(STORAGE_KEYS.cricketCheckLog);
            const log = cLog ? JSON.parse(cLog) : [];
            log.unshift({ timestamp: Date.now(), hour: new Date().getHours(), day: new Date().getDay() });
            if (log.length > 200) log.length = 200;
            await AsyncStorage.setItem(STORAGE_KEYS.cricketCheckLog, JSON.stringify(log));
          } catch (e) {}
          break;
          
        case 'cab':
          // If user typed a specific cab app name, open it directly
          const cabLow = query.toLowerCase();
          const directCab = cabLow.includes('uber') ? { name: 'Uber', scheme: 'uber://', web: 'https://m.uber.com' }
            : cabLow.includes('ola') ? { name: 'Ola', scheme: 'olacabs://', web: 'https://www.olacabs.com' }
            : cabLow.includes('rapido') ? { name: 'Rapido', scheme: 'rapido://', web: 'https://www.rapido.bike' }
            : (cabLow.includes('namma') || cabLow.includes('yatri')) ? { name: 'Namma Yatri', scheme: 'nammayatri://', web: 'https://nammayatri.in' }
            : null;
          
          if (directCab) {
            result = { type: 'cab', connected: true, source: directCab.name, message: `Open ${directCab.name}`, deepLink: directCab.scheme, webUrl: directCab.web };
          } else {
            result = await handleCabQuery();
          }
          break;
          
        default:
          // Handle new query types with friendly responses
          if (queryType === 'onboarding') {
            result = {
              type: 'general',
              message: `Hey! 👋 I'm un-app — I learn what you need and when.\n\nTry typing:\n📈 "reliance" or "nifty"\n🍕 "hungry" or "swiggy"\n🚕 "uber" or "cab"\n🏏 "cricket"\n📅 "calendar"\n🌤️ "weather" or "barish"\n▶️ "play hanuman chalisa" or "arijit singh song"\n\nThe more you use me, the better I get.`,
            };
          } else if (queryType === 'weather') {
            // v0.4: Actual weather fetch
            const location = userLocation || { lat: 19.076, lng: 72.8777 };
            // Extract city name: strip ALL weather trigger words (English + Hindi)
            const cityMatch = query.toLowerCase()
              .replace(/\b(weather|rain|rainy|sunny|cloudy|humidity|forecast|temperature|temprature|tempreature|temp|climate|barish|baarish|mausam|thand|thandi|garmi|sardi|dhoop|will|it|in|how|is|the|like|outside|what|kya|aaj|ka|ke|today|kal)\b/g, '')
              .trim();
            result = await fetchWeather(location.lat, location.lng, cityMatch.length > 2 ? cityMatch : null);
            await updatePatterns('weather');
          } else if (queryType === 'media') {
            // v0.4: All content → YouTube with search query
            // Strip trigger words but keep the actual content
            const contentQuery = query.replace(/\b(play|watch|listen|listen to|open|show me|on|search|find|songs? of|songs? by|video of|videos? of|youtube|on youtube|trailer of|highlights of)\b/gi, '').trim();
            
            const encoded = contentQuery.length > 1 ? encodeURIComponent(contentQuery) : '';
            const searchScheme = encoded ? `youtube://results?search_query=${encoded}` : 'youtube://';
            const searchWeb = encoded ? `https://www.youtube.com/results?search_query=${encoded}` : 'https://www.youtube.com';
            
            result = {
              type: 'media',
              apps: [{ scheme: searchScheme, web: searchWeb, name: 'YouTube', emoji: '▶️' }],
              targetApp: 'youtube',
              contentQuery: contentQuery || null,
              message: contentQuery && contentQuery.length > 1 
                ? `▶️ "${contentQuery}" on YouTube` 
                : 'Open YouTube',
            };
          } else {
            // Before giving up, try as unknown stock ticker (single word, 2-15 chars, all letters)
            // But skip common English words that are definitely NOT tickers
            const trimmed = query.trim();
            const COMMON_WORDS = new Set([
              'the','and','for','are','but','not','you','all','can','had','her','was','one','our',
              'out','has','his','how','its','may','new','now','old','see','way','who','did','get',
              'got','let','say','she','too','use','yes','no','ok','hi','hey','hello','bye','thanks',
              'thank','please','sorry','good','bad','nice','great','cool','fine','sure','well','just',
              'like','what','when','where','why','how','this','that','with','from','will','have','been',
              'more','some','than','them','then','they','time','very','your','about','could','after',
              'make','much','also','back','only','come','made','find','here','know','take','want',
              'give','most','help','test','create','done','next','best','open','close','start','stop',
              'send','save','edit','read','work','name','home','page','app','data','info','news',
            ]);
            const looksLikeStock = /^[a-zA-Z]{2,15}$/i.test(trimmed) && !COMMON_WORDS.has(trimmed.toLowerCase());
            if (looksLikeStock) {
              try {
                const trySymbol = `${trimmed.toUpperCase()}.NS`;
                const tryResult = await fetchNSEStocks(trySymbol);
                if (tryResult?.data?.length > 0 && tryResult.data[0].price !== '0.00') {
                  // It's a valid stock! Show it with indices
                  const indices = await fetchNSEStocks(null, 'india');
                  result = { 
                    type: 'stocks', 
                    data: [...tryResult.data, ...(indices.data || [])], 
                    timestamp: new Date().toLocaleTimeString() 
                  };
                  // Track as stocks
                  await updatePatterns('stocks');
                  setResponse(result);
                  if (result?.data?.length > 0) await storeLastStockCheck(result);
                  setLoading(false);
                  return;
                }
              } catch (e) { /* not a stock, continue to fallback */ }
            }
            
            // Smarter fallback: if query looks like a person/song name, suggest contextually
            // Multi-word = person name → suggest play, NOT stock (no one checks "virat kohli stock")
            // Single word = could be ticker → suggest both play and stock
            const words = query.trim().split(/\s+/);
            const looksLikeName = words.length <= 3 && words.every(w => /^[a-zA-Z]+$/.test(w));
            const isMultiWord = words.length >= 2;
            
            result = {
              type: 'general',
              message: looksLikeName 
                ? (isMultiWord
                  ? `Looking for "${query.trim()}"?\n\n▶️ "play ${query.trim()}" → YouTube\n🏏 "${query.trim()} cricket" → scores\n\nOr try: food, cab, weather, calendar`
                  : `Looking for "${query.trim()}"? Try:\n\n▶️ "play ${query.trim()}" → YouTube\n📈 "${query.trim()} stock" → stock price\n\nOr try: food, cab, cricket, weather, calendar`)
                : `I don't handle that yet, but I'm learning.\n\nTry:\n📈 "tcs" or "nifty"\n🍕 "hungry" or "swiggy"\n🚕 "uber" or "cab"\n🏏 "cricket"\n📅 "calendar"\n🌤️ "weather"\n▶️ For music/video: "play [name]"`,
            };
            captureIntent(query.trim());
          }
      }
      
      setResponse(result);
      
      // Bug fix 1: Remove contextual cards for this category and prevent regeneration
      if (result?.type && ['stocks', 'food', 'food_compare', 'cab', 'cab_compare', 'calendar', 'eventkit_calendar', 'cricket', 'weather', 'media'].includes(result.type)) {
        const dismissType = result.type === 'eventkit_calendar' ? 'calendar' 
          : result.type === 'cab_compare' ? 'cab'
          : result.type === 'food_compare' ? 'food'
          : result.type;
        setDismissedCategories(prev => new Set([...prev, dismissType]));
        setContextCards(prev => prev.filter(c => c.category !== dismissType));
      }
      
      // Bug fix 2: Only track patterns for valid categories
      if (['stocks', 'food', 'cab', 'calendar', 'cricket', 'weather', 'media'].includes(queryType)) {
        await updatePatterns(queryType);
      }
      
      // Feature 3: Track prediction accuracy (only for typed queries, not card taps)
      if (currentPredictionRef.current && ['stocks', 'food', 'cab', 'calendar', 'cricket', 'weather', 'media'].includes(queryType)) {
        await trackPredictionResult(currentPredictionRef.current, queryType);
      }
      
      // Feature 4: Store stock checkpoint
      if (queryType === 'stocks' && result?.data?.length > 0) {
        await storeLastStockCheck(result);
      }
      
    } catch (error) {
      console.log('Query error:', error);
      setResponse({
        type: 'error',
        message: 'Something broke on our end. Give it another shot.',
      });
    } finally {
      setLoading(false);
      setQuery('');
    }
  };

  // ============================================
  // FOOD QUERY (v0.3: MCP GATEWAY FOR COMPARISON)
  // ============================================
  const handleFoodQuery = async () => {
    const isSwiggyConnected = connectedServices.swiggy;
    const isZomatoConnected = connectedServices.zomato;
    
    if (!isSwiggyConnected && !isZomatoConnected) {
      return {
        type: 'food',
        needsConnection: true,
        message: 'Connect to order food',
        services: ['swiggy', 'zomato'],
      };
    }
    
    const queryLower = query.toLowerCase();
    const wantsSwiggy = queryLower.includes('swiggy');
    const wantsZomato = queryLower.includes('zomato');
    
    // If specific service mentioned, open that one directly
    if (wantsSwiggy && isSwiggyConnected) {
      return { type: 'food', connected: true, source: 'Swiggy', message: 'Open Swiggy to order', deepLink: 'swiggy://' };
    }
    if (wantsZomato && isZomatoConnected) {
      return { type: 'food', connected: true, source: 'Zomato', message: 'Open Zomato to order', deepLink: 'zomato://' };
    }
    
    // v0.3: Try MCP gateway for Swiggy vs Zomato comparison
    if (isSwiggyConnected || isZomatoConnected) {
      try {
        // Load cuisine preference
        let cuisinePref = null;
        try {
          cuisinePref = await AsyncStorage.getItem(STORAGE_KEYS.cuisinePreference);
        } catch (e) {}
        
        // Use device GPS, fallback to Mumbai center
        const location = userLocation || { lat: 19.076, lng: 72.8777 };
        
        const comparison = await fetchFoodCompare(location.lat, location.lng, cuisinePref);
        
        if (comparison && comparison.platforms) {
          const fetchedAt = Date.now();
          try {
            await AsyncStorage.setItem(STORAGE_KEYS.lastFoodCompare, JSON.stringify({ ...comparison, fetchedAt }));
          } catch (e) {}
          
          trackEvent('mcp_fetch', { service: 'food', cache_hit: false });
          
          return {
            type: 'food_compare',
            connected: true,
            comparison,
            fetchedAt,
            swiggyConnected: isSwiggyConnected,
            zomatoConnected: isZomatoConnected,
            message: 'Restaurant comparison',
          };
        }
      } catch (e) {
        console.log('MCP food fetch failed, falling back:', e);
      }
    }
    
    // Fallback: show both options (v0.2 behavior)
    return {
      type: 'food',
      connected: true,
      showBoth: true,
      swiggyConnected: isSwiggyConnected,
      zomatoConnected: isZomatoConnected,
      message: 'Choose where to order',
    };
  };

  // ============================================
  // CALENDAR QUERY
  // ============================================
  const handleCalendarQuery = async () => {
    // v0.2: Use native EventKit instead of Google Calendar OAuth
    const result = await fetchCalendarInsights();
    
    if (result.denied) {
      return {
        type: 'calendar',
        needsPermission: true,
        message: 'Grant calendar access to see your schedule',
      };
    }
    if (result.error) {
      return { type: 'calendar', error: result.error, message: result.error };
    }
    return result;
  };

  // ============================================
  // DEEP LINK HELPER (TRY APP, FALLBACK TO WEB)
  // ============================================
  const openWithFallback = async (deepLink, webUrl) => {
    try {
      // Try opening app directly (same as food deep links)
      await Linking.openURL(deepLink);
    } catch (e) {
      // App not installed or scheme not supported, open web
      try {
        await Linking.openURL(webUrl);
      } catch (e2) {
        console.log('Could not open:', deepLink, webUrl);
      }
    }
  };

  const CAB_WEB_URLS = {
    'nammayatri://': 'https://nammayatri.in',
    'uber://': 'https://m.uber.com',
    'olacabs://': 'https://www.olacabs.com',
    'rapido://': 'https://www.rapido.bike',
  };

  // ============================================
  // CAB QUERY (v0.3: MCP GATEWAY FOR LIVE PRICING)
  // ============================================
  const handleCabQuery = async () => {
    const isNammaConnected = connectedServices.nammaYatri;
    const isUberConnected = connectedServices.uber;
    const isOlaConnected = connectedServices.ola;
    const isRapidoConnected = connectedServices.rapido;
    
    if (!isNammaConnected && !isUberConnected && !isOlaConnected && !isRapidoConnected) {
      return {
        type: 'cab',
        needsConnection: true,
        message: 'Connect to book a ride',
        services: ['nammaYatri', 'uber', 'ola', 'rapido'],
      };
    }
    
    const queryLower = query.toLowerCase();
    const wantsNamma = queryLower.includes('namma') || queryLower.includes('yatri');
    const wantsUber = queryLower.includes('uber');
    const wantsOla = queryLower.includes('ola');
    const wantsRapido = queryLower.includes('rapido') || queryLower.includes('bike');
    
    if (wantsNamma && isNammaConnected) {
      return { type: 'cab', connected: true, source: 'Namma Yatri', message: 'Open Namma Yatri', deepLink: 'nammayatri://' };
    }
    if (wantsRapido && isRapidoConnected) {
      return { type: 'cab', connected: true, source: 'Rapido', message: 'Open Rapido', deepLink: 'rapido://' };
    }

    // v0.3: Try MCP gateway for live pricing
    if (isUberConnected || isOlaConnected || isRapidoConnected) {
      try {
        // Use device GPS for pickup, offset ~5km for dropoff estimate
        // CoreML will predict actual destination later
        const pickup = userLocation || { lat: 19.076, lng: 72.8777 };
        const dropoff = { lat: pickup.lat + 0.035, lng: pickup.lng + 0.025 };
        
        const estimate = await fetchCabEstimate(pickup.lat, pickup.lng, dropoff.lat, dropoff.lng);
        
        if (estimate && estimate.providers) {
          const fetchedAt = Date.now();
          // Cache it
          try {
            await AsyncStorage.setItem(STORAGE_KEYS.lastCabEstimate, JSON.stringify({ ...estimate, fetchedAt }));
          } catch (e) {}
          
          trackEvent('mcp_fetch', { service: 'cab', cache_hit: false });
          
          return {
            type: 'cab_compare',
            connected: true,
            estimate,
            fetchedAt,
            uberConnected: isUberConnected,
            olaConnected: isOlaConnected,
            rapidoConnected: isRapidoConnected,
            message: 'Live cab pricing',
          };
        }
      } catch (e) {
        console.log('MCP cab fetch failed, falling back:', e);
      }
    }
    
    // Fallback: show all connected services (v0.2 behavior)
    if (wantsUber && isUberConnected) {
      return { type: 'cab', connected: true, source: 'Uber', message: 'Open Uber', deepLink: 'uber://' };
    }
    if (wantsOla && isOlaConnected) {
      return { type: 'cab', connected: true, source: 'Ola', message: 'Open Ola', deepLink: 'olacabs://' };
    }
    
    return {
      type: 'cab',
      connected: true,
      showAll: true,
      nammaConnected: isNammaConnected,
      uberConnected: isUberConnected,
      olaConnected: isOlaConnected,
      rapidoConnected: isRapidoConnected,
      message: 'Choose your ride',
    };
  };

  // ============================================
  // OAUTH HANDLING
  // ============================================
  const initiateOAuth = async (service) => {
    // Bug fix 3: For cab and food services, just mark as connected and open externally
    // No actual OAuth needed — these are deeplink-only integrations
    const deepLinkServices = {
      uber: 'uber://',
      ola: 'olacabs://',
      rapido: 'rapido://',
      nammaYatri: 'nammayatri://',
      swiggy: 'swiggy://',
      zomato: 'zomato://',
    };
    
    if (deepLinkServices[service]) {
      // Mark as connected
      const newConnected = { ...connectedServices, [service]: true };
      setConnectedServices(newConnected);
      await AsyncStorage.setItem(STORAGE_KEYS.connectedServices, JSON.stringify(newConnected));
      await AsyncStorage.setItem(STORAGE_KEYS[`${service}Token`], 'session_active');
      trackEvent('service_connected', { service });
      
      // Try opening the native app
      try {
        const canOpen = await Linking.canOpenURL(deepLinkServices[service]);
        if (canOpen) {
          await Linking.openURL(deepLinkServices[service]);
        } else {
          // App not installed — open web fallback
          const webFallbacks = {
            uber: 'https://m.uber.com',
            ola: 'https://www.olacabs.com',
            rapido: 'https://www.rapido.bike',
            nammaYatri: 'https://nammayatri.in',
            swiggy: 'https://www.swiggy.com',
            zomato: 'https://www.zomato.com',
          };
          if (webFallbacks[service]) await Linking.openURL(webFallbacks[service]);
        }
      } catch (e) {
        console.log(`Could not open ${service}:`, e);
      }
      
      setResponse(null);
      return;
    }
    
    // Calendar still uses in-app flow
    setCurrentOAuthService(service);
    
    let authUrl;
    
    switch (service) {
      case 'swiggy':
        // Swiggy login - user logs in on swiggy.com, session carries over
        authUrl = 'https://www.swiggy.com/auth';
        break;
        
      case 'zomato':
        authUrl = 'https://www.zomato.com/login';
        break;
        
      case 'calendar':
        authUrl = 'https://calendar.google.com';
        break;
        
      case 'nammaYatri':
        authUrl = 'https://nammayatri.in';
        break;
        
      case 'uber':
        authUrl = 'https://m.uber.com';
        break;
        
      case 'ola':
        authUrl = 'https://www.olacabs.com';
        break;
        
      case 'rapido':
        authUrl = 'https://www.rapido.bike';
        break;
    }
    
    if (authUrl) {
      setOauthUrl(authUrl);
      setShowOAuthModal(true);
    }
  };

  const handleOAuthCallback = async (url) => {
    // For MVP: Mark as connected when user completes login
    const newConnected = { ...connectedServices, [currentOAuthService]: true };
    setConnectedServices(newConnected);
    await AsyncStorage.setItem(STORAGE_KEYS.connectedServices, JSON.stringify(newConnected));
    trackEvent('service_connected', { service: currentOAuthService });
    await AsyncStorage.setItem(STORAGE_KEYS[`${currentOAuthService}Token`], 'session_active');
    
    setShowOAuthModal(false);
    setCurrentOAuthService(null);
  };

  const handleOAuthClose = async () => {
    // When user closes after logging in, mark as connected
    if (currentOAuthService) {
      const newConnected = { ...connectedServices, [currentOAuthService]: true };
      setConnectedServices(newConnected);
      await AsyncStorage.setItem(STORAGE_KEYS.connectedServices, JSON.stringify(newConnected));
      await AsyncStorage.setItem(STORAGE_KEYS[`${currentOAuthService}Token`], 'session_active');
    }
    
    setShowOAuthModal(false);
    setCurrentOAuthService(null);
  };

  // ============================================
  // PRIVACY ACKNOWLEDGMENT
  // ============================================
  const handleDataConsent = async (granted) => {
    if (granted) {
      await AsyncStorage.setItem(STORAGE_KEYS.dataConsent, 'granted');
      await AsyncStorage.setItem(STORAGE_KEYS.privacyAcknowledged, 'true');
      setDataConsentGiven(true);
      setShowPrivacyNotice(false);
      trackEvent('data_consent_granted');
    } else {
      // User declined — keep showing consent, can't use app without it
      Alert.alert(
        'Data sharing required',
        'un-app needs to process data with AI services to work. You can revoke consent anytime in Settings.',
        [{ text: 'OK' }]
      );
    }
  };

  // ============================================
  // RENDER FUNCTIONS
  // ============================================
  
  // Apple-compliant Data Consent Screen (5.1.1 + 5.1.2)
  const renderPrivacyNotice = () => (
    <Modal visible={showPrivacyNotice} animationType="fade" transparent={false}>
      <SafeAreaView style={{ flex: 1, backgroundColor: THEME.black }}>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 48, paddingBottom: 24 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: THEME.lime, letterSpacing: 2, marginBottom: 32 }}>UN-APP</Text>
          <Text style={{ fontSize: 26, fontWeight: '700', color: THEME.white, marginBottom: 12 }}>Before we begin</Text>
          <Text style={{ fontSize: 15, color: '#999', lineHeight: 22, marginBottom: 28 }}>
            un-app uses AI to learn your patterns and surface the right info at the right time. Here's how your data is handled.
          </Text>

          {/* What we collect */}
          <Text style={{ fontSize: 16, fontWeight: '600', color: THEME.lime, marginBottom: 10 }}>What data we collect</Text>
          <Text style={{ fontSize: 14, color: '#ccc', lineHeight: 22, marginBottom: 24 }}>
            {'• App usage patterns and timing signals\n• Device context (time of day, day of week)\n• Coarse location (for weather and nearby services)\n• Calendar event metadata (titles, times, durations)\n• Your interactions within un-app (queries, taps)'}
          </Text>

          {/* Who we share with */}
          <Text style={{ fontSize: 16, fontWeight: '600', color: THEME.lime, marginBottom: 10 }}>Who we share it with</Text>
          
          <View style={{ backgroundColor: '#111', borderRadius: 10, padding: 14, marginBottom: 10 }}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: THEME.white, marginBottom: 4 }}>Anthropic (Claude API)</Text>
            <Text style={{ fontSize: 13, color: '#999', lineHeight: 20 }}>
              Processes your queries and generates behavioral insights. Data sent: your questions, anonymized usage patterns. Anthropic does not use API data to train models.
            </Text>
          </View>

          <View style={{ backgroundColor: '#111', borderRadius: 10, padding: 14, marginBottom: 10 }}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: THEME.white, marginBottom: 4 }}>Supabase</Text>
            <Text style={{ fontSize: 13, color: '#999', lineHeight: 20 }}>
              Stores anonymized analytics (interaction events, session data). No personal content is stored.
            </Text>
          </View>

          <View style={{ backgroundColor: '#111', borderRadius: 10, padding: 14, marginBottom: 10 }}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: THEME.white, marginBottom: 4 }}>Third-party APIs</Text>
            <Text style={{ fontSize: 13, color: '#999', lineHeight: 20 }}>
              Stock data via Yahoo Finance, cricket scores via CricAPI. Only market/score queries are sent — no personal data.
            </Text>
          </View>

          {/* How protected */}
          <Text style={{ fontSize: 16, fontWeight: '600', color: THEME.lime, marginTop: 14, marginBottom: 10 }}>How your data is protected</Text>
          <Text style={{ fontSize: 14, color: '#ccc', lineHeight: 22, marginBottom: 24 }}>
            All data is transmitted over encrypted connections (TLS). We collect the minimum data needed. We do not sell your data or use it for advertising. Third-party providers maintain equivalent or stronger data protection.
          </Text>

          {/* Privacy policy link */}
          <TouchableOpacity onPress={() => Linking.openURL('https://overview-un-app.netlify.app/privacy')}>
            <Text style={{ fontSize: 14, color: THEME.lime, fontWeight: '500', marginBottom: 24 }}>Read our full Privacy Policy →</Text>
          </TouchableOpacity>
        </ScrollView>

        {/* Buttons */}
        <View style={{ paddingHorizontal: 24, paddingBottom: 24 }}>
          <TouchableOpacity 
            style={{ backgroundColor: THEME.lime, borderRadius: 12, paddingVertical: 16, alignItems: 'center', marginBottom: 10 }} 
            onPress={() => handleDataConsent(true)}
          >
            <Text style={{ fontSize: 16, fontWeight: '700', color: THEME.black }}>Allow & Continue</Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={{ backgroundColor: 'transparent', borderRadius: 12, borderWidth: 1, borderColor: '#333', paddingVertical: 14, alignItems: 'center', marginBottom: 12 }} 
            onPress={() => handleDataConsent(false)}
          >
            <Text style={{ fontSize: 15, fontWeight: '500', color: '#666' }}>Don't Allow</Text>
          </TouchableOpacity>
          <Text style={{ fontSize: 12, color: '#555', textAlign: 'center', lineHeight: 18 }}>
            You can change this anytime in Settings.
          </Text>
        </View>
      </SafeAreaView>
    </Modal>
  );

  // OAuth WebView Modal
  const renderOAuthModal = () => (
    <Modal visible={showOAuthModal} animationType="slide">
      <SafeAreaView style={styles.oauthContainer}>
        <View style={styles.oauthHeader}>
          <TouchableOpacity onPress={async () => {
            if (currentOAuthService) {
              await AsyncStorage.setItem(
                STORAGE_KEYS[`${currentOAuthService}Token`], 
                'session_active'
              );
              const newConnected = { ...connectedServices, [currentOAuthService]: true };
              setConnectedServices(newConnected);
              await AsyncStorage.setItem(STORAGE_KEYS.connectedServices, JSON.stringify(newConnected));
            }
            setResponse(null);
            setShowOAuthModal(false);
            setCurrentOAuthService(null);
          }}>
            <Text style={styles.oauthClose}>✕ Done</Text>
          </TouchableOpacity>
          <Text style={styles.oauthTitle}>
            Connect {currentOAuthService?.charAt(0).toUpperCase() + currentOAuthService?.slice(1)}
          </Text>
          <View style={{ width: 60 }} />
        </View>
        
        <Text style={styles.oauthNote}>
          You're logging in directly with {currentOAuthService}. We never see your credentials.
        </Text>
        
        <WebView
          source={{ uri: oauthUrl }}
          onNavigationStateChange={(navState) => {
            if (navState.url.startsWith('http://localhost')) {
              handleOAuthCallback(navState.url);
            }
          }}
          style={styles.webview}
        />
      </SafeAreaView>
    </Modal>
  );

  // Response Card
  const renderResponse = () => {
    if (!response) return null;
    
    switch (response.type) {
      case 'stocks':
        const sinceCheck = getSinceLastCheck(response);
        return (
          <View style={styles.responseCard}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={styles.responseTitle}>📈 Market Update</Text>
              <TouchableOpacity 
                onPress={async () => {
                  setLoading(true);
                  // Re-fetch whatever stocks were shown
                  const individualStock = response.data?.find(s => !['NIFTY 50', 'SENSEX', 'NASDAQ', 'DOW JONES', 'S&P 500'].includes(s.symbol));
                  let refreshed;
                  if (individualStock) {
                    const sym = `${individualStock.symbol}.NS`;
                    const [indiv, indices] = await Promise.all([
                      fetchNSEStocks(sym),
                      fetchNSEStocks(null, 'india'),
                    ]);
                    refreshed = { type: 'stocks', data: [...(indiv.data || []), ...(indices.data || [])], timestamp: new Date().toLocaleTimeString() };
                  } else {
                    const isUS = response.data?.some(s => ['NASDAQ', 'DOW JONES', 'S&P 500'].includes(s.symbol));
                    refreshed = await fetchNSEStocks(null, isUS ? 'us' : 'india');
                  }
                  setResponse(refreshed);
                  if (refreshed?.data?.length > 0) await storeLastStockCheck(refreshed);
                  trackEvent('card_refresh_tap', { card_type: 'stocks' });
                  setLoading(false);
                }}
                style={{ padding: 6 }}
              >
                <Text style={{ fontSize: 14, color: THEME.lime }}>↻ Refresh</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.responseTime}>{response.timestamp}</Text>
            
            {sinceCheck && (
              <View style={styles.sinceCheckWrap}>
                <Text style={styles.sinceCheckLabel}>Since you checked at {sinceCheck.timeLabel} ({sinceCheck.timeAgo})</Text>
                {sinceCheck.deltas.map((d, i) => (
                  <Text key={i} style={[styles.sinceCheckDelta, { color: d.isUp ? '#00ff00' : '#ff4444' }]}>
                    {d.symbol} {d.isUp ? '▲' : '▼'} {d.change}%
                  </Text>
                ))}
              </View>
            )}
            
            {response.data && response.data.length > 0 ? response.data.map((stock, index) => {
              const isUS = ['NASDAQ', 'DOW JONES', 'S&P 500'].includes(stock.symbol);
              const currency = isUS ? '$' : '₹';
              return (
                <View key={index} style={styles.stockRow}>
                  <Text style={styles.stockSymbol}>{stock.symbol}</Text>
                  <View style={styles.stockRight}>
                    <Text style={styles.stockPrice}>{currency}{stock.price}</Text>
                    <Text style={[
                      styles.stockChange,
                      { color: stock.isUp ? '#00ff00' : '#ff4444' }
                    ]}>
                      {stock.isUp ? '▲' : '▼'} {stock.changePercent}%
                    </Text>
                  </View>
                </View>
              );
            }) : null}
            
            {response.error && (
              <Text style={styles.errorText}>{response.error}</Text>
            )}
            
            {response.mutualFundNote && (
              <Text style={{ fontSize: 12, color: THEME.lime, marginTop: 8, fontStyle: 'italic' }}>{response.mutualFundNote}</Text>
            )}
          </View>
        );
        case 'route':
        const statusColors = { clear: '#22C55E', likely_clear: '#22C55E', delayed: '#F59E0B', heavy: '#EF4444', unknown: '#888' };
        const statusLabels = { clear: 'CLEAR', likely_clear: 'LIKELY CLEAR', delayed: 'DELAYS', heavy: 'HEAVY', unknown: 'CHECKING' };
        const rColor = statusColors[response.status] || '#888';
        return (
          <View style={[styles.responseCard, { borderLeftWidth: 4, borderLeftColor: rColor }]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <Text style={styles.responseTitle}>{response.title}</Text>
              <View style={{ backgroundColor: rColor + '22', paddingHorizontal: 10, paddingVertical: 3, borderRadius: 12 }}>
                <Text style={{ color: rColor, fontSize: 11, fontWeight: '700' }}>{statusLabels[response.status] || 'CHECKING'}</Text>
              </View>
            </View>
            <Text style={{ color: '#E5E5E5', fontSize: 14, lineHeight: 20, marginBottom: 10 }}>{response.summary}</Text>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
              <View style={{ alignItems: 'center', flex: 1 }}>
                <Text style={{ color: '#A3E635', fontSize: 18, fontWeight: '700' }}>{response.driveTime}</Text>
                <Text style={{ color: '#888', fontSize: 10, marginTop: 2 }}>DRIVE</Text>
              </View>
              <View style={{ alignItems: 'center', flex: 1 }}>
                <Text style={{ color: '#FFF', fontSize: 14, fontWeight: '600' }}>{response.distance}</Text>
                <Text style={{ color: '#888', fontSize: 10, marginTop: 2 }}>DISTANCE</Text>
              </View>
              <View style={{ alignItems: 'center', flex: 1 }}>
                <Text style={{ color: '#FFF', fontSize: 14, fontWeight: '600' }}>{response.toll}</Text>
                <Text style={{ color: '#888', fontSize: 10, marginTop: 2 }}>TOLL</Text>
              </View>
            </View>
            <View style={{ borderTopWidth: 1, borderTopColor: '#333', paddingTop: 6 }}>
              <Text style={{ color: '#666', fontSize: 10 }}>via {response.highway} • Polled from {response.sourcesChecked} source{response.sourcesChecked !== 1 ? 's' : ''} • {response.confidence} confidence</Text>
            </View>
          </View>
        );
      case 'food':
        if (response.needsConnection) {
          return (
            <View style={styles.responseCard}>
              <Text style={styles.responseTitle}>🍕 Food</Text>
              <Text style={styles.responseMessage}>{response.message}</Text>
              
              <View style={styles.connectButtons}>
                <TouchableOpacity
                  style={styles.connectButton}
                  onPress={() => initiateOAuth('swiggy')}
                >
                  <Text style={styles.connectButtonText}>Connect Swiggy</Text>
                </TouchableOpacity>
                
                <TouchableOpacity
                  style={styles.connectButton}
                  onPress={() => initiateOAuth('zomato')}
                >
                  <Text style={styles.connectButtonText}>Connect Zomato</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        }
        if (response.showBoth) {
          return (
            <View style={styles.responseCard}>
              <Text style={styles.responseTitle}>🍕 Food</Text>
              <Text style={styles.responseMessage}>{response.message}</Text>
              <View style={styles.connectButtons}>
                {response.swiggyConnected && (
                  <TouchableOpacity
                    style={styles.connectButton}
                    onPress={() => {
                      setResponse(null);
                      setTimeout(() => Linking.openURL('swiggy://'), 100);
                    }}
                  >
                    <Text style={styles.connectButtonText}>Open Swiggy</Text>
                  </TouchableOpacity>
                )}
                {response.zomatoConnected && (
                  <TouchableOpacity
                    style={styles.connectButton}
                    onPress={() => {
                      setResponse(null);
                      setTimeout(() => Linking.openURL('zomato://'), 100);
                    }}
                  >
                    <Text style={styles.connectButtonText}>Open Zomato</Text>
                  </TouchableOpacity>
                )}
                {!response.swiggyConnected && (
                  <TouchableOpacity
                    style={styles.connectButton}
                    onPress={() => initiateOAuth('swiggy')}
                  >
                    <Text style={styles.connectButtonText}>Connect Swiggy</Text>
                  </TouchableOpacity>
                )}
                {!response.zomatoConnected && (
                  <TouchableOpacity
                    style={styles.connectButton}
                    onPress={() => initiateOAuth('zomato')}
                  >
                    <Text style={styles.connectButtonText}>Connect Zomato</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          );
        }
        return (
          <View style={styles.responseCard}>
            <Text style={styles.responseTitle}>🍕 {response.source}</Text>
            <Text style={styles.responseMessage}>{response.message}</Text>
            <TouchableOpacity
              style={styles.connectButton}
              onPress={() => {
                setResponse(null);
                setTimeout(() => openWithFallback(response.deepLink, response.webUrl || response.deepLink), 100);
              }}
            >
              <Text style={styles.connectButtonText}>Open {response.source}</Text>
            </TouchableOpacity>
          </View>
        );
        
      case 'eventkit_calendar':
      case 'calendar':
        if (response.needsConnection) {
          return (
            <View style={styles.responseCard}>
              <Text style={styles.responseTitle}>📅 Calendar</Text>
              <Text style={styles.responseMessage}>{response.message}</Text>
              <TouchableOpacity style={styles.connectButton} onPress={() => initiateOAuth('calendar')}>
                <Text style={styles.connectButtonText}>Connect Calendar</Text>
              </TouchableOpacity>
            </View>
          );
        }
        // v0.2: EventKit calendar with permission prompt
        if (response.needsPermission) {
          return (
            <View style={styles.responseCard}>
              <Text style={styles.responseTitle}>📅 Calendar</Text>
              <Text style={styles.responseMessage}>{response.message}</Text>
              <Text style={{ fontSize: 12, color: THEME.lightGray, marginTop: 8 }}>
                Go to Settings → un-app → Calendar to enable
              </Text>
            </View>
          );
        }
        // v0.2: EventKit results
        if (response.type === 'eventkit_calendar') {
          return (
            <View style={styles.responseCard}>
              <Text style={styles.responseTitle}>📅 Today's Schedule</Text>
              <Text style={styles.responseTime}>{response.timestamp}</Text>
              
              {response.nextFreeGap && (
                <View style={[styles.sinceCheckWrap, { borderLeftWidth: 3, borderLeftColor: THEME.lime }]}>
                  <Text style={{ fontSize: 13, color: THEME.lime, fontWeight: '600' }}>
                    Next free: {response.nextFreeGap}
                  </Text>
                </View>
              )}
              
              {response.events && response.events.length > 0 ? response.events.map((ev, i) => (
                <View key={i} style={styles.eventRow}>
                  <Text style={styles.eventTime}>{ev.time}</Text>
                  <Text style={styles.eventTitle}>{ev.title}</Text>
                  <Text style={{ fontSize: 11, color: THEME.lightGray }}>{ev.duration}m</Text>
                </View>
              )) : (
                <Text style={styles.noEvents}>No more events today — you're free</Text>
              )}
              
              <Text style={{ fontSize: 11, color: THEME.lightGray, marginTop: 10 }}>
                {response.totalToday} event{response.totalToday !== 1 ? 's' : ''} remaining today
              </Text>
            </View>
          );
        }
        return (
          <View style={styles.responseCard}>
            <Text style={styles.responseTitle}>📅 Calendar</Text>
            <Text style={styles.responseMessage}>{response.message || response.error}</Text>
            {response.deepLink && (
              <TouchableOpacity style={styles.connectButton} onPress={() => {
                setResponse(null);
                setTimeout(() => Linking.openURL(response.deepLink), 100);
              }}>
                <Text style={styles.connectButtonText}>Open Calendar</Text>
              </TouchableOpacity>
            )}
          </View>
        );
        
      case 'cricket':
        return (
          <View style={styles.responseCard}>
            <Text style={styles.responseTitle}>🏏 Cricket</Text>
            {response.timestamp && <Text style={styles.responseTime}>{response.timestamp}</Text>}
            {response.error && <Text style={styles.responseMessage}>{response.error}</Text>}
            {response.data && response.data.length > 0 ? response.data.map((match, i) => (
              <View key={i} style={[styles.stockRow, { flexDirection: 'column', alignItems: 'flex-start', paddingVertical: 10 }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
                  <View style={{
                    backgroundColor: match.status === 'live' ? '#ff4444' : match.status === 'completed' ? THEME.lightGray : THEME.lime,
                    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginRight: 8,
                  }}>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: match.status === 'live' ? '#fff' : THEME.black }}>
                      {match.status === 'live' ? 'LIVE' : match.status === 'completed' ? 'DONE' : 'SOON'}
                    </Text>
                  </View>
                  <Text style={{ fontSize: 11, color: THEME.lightGray }}>{match.format}</Text>
                </View>
                <Text style={{ fontSize: 14, color: THEME.white, fontWeight: '600' }}>
                  {match.teams.home} {match.score.home || ''} 
                </Text>
                <Text style={{ fontSize: 14, color: THEME.white, fontWeight: '600' }}>
                  {match.teams.away} {match.score.away || ''}
                </Text>
                {match.name ? <Text style={{ fontSize: 11, color: THEME.lightGray, marginTop: 2 }}>{match.name}</Text> : null}
              </View>
            )) : null}
            {(!response.data || response.data.length === 0) && !response.error && (
              <Text style={styles.responseMessage}>No matches right now</Text>
            )}
          </View>
        );
        
      case 'cab':
        if (response.needsConnection) {
          return (
            <View style={styles.responseCard}>
              <Text style={styles.responseTitle}>🚕 Ride</Text>
              <Text style={styles.responseMessage}>{response.message}</Text>
              <View style={styles.connectButtons}>
                <TouchableOpacity style={styles.connectButton} onPress={() => initiateOAuth('nammaYatri')}>
                  <Text style={styles.connectButtonText}>Connect Namma Yatri</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.connectButton} onPress={() => initiateOAuth('uber')}>
                  <Text style={styles.connectButtonText}>Connect Uber</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.connectButton} onPress={() => initiateOAuth('ola')}>
                  <Text style={styles.connectButtonText}>Connect Ola</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.connectButton} onPress={() => initiateOAuth('rapido')}>
                  <Text style={styles.connectButtonText}>Connect Rapido</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        }
        if (response.showAll) {
          return (
            <View style={styles.responseCard}>
              <Text style={styles.responseTitle}>🚕 Ride</Text>
              <Text style={styles.responseMessage}>{response.message}</Text>
              <View style={styles.connectButtons}>
                {response.nammaConnected && (
                  <TouchableOpacity style={styles.connectButton} onPress={() => { setResponse(null); setTimeout(() => openWithFallback('nammayatri://', 'https://nammayatri.in'), 100); }}>
                    <Text style={styles.connectButtonText}>Open Namma Yatri</Text>
                  </TouchableOpacity>
                )}
                {response.uberConnected && (
                  <TouchableOpacity style={styles.connectButton} onPress={() => { setResponse(null); setTimeout(() => openWithFallback('uber://', 'https://m.uber.com'), 100); }}>
                    <Text style={styles.connectButtonText}>Open Uber</Text>
                  </TouchableOpacity>
                )}
                {response.olaConnected && (
                  <TouchableOpacity style={styles.connectButton} onPress={() => { setResponse(null); setTimeout(() => openWithFallback('olacabs://', 'https://www.olacabs.com'), 100); }}>
                    <Text style={styles.connectButtonText}>Open Ola</Text>
                  </TouchableOpacity>
                )}
                {response.rapidoConnected && (
                  <TouchableOpacity style={styles.connectButton} onPress={() => { setResponse(null); setTimeout(() => openWithFallback('rapido://', 'https://www.rapido.bike'), 100); }}>
                    <Text style={styles.connectButtonText}>Open Rapido</Text>
                  </TouchableOpacity>
                )}
                {!response.nammaConnected && (
                  <TouchableOpacity style={styles.connectButton} onPress={() => initiateOAuth('nammaYatri')}>
                    <Text style={styles.connectButtonText}>Connect Namma Yatri</Text>
                  </TouchableOpacity>
                )}
                {!response.uberConnected && (
                  <TouchableOpacity style={styles.connectButton} onPress={() => initiateOAuth('uber')}>
                    <Text style={styles.connectButtonText}>Connect Uber</Text>
                  </TouchableOpacity>
                )}
                {!response.olaConnected && (
                  <TouchableOpacity style={styles.connectButton} onPress={() => initiateOAuth('ola')}>
                    <Text style={styles.connectButtonText}>Connect Ola</Text>
                  </TouchableOpacity>
                )}
                {!response.rapidoConnected && (
                  <TouchableOpacity style={styles.connectButton} onPress={() => initiateOAuth('rapido')}>
                    <Text style={styles.connectButtonText}>Connect Rapido</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          );
        }
        return (
          <View style={styles.responseCard}>
            <Text style={styles.responseTitle}>🚕 {response.source}</Text>
            <Text style={styles.responseMessage}>{response.message}</Text>
            <TouchableOpacity style={styles.connectButton} onPress={() => { setResponse(null); setTimeout(() => openWithFallback(response.deepLink, CAB_WEB_URLS[response.deepLink] || response.deepLink), 100); }}>
              <Text style={styles.connectButtonText}>Open {response.source}</Text>
            </TouchableOpacity>
          </View>
        );

      // ============================================
      // v0.3: CAB COMPARISON CARD (Uber vs Ola)
      // ============================================
      case 'cab_compare': {
        const est = response.estimate;
        const uberData = est?.providers?.uber;
        const olaData = est?.providers?.ola;
        const rapidoData = est?.providers?.rapido;
        const ageMinutes = response.fetchedAt ? Math.round((Date.now() - response.fetchedAt) / 60000) : 0;

        return (
          <View style={styles.responseCard}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={styles.responseTitle}>🚕 Cab Pricing</Text>
              <TouchableOpacity 
                onPress={async () => {
                  setLoading(true);
                  const result = await handleCabQuery();
                  setResponse(result);
                  setLoading(false);
                  trackEvent('card_refresh_tap', { card_type: 'cab' });
                }}
              >
                <Text style={{ fontSize: 12, color: THEME.lime }}>↻ Refresh</Text>
              </TouchableOpacity>
            </View>
            <Text style={{ fontSize: 11, color: THEME.lightGray, marginBottom: 12 }}>
              Updated {ageMinutes < 1 ? 'just now' : `${ageMinutes} min ago`}
            </Text>

            {/* Uber */}
            {uberData && (
              <TouchableOpacity 
                style={[styles.compareRow, response.uberConnected && styles.compareRowActive]}
                onPress={() => {
                  if (uberData.deeplink) {
                    trackEvent('card_comparison_tap', { card_type: 'cab', chosen: 'uber' });
                    openWithFallback(uberData.deeplink, 'https://m.uber.com');
                  }
                }}
              >
                <Text style={styles.compareProvider}>Uber</Text>
                <View style={{ flex: 1 }}>
                  {uberData.rides && uberData.rides.length > 0 ? uberData.rides.slice(0, 2).map((ride, i) => (
                    <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 }}>
                      <Text style={{ fontSize: 13, color: THEME.white }}>{ride.type}</Text>
                      <View style={{ flexDirection: 'row', gap: 10 }}>
                        <Text style={{ fontSize: 13, color: THEME.lime, fontWeight: '600' }}>{ride.fare_estimate}</Text>
                        {ride.eta_minutes && <Text style={{ fontSize: 12, color: THEME.lightGray }}>{ride.eta_minutes} min</Text>}
                        {ride.surge && <Text style={{ fontSize: 11, color: '#ff4444' }}>⚡{ride.surge}x</Text>}
                      </View>
                    </View>
                  )) : (
                    <Text style={{ fontSize: 13, color: THEME.lightGray }}>{uberData.note || 'Tap to open Uber'}</Text>
                  )}
                </View>
              </TouchableOpacity>
            )}

            {/* Ola */}
            {olaData && (
              <TouchableOpacity 
                style={[styles.compareRow, response.olaConnected && styles.compareRowActive]}
                onPress={() => {
                  if (olaData.deeplink) {
                    trackEvent('card_comparison_tap', { card_type: 'cab', chosen: 'ola' });
                    openWithFallback(olaData.deeplink, 'https://www.olacabs.com');
                  }
                }}
              >
                <Text style={styles.compareProvider}>Ola</Text>
                <View style={{ flex: 1 }}>
                  {olaData.rides && olaData.rides.length > 0 ? olaData.rides.slice(0, 2).map((ride, i) => (
                    <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 }}>
                      <Text style={{ fontSize: 13, color: THEME.white }}>{ride.type}</Text>
                      <View style={{ flexDirection: 'row', gap: 10 }}>
                        <Text style={{ fontSize: 13, color: THEME.lime, fontWeight: '600' }}>{ride.fare_estimate}</Text>
                        {ride.eta_minutes && <Text style={{ fontSize: 12, color: THEME.lightGray }}>{ride.eta_minutes} min</Text>}
                      </View>
                    </View>
                  )) : (
                    <Text style={{ fontSize: 13, color: THEME.lightGray }}>{olaData.note || 'Tap to open Ola'}</Text>
                  )}
                </View>
              </TouchableOpacity>
            )}

            {/* Fallback if all failed */}
            {(!uberData || uberData.available === false) && (!olaData || olaData.available === false) && (!rapidoData || rapidoData.available === false) && (
              <Text style={{ fontSize: 13, color: THEME.lightGray, textAlign: 'center', marginTop: 8 }}>
                Live pricing unavailable. Tap to open your ride app.
              </Text>
            )}

            {/* Rapido */}
            {rapidoData && (
              <TouchableOpacity 
                style={[styles.compareRow, response.rapidoConnected && styles.compareRowActive]}
                onPress={() => {
                  if (rapidoData.deeplink) {
                    trackEvent('card_comparison_tap', { card_type: 'cab', chosen: 'rapido' });
                    openWithFallback(rapidoData.deeplink, 'https://www.rapido.bike');
                  }
                }}
              >
                <Text style={styles.compareProvider}>Rapido</Text>
                <View style={{ flex: 1 }}>
                  {rapidoData.rides && rapidoData.rides.length > 0 ? rapidoData.rides.slice(0, 2).map((ride, i) => (
                    <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 }}>
                      <Text style={{ fontSize: 13, color: THEME.white }}>{ride.type}</Text>
                      <View style={{ flexDirection: 'row', gap: 10 }}>
                        <Text style={{ fontSize: 13, color: THEME.lime, fontWeight: '600' }}>{ride.fare_estimate}</Text>
                        {ride.eta_minutes && <Text style={{ fontSize: 12, color: THEME.lightGray }}>{ride.eta_minutes} min</Text>}
                        {ride.surge && <Text style={{ fontSize: 11, color: '#ff4444' }}>⚡{ride.surge}x</Text>}
                      </View>
                    </View>
                  )) : (
                    <Text style={{ fontSize: 13, color: THEME.lightGray }}>{rapidoData.note || 'Tap to open Rapido'}</Text>
                  )}
                </View>
              </TouchableOpacity>
            )}

            {/* Distance + time summary */}
            {est?.distance_km && (
              <Text style={{ fontSize: 11, color: THEME.lightGray, textAlign: 'center', marginTop: 6 }}>
                ~{est.distance_km} km • ~{est.duration_min} min • Estimates may vary
              </Text>
            )}
          </View>
        );
      }

      // ============================================
      // v0.3: FOOD COMPARISON CARD (Swiggy vs Zomato)
      // ============================================
      case 'food_compare': {
        const comp = response.comparison;
        const swiggy = comp?.platforms?.swiggy;
        const zomato = comp?.platforms?.zomato;
        const ageMinutes = response.fetchedAt ? Math.round((Date.now() - response.fetchedAt) / 60000) : 0;

        return (
          <View style={styles.responseCard}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={styles.responseTitle}>🍛 Restaurants</Text>
              <TouchableOpacity 
                onPress={async () => {
                  setLoading(true);
                  const result = await handleFoodQuery();
                  setResponse(result);
                  setLoading(false);
                  trackEvent('card_refresh_tap', { card_type: 'food' });
                }}
              >
                <Text style={{ fontSize: 12, color: THEME.lime }}>↻ Refresh</Text>
              </TouchableOpacity>
            </View>
            <Text style={{ fontSize: 11, color: THEME.lightGray, marginBottom: 12 }}>
              Updated {ageMinutes < 1 ? 'just now' : `${ageMinutes} min ago`}
            </Text>

            {/* Cross-platform comparison */}
            {comp?.comparison && comp.comparison.length > 0 && (
              <View style={{ marginBottom: 12 }}>
                <Text style={{ fontSize: 12, color: THEME.lime, fontWeight: '600', marginBottom: 8 }}>Same restaurant, both platforms:</Text>
                {comp.comparison.slice(0, 3).map((item, i) => (
                  <View key={i} style={[styles.compareRow, { flexDirection: 'column', alignItems: 'stretch' }]}>
                    <Text style={{ fontSize: 14, color: THEME.white, fontWeight: '600', marginBottom: 6 }}>{item.restaurant}</Text>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <TouchableOpacity 
                        style={{ flex: 1, marginRight: 6 }}
                        onPress={() => {
                          trackEvent('card_comparison_tap', { card_type: 'food', chosen: 'swiggy' });
                          Linking.openURL('swiggy://');
                        }}
                      >
                        <Text style={{ fontSize: 11, color: THEME.lightGray }}>Swiggy</Text>
                        <Text style={{ fontSize: 13, color: THEME.white }}>{item.swiggy.delivery_time || '—'}</Text>
                        {item.swiggy.offers && <Text style={{ fontSize: 11, color: THEME.lime }}>{item.swiggy.offers}</Text>}
                      </TouchableOpacity>
                      <TouchableOpacity 
                        style={{ flex: 1, marginLeft: 6 }}
                        onPress={() => {
                          trackEvent('card_comparison_tap', { card_type: 'food', chosen: 'zomato' });
                          Linking.openURL('zomato://');
                        }}
                      >
                        <Text style={{ fontSize: 11, color: THEME.lightGray }}>Zomato</Text>
                        <Text style={{ fontSize: 13, color: THEME.white }}>{item.zomato.delivery_time || '—'}</Text>
                        {item.zomato.offers && <Text style={{ fontSize: 11, color: THEME.lime }}>{item.zomato.offers}</Text>}
                      </TouchableOpacity>
                    </View>
                  </View>
                ))}
              </View>
            )}

            {/* Swiggy top restaurants */}
            {swiggy?.restaurants && swiggy.restaurants.length > 0 && (
              <View style={styles.compareRow}>
                <Text style={styles.compareProvider}>Swiggy</Text>
                <View style={{ flex: 1 }}>
                  {swiggy.restaurants.slice(0, 3).map((r, i) => (
                    <TouchableOpacity 
                      key={i} 
                      style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6, paddingVertical: 3 }}
                      onPress={() => {
                        trackEvent('card_restaurant_tap', { platform: 'swiggy', restaurant: r.name });
                        Linking.openURL(r.deeplink || 'swiggy://');
                      }}
                    >
                      <Text style={{ fontSize: 13, color: THEME.white, flex: 1 }} numberOfLines={1}>{r.name}</Text>
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        {r.rating && <Text style={{ fontSize: 12, color: THEME.lime }}>★ {r.rating}</Text>}
                        {r.delivery_time_display && <Text style={{ fontSize: 12, color: THEME.lightGray }}>{r.delivery_time_display}</Text>}
                      </View>
                    </TouchableOpacity>
                  ))}
                  {swiggy.restaurants[0]?.offers && (
                    <Text style={{ fontSize: 11, color: THEME.lime, marginTop: 2 }}>{swiggy.restaurants[0].offers}</Text>
                  )}
                </View>
              </View>
            )}

            {/* Zomato top restaurants */}
            {zomato?.restaurants && zomato.restaurants.length > 0 && (
              <View style={styles.compareRow}>
                <Text style={styles.compareProvider}>Zomato</Text>
                <View style={{ flex: 1 }}>
                  {zomato.restaurants.slice(0, 3).map((r, i) => (
                    <TouchableOpacity 
                      key={i} 
                      style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6, paddingVertical: 3 }}
                      onPress={() => {
                        trackEvent('card_restaurant_tap', { platform: 'zomato', restaurant: r.name });
                        Linking.openURL(r.deeplink || 'zomato://');
                      }}
                    >
                      <Text style={{ fontSize: 13, color: THEME.white, flex: 1 }} numberOfLines={1}>{r.name}</Text>
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        {r.rating && <Text style={{ fontSize: 12, color: THEME.lime }}>★ {r.rating}</Text>}
                        {r.delivery_time_display && <Text style={{ fontSize: 12, color: THEME.lightGray }}>{r.delivery_time_display}</Text>}
                      </View>
                    </TouchableOpacity>
                  ))}
                  {zomato.restaurants[0]?.offers && (
                    <Text style={{ fontSize: 11, color: THEME.lime, marginTop: 2 }}>{zomato.restaurants[0].offers}</Text>
                  )}
                </View>
              </View>
            )}

            {/* Fallback */}
            {(!swiggy?.restaurants || swiggy.restaurants.length === 0) && (!zomato?.restaurants || zomato.restaurants.length === 0) && (
              <View style={styles.connectButtons}>
                {response.swiggyConnected && (
                  <TouchableOpacity style={styles.connectButton} onPress={() => Linking.openURL('swiggy://')}>
                    <Text style={styles.connectButtonText}>Open Swiggy</Text>
                  </TouchableOpacity>
                )}
                {response.zomatoConnected && (
                  <TouchableOpacity style={styles.connectButton} onPress={() => Linking.openURL('zomato://')}>
                    <Text style={styles.connectButtonText}>Open Zomato</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
          </View>
        );
      }
        
      // ============================================
      // v0.4: WEATHER CARD
      // ============================================
      case 'weather':
        if (response.error) {
          return (
            <View style={styles.generalResponseCard}>
              <Text style={styles.generalResponseEmoji}>🌤️</Text>
              <Text style={styles.generalResponseText}>{response.error}</Text>
            </View>
          );
        }
        return (
          <View style={styles.responseCard}>
            <Text style={styles.responseTitle}>🌤️ {response.city}</Text>
            <Text style={styles.responseTime}>{response.timestamp}</Text>
            
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <View>
                <Text style={{ fontSize: 36, fontWeight: '700', color: THEME.white }}>{response.temp}°C</Text>
                <Text style={{ fontSize: 14, color: THEME.lightGray }}>Feels like {response.feelsLike}°C</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ fontSize: 14, color: THEME.white }}>{response.description}</Text>
                <Text style={{ fontSize: 12, color: THEME.lightGray }}>💧 {response.humidity}% • 💨 {response.windSpeed} km/h</Text>
              </View>
            </View>
            
            {response.forecast && response.forecast.length > 0 && (
              <View style={{ borderTopWidth: 1, borderTopColor: THEME.mediumGray, paddingTop: 10 }}>
                <Text style={{ fontSize: 12, color: THEME.lime, fontWeight: '600', marginBottom: 6 }}>Next 3 days</Text>
                {response.forecast.map((day, i) => (
                  <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
                    <Text style={{ fontSize: 13, color: THEME.lightGray }}>{new Date(day.date).toLocaleDateString('en-IN', { weekday: 'short' })}</Text>
                    <Text style={{ fontSize: 13, color: THEME.white }}>{day.description}</Text>
                    <Text style={{ fontSize: 13, color: THEME.white }}>{day.minTemp}° — {day.maxTemp}°</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        );

      // ============================================
      // v0.4: MEDIA CARD (YouTube, Spotify, etc.)
      // ============================================
      case 'media':
        return (
          <View style={styles.responseCard}>
            <Text style={styles.responseTitle}>🎬 Media</Text>
            <Text style={{ fontSize: 14, color: THEME.white, marginBottom: 12 }}>{response.message}</Text>
            <View style={styles.connectButtons}>
              {(response.apps || []).map((app, i) => (
                <TouchableOpacity
                  key={i}
                  style={styles.connectButton}
                  onPress={() => {
                    trackEvent('media_app_tap', { app: app.name });
                    openWithFallback(app.scheme, app.web);
                  }}
                >
                  <Text style={styles.connectButtonText}>
                    {response.contentQuery ? `▶️ Search "${response.contentQuery}"` : `${app.emoji} Open ${app.name}`}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        );
        
      default:
        return (
          <View style={styles.generalResponseCard}>
            <Text style={styles.generalResponseEmoji}>💡</Text>
            <Text style={[styles.generalResponseText, { textAlign: 'left' }]}>{response.message}</Text>
          </View>
        );
    }
  };
// ============================================
  // AI: PREDICT WHAT USER WANTS
  // ============================================
  // ============================================
  // AI: SMART GREETING
  // ============================================
  // ============================================
  // AI: STREAK CALCULATION
  // ============================================
  const getStreak = () => {
    if (queryHistory.length === 0) return 0;
    
    const today = new Date().toDateString();
    const dates = [...new Set(queryHistory.map(q => 
      new Date(q.timestamp).toDateString()
    ))];
    
    let streak = 0;
    let checkDate = new Date();
    
    for (let i = 0; i < 30; i++) {
      const dateStr = checkDate.toDateString();
      if (dates.includes(dateStr)) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else if (i === 0) {
        // Today not counted yet, check yesterday
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        break;
      }
    }
    
    return streak;
  };
  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return 'Good morning';
    if (hour >= 12 && hour < 17) return 'Good afternoon';
    if (hour >= 17 && hour < 21) return 'Good evening';
    return 'Good night';
  };
  const getPrediction = () => {
    const hour = new Date().getHours();
    const day = new Date().getDay();
    const isWeekday = day >= 1 && day <= 5;
    const isMarketHours = hour >= 9 && hour <= 16;
    const isLunchTime = hour >= 12 && hour <= 14;
    const isDinnerTime = hour >= 19 && hour <= 21;
    const isMorning = hour >= 7 && hour <= 10;
    
    // Score each category based on patterns + current context
    const scores = {};
    
    // Stocks: high score during market hours if user has pattern
    if (patterns.stocks && isMarketHours) {
      const avgHour = patterns.stocks.times?.length > 0 
        ? patterns.stocks.times.reduce((a, b) => a + b, 0) / patterns.stocks.times.length 
        : 10;
      const hourMatch = Math.abs(hour - avgHour) < 2 ? 1.5 : 1;
      scores.stocks = patterns.stocks.count * hourMatch;
    }
    
    // Food: high score during meal times
    if (patterns.food && (isLunchTime || isDinnerTime)) {
      scores.food = patterns.food.count * 1.5;
    }
    
    // Calendar: high score in morning or work hours
    if (patterns.calendar && (isMorning || isMarketHours)) {
      scores.calendar = patterns.calendar.count * 1.5;
    }
    
    // Cab: high score during commute times (morning 7-10, evening 5-8)
    const isMorningCommute = hour >= 7 && hour <= 10;
    const isEveningCommute = hour >= 17 && hour <= 20;
    if (patterns.cab && (isMorningCommute || isEveningCommute)) {
      scores.cab = patterns.cab.count * 1.5;
    }
    
    // Cricket: high score during typical match times (afternoon/evening)
    const isCricketTime = hour >= 14 && hour <= 22;
    if (patterns.cricket && isCricketTime) {
      const avgHour = patterns.cricket.times?.length > 0
        ? patterns.cricket.times.reduce((a, b) => a + b, 0) / patterns.cricket.times.length
        : 19;
      const hourMatch = Math.abs(hour - avgHour) < 2 ? 1.5 : 1;
      scores.cricket = patterns.cricket.count * hourMatch;
    }
    
    // Find highest score
    const topCategory = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    
    if (!topCategory || topCategory[1] < 1) return null;
    
    return topCategory[0];
  };

  const renderPrediction = () => {
    const prediction = getPrediction();
    if (!prediction) {
      currentPredictionRef.current = null;
      return null;
    }
    
    // Don't show prediction if contextual card already covers this category
    if (contextCards.some(c => c.category === prediction)) return null;
    
    // Track what we're showing (for accuracy measurement)
    currentPredictionRef.current = prediction;
    
    const predictions = {
      stocks: {
        emoji: '📈',
        text: 'Check market?',
        action: () => handlePredictionTap('stocks'),
      },
      food: {
        emoji: '🍕',
        text: 'Order food?',
        action: () => handlePredictionTap('food'),
      },
      calendar: {
        emoji: '📅',
        text: 'Check schedule?',
        action: () => handlePredictionTap('calendar'),
      },
      cab: {
        emoji: '🚕',
        text: 'Book a ride?',
        action: () => handlePredictionTap('cab'),
      },
      cricket: {
        emoji: '🏏',
        text: 'Check cricket?',
        action: () => handlePredictionTap('cricket'),
      },
      weather: {
        emoji: '🌤️',
        text: 'Check weather?',
        action: () => handlePredictionTap('weather'),
      },
    };
    
    const p = predictions[prediction];
    if (!p) return null;
    
    return (
      <View>
        <Text style={styles.cardTipLabel}>We learned this from your past behavior</Text>
        <TouchableOpacity style={styles.predictionCard} onPress={p.action}>
          <Text style={styles.predictionEmoji}>{p.emoji}</Text>
          <Text style={styles.predictionText}>{p.text}</Text>
          <Text style={styles.predictionHint}>Tap to go</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const handlePredictionTap = async (type) => {
    setLoading(true);
    let result;
    
    switch (type) {
      case 'stocks':
        result = await fetchNSEStocks();
        break;
      case 'food':
        result = await handleFoodQuery();
        break;
      case 'calendar':
        result = await handleCalendarQuery();
        break;
      case 'cab':
        result = await handleCabQuery();
        break;
      case 'cricket':
        result = await fetchCricketScores();
        break;
      case 'weather':
        const loc = userLocation || { lat: 19.076, lng: 72.8777 };
        result = await fetchWeather(loc.lat, loc.lng);
        break;
    }
    
    setResponse(result);
    await updatePatterns(type);
    
    // Feature 3: Prediction was correct (user tapped it)
    await trackPredictionResult(type, type);
    
    // Feature 5: Count tap saved
    await incrementTapsSaved();
    
    // Bug fix 1: Remove contextual cards for this category
    setDismissedCategories(prev => new Set([...prev, type]));
    setContextCards(prev => prev.filter(c => c.category !== type));
    
    // Feature 4: Store stock checkpoint
    if (type === 'stocks' && result?.data?.length > 0) {
      await storeLastStockCheck(result);
    }
    
    setLoading(false);
  };
  // Analyze patterns into insights
  const analyzePatterns = () => {
    const insights = [];
    const patternList = Object.keys(patterns);
    
    for (const key of patternList) {
      const p = patterns[key];
      if (p.count < 2) continue;
      
      // Only show valid categories
      if (!['stocks', 'food', 'cab', 'calendar', 'cricket', 'weather', 'media'].includes(key)) continue;
      
      const emoji = key === 'stocks' ? '📈' : 
                   key === 'food' ? '🍕' : 
                   key === 'calendar' ? '📅' : 
                   key === 'cricket' ? '🏏' : 
                   key === 'cab' ? '🚕' : 
                   key === 'weather' ? '🌤️' :
                   key === 'media' ? '🎬' : '⚡';
      
      // Find most common hour
      const hourCounts = {};
      (p.times || []).forEach(h => { hourCounts[h] = (hourCounts[h] || 0) + 1; });
      const topHour = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0];
      
      // Find most common day
      const dayCounts = {};
      (p.days || []).forEach(d => { dayCounts[d] = (dayCounts[d] || 0) + 1; });
      const topDay = Object.entries(dayCounts).sort((a, b) => b[1] - a[1])[0];
      
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      let hourStr = '';
      if (topHour) {
        const h = parseInt(topHour[0]);
        if (h === 0) hourStr = '12am';
        else if (h < 12) hourStr = `${h}am`;
        else if (h === 12) hourStr = '12pm';
        else hourStr = `${h - 12}pm`;
      }
      
      // Build insight
      let insight = '';
      if (key === 'stocks') {
        insight = `You check market around ${hourStr}`;
      } else if (key === 'food') {
        const hour = parseInt(topHour?.[0]);
        const mealTime = hour < 14 ? 'lunch' : 'dinner';
        insight = `You order ${mealTime} around ${hourStr}`;
      } else if (key === 'calendar') {
        insight = `You check schedule around ${hourStr}`;
      } else if (key === 'cab') {
        const hour = parseInt(topHour?.[0]);
        const commuteTime = hour < 12 ? 'morning' : 'evening';
        insight = `You book ${commuteTime} rides around ${hourStr}`;
      } else if (key === 'cricket') {
        insight = `You check cricket around ${hourStr}`;
      } else if (key === 'weather') {
        insight = `You check weather around ${hourStr}`;
      } else if (key === 'media') {
        insight = `You open media around ${hourStr}`;
      } else {
        insight = `You check ${key} around ${hourStr}`;
      }
      
      insights.push({ key, emoji, insight, count: p.count, times: p.times?.length || p.count });
    }
    
    return insights;
  };

  // Patterns Display (Flex Screen)
  const renderPatterns = () => {
    const insights = analyzePatterns();
    const totalQueries = queryHistory.length;
    
    return (
      <View style={styles.patternsCard}>
        <View style={styles.patternsHeader}>
          <Text style={styles.patternsTitle}>YOUR PATTERNS</Text>
          <Text style={styles.patternsBadge}>{insights.length}</Text>
        </View>
        
        {insights.length === 0 ? (
          <Text style={styles.noPatterns}>Keep using un-app to build patterns</Text>
        ) : (
          insights.map((item) => (
            <View key={item.key} style={styles.patternRow}>
              <Text style={styles.patternEmoji}>{item.emoji}</Text>
              <Text style={styles.patternInsight}>{item.insight}</Text>
            <Text style={styles.patternCount}>{item.times}x</Text>
            </View>
          ))
        )}
        
        <View style={styles.statsRow}>
          <View style={styles.statItem}>
            <Text style={styles.statLabel}>App Opens</Text>
            <Text style={styles.statValue}>{appOpens}</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={styles.statLabel}>Taps Saved</Text>
            <Text style={styles.statValue}>{tapsSaved}⚡</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={styles.statLabel}>Accuracy</Text>
            <Text style={styles.statValue}>
              {predictionAccuracy.total >= 5 
                ? `${Math.round((predictionAccuracy.correct / predictionAccuracy.total) * 100)}%` 
                : 'learning...'}
            </Text>
          </View>
          <View style={styles.statItem}>
            <Text style={styles.statLabel}>Streak</Text>
            <Text style={styles.statValue}>{getStreak()}🔥</Text>
          </View>
        </View>
      </View>
    );
  };

  // Connected Services
  const renderConnectedServices = () => {
    const services = Object.keys(connectedServices).filter(k => connectedServices[k]);
    if (services.length === 0) return null;
    
    return (
      <View style={styles.connectedCard}>
        <Text style={styles.connectedTitle}>Connected</Text>
        <View style={styles.connectedList}>
          {services.map((service) => (
            <View key={service} style={styles.connectedBadge}>
              <Text style={styles.connectedText}>
                {service === 'swiggy' ? '🟠' : service === 'zomato' ? '🔴' : service === 'nammaYatri' ? '🟢' : service === 'uber' ? '⚫' : service === 'ola' ? '🟡' : service === 'rapido' ? '🏍️' : '📅'} {service === 'nammaYatri' ? 'Namma Yatri' : service === 'rapido' ? 'Rapido' : service}
              </Text>
            </View>
          ))}
        </View>
      </View>
    );
  };

  // ============================================
  // MAIN RENDER
  // ============================================
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      
      {renderPrivacyNotice()}
      {renderOAuthModal()}
      
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        {/* Header */}
        <View style={styles.header}>
          {response ? (
            <TouchableOpacity onPress={clearResponse} style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', paddingHorizontal: 16 }}>
              <Text style={{ fontSize: 16, color: THEME.lime, fontWeight: '600' }}>← Back</Text>
            </TouchableOpacity>
          ) : (
            <>
              <Image
                source={require('./assets/Logo-01.jpg')}
                style={styles.logoImage}
              />
              <Text style={styles.tagline}>YOUR AI - learns you, acts for you</Text>
            </>
          )}
          <Animated.Text style={[styles.greeting, { opacity: pulseAnim }]}>{getGreeting()}</Animated.Text>
        </View>

        {/* Main Content */}
        <ScrollView
          ref={scrollViewRef}
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Smart prediction based on patterns */}
          {!response && renderPrediction()}
          
          {/* Contextual cards (time-based, auto-show) */}
          {contextCards.length > 0 && (
            <View style={styles.contextSection}>
              <Text style={styles.cardTipLabel}>Right now might be a good time for this</Text>
              {contextCards.map((card) => (
                <TouchableOpacity
                  key={card.id}
                  style={styles.contextCard}
                  onPress={() => handleContextCardTap(card)}
                >
                  <Text style={styles.contextEmoji}>{card.emoji}</Text>
                  <View style={styles.contextTextWrap}>
                    <Text style={styles.contextTitle}>{card.title}</Text>
                    <Text style={styles.contextSub}>{card.subtitle}</Text>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          )}
          
          {/* Empty state - no cards, no prediction, no response */}
          {!response && contextCards.length === 0 && !currentPredictionRef.current && Object.keys(patterns).length === 0 && (
            <View style={styles.emptyState}>
              <Text style={styles.emptyEmoji}>👋</Text>
              <Text style={styles.emptyTitle}>Nothing yet</Text>
              <Text style={styles.emptySub}>Type what you need — stocks, food, cab, weather, cricket or even a song name. The more you use it, the smarter it gets.</Text>
            </View>
          )}
          
          {/* Pre-loaded suggestion — only if no stocks context card already */}
          {preloadedData?.stocks && !contextCards.some(c => c.category === 'stocks') && (() => {
            const h = new Date().getHours();
            const m = new Date().getMinutes();
            const d = new Date().getDay();
            const t = h * 60 + m;
            const isMarket = d >= 1 && d <= 5 && t >= 555 && t <= 930;
            return isMarket;
          })() && (
            <TouchableOpacity
              style={styles.preloadCard}
              onPress={() => {
                setResponse(preloadedData.stocks);
                setPreloadedData(prev => ({ ...prev, stocks: null }));
              }}
            >
              <Text style={styles.preloadText}>
                📈 Market is open. Tap to see SENSEX & NIFTY
              </Text>
            </TouchableOpacity>
          )}
          
          {/* Response */}
          {renderResponse()}
          
          {/* Patterns */}
          {renderPatterns()}
          
          {/* Shareable Flex Card */}
          <View style={styles.flexCardPlaceholder}>
            <Text style={styles.flexCardEmoji}>✨</Text>
            <Text style={styles.flexCardTitle}>YOUR FLEX CARD</Text>
            {getStreak() >= 7 ? (
              <View style={styles.flexCardContent}>
                {predictionAccuracy.total > 0 && (
                  <Text style={styles.flexCardStat}>
                    un-app got you right {predictionAccuracy.correct}/{predictionAccuracy.total} times ({Math.round((predictionAccuracy.correct / predictionAccuracy.total) * 100)}%)
                  </Text>
                )}
                {tapsSaved > 0 && (
                  <Text style={styles.flexCardStat}>
                    {tapsSaved} taps saved this week ⚡
                  </Text>
                )}
                {weeklyInsight && (
                  <Text style={styles.flexCardInsight}>"{weeklyInsight}"</Text>
                )}
                {!weeklyInsight && !predictionAccuracy.total && (
                  <Text style={styles.flexCardSub}>Your shareable pattern card is building...</Text>
                )}
              </View>
            ) : (
              <Text style={styles.flexCardSub}>
                Unlocks at 7-day streak ({getStreak()}/7)
              </Text>
            )}
            <Text style={styles.flexCardHint}>Soon you'll be able to share this as your flex card</Text>
          </View>
          
          {/* Connected Services */}
          {renderConnectedServices()}
          
          {/* Loading */}
          {loading && (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={THEME.lime} />
            </View>
          )}
        </ScrollView>

        {/* Input */}
        <View style={styles.inputContainer}>
          <TextInput
            style={styles.input}
            placeholder="what do you need right now?"
            placeholderTextColor={THEME.lightGray}
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={handleSubmit}
            returnKeyType="go"
          />
          <TouchableOpacity
            style={[styles.sendButton, !query.trim() && styles.sendButtonDisabled]}
            onPress={handleSubmit}
            disabled={!query.trim() || loading}
          >
            <Text style={styles.sendButtonText}>→</Text>
          </TouchableOpacity>
        </View>
        
        {/* Privacy Footer */}
        <TouchableOpacity
          style={styles.privacyFooter}
          onPress={() => setShowPrivacyNotice(true)}
        >
          <Text style={styles.privacyFooterText}>
            🔒 Privacy & data settings
          </Text>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ============================================
// STYLES
// ============================================
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: THEME.black,
  },
  keyboardView: {
    flex: 1,
  },
  header: {
    alignItems: 'center',
    paddingVertical: 20,
    borderBottomWidth: 1,
    borderBottomColor: THEME.darkGray,
  },
  logoImage: {
    width: 50,
    height: 50,
    resizeMode: 'contain',
  },
  tagline: {
    fontSize: 14,
    color: THEME.lime,
    marginTop: 8,
    letterSpacing: 2,
  },
  greeting: {
    fontSize: 16,
    color: '#00BFFF',
    marginTop: 12,
    fontWeight: '600',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
  },
  
  // Response Card
  responseCard: {
    backgroundColor: THEME.darkGray,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: THEME.mediumGray,
  },
  responseTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: THEME.lime,
    marginBottom: 12,
  },
  responseTime: {
    fontSize: 12,
    color: THEME.lightGray,
    marginBottom: 12,
  },
  responseMessage: {
    fontSize: 14,
    color: THEME.white,
    lineHeight: 20,
  },
  responseDate: {
    fontSize: 12,
    color: THEME.lightGray,
    marginBottom: 12,
  },
  
  // Stock Row
  stockRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: THEME.mediumGray,
  },
  stockSymbol: {
    fontSize: 16,
    fontWeight: '600',
    color: THEME.white,
  },
  stockRight: {
    alignItems: 'flex-end',
  },
  stockPrice: {
    fontSize: 16,
    fontWeight: '700',
    color: THEME.white,
  },
  stockChange: {
    fontSize: 12,
    marginTop: 2,
  },
  
  // Event Row
  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: THEME.mediumGray,
  },
  eventTime: {
    fontSize: 14,
    color: THEME.lime,
    width: 60,
  },
  eventTitle: {
    fontSize: 14,
    color: THEME.white,
    flex: 1,
  },
  noEvents: {
    fontSize: 14,
    color: THEME.lightGray,
    fontStyle: 'italic',
  },
  
  // Connect Buttons
  connectButtons: {
    marginTop: 16,
    gap: 12,
  },
  connectButton: {
    backgroundColor: THEME.lime,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 12,
  },
  connectButtonText: {
    color: THEME.black,
    fontWeight: '700',
    fontSize: 14,
  },
  
  // Patterns Card
  patternsCard: {
    backgroundColor: THEME.darkGray,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: THEME.lime,
  },
  patternsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  patternsTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: THEME.lime,
    letterSpacing: 1,
  },
  patternsBadge: {
    backgroundColor: THEME.lime,
    color: THEME.black,
    fontWeight: '700',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    fontSize: 12,
    overflow: 'hidden',
  },
  patternRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
  },
  patternEmoji: {
    fontSize: 16,
    marginRight: 8,
  },
  patternName: {
    fontSize: 14,
    color: THEME.white,
    flex: 1,
    textTransform: 'capitalize',
  },
  patternCount: {
    fontSize: 14,
    color: THEME.lightGray,
  },
  patternInsight: {
    fontSize: 13,
    color: THEME.white,
    flex: 1,
  },
  noPatterns: {
    fontSize: 13,
    color: THEME.lightGray,
    fontStyle: 'italic',
    paddingVertical: 8,
  },
  statsRow: {
    flexDirection: 'row',
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: THEME.mediumGray,
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statLabel: {
    fontSize: 10,
    color: THEME.lightGray,
    marginBottom: 4,
  },
  statValue: {
    fontSize: 18,
    fontWeight: '700',
    color: THEME.lime,
  },
  
  // Connected Services
  connectedCard: {
    marginBottom: 16,
  },
  connectedTitle: {
    fontSize: 12,
    color: THEME.lightGray,
    marginBottom: 8,
  },
  connectedList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  connectedBadge: {
    backgroundColor: THEME.mediumGray,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  connectedText: {
    fontSize: 12,
    color: THEME.white,
  },
  predictionCard: {
    backgroundColor: THEME.lime,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  predictionEmoji: {
    fontSize: 24,
    marginRight: 12,
  },
  predictionText: {
    fontSize: 18,
    fontWeight: '700',
    color: THEME.black,
    flex: 1,
  },
  predictionHint: {
    fontSize: 12,
    color: THEME.black,
    opacity: 0.6,
  },
  // Pre-load Card
  preloadCard: {
    backgroundColor: THEME.mediumGray,
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
    borderLeftWidth: 3,
    borderLeftColor: THEME.lime,
  },
  preloadText: {
    fontSize: 14,
    color: THEME.white,
  },
  
  // Loading
  loadingContainer: {
    alignItems: 'center',
    padding: 20,
  },
  
  // Input
  inputContainer: {
    flexDirection: 'row',
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: THEME.darkGray,
    gap: 12,
  },
  input: {
    flex: 1,
    backgroundColor: THEME.darkGray,
    borderRadius: 24,
    paddingHorizontal: 20,
    paddingVertical: 12,
    fontSize: 16,
    color: THEME.white,
  },
  sendButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: THEME.lime,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
  sendButtonText: {
    fontSize: 24,
    color: THEME.black,
    fontWeight: '700',
  },
  
  // Privacy Footer
  privacyFooter: {
    alignItems: 'center',
    paddingBottom: 8,
  },
  privacyFooterText: {
    fontSize: 11,
    color: THEME.lightGray,
  },
  
  // Privacy Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.9)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  privacyModal: {
    backgroundColor: THEME.darkGray,
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 360,
    borderWidth: 1,
    borderColor: THEME.lime,
  },
  privacyTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: THEME.lime,
    textAlign: 'center',
    marginBottom: 24,
  },
  privacyItem: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  privacyIcon: {
    fontSize: 20,
    marginRight: 12,
  },
  privacyText: {
    flex: 1,
    fontSize: 14,
    color: THEME.white,
    lineHeight: 20,
  },
  privacyButton: {
    backgroundColor: THEME.lime,
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 16,
  },
  privacyButtonText: {
    color: THEME.black,
    fontWeight: '700',
    fontSize: 16,
    textAlign: 'center',
  },
  
  // OAuth Modal
  oauthContainer: {
    flex: 1,
    backgroundColor: THEME.black,
  },
  oauthHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: THEME.darkGray,
  },
  oauthClose: {
    color: THEME.lime,
    fontSize: 14,
  },
  oauthTitle: {
    color: THEME.white,
    fontSize: 16,
    fontWeight: '600',
  },
  oauthNote: {
    fontSize: 12,
    color: THEME.lightGray,
    textAlign: 'center',
    padding: 12,
    backgroundColor: THEME.darkGray,
  },
  webview: {
    flex: 1,
  },
  
  // Error
  errorText: {
    fontSize: 12,
    color: '#ff6b6b',
    marginTop: 8,
  },
  
  // Contextual Cards
  contextSection: {
    marginBottom: 16,
    gap: 8,
  },
  contextCard: {
    backgroundColor: THEME.darkGray,
    borderRadius: 12,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    borderLeftWidth: 3,
    borderLeftColor: THEME.lime,
  },
  contextEmoji: {
    fontSize: 24,
    marginRight: 12,
  },
  contextTextWrap: {
    flex: 1,
  },
  contextTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: THEME.white,
  },
  contextSub: {
    fontSize: 13,
    color: THEME.lightGray,
    marginTop: 2,
  },
  // Flex Card Placeholder
  flexCardPlaceholder: {
    backgroundColor: THEME.darkGray,
    borderRadius: 12,
    padding: 20,
    marginBottom: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: THEME.mediumGray,
    borderStyle: 'dashed',
  },
  
  // Empty State
  emptyState: {
    alignItems: 'center',
    paddingVertical: 30,
    paddingHorizontal: 20,
  },
  emptyEmoji: {
    fontSize: 32,
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: THEME.white,
    marginBottom: 8,
  },
  emptySub: {
    fontSize: 13,
    color: THEME.lightGray,
    textAlign: 'center',
    lineHeight: 20,
  },
  flexCardEmoji: {
    fontSize: 28,
    marginBottom: 8,
  },
  flexCardTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: THEME.lime,
    letterSpacing: 2,
    marginBottom: 8,
  },
  flexCardSub: {
    fontSize: 14,
    color: THEME.white,
    textAlign: 'center',
  },
  flexCardHint: {
    fontSize: 12,
    color: THEME.lightGray,
    marginTop: 8,
  },
  
  // General/error response card
  generalResponseCard: {
    backgroundColor: THEME.darkGray,
    borderRadius: 12,
    padding: 24,
    marginBottom: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: THEME.mediumGray,
  },
  generalResponseEmoji: {
    fontSize: 28,
    marginBottom: 10,
  },
  generalResponseText: {
    fontSize: 16,
    color: THEME.white,
    textAlign: 'center',
    lineHeight: 24,
  },
  
  // Card tip labels
  cardTipLabel: {
    fontSize: 11,
    color: THEME.lightGray,
    marginBottom: 6,
    marginLeft: 4,
    fontStyle: 'italic',
  },
  
  // Since you last checked
  sinceCheckWrap: {
    backgroundColor: THEME.mediumGray,
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
  },
  sinceCheckLabel: {
    fontSize: 12,
    color: THEME.lightGray,
    marginBottom: 4,
  },
  sinceCheckDelta: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 2,
  },
  
  // Flex card content
  flexCardContent: {
    alignItems: 'center',
    width: '100%',
  },
  flexCardStat: {
    fontSize: 13,
    color: THEME.white,
    textAlign: 'center',
    marginBottom: 4,
  },
  flexCardInsight: {
    fontSize: 13,
    color: THEME.lime,
    textAlign: 'center',
    fontStyle: 'italic',
    marginTop: 6,
    paddingHorizontal: 10,
    lineHeight: 20,
  },

  // v0.3: Comparison cards
  compareRow: {
    backgroundColor: THEME.mediumGray,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  compareRowActive: {
    borderWidth: 1,
    borderColor: THEME.lime,
  },
  compareProvider: {
    fontSize: 13,
    fontWeight: '700',
    color: THEME.lime,
    width: 50,
    marginTop: 2,
  },
});
