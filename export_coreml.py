"""
un-app CoreML Model Export
==========================
Converts the trained PyTorch MLP model to CoreML .mlpackage format
for on-device prediction on iOS.

Usage:
    python export_coreml.py

Outputs:
    UnAppPredictor.mlpackage — ready to drop into Xcode/Expo native module
"""

import torch
import torch.nn as nn
import coremltools as ct
import numpy as np

# ============================================
# MODEL ARCHITECTURE (must match training)
# ============================================
class UnAppMLP(nn.Module):
    def __init__(self, input_size=13, hidden_sizes=[128, 64, 32], num_classes=6, dropout_rate=0.3):
        super(UnAppMLP, self).__init__()
        layers = []
        prev_size = input_size
        for h in hidden_sizes:
            layers.extend([
                nn.Linear(prev_size, h),
                nn.BatchNorm1d(h),
                nn.ReLU(),
                nn.Dropout(dropout_rate),
            ])
            prev_size = h
        layers.append(nn.Linear(prev_size, num_classes))
        self.network = nn.Sequential(*layers)
    
    def forward(self, x):
        return self.network(x)

# ============================================
# FEATURE NAMES (must match training order)
# ============================================
FEATURE_NAMES = [
    'hour_of_day',           # 0-23
    'day_of_week',           # 0-6 (Mon=0)
    'is_weekend',            # 0 or 1
    'minutes_since_midnight',# 0-1439
    'hour_sin',              # sin(2*pi*hour/24)
    'hour_cos',              # cos(2*pi*hour/24)
    'day_sin',               # sin(2*pi*day/7)
    'day_cos',               # cos(2*pi*day/7)
    'stocks_pattern_count',  # historical pattern count
    'food_pattern_count',
    'cab_pattern_count',
    'calendar_pattern_count',
    'cricket_pattern_count',
]

CLASS_LABELS = ['stocks', 'food', 'cab', 'calendar', 'cricket', 'none']

# ============================================
# EXPORT
# ============================================
def export_to_coreml():
    # Load trained model
    model = UnAppMLP(input_size=13, hidden_sizes=[128, 64, 32], num_classes=6)
    
    # Try loading saved weights
    try:
        model.load_state_dict(torch.load('unapp_model.pt', map_location='cpu'))
        print("Loaded trained weights from unapp_model.pt")
    except FileNotFoundError:
        print("WARNING: No trained weights found. Exporting with random weights for structure only.")
    
    model.eval()
    
    # Trace model
    example_input = torch.randn(1, 13)
    traced_model = torch.jit.trace(model, example_input)
    
    # Convert to CoreML
    mlmodel = ct.convert(
        traced_model,
        inputs=[
            ct.TensorType(name="features", shape=(1, 13)),
        ],
        classifier_config=ct.ClassifierConfig(CLASS_LABELS),
        minimum_deployment_target=ct.target.iOS16,
    )
    
    # Add metadata
    mlmodel.author = "un-app"
    mlmodel.short_description = "Behavioral prediction model for un-app. Predicts what action the user needs based on time, day, and usage patterns."
    mlmodel.version = "0.3.0"
    
    # Add feature descriptions
    spec = mlmodel.get_spec()
    for i, name in enumerate(FEATURE_NAMES):
        desc = spec.description.input[0]  # Single tensor input
    
    # Save
    mlmodel.save("UnAppPredictor.mlpackage")
    print("Exported: UnAppPredictor.mlpackage")
    print(f"  Input:  features (1, 13) — {FEATURE_NAMES}")
    print(f"  Output: classLabel — {CLASS_LABELS}")
    print(f"  Size:   ~{len(open('UnAppPredictor.mlpackage', 'rb').read()) // 1024}KB" if False else "")
    print("Done. Copy UnAppPredictor.mlpackage to modules/unapp-coreml/ios/")

if __name__ == '__main__':
    export_to_coreml()
