import ExpoModulesCore
import CoreML

public class UnAppPredictorModule: Module {
  
  // Card type labels matching training order
  private let cardTypes = ["cab", "food", "stocks", "cricket", "calendar", "nothing"]
  
  // Lazy-load model
  private lazy var model: MLModel? = {
    guard let url = Bundle.main.url(forResource: "UnAppPredictor", withExtension: "mlmodel") else {
      print("[UnAppPredictor] Model file not found in bundle")
      return nil
    }
    do {
      let compiledURL = try MLModel.compileModel(at: url)
      return try MLModel(contentsOf: compiledURL)
    } catch {
      print("[UnAppPredictor] Failed to load model: \(error)")
      return nil
    }
  }()
  
  public func definition() -> ModuleDefinition {
    Name("UnAppPredictor")
    
    // Check if model is available
    AsyncFunction("isModelReady") { () -> Bool in
      return self.model != nil
    }
    
    // Run prediction
    // features: [hour, minute, day_of_week, is_weekend, is_holiday,
    //            location_cluster, battery_level, is_charging,
    //            has_event_within_60min, event_has_location,
    //            mins_since_last_cab, mins_since_last_food, mins_since_last_stocks]
    // All pre-normalized to 0-1 range by JS caller
    AsyncFunction("predict") { (features: [Double]) -> [String: Any] in
      guard let model = self.model else {
        return ["error": "Model not loaded", "card_type": "nothing", "confidence": 0.0]
      }
      
      guard features.count == 13 else {
        return ["error": "Expected 13 features, got \(features.count)", "card_type": "nothing", "confidence": 0.0]
      }
      
      do {
        // Create MLMultiArray input
        let input = try MLMultiArray(shape: [1, 13], dataType: .float32)
        for (i, val) in features.enumerated() {
          input[[0, i] as [NSNumber]] = NSNumber(value: Float(val))
        }
        
        // Create feature provider
        let provider = try MLDictionaryFeatureProvider(dictionary: ["features": MLFeatureValue(multiArray: input)])
        
        // Run prediction
        let output = try model.prediction(from: provider)
        
        // Get probabilities
        guard let probs = output.featureValue(for: "card_type_probs")?.multiArrayValue else {
          return ["error": "No output", "card_type": "nothing", "confidence": 0.0]
        }
        
        // Find best class
        var bestIdx = 0
        var bestProb: Float = 0
        var allProbs: [String: Float] = [:]
        
        for i in 0..<self.cardTypes.count {
          let p = probs[[i] as [NSNumber]].floatValue
          allProbs[self.cardTypes[i]] = p
          if p > bestProb {
            bestProb = p
            bestIdx = i
          }
        }
        
        return [
          "card_type": self.cardTypes[bestIdx],
          "confidence": Double(bestProb),
          "all_probs": allProbs
        ]
        
      } catch {
        return ["error": error.localizedDescription, "card_type": "nothing", "confidence": 0.0]
      }
    }
    
    // Get model info
    AsyncFunction("getModelInfo") { () -> [String: Any] in
      return [
        "version": "0.3.0",
        "card_types": self.cardTypes,
        "feature_count": 13,
        "ready": self.model != nil
      ]
    }
  }
}
