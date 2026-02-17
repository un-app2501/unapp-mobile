Pod::Spec.new do |s|
  s.name           = 'UnAppCoreML'
  s.version        = '0.3.0'
  s.summary        = 'On-device CoreML prediction for un-app'
  s.description    = 'Behavioral prediction using CoreML neural network. Runs entirely on-device.'
  s.homepage       = 'https://un-app.ai'
  s.license        = 'MIT'
  s.author         = 'Swapnil Shah'
  s.source         = { git: '' }
  s.platform       = :ios, '16.0'
  s.swift_version  = '5.9'
  s.source_files   = '*.swift'
  s.resources      = ['*.mlmodel']
  s.frameworks     = 'CoreML'
  s.dependency 'ExpoModulesCore'
end
