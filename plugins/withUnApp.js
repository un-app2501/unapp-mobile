/**
 * un-app Expo Config Plugin
 * =========================
 * Adds:
 * 1. App Groups (for widget data sharing)
 * 2. Background Modes (for silent notifications)
 * 3. WidgetKit extension target reference
 */
const { withEntitlementsPlist, withInfoPlist, withXcodeProject } = require('@expo/config-plugins');

const APP_GROUP = 'group.ai.unapp.mobile';

// Add App Groups entitlement
const withAppGroups = (config) => {
  return withEntitlementsPlist(config, (mod) => {
    mod.modResults['com.apple.security.application-groups'] = [APP_GROUP];
    return mod;
  });
};

// Add Background Modes for silent push + background fetch
const withBackgroundModes = (config) => {
  return withInfoPlist(config, (mod) => {
    const existing = mod.modResults.UIBackgroundModes || [];
    const modes = new Set(existing);
    modes.add('fetch');
    modes.add('remote-notification');
    modes.add('processing');
    mod.modResults.UIBackgroundModes = Array.from(modes);
    return mod;
  });
};

// Main plugin
const withUnApp = (config) => {
  config = withAppGroups(config);
  config = withBackgroundModes(config);
  return config;
};

module.exports = withUnApp;
