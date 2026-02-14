import ExpoModulesCore
import CoreML
import WidgetKit

public class UnAppCoreMLModule: Module {
  
  private var model: MLModel?
  
  public func definition() -> ModuleDefinition {
    Name("UnAppCoreML")
    
    // Load model on module init
    OnCreate {
      self.loadModel()
    }
    
    // Predict: takes 13 features, returns predicted action + confidence
    AsyncFunction("predict") { (features: [Double]) -> [String: Any] in
      guard features.count == 13 else {
        throw NSError(domain: "UnAppCoreML", code: 1, userInfo: [
          NSLocalizedDescriptionKey: "Expected 13 features, got \(features.count)"
        ])
      }
      
      guard let model = self.model else {
        throw NSError(domain: "UnAppCoreML", code: 2, userInfo: [
          NSLocalizedDescriptionKey: "Model not loaded"
        ])
      }
      
      do {
        // Create MLMultiArray input
        let mlArray = try MLMultiArray(shape: [1, 13], dataType: .double)
        for (i, val) in features.enumerated() {
          mlArray[i] = NSNumber(value: val)
        }
        
        let input = try MLDictionaryFeatureProvider(dictionary: [
          "features": MLFeatureValue(multiArray: mlArray)
        ])
        
        let prediction = try model.prediction(from: input)
        
        // Extract class label
        let classLabel = prediction.featureValue(for: "classLabel")?.stringValue ?? "none"
        
        // Extract confidence scores if available
        var confidences: [String: Double] = [:]
        if let probs = prediction.featureValue(for: "classProbability")?.dictionaryValue {
          for (key, value) in probs {
            if let label = key as? String, let conf = value as? Double {
              confidences[label] = conf
            }
          }
        }
        
        return [
          "prediction": classLabel,
          "confidence": confidences[classLabel] ?? 0.0,
          "all_scores": confidences,
          "model_version": "0.3.0",
        ]
      } catch {
        throw NSError(domain: "UnAppCoreML", code: 3, userInfo: [
          NSLocalizedDescriptionKey: "Prediction failed: \(error.localizedDescription)"
        ])
      }
    }
    
    // Build features from current context
    AsyncFunction("buildFeatures") { (patternCounts: [String: Int]) -> [Double] in
      let now = Date()
      let calendar = Calendar.current
      let hour = Double(calendar.component(.hour, from: now))
      let minute = Double(calendar.component(.minute, from: now))
      let weekday = Double(calendar.component(.weekday, from: now) - 2) // Mon=0
      let adjustedWeekday = weekday < 0 ? weekday + 7 : weekday
      let isWeekend: Double = (adjustedWeekday >= 5) ? 1.0 : 0.0
      let minutesSinceMidnight = hour * 60 + minute
      
      let hourSin = sin(2 * Double.pi * hour / 24)
      let hourCos = cos(2 * Double.pi * hour / 24)
      let daySin = sin(2 * Double.pi * adjustedWeekday / 7)
      let dayCos = cos(2 * Double.pi * adjustedWeekday / 7)
      
      let stocksCount = Double(patternCounts["stocks"] ?? 0)
      let foodCount = Double(patternCounts["food"] ?? 0)
      let cabCount = Double(patternCounts["cab"] ?? 0)
      let calendarCount = Double(patternCounts["calendar"] ?? 0)
      let cricketCount = Double(patternCounts["cricket"] ?? 0)
      
      return [
        hour,
        adjustedWeekday,
        isWeekend,
        minutesSinceMidnight,
        hourSin,
        hourCos,
        daySin,
        dayCos,
        stocksCount,
        foodCount,
        cabCount,
        calendarCount,
        cricketCount,
      ]
    }
    
    // Check if model is loaded
    Function("isModelLoaded") { () -> Bool in
      return self.model != nil
    }
    
    // Get model metadata
    Function("getModelInfo") { () -> [String: Any] in
      guard let model = self.model else {
        return ["loaded": false]
      }
      return [
        "loaded": true,
        "version": "0.3.0",
        "description": model.modelDescription.metadata[.description] as? String ?? "UnApp Predictor",
        "input_features": 13,
        "output_classes": ["stocks", "food", "cab", "calendar", "cricket", "none"],
      ]
    }
    
    // Write data to shared App Group for WidgetKit
    AsyncFunction("updateWidgetData") { (jsonString: String) -> Bool in
      guard let sharedDefaults = UserDefaults(suiteName: "group.ai.unapp.mobile") else {
        return false
      }
      sharedDefaults.set(jsonString, forKey: "widgetData")
      sharedDefaults.synchronize()
      
      // Tell WidgetKit to refresh
      if #available(iOS 14.0, *) {
        WidgetKit.WidgetCenter.shared.reloadAllTimelines()
      }
      return true
    }
  }
  
  private func loadModel() {
    // Try loading from app bundle
    guard let modelURL = Bundle.main.url(forResource: "UnAppPredictor", withExtension: "mlmodelc") else {
      // Try .mlpackage
      guard let packageURL = Bundle.main.url(forResource: "UnAppPredictor", withExtension: "mlpackage") else {
        print("[UnAppCoreML] Model file not found in bundle")
        return
      }
      do {
        let compiledURL = try MLModel.compileModel(at: packageURL)
        self.model = try MLModel(contentsOf: compiledURL)
        print("[UnAppCoreML] Model loaded from .mlpackage")
      } catch {
        print("[UnAppCoreML] Failed to compile model: \(error)")
      }
      return
    }
    
    do {
      self.model = try MLModel(contentsOf: modelURL)
      print("[UnAppCoreML] Model loaded from .mlmodelc")
    } catch {
      print("[UnAppCoreML] Failed to load model: \(error)")
    }
  }
}
