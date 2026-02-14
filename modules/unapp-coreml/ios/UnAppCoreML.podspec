Pod::Spec.new do |s|
  s.name           = 'UnAppCoreML'
  s.version        = '0.3.0'
  s.summary        = 'CoreML prediction module for un-app'
  s.description    = 'On-device behavioral prediction using CoreML for un-app'
  s.homepage       = 'https://github.com/connectswapnil/un-app'
  s.license        = 'MIT'
  s.author         = 'Swapnil Shah'
  s.source         = { git: '' }
  s.platform       = :ios, '16.0'
  s.swift_version  = '5.9'
  s.source_files   = '**/*.swift'
  s.frameworks     = 'CoreML'
  s.resource_bundles = {
    'UnAppCoreMLResources' => ['**/*.mlpackage', '**/*.mlmodelc']
  }
  s.dependency 'ExpoModulesCore'
end
