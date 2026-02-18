import WidgetKit
import SwiftUI

// ============================================
// SHARED DATA (via App Groups)
// ============================================
struct UnAppWidgetData: Codable {
  let prediction: String
  let confidence: Double
  let greeting: String
  let cards: [WidgetCard]
  let lastUpdated: Date
  
  struct WidgetCard: Codable {
    let emoji: String
    let title: String
    let subtitle: String
    let action: String
  }
}

// ============================================
// TIMELINE PROVIDER
// ============================================
struct UnAppTimelineProvider: TimelineProvider {
  
  func placeholder(in context: Context) -> UnAppWidgetEntry {
    UnAppWidgetEntry(date: Date(), data: sampleData())
  }
  
  func getSnapshot(in context: Context, completion: @escaping (UnAppWidgetEntry) -> Void) {
    let entry = UnAppWidgetEntry(date: Date(), data: loadWidgetData() ?? sampleData())
    completion(entry)
  }
  
  func getTimeline(in context: Context, completion: @escaping (Timeline<UnAppWidgetEntry>) -> Void) {
    let currentDate = Date()
    let data = loadWidgetData() ?? sampleData()
    let entry = UnAppWidgetEntry(date: currentDate, data: data)
    
    // Refresh every 15 minutes
    let nextUpdate = Calendar.current.date(byAdding: .minute, value: 15, to: currentDate)!
    let timeline = Timeline(entries: [entry], policy: .after(nextUpdate))
    completion(timeline)
  }
  
  private func loadWidgetData() -> UnAppWidgetData? {
    guard let sharedDefaults = UserDefaults(suiteName: "group.ai.unapp.mobile") else {
      return nil
    }
    guard let data = sharedDefaults.data(forKey: "widgetData") else {
      return nil
    }
    return try? JSONDecoder().decode(UnAppWidgetData.self, from: data)
  }
  
  private func sampleData() -> UnAppWidgetData {
    return UnAppWidgetData(
      prediction: "none",
      confidence: 0.0,
      greeting: "YOUR AI",
      cards: [
        .init(emoji: "👋", title: "Open un-app", subtitle: "Learning your patterns", action: "open")
      ],
      lastUpdated: Date()
    )
  }
}

// ============================================
// TIMELINE ENTRY
// ============================================
struct UnAppWidgetEntry: TimelineEntry {
  let date: Date
  let data: UnAppWidgetData
}

// ============================================
// WIDGET VIEWS
// ============================================

// Small widget — single prediction card
struct UnAppWidgetSmallView: View {
  let entry: UnAppWidgetEntry
  
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text("U")
          .font(.system(size: 18, weight: .black))
          .foregroundColor(Color(hex: "CCFF00"))
        Spacer()
        Text(entry.data.greeting)
          .font(.system(size: 11))
          .foregroundColor(.gray)
      }
      
      Spacer()
      
      if let card = entry.data.cards.first {
        Text(card.emoji)
          .font(.system(size: 24))
        Text(card.title)
          .font(.system(size: 14, weight: .bold))
          .foregroundColor(.white)
        Text(card.subtitle)
          .font(.system(size: 11))
          .foregroundColor(.gray)
          .lineLimit(1)
      }
    }
    .padding(14)
    .containerBackground(for: .widget) {
      Color.black
    }
  }
}

// Medium widget — multiple cards
struct UnAppWidgetMediumView: View {
  let entry: UnAppWidgetEntry
  
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text("U")
          .font(.system(size: 18, weight: .black))
          .foregroundColor(Color(hex: "CCFF00"))
        Text("un-app")
          .font(.system(size: 13, weight: .semibold))
          .foregroundColor(.white)
        Spacer()
        Text(entry.data.greeting)
          .font(.system(size: 11))
          .foregroundColor(.gray)
      }
      
      HStack(spacing: 10) {
        ForEach(Array(entry.data.cards.prefix(3).enumerated()), id: \.offset) { _, card in
          Link(destination: URL(string: "unapp://action/\(card.action)")!) {
            VStack(alignment: .leading, spacing: 4) {
              Text(card.emoji)
                .font(.system(size: 20))
              Text(card.title)
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(.white)
                .lineLimit(1)
              Text(card.subtitle)
                .font(.system(size: 10))
                .foregroundColor(.gray)
                .lineLimit(1)
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(hex: "1A1A1A"))
            .cornerRadius(10)
          }
        }
      }
    }
    .padding(14)
    .containerBackground(for: .widget) {
      Color.black
    }
  }
}

// ============================================
// COLOR EXTENSION
// ============================================
extension Color {
  init(hex: String) {
    let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
    var int: UInt64 = 0
    Scanner(string: hex).scanHexInt64(&int)
    let r, g, b: UInt64
    (r, g, b) = ((int >> 16) & 0xFF, (int >> 8) & 0xFF, int & 0xFF)
    self.init(
      .sRGB,
      red: Double(r) / 255,
      green: Double(g) / 255,
      blue: Double(b) / 255,
      opacity: 1
    )
  }
}

// ============================================
// WIDGET CONFIGURATION
// ============================================
struct UnAppWidget: Widget {
  let kind: String = "UnAppWidget"
  
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: UnAppTimelineProvider()) { entry in
      if #available(iOS 17.0, *) {
        UnAppWidgetMediumView(entry: entry)
      } else {
        UnAppWidgetMediumView(entry: entry)
      }
    }
    .configurationDisplayName("un-app")
    .description("YOUR AI — learns you, acts for you")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

// ============================================
// WIDGET BUNDLE
// ============================================
@main
struct UnAppWidgetBundle: WidgetBundle {
  var body: some Widget {
    UnAppWidget()
  }
}
