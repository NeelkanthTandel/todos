import AppKit
import Carbon.HIToolbox

/// What ⌥Space should do, given the window's state. Kept apart from AppKit so it can be tested.
enum WindowToggle {
    enum Action: Equatable { case show, hide }

    /// Hide only when Todos is already in front with its window up; otherwise bring it forward. So pressing the
    /// shortcut from another app always shows the board, even if the window was open behind that app.
    static func action(appActive: Bool, windowVisible: Bool, windowMiniaturized: Bool) -> Action {
        appActive && windowVisible && !windowMiniaturized ? .hide : .show
    }
}

/// One system-wide hot key through Carbon's RegisterEventHotKey, which needs no Accessibility permission.
final class GlobalHotKey {
    static let optionSpace = (keyCode: UInt32(kVK_Space), modifiers: UInt32(optionKey))

    private var ref: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private let action: () -> Void

    /// Returns nil when another app already owns the combination.
    init?(keyCode: UInt32, modifiers: UInt32, action: @escaping () -> Void) {
        self.action = action
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let me = Unmanaged.passUnretained(self).toOpaque()
        let installed = InstallEventHandler(
            GetEventDispatcherTarget(),
            { _, _, userData -> OSStatus in
                guard let userData else { return noErr }
                let hotKey = Unmanaged<GlobalHotKey>.fromOpaque(userData).takeUnretainedValue()
                DispatchQueue.main.async { hotKey.action() }
                return noErr
            }, 1, &spec, me, &handlerRef)
        let id = EventHotKeyID(signature: OSType(0x5444_4F53), id: 1)  // 'TDOS'
        let registered = RegisterEventHotKey(keyCode, modifiers, id, GetEventDispatcherTarget(), 0, &ref)
        guard installed == noErr, registered == noErr, ref != nil else {
            NSLog("Todos: couldn't register the global shortcut (\(registered)); another app may be using it")
            if let handlerRef { RemoveEventHandler(handlerRef) }
            return nil
        }
    }

    deinit {
        if let ref { UnregisterEventHotKey(ref) }
        if let handlerRef { RemoveEventHandler(handlerRef) }
    }
}
