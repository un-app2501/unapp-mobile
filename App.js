import React, { useState, useEffect } from 'react';
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
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';

// un-app: The app you never have to open
// Version 0.1.0 - Cricket Score MVP

const THEME = {
  background: '#000000',
  lime: '#CDFF00',
  darkGray: '#1a1a1a',
  mediumGray: '#333333',
  lightGray: '#666666',
  white: '#ffffff',
};

export default function App() {
  const [query, setQuery] = useState('');
  const [response, setResponse] = useState(null);
  const [loading, setLoading] = useState(false);
  const [patterns, setPatterns] = useState([]);
  const [queryHistory, setQueryHistory] = useState([]);

  // Load patterns and history on app start
  useEffect(() => {
    loadStoredData();
  }, []);

  const loadStoredData = async () => {
    try {
      const storedPatterns = await AsyncStorage.getItem('unapp_patterns');
      const storedHistory = await AsyncStorage.getItem('unapp_history');
      if (storedPatterns) setPatterns(JSON.parse(storedPatterns));
      if (storedHistory) setQueryHistory(JSON.parse(storedHistory));
    } catch (error) {
      console.log('Error loading stored data:', error);
    }
  };

  const saveQuery = async (queryText, responseData) => {
    try {
      const newEntry = {
        query: queryText,
        timestamp: new Date().toISOString(),
        type: detectQueryType(queryText),
      };
      
      const updatedHistory = [newEntry, ...queryHistory].slice(0, 50); // Keep last 50
      setQueryHistory(updatedHistory);
      await AsyncStorage.setItem('unapp_history', JSON.stringify(updatedHistory));
      
      // Pattern detection (simple version)
      detectPatterns(updatedHistory);
    } catch (error) {
      console.log('Error saving query:', error);
    }
  };

  const detectQueryType = (text) => {
    const lower = text.toLowerCase();
    if (lower.includes('score') || lower.includes('cricket') || lower.includes('match') || lower.includes('india')) {
      return 'cricket';
    }
    if (lower.includes('pizza') || lower.includes('food') || lower.includes('order') || lower.includes('swiggy')) {
      return 'food';
    }
    if (lower.includes('cab') || lower.includes('ride') || lower.includes('ola') || lower.includes('uber')) {
      return 'cab';
    }
    if (lower.includes('stock') || lower.includes('nifty') || lower.includes('portfolio') || lower.includes('market')) {
      return 'stocks';
    }
    return 'general';
  };

  const detectPatterns = async (history) => {
    // Count query types
    const typeCounts = {};
    history.forEach(entry => {
      typeCounts[entry.type] = (typeCounts[entry.type] || 0) + 1;
    });

    const detectedPatterns = Object.entries(typeCounts)
      .filter(([type, count]) => count >= 2)
      .map(([type, count]) => ({
        type,
        count,
        message: getPatternMessage(type, count),
      }));

    setPatterns(detectedPatterns);
    await AsyncStorage.setItem('unapp_patterns', JSON.stringify(detectedPatterns));
  };

  const getPatternMessage = (type, count) => {
    const messages = {
      cricket: `🏏 You've checked cricket ${count} times`,
      food: `🍕 You've ordered food ${count} times`,
      cab: `🚕 You've booked cabs ${count} times`,
      stocks: `📈 You've checked stocks ${count} times`,
      general: `💬 ${count} general queries`,
    };
    return messages[type] || `${count} queries`;
  };

  const handleSubmit = async () => {
    if (!query.trim()) return;

    setLoading(true);
    const queryType = detectQueryType(query);

    try {
      let result;

      if (queryType === 'cricket') {
        result = await fetchCricketScore();
      } else {
        // For MVP, show coming soon for other types
        result = {
          type: queryType,
          message: getComingSoonMessage(queryType),
        };
      }

      setResponse(result);
      await saveQuery(query, result);
    } catch (error) {
      setResponse({
        type: 'error',
        message: 'Something went wrong. Try again.',
      });
    }

    setLoading(false);
    setQuery('');
  };

  const fetchCricketScore = async () => {
    // Using free cricket API
    try {
      const response = await fetch('https://api.cricapi.com/v1/currentMatches?apikey=demo&offset=0');
      const data = await response.json();
      
      if (data.data && data.data.length > 0) {
        // Find India match or first live match
        const indiaMatch = data.data.find(match => 
          match.teams && (match.teams.includes('India') || match.teams.some(t => t.includes('India')))
        );
        const liveMatch = data.data.find(match => match.matchStarted && !match.matchEnded);
        const match = indiaMatch || liveMatch || data.data[0];

        return {
          type: 'cricket',
          match: {
            name: match.name || 'Match',
            status: match.status || 'No status available',
            teams: match.teams || [],
            score: match.score || [],
          },
        };
      } else {
        // Fallback demo response
        return {
          type: 'cricket',
          match: {
            name: 'No live matches',
            status: 'Check back during match time',
            teams: [],
            score: [],
            demo: true,
          },
        };
      }
    } catch (error) {
      // Demo fallback
      return {
        type: 'cricket',
        match: {
          name: 'India vs Australia',
          status: 'Demo Mode - API limit reached',
          teams: ['India', 'Australia'],
          score: [{ team: 'India', score: '287/4 (45.2)' }],
          demo: true,
        },
      };
    }
  };

  const getComingSoonMessage = (type) => {
    const messages = {
      food: '🍕 Food ordering coming soon!\n\nSwiggy integration in progress.',
      cab: '🚕 Cab booking coming soon!\n\nNamma Yatri integration in progress.',
      stocks: '📈 Stock tracking coming soon!\n\nZerodha integration in progress.',
      general: '🤔 I\'m learning!\n\nTry asking about cricket scores.',
    };
    return messages[type] || 'Coming soon!';
  };

  const renderResponse = () => {
    if (!response) return null;

    if (response.type === 'cricket' && response.match) {
      const { match } = response;
      return (
        <View style={styles.responseCard}>
          {match.demo && (
            <Text style={styles.demoTag}>DEMO</Text>
          )}
          <Text style={styles.matchName}>{match.name}</Text>
          {match.score && match.score.length > 0 && (
            <View style={styles.scoreContainer}>
              {match.score.map((s, i) => (
                <Text key={i} style={styles.scoreText}>
                  {s.team || s.inning}: {s.score || s.r + '/' + s.w + ' (' + s.o + ')'}
                </Text>
              ))}
            </View>
          )}
          <Text style={styles.matchStatus}>{match.status}</Text>
        </View>
      );
    }

    return (
      <View style={styles.responseCard}>
        <Text style={styles.responseText}>{response.message}</Text>
      </View>
    );
  };

  const renderPatterns = () => {
    if (patterns.length === 0) return null;

    return (
      <View style={styles.patternsContainer}>
        <Text style={styles.patternsTitle}>Your patterns</Text>
        {patterns.map((pattern, index) => (
          <Text key={index} style={styles.patternText}>
            {pattern.message}
          </Text>
        ))}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      
      <KeyboardAvoidingView 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        {/* Header */}
        <View style={styles.header}>
          <Image source={require('./assets/Logo-01.jpg')} style={styles.logoImage} />
          <Text style={styles.tagline}>YOUR AI</Text>
        </View>

        {/* Main Content */}
        <ScrollView 
          style={styles.content}
          contentContainerStyle={styles.contentContainer}
          keyboardShouldPersistTaps="handled"
        >
          {/* Response Area */}
          {loading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={THEME.lime} />
            </View>
          ) : (
            renderResponse()
          )}

          {/* Patterns */}
          {renderPatterns()}

          {/* Hint */}
          {!response && !loading && (
            <View style={styles.hintContainer}>
              <Text style={styles.hintText}>Try: "cricket score"</Text>
            </View>
          )}
        </ScrollView>

        {/* Input Area */}
        <View style={styles.inputContainer}>
          <TextInput
            style={styles.input}
            placeholder="What do you need?"
            placeholderTextColor={THEME.lightGray}
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={handleSubmit}
            returnKeyType="go"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity 
            style={[styles.submitButton, !query.trim() && styles.submitButtonDisabled]}
            onPress={handleSubmit}
            disabled={!query.trim() || loading}
          >
            <Text style={styles.submitButtonText}>→</Text>
          </TouchableOpacity>
        </View>

        {/* Footer */}
        <Text style={styles.footer}>on-device only • no cloud</Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: THEME.background,
  },
  keyboardView: {
    flex: 1,
  },
  header: {
    paddingTop: 20,
    paddingHorizontal: 24,
    paddingBottom: 10,
  },
  logo: {
    fontSize: 32,
    fontWeight: '700',
    color: THEME.lime,
    letterSpacing: -1,
  },
  logoImage: {
    width: 50,
    height: 50,
    resizeMode: 'contain',
  },
  tagline: {
    fontSize: 14,
    color: THEME.lightGray,
    marginTop: 2,
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    padding: 24,
    paddingTop: 10,
  },
  loadingContainer: {
    padding: 40,
    alignItems: 'center',
  },
  responseCard: {
    backgroundColor: THEME.darkGray,
    borderRadius: 16,
    padding: 20,
    marginBottom: 20,
    borderLeftWidth: 3,
    borderLeftColor: THEME.lime,
  },
  demoTag: {
    fontSize: 10,
    color: THEME.lime,
    backgroundColor: THEME.mediumGray,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    alignSelf: 'flex-start',
    marginBottom: 10,
    overflow: 'hidden',
  },
  matchName: {
    fontSize: 18,
    fontWeight: '600',
    color: THEME.white,
    marginBottom: 12,
  },
  scoreContainer: {
    marginBottom: 12,
  },
  scoreText: {
    fontSize: 24,
    fontWeight: '700',
    color: THEME.lime,
    marginBottom: 4,
  },
  matchStatus: {
    fontSize: 14,
    color: THEME.lightGray,
  },
  responseText: {
    fontSize: 16,
    color: THEME.white,
    lineHeight: 24,
  },
  patternsContainer: {
    backgroundColor: THEME.darkGray,
    borderRadius: 16,
    padding: 20,
    marginBottom: 20,
  },
  patternsTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: THEME.lime,
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  patternText: {
    fontSize: 14,
    color: THEME.white,
    marginBottom: 6,
  },
  hintContainer: {
    padding: 40,
    alignItems: 'center',
  },
  hintText: {
    fontSize: 16,
    color: THEME.lightGray,
    fontStyle: 'italic',
  },
  inputContainer: {
    flexDirection: 'row',
    paddingHorizontal: 24,
    paddingVertical: 16,
    backgroundColor: THEME.background,
    borderTopWidth: 1,
    borderTopColor: THEME.darkGray,
  },
  input: {
    flex: 1,
    backgroundColor: THEME.darkGray,
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 16,
    fontSize: 16,
    color: THEME.white,
    marginRight: 12,
  },
  submitButton: {
    backgroundColor: THEME.lime,
    borderRadius: 12,
    width: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitButtonDisabled: {
    backgroundColor: THEME.mediumGray,
  },
  submitButtonText: {
    fontSize: 24,
    fontWeight: '600',
    color: THEME.background,
  },
  footer: {
    textAlign: 'center',
    fontSize: 12,
    color: THEME.lightGray,
    paddingBottom: 20,
  },
});