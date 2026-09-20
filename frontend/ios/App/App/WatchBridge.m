#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Bridges the Swift WatchBridge plugin into Capacitor's Objective-C plugin registry.
CAP_PLUGIN(WatchBridge, "WatchBridge",
           CAP_PLUGIN_METHOD(syncTodayPlan, CAPPluginReturnPromise);
)
