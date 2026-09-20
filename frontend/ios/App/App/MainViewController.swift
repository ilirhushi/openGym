import Capacitor

// Capacitor 7 only auto-registers plugins that ship as npm packages (their class names are
// scanned into capacitor.config.json's packageClassList by `cap sync`, which only looks inside
// node_modules — never at this app target's own source files, and overwrites the whole list on
// every sync besides). A plugin defined directly in this project, like PrintPlugin or
// WatchBridge, is invisible to that mechanism no matter what the CAP_PLUGIN macro declares: the
// class exists in the binary, but nothing ever calls registerPluginInstance on it, so every JS
// call to it hangs forever with no error (the call is queued for a plugin that's never there to
// receive it). capacitorDidLoad() is Capacitor's own documented hook for exactly this case.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        NSLog("[MainViewController] capacitorDidLoad() called, bridge=\(String(describing: bridge))")
        bridge?.registerPluginInstance(PrintPlugin())
        bridge?.registerPluginInstance(WatchBridge())
        NSLog("[MainViewController] plugin instances registered")
    }
}
