import React, { useState, useEffect, useRef } from 'react';
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
const fetchNSEStocks = async (symbol = null) => {
  try {
    // Using Yahoo Finance via free API wrapper
    const symbols = symbol 
      ? [symbol] 
      : ['^NSEI', '^BSESN']; // NIFTY 50 and SENSEX
    
    const results = [];
    
    for (const sym of symbols) {
      const response = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`
      );
      const data = await response.json();
      
      if (data.chart && data.chart.result && data.chart.result[0]) {
        const quote = data.chart.result[0];
        const meta = quote.meta;
        const price = meta.regularMarketPrice;
        const prevClose = meta.previousClose;
        const change = price - prevClose;
        const changePercent = (change / prevClose) * 100;
        
        results.push({
          symbol: sym === '^NSEI' ? 'NIFTY 50' : sym === '^BSESN' ? 'SENSEX' : sym,
          price: price.toFixed(2),
          change: change.toFixed(2),
          changePercent: changePercent.toFixed(2),
          isUp: change >= 0,
        });
      }
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
      data: [
        { symbol: 'NIFTY 50', price: '--', change: '--', changePercent: '--', isUp: true },
        { symbol: 'SENSEX', price: '--', change: '--', changePercent: '--', isUp: true },
      ],
      error: 'Market data temporarily unavailable',
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
  
  const scrollViewRef = useRef(null);

  // ============================================
  // LIFECYCLE
  // ============================================
  useEffect(() => {
    initializeApp();
  }, []);

  const initializeApp = async () => {
    await loadStoredData();
    await checkAndPreloadData();
  };

  const loadStoredData = async () => {
    try {
      const storedPatterns = await AsyncStorage.getItem(STORAGE_KEYS.patterns);
      const storedHistory = await AsyncStorage.getItem(STORAGE_KEYS.history);
      const storedServices = await AsyncStorage.getItem(STORAGE_KEYS.connectedServices);
      const storedOpens = await AsyncStorage.getItem(STORAGE_KEYS.opens);
      const privacyAck = await AsyncStorage.getItem(STORAGE_KEYS.privacyAcknowledged);
      
      if (storedPatterns) {
        const parsed = JSON.parse(storedPatterns);
        // Clean invalid pattern keys
        const cleaned = {};
        for (const key of Object.keys(parsed)) {
          if (key && key !== '0' && isNaN(key) && parsed[key].count >= 1) {
            cleaned[key] = parsed[key];
          }
        }
        setPatterns(cleaned);
        await AsyncStorage.setItem(STORAGE_KEYS.patterns, JSON.stringify(cleaned));
      }
      if (storedHistory) setQueryHistory(JSON.parse(storedHistory));
      if (storedServices) setConnectedServices(JSON.parse(storedServices));
      
      // Track app opens
      const opens = storedOpens ? parseInt(storedOpens) + 1 : 1;
      setAppOpens(opens);
      await AsyncStorage.setItem(STORAGE_KEYS.opens, opens.toString());
      
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
        lowered.includes('share')) {
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
            result = await fetchNSEStocks();
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
            message: 'Cricket integration coming soon! We\'re finding a reliable free API.',
            status: 'pending',
          };
          break;
          
        default:
          result = {
            type: 'general',
            message: 'Try asking about: stocks, food ordering, or your calendar!',
          };
      }
      
      setResponse(result);
      await updatePatterns(queryType);
      
    } catch (error) {
      console.log('Query error:', error);
      setResponse({
        type: 'error',
        message: 'Something went wrong. Please try again.',
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
        return (
          <View style={styles.responseCard}>
            <Text style={styles.responseTitle}>📈 Market Update</Text>
            <Text style={styles.responseTime}>{response.timestamp}</Text>
            
            {response.data.map((stock, index) => (
              <View key={index} style={styles.stockRow}>
                <Text style={styles.stockSymbol}>{stock.symbol}</Text>
                <View style={styles.stockRight}>
                  <Text style={styles.stockPrice}>₹{stock.price}</Text>
                  <Text style={[
                    styles.stockChange,
                    { color: stock.isUp ? '#00ff00' : '#ff4444' }
                  ]}>
                    {stock.isUp ? '▲' : '▼'} {stock.changePercent}%
                  </Text>
                </View>
              </View>
            ))}
            
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
        
      default:
        return (
          <View style={styles.responseCard}>
            <Text style={styles.responseMessage}>{response.message}</Text>
          </View>
        );
    }
  };

  // Analyze patterns into insights
  const analyzePatterns = () => {
    const insights = [];
    const patternList = Object.keys(patterns);
    
    for (const key of patternList) {
      const p = patterns[key];
      if (p.count < 2) continue;
      
      // Skip invalid pattern keys
      if (!key || key === '0' || !isNaN(key)) continue;
      
      const emoji = key === 'stocks' ? '📈' : 
                   key === 'food' ? '🍕' : 
                   key === 'calendar' ? '📅' : 
                   key === 'cricket' ? '🏏' : '⚡';
      
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
            <Text style={styles.statLabel}>Queries</Text>
            <Text style={styles.statValue}>{totalQueries}</Text>
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
                {service === 'swiggy' ? '🟠' : service === 'zomato' ? '🔴' : '📅'} {service}
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
          <Text style={styles.tagline}>YOUR AI</Text>
        </View>

        {/* Main Content */}
        <ScrollView
          ref={scrollViewRef}
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
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
});
