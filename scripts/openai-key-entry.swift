// Local setup only. No network, CLI login, or product execution.
import AppKit
import Security
import LocalAuthentication

let service = "ai.irixi.personal-agent.openai-api"
let account = "default"

func query(_ name: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: name,
     kSecAttrAccount as String: account,
     kSecAttrSynchronizable as String: false]
}

func save(_ value: Data, to name: String) -> OSStatus {
    let status = SecItemUpdate(query(name) as CFDictionary,
                               [kSecValueData as String: value] as CFDictionary)
    if status != errSecItemNotFound { return status }
    var item = query(name)
    item[kSecValueData as String] = value
    item[kSecAttrLabel as String] = "iRIXI Personal Agent · OpenAI API Key"
    return SecItemAdd(item as CFDictionary, nil)
}

if CommandLine.arguments.contains("--self-test") {
    // Only synthetic data in a unique test item; never read the real credential.
    let name = service + ".self-test." + UUID().uuidString
    let first = Data("synthetic-one".utf8)
    let second = Data("synthetic-two".utf8)
    let added = save(first, to: name)
    let updated = added == errSecSuccess ? save(second, to: name) : added
    var check = query(name)
    check[kSecReturnData as String] = true
    var result: CFTypeRef?
    let read = SecItemCopyMatching(check as CFDictionary, &result)
    let matches = (result as? Data) == second
    let removed = SecItemDelete(query(name) as CFDictionary)
    let absent = SecItemCopyMatching(check as CFDictionary, nil) == errSecItemNotFound
    let ok = added == errSecSuccess && updated == errSecSuccess && read == errSecSuccess
        && matches && removed == errSecSuccess && absent
    print(ok ? "SELF_TEST_PASSED: synthetic add/update/read/delete" : "SELF_TEST_FAILED: OSStatus \(added)/\(updated)/\(read)/\(removed)")
    exit(ok ? 0 : 1)
}

if CommandLine.arguments.contains("--status") {
    var check = query(service)
    check[kSecReturnAttributes as String] = true
    let context = LAContext()
    context.interactionNotAllowed = true
    check[kSecUseAuthenticationContext as String] = context
    let status = SecItemCopyMatching(check as CFDictionary, nil)
    print(status == errSecSuccess ? "CREDENTIAL_PRESENT_NOT_VALIDATED"
          : status == errSecItemNotFound ? "CREDENTIAL_NOT_CONFIGURED"
          : "CREDENTIAL_STATUS_UNAVAILABLE: \(status)")
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let menu = NSMenu()
let applicationItem = NSMenuItem()
menu.addItem(applicationItem)
let applicationMenu = NSMenu()
applicationMenu.addItem(withTitle: "退出", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
applicationItem.submenu = applicationMenu
let editItem = NSMenuItem()
menu.addItem(editItem)
let editMenu = NSMenu(title: "编辑")
editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
editItem.submenu = editMenu
app.mainMenu = menu

final class KeyEntryDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        DispatchQueue.main.async {
            let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 380, height: 28))
            field.placeholderString = "在这里粘贴 OpenAI 官方 API Key"
            let uiCheck = CommandLine.arguments.contains("--ui-test")
            let alert = NSAlert()
            alert.messageText = uiCheck ? "iRIXI · 粘贴检查（只用合成内容）" : "iRIXI · 填写 OpenAI API Key"
            alert.informativeText = "仅保存到本机专用钥匙串。\n不会发送网络请求、启动测试或更改 Codex 登录。\n已有本产品密钥时，保存会替换它。"
            alert.accessoryView = field
            alert.addButton(withTitle: uiCheck ? "校验合成内容" : "保存密钥")
            alert.addButton(withTitle: "取消")
            alert.window.initialFirstResponder = field
            NSApplication.shared.activate(ignoringOtherApps: true)
            print("KEY_ENTRY_OPENED: masked native input; no network")
            fflush(stdout)
            while alert.runModal() == .alertFirstButtonReturn {
                let value = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !value.isEmpty && !value.contains(where: { $0.isWhitespace }) else {
                    alert.informativeText = "请输入非空且不含空白字符的密钥。\n不会发送网络请求或启动测试。"
                    continue
                }
                if uiCheck {
                    let passed = value == "irixi-ui-synthetic-20261029"
                    field.stringValue = ""
                    print(passed ? "UI_PASTE_CHECK_PASSED" : "UI_PASTE_CHECK_FAILED")
                    fflush(stdout)
                    exit(passed ? 0 : 1)
                }
                let status = save(Data(value.utf8), to: service)
                field.stringValue = ""
                guard status == errSecSuccess else {
                    alert.informativeText = "未能保存。系统状态码：\(status)。\n原密钥不会被主动删除。可重试或取消。"
                    continue
                }
                let done = NSAlert()
                done.messageText = "密钥已保存"
                done.informativeText = "尚未验证连接，也未调用模型。\n目标任务启动后，再接入产品并验证指定模型。"
                done.addButton(withTitle: "完成")
                print("CREDENTIAL_SAVED_NOT_VALIDATED")
                fflush(stdout)
                done.runModal()
                exit(0)
            }
            field.stringValue = ""
            print("KEY_ENTRY_CANCELLED")
            NSApplication.shared.terminate(nil)
        }
    }
}
let delegate = KeyEntryDelegate()
app.delegate = delegate
app.run()
