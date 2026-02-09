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
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import { WebView } from 'react-native-webview';
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
      const response = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`
      );
      const data = await response.json();
      
      if (data.chart && data.chart.result && data.chart.result[0]) {
        const quote = data.chart.result[0];
        const meta = quote.meta;
        const price = meta.regularMarketPrice || meta.previousClose || 0;
        const prevClose = meta.previousClose || price || 1;
        const change = price - prevClose;
        const changePercent = prevClose ? (change / prevClose) * 100 : 0;
        
        const nameMap = {
          '^NSEI': 'NIFTY 50', '^BSESN': 'SENSEX',
          '^IXIC': 'NASDAQ', '^DJI': 'DOW JONES', '^GSPC': 'S&P 500',
        };
        
        results.push({
          symbol: nameMap[sym] || sym,
          price: price.toFixed(2),
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
// MCP CLIENT (JSON-RPC 2.0)
// ============================================
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
  const currentPredictionRef = useRef(null);
  
  const scrollViewRef = useRef(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  
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
    trackEvent('app_started', { source: 'ios_app' });
  }, []);

  const initializeApp = async () => {
    await loadStoredData();
    await checkAndPreloadData();
  };

  // Trigger weekly insight when patterns are ready
  useEffect(() => {
    if (Object.keys(patterns).length >= 2) {
      generateWeeklyInsight();
    }
  }, [patterns]);

  // ============================================
  // CONTEXTUAL CARDS (TIME-BASED, AUTO-SHOW)
  // ============================================
  useEffect(() => {
    generateContextCards();
  }, [patterns, connectedServices, dismissedCategories]);

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
          const validCategories = ['stocks', 'food', 'cab', 'calendar'];
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
      
      // Show privacy notice on first open
      if (!privacyAck) {
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
    if (hoursSince < 0.5) return null; // Don't show if checked less than 30 min ago
    
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
          'x-api-key': 'REPLACE_WITH_YOUR_KEY',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 150,
          messages: [{
            role: 'user',
            content: `You are un-app's behavioral AI. Given this user's anonymous app usage patterns from the past week, write ONE short casual behavioral insight (max 2 sentences). Be specific about what you notice. Be witty, not generic. No emojis. Patterns: ${JSON.stringify(patternSummary)}`,
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
  };

  // ============================================
  // QUERY DETECTION
  // ============================================
  const detectQueryType = (text) => {
    const lowered = text.toLowerCase().trim();
    
    // Stocks
    if (lowered.includes('stock') || lowered.includes('sensex') || 
        lowered.includes('nifty') || lowered.includes('market') ||
        lowered.includes('share') || lowered.includes('nasdaq') ||
        lowered.includes('dow') || lowered.includes('s&p') ||
        lowered.includes('us market')) {
      return 'stocks';
    }
    
    // Food
    if (lowered.includes('food') || lowered.includes('hungry') ||
        lowered.includes('eat') || lowered.includes('swiggy') ||
        lowered.includes('zomato') || lowered.includes('order') ||
        lowered.includes('biryani') || lowered.includes('pizza') ||
        lowered.includes('dinner') || lowered.includes('lunch')) {
      return 'food';
    }
    
    // Calendar
    if (lowered.includes('calendar') || lowered.includes('meeting') ||
        lowered.includes('schedule') || lowered.includes('event') ||
        lowered.includes('today') || lowered.includes('tomorrow')) {
      return 'calendar';
    }
    
    // Cricket (legacy support)
    if (lowered.includes('cricket') || lowered.includes('score') ||
        lowered.includes('ipl') || lowered.includes('match')) {
      return 'cricket';
    }
    
    // Cab
    if (lowered.includes('cab') || lowered.includes('ride') ||
        lowered.includes('uber') || lowered.includes('ola') ||
        lowered.includes('namma') || lowered.includes('yatri') ||
        lowered.includes('rapido') || lowered.includes('bike') ||
        lowered.includes('taxi') || lowered.includes('auto') ||
        lowered.includes('commute') || lowered.includes('office') ||
        lowered.includes('home') || lowered.includes('drop')) {
      return 'cab';
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
      
      switch (queryType) {
        case 'stocks':
          // Check if pre-loaded
          if (preloadedData?.stocks) {
            result = preloadedData.stocks;
            setPreloadedData(prev => ({ ...prev, stocks: null }));
          } else {
            const lowQ = query.toLowerCase();
            const isUS = lowQ.includes('nasdaq') || lowQ.includes('dow') || lowQ.includes('s&p') || lowQ.includes('us market');
            result = await fetchNSEStocks(null, isUS ? 'us' : 'india');
          }
          break;
          
        case 'food':
          result = await handleFoodQuery();
          break;
          
        case 'calendar':
          result = await handleCalendarQuery();
          break;
          
        case 'cricket':
          result = {
            type: 'cricket',
            message: 'Cricket is on our radar. Hunting for a solid API to bring scores here.',
            status: 'pending',
          };
          break;
          
        case 'cab':
          result = await handleCabQuery();
          break;
          
        default:
          result = {
            type: 'general',
            message: 'Didn\'t catch that one. Try stocks, food, cab or calendar.',
          };
      }
      
      setResponse(result);
      
      // Bug fix 1: Remove contextual cards for this category and prevent regeneration
      if (result?.type && ['stocks', 'food', 'cab', 'calendar'].includes(result.type)) {
        setDismissedCategories(prev => new Set([...prev, result.type]));
        setContextCards(prev => prev.filter(c => c.category !== result.type));
      }
      
      // Bug fix 2: Only track patterns for valid categories
      if (['stocks', 'food', 'cab', 'calendar'].includes(queryType)) {
        await updatePatterns(queryType);
      }
      
      // Feature 3: Track prediction accuracy (only for typed queries, not card taps)
      if (currentPredictionRef.current && ['stocks', 'food', 'cab', 'calendar'].includes(queryType)) {
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
  // FOOD QUERY (SWIGGY/ZOMATO MCP)
  // ============================================
  const handleFoodQuery = async () => {
    // Check if Swiggy or Zomato is connected
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
    
    // Check if user mentioned specific service
    const queryLower = query.toLowerCase();
    const wantsSwiggy = queryLower.includes('swiggy');
    const wantsZomato = queryLower.includes('zomato');
    
    // If specific service mentioned, open that one
    if (wantsSwiggy && isSwiggyConnected) {
      return {
        type: 'food',
        connected: true,
        source: 'Swiggy',
        message: 'Open Swiggy to order',
        deepLink: 'swiggy://',
      };
    }
    
    if (wantsZomato && isZomatoConnected) {
      return {
        type: 'food',
        connected: true,
        source: 'Zomato',
        message: 'Open Zomato to order',
        deepLink: 'zomato://',
      };
    }
    
    // Show both options
    return {
      type: 'food',
      connected: true,
      showBoth: true,
      swiggyConnected: isSwiggyConnected,
      zomatoConnected: isZomatoConnected,
      message: 'Choose where to order',
    };
    
    // Connected! Show confirmation for now
    return {
      type: 'food',
      connected: true,
      source: isSwiggyConnected ? 'Swiggy' : 'Zomato',
      message: 'Ready to order! Full integration coming soon.',
    };
    
    // Try Swiggy first
    if (swiggyToken) {
      const client = new MCPClient(MCP_ENDPOINTS.swiggy.food, swiggyToken);
      const result = await client.callTool('search_restaurants', {
        query: query,
      });
      
      if (result.needsAuth) {
        // Token expired, need to re-auth
        await AsyncStorage.removeItem(STORAGE_KEYS.swiggyToken);
        return handleFoodQuery();
      }
      
      return {
        type: 'food',
        source: 'swiggy',
        data: result,
      };
    }
    
    // Try Zomato
    if (zomatoToken) {
      const client = new MCPClient(MCP_ENDPOINTS.zomato, zomatoToken);
      const result = await client.callTool('search_restaurants', {
        query: query,
      });
      
      if (result.needsAuth) {
        await AsyncStorage.removeItem(STORAGE_KEYS.zomatoToken);
        return handleFoodQuery();
      }
      
      return {
        type: 'food',
        source: 'zomato',
        data: result,
      };
    }
  };

  // ============================================
  // CALENDAR QUERY
  // ============================================
  const handleCalendarQuery = async () => {
    const isCalendarConnected = connectedServices.calendar;
    
    if (!isCalendarConnected) {
      return {
        type: 'calendar',
        needsConnection: true,
        message: 'Connect to see your schedule',
        services: ['calendar'],
      };
    }
    
    return {
      type: 'calendar',
      connected: true,
      message: 'Open Google Calendar',
      deepLink: 'googlecalendar://',
    };
    
    // Fetch calendar events using Google Calendar API
    try {
      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      
      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${today.toISOString()}&timeMax=${tomorrow.toISOString()}&singleEvents=true&orderBy=startTime`,
        {
          headers: {
            Authorization: `Bearer ${calendarToken}`,
          },
        }
      );
      
      if (response.status === 401) {
        await AsyncStorage.removeItem(STORAGE_KEYS.calendarToken);
        return handleCalendarQuery();
      }
      
      const data = await response.json();
      
      return {
        type: 'calendar',
        events: data.items || [],
        date: today.toDateString(),
      };
    } catch (error) {
      return {
        type: 'calendar',
        error: 'Could not fetch calendar',
        message: error.message,
      };
    }
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
  // CAB QUERY (NAMMA YATRI / UBER / OLA / RAPIDO)
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
    if (wantsUber && isUberConnected) {
      return { type: 'cab', connected: true, source: 'Uber', message: 'Open Uber', deepLink: 'uber://' };
    }
    if (wantsOla && isOlaConnected) {
      return { type: 'cab', connected: true, source: 'Ola', message: 'Open Ola', deepLink: 'olacabs://' };
    }
    if (wantsRapido && isRapidoConnected) {
      return { type: 'cab', connected: true, source: 'Rapido', message: 'Open Rapido', deepLink: 'rapido://' };
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
  const acknowledgePrivacy = async () => {
    await AsyncStorage.setItem(STORAGE_KEYS.privacyAcknowledged, 'true');
    setShowPrivacyNotice(false);
  };

  // ============================================
  // RENDER FUNCTIONS
  // ============================================
  
  // Privacy Notice Modal
  const renderPrivacyNotice = () => (
    <Modal visible={showPrivacyNotice} animationType="fade" transparent>
      <View style={styles.modalOverlay}>
        <View style={styles.privacyModal}>
          <Text style={styles.privacyTitle}>🔒 We respect your privacy</Text>
          
          <View style={styles.privacyItem}>
            <Text style={styles.privacyIcon}>📱</Text>
            <Text style={styles.privacyText}>
              All data stays on your phone. Nothing goes to any server.
            </Text>
          </View>
          
          <View style={styles.privacyItem}>
            <Text style={styles.privacyIcon}>🔐</Text>
            <Text style={styles.privacyText}>
              We never see your phone number, passwords or personal info.
            </Text>
          </View>
          
          <View style={styles.privacyItem}>
            <Text style={styles.privacyIcon}>🧠</Text>
            <Text style={styles.privacyText}>
              We learn patterns (like "checks stocks at 9am"), not your data.
            </Text>
          </View>
          
          <View style={styles.privacyItem}>
            <Text style={styles.privacyIcon}>🔗</Text>
            <Text style={styles.privacyText}>
              When you connect Swiggy/Zomato, you login directly with them - we only get a permission token.
            </Text>
          </View>
          
          <TouchableOpacity style={styles.privacyButton} onPress={acknowledgePrivacy}>
            <Text style={styles.privacyButtonText}>I understand this is part of building my AI</Text>
          </TouchableOpacity>
        </View>
      </View>
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
            <Text style={styles.responseTitle}>📈 Market Update</Text>
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
                setTimeout(() => Linking.openURL(response.deepLink), 100);
              }}
            >
              <Text style={styles.connectButtonText}>Open {response.source}</Text>
            </TouchableOpacity>
          </View>
        );
        
      case 'calendar':
        if (response.needsConnection) {
          return (
            <View style={styles.responseCard}>
              <Text style={styles.responseTitle}>📅 Calendar</Text>
              <Text style={styles.responseMessage}>{response.message}</Text>
              
              <TouchableOpacity
                style={styles.connectButton}
                onPress={() => initiateOAuth('calendar')}
              >
                <Text style={styles.connectButtonText}>Connect Calendar</Text>
              </TouchableOpacity>
            </View>
          );
        }
        return (
          <View style={styles.responseCard}>
            <Text style={styles.responseTitle}>📅 Calendar</Text>
            <Text style={styles.responseMessage}>{response.message}</Text>
            <TouchableOpacity
              style={styles.connectButton}
              onPress={() => {
              setResponse(null);
              setTimeout(() => Linking.openURL(response.deepLink), 100);
            }}
            >
              <Text style={styles.connectButtonText}>Open Calendar</Text>
            </TouchableOpacity>
          </View>
        );
        
      case 'cricket':
        return (
          <View style={styles.responseCard}>
            <Text style={styles.responseTitle}>🏏 Cricket</Text>
            <Text style={styles.responseMessage}>{response.message}</Text>
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
        
      default:
        return (
          <View style={styles.generalResponseCard}>
            <Text style={styles.generalResponseEmoji}>🤷</Text>
            <Text style={styles.generalResponseText}>{response.message}</Text>
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
    const stockPattern = patterns.stocks?.count > 2;
    const foodPattern = patterns.food?.count > 2;
    
    if (hour >= 5 && hour < 9) {
      return stockPattern ? 'Market opens soon' : 'Good morning';
    } else if (hour >= 9 && hour < 12) {
      return stockPattern ? 'Market is open' : 'Good morning';
    } else if (hour >= 12 && hour < 14) {
      return foodPattern ? 'Lunch time?' : 'Good afternoon';
    } else if (hour >= 14 && hour < 17) {
      return 'Good afternoon';
    } else if (hour >= 17 && hour < 21) {
      return foodPattern ? 'Dinner time?' : 'Good evening';
    } else {
      return 'YOUR AI';
    }
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
      if (!['stocks', 'food', 'cab', 'calendar'].includes(key)) continue;
      
      const emoji = key === 'stocks' ? '📈' : 
                   key === 'food' ? '🍕' : 
                   key === 'calendar' ? '📅' : 
                   key === 'cricket' ? '🏏' : 
                   key === 'cab' ? '🚕' : '⚡';
      
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
              {predictionAccuracy.total > 0 
                ? `${Math.round((predictionAccuracy.correct / predictionAccuracy.total) * 100)}%` 
                : '—'}
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
          <Image
            source={require('./assets/Logo-01.jpg')}
            style={styles.logoImage}
          />
          <Text style={styles.tagline}>YOUR AI - learns you, acts for you</Text>
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
              <Text style={styles.emptySub}>Use un-app a few days and it starts learning you. Try stocks, food, cab or calendar.</Text>
            </View>
          )}
          
          {/* Pre-loaded suggestion */}
          {preloadedData?.stocks && (
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
            placeholder="Ask me anything..."
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
            🔒 All data stays on your phone
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
});
