import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    var mainWindow: NSWindow!
    var webView: WKWebView!
    var previewWindows: [NSWindow] = []
    var launcherProcess: Process?
    var port: Int { (Bundle.main.object(forInfoDictionaryKey: "IrixiPilotPort") as? Int) ?? 58312 }
    var runtimeDirectory: String { (Bundle.main.object(forInfoDictionaryKey: "IrixiRuntimeDirectory") as? String) ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/IRiXi/Personal Agent P0").path }
    var workspaceRoot: String = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Projects/irixi-office-agent").path

    var homeUrl: URL {
        var components = URLComponents(string: "http://127.0.0.1:\(port)/?backend=openoffice&view=office")!
        if let conversation = UserDefaults.standard.string(forKey: "lastConversation") {
            components.queryItems?.append(URLQueryItem(name: "conversation", value: conversation))
        }
        let identity = UserDefaults.standard.string(forKey: "mainDraftWindow") ?? UUID().uuidString
        UserDefaults.standard.set(identity, forKey: "mainDraftWindow")
        components.queryItems?.append(URLQueryItem(name: "window", value: identity))
        return components.url!
    }

    func resolveWorkspaceRoot() -> String {
        if let configured = Bundle.main.object(forInfoDictionaryKey: "IrixiWorkspaceRoot") as? String { return configured }
        // Support a bundle kept next to its workspace.
        var url = Bundle.main.bundleURL.deletingLastPathComponent()
        let fm = FileManager.default
        for _ in 0..<4 {
            let candidate = url.appendingPathComponent("omo-pilot/server.mjs").path
            if fm.fileExists(atPath: candidate) {
                return url.path
            }
            url.deleteLastPathComponent()
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Projects/irixi-office-agent").path
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        workspaceRoot = resolveWorkspaceRoot()
        setupMenu()
        setupMainWindow()
        ensureServerAndLoad()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        // The shared service keeps running after this window closes.
        rememberSelection()
    }

    func rememberSelection() {
        if let url = webView.url, url.host == "127.0.0.1", url.port == port, url.path == "/" {
            let conversation = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "conversation" })?.value
            UserDefaults.standard.set(conversation, forKey: "lastConversation")
            if let identity = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "window" })?.value { UserDefaults.standard.set(identity, forKey: "mainDraftWindow") }
        }
    }

    func setupMenu() {
        let mainMenu = NSMenu()

        // App Menu
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenuItem.submenu = appMenu
        appMenu.addItem(withTitle: "关于 iRIXI Personal Agent", action: #selector(showAbout), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "重新连接本地服务", action: #selector(restartBackend), keyEquivalent: "R")
        appMenu.addItem(withTitle: "在默认浏览器中打开", action: #selector(openInBrowser), keyEquivalent: "b")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "退出 iRIXI Personal Agent", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        // Edit Menu (needed for Cmd+C / Cmd+V / Cmd+A in inputs)
        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "编辑")
        editMenuItem.submenu = editMenu
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        // View Menu
        let viewMenuItem = NSMenuItem()
        mainMenu.addItem(viewMenuItem)
        let viewMenu = NSMenu(title: "视图")
        viewMenuItem.submenu = viewMenu
        let reloadItem = viewMenu.addItem(withTitle: "重新加载页面", action: #selector(reloadPage(_:)), keyEquivalent: "r")
        reloadItem.target = self
        viewMenu.addItem(withTitle: "维多利亚办公室主场景", action: #selector(goHome), keyEquivalent: "1")
        viewMenu.addItem(withTitle: "项目与对话", action: #selector(goReviewView), keyEquivalent: "2")
        viewMenu.addItem(withTitle: "本对话最近网页成果", action: #selector(openCurrentToolPreview), keyEquivalent: "3")

        NSApp.mainMenu = mainMenu
    }

    func setupMainWindow() {
        let screenRect = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let width = min(1440.0, screenRect.width * 0.92)
        let height = min(920.0, screenRect.height * 0.90)
        let frame = NSRect(
            x: screenRect.origin.x + (screenRect.width - width) / 2.0,
            y: screenRect.origin.y + (screenRect.height - height) / 2.0,
            width: width,
            height: height
        )

        mainWindow = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        mainWindow.title = "iRIXI Personal Agent · 维多利亚办公室"
        mainWindow.minSize = NSSize(width: 980, height: 680)

        let config = WKWebViewConfiguration()
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        config.userContentController.add(self, name: "irixiHost")

        webView = WKWebView(frame: mainWindow.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.uiDelegate = self
        webView.navigationDelegate = self

        mainWindow.contentView?.addSubview(webView)
        mainWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        showLoadingScreen(statusText: "正在连接本机对话与项目。无需打开终端。")
    }

    func showLoadingScreen(statusText: String, isError: Bool = false) {
        let retryHtml = isError
            ? "<div style='margin-top:18px;'><a href='irixi://restart-backend' style='display:inline-block;padding:9px 18px;background:#d4af6a;color:#1c1915;border-radius:8px;text-decoration:none;font-weight:600;'>重新连接</a></div>"
            : ""
        let loadingHtml = """
        <!doctype html>
        <html lang="zh-CN">
        <head><meta charset="utf-8"><style>
          body { margin: 0; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #1c1915; color: #f3ead8; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
          .card { padding: 32px 44px; border: 1px solid rgba(212, 175, 106, 0.35); border-radius: 14px; background: rgba(38, 33, 27, 0.92); text-align: center; max-width: 520px; }
          h1 { margin: 0 0 10px 0; font-size: 20px; color: #e8c987; }
          p { margin: 0; font-size: 14px; opacity: 0.88; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
        </style></head>
        <body><div class="card">
          <h1>\(isError ? "iRIXI 后台引擎需要重连" : "iRIXI Personal Agent 正在唤醒…")</h1>
          <p>\(statusText.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;"))</p>
          \(retryHtml)
        </div></body></html>
        """
        webView.loadHTMLString(loadingHtml, baseURL: nil)
    }

    func ensureServerAndLoad() {
        // A live local service needs no new filesystem permission or child process.
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/product-health")!)
        request.timeoutInterval = 10
        URLSession.shared.dataTask(with: request) { [weak self] bytes, response, error in
            guard let self else { return }
            if let error {
                DispatchQueue.main.async {
                    if (error as? URLError)?.code == .cannotConnectToHost { self.startBackendProcess() }
                    else { self.showLoadingScreen(statusText: "本地服务暂时没有回应。为保护工作，没有启动第二份服务。请稍后重新连接。", isError: true) }
                }
                return
            }
            let state = bytes.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let expected = URL(fileURLWithPath: self.runtimeDirectory).appendingPathComponent("conversation").path
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  state?["storagePath"] as? String == expected,
                  let build = state?["build"] as? String else {
                DispatchQueue.main.async { self.showLoadingScreen(statusText: "本地端口尚未提供当前版本的项目数据。没有替换任何服务。请稍后重新连接。", isError: true) }
                return
            }
            var pageRequest = URLRequest(url: self.homeUrl, cachePolicy: .reloadIgnoringLocalCacheData)
            pageRequest.timeoutInterval = 10
            URLSession.shared.dataTask(with: pageRequest) { bytes, response, error in
                let html = bytes.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                DispatchQueue.main.async {
                    if error != nil {
                        self.showLoadingScreen(statusText: "后台响应较慢或连接中断。工作仍保留，请稍后重新连接。", isError: true)
                    } else if (response as? HTTPURLResponse)?.statusCode == 200 && html.contains("/conversation-app.js?v=\(build)") {
                        self.webView.load(pageRequest)
                    } else {
                        self.showLoadingScreen(statusText: "当前服务与产品文件版本不一致，需要维护者安全重载。对话和成果仍在。", isError: true)
                    }
                }
            }.resume()
        }.resume()
    }

    func startBackendProcess() {
        if launcherProcess?.isRunning == true { return }
        let fm = FileManager.default
        let candidates = ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"]
        guard let node = candidates.first(where: { fm.isExecutableFile(atPath: $0) }) else {
            showLoadingScreen(statusText: "未找到 Node.js。本机项目和对话仍保留。", isError: true)
            return
        }
        let script = "\(workspaceRoot)/scripts/open-personal-agent-p0.mjs"
        guard fm.fileExists(atPath: script) else {
            showLoadingScreen(statusText: "找不到本地启动入口：\(script)", isError: true)
            return
        }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: node)
        proc.arguments = [script, "--no-open", "--port", String(port), "--runtime", runtimeDirectory]
        proc.currentDirectoryURL = URL(fileURLWithPath: workspaceRoot)
        let logURL = URL(fileURLWithPath: runtimeDirectory).appendingPathComponent("app-launcher.log")
        if !fm.fileExists(atPath: logURL.path) { fm.createFile(atPath: logURL.path, contents: nil) }
        if let log = try? FileHandle(forWritingTo: logURL) {
            _ = try? log.seekToEnd()
            proc.standardOutput = log
            proc.standardError = log
        }
        proc.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self else { return }
                self.launcherProcess = nil
                if process.terminationStatus == 0 {
                    self.webView.load(URLRequest(url: self.homeUrl, cachePolicy: .reloadIgnoringLocalCacheData))
                } else {
                    self.showLoadingScreen(statusText: "本地服务未能连接。项目和对话仍保留。请检查启动记录：\(logURL.path)", isError: true)
                }
            }
        }
        do {
            try proc.run(); launcherProcess = proc
            DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self, weak proc] in
                guard let self, let proc, self.launcherProcess === proc, proc.isRunning else { return }
                // Keep the handle until its termination callback confirms exit.
                // Repeated reconnects must not spawn another pending launcher.
                proc.terminate()
                self.showLoadingScreen(statusText: "启动尚未完成。如果 macOS 正在询问桌面文件夹访问，请处理系统提示后重新连接。项目与对话仍保留。", isError: true)
            }
        }
        catch { showLoadingScreen(statusText: "无法启动本地入口：\(error.localizedDescription)", isError: true) }
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        guard menuItem.action == #selector(reloadPage(_:)) else { return true }
        guard let keyWindow = NSApp.keyWindow else { return false }
        return webView(in: keyWindow) != nil
    }

    @objc func reloadPage(_ sender: Any?) {
        let targetWindow: NSWindow?
        if sender is NSMenuItem {
            targetWindow = NSApp.keyWindow
        } else if let button = sender as? NSButton {
            targetWindow = button.window
        } else {
            return
        }
        guard let targetWindow, let targetWebView = webView(in: targetWindow) else { return }
        targetWebView.reload()
    }

    private func webView(in window: NSWindow) -> WKWebView? {
        func findWebView(in view: NSView) -> WKWebView? {
            if let webView = view as? WKWebView { return webView }
            for subview in view.subviews {
                if let found = findWebView(in: subview) { return found }
            }
            return nil
        }
        guard let contentView = window.contentView else { return nil }
        return findWebView(in: contentView)
    }

    @objc func goHome() {
        guard let window = NSApp.keyWindow, let target = webView(in: window) else { return }
        target.evaluateJavaScript("document.querySelector('[data-view-target=office]')?.click(); document.querySelector('[data-project-dialogue-close]')?.click(); document.querySelector('[data-action=close-sidebar]')?.click();", completionHandler: nil)
    }

    @objc func goReviewView() {
        guard let window = NSApp.keyWindow, let target = webView(in: window) else { return }
        target.evaluateJavaScript("document.querySelector('[data-view-target=office]')?.click(); document.querySelector('.office-map-project-button')?.click();", completionHandler: nil)
    }

    @objc func openCurrentToolPreview() {
        let js = """
        (function() {
          const link = document.querySelector('#wb-results-slot .wb-application a[target="_blank"]') || document.querySelector('#wb-results-slot a[href*="/index.html?"]');
          if (link) { link.click(); }
          else {
            const results = document.querySelector('#wb-results');
            if (results) { results.open = true; results.scrollIntoView({block: 'nearest'}); }
            alert('当前没有正在运行的网页成果。请在“进度与成果”查看状态和可用操作。');
          }
        })();
        """
        guard let window = NSApp.keyWindow, let target = webView(in: window) else { return }
        target.evaluateJavaScript(js, completionHandler: nil)
    }

    @objc func openInBrowser() {
        rememberSelection()
        NSWorkspace.shared.open(homeUrl)
    }

    @objc func restartBackend() {
        rememberSelection()
        showLoadingScreen(statusText: "正在重新连接。正在进行的工作会保留。")
        ensureServerAndLoad()
    }

    @objc func showAbout() {
        let alert = NSAlert()
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "未知"
        alert.messageText = "iRIXI Personal Agent"
        alert.informativeText = "本地版 \(version)\n对话与项目由 OmO 执行。关闭窗口不会停止后台工作。\n工程位置：\(workspaceRoot)"
        alert.runModal()
    }

    func showDownloadMessage(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "交付文件未保存"
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        alert.runModal()
    }

    // The preview origin is untrusted and cannot use this bridge, even in a popup.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              let page = message.frameInfo.request.url,
              page.scheme == "http", page.host == "127.0.0.1", page.port == port, page.path == "/",
              let body = message.body as? [String: Any], let requestId = body["requestId"] as? String,
              requestId.count < 100, let action = body["action"] as? String,
              let sender = message.webView else { return }
        func reply(_ result: [String: Any]) {
            let value: [String: Any] = ["requestId": requestId, "result": result]
            guard let bytes = try? JSONSerialization.data(withJSONObject: value), let json = String(data: bytes, encoding: .utf8) else { return }
            sender.evaluateJavaScript("window.irixiHostReceive?.(\(json))", completionHandler: nil)
        }
        if action == "choose-directory" {
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true; panel.canChooseFiles = false
            panel.canCreateDirectories = true; panel.allowsMultipleSelection = false
            panel.message = "选择这个项目保存和工作的文件夹"
            let finish: (NSApplication.ModalResponse) -> Void = { response in
                if response == .OK, let url = panel.url { reply(["path": url.path]) }
                else { reply(["cancelled": true]) }
            }
            if let window = sender.window { panel.beginSheetModal(for: window, completionHandler: finish) }
            else { panel.begin(completionHandler: finish) }
        } else if action == "copy", let text = body["text"] as? String, text.count <= 200000 {
            NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string); reply(["copied": true])
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard let link = urls.first, link.scheme == "irixi", link.host == "conversation",
              let source = URLComponents(url: link, resolvingAgainstBaseURL: false),
              let conversation = source.queryItems?.first(where: { $0.name == "id" })?.value,
              conversation.hasPrefix("conversation-") else { return }
        var target = URLComponents(url: homeUrl, resolvingAgainstBaseURL: false)!
        target.queryItems = [URLQueryItem(name: "backend", value: "openoffice"), URLQueryItem(name: "view", value: "office"), URLQueryItem(name: "conversation", value: conversation)]
        if let identity = UserDefaults.standard.string(forKey: "mainDraftWindow") { target.queryItems?.append(URLQueryItem(name: "window", value: identity)) }
        if let message = source.queryItems?.first(where: { $0.name == "message" })?.value { target.queryItems?.append(URLQueryItem(name: "message", value: message)) }
        if let url = target.url { webView.load(URLRequest(url: url)); mainWindow.makeKeyAndOrderFront(nil) }
    }

    // MARK: - WKUIDelegate (Alert, Confirm, File Upload, Popup Preview Windows)

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "iRIXI 办公室提示"
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "请确认操作"
        alert.informativeText = message
        alert.addButton(withTitle: "确认")
        alert.addButton(withTitle: "取消")
        let response = alert.runModal()
        completionHandler(response == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        if panel.runModal() == .OK {
            completionHandler(panel.urls)
        } else {
            completionHandler(nil)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        let popupRect = NSRect(x: 160, y: 120, width: 1120, height: 780)
        let popupWindow = NSWindow(
            contentRect: popupRect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        let targetURL = navigationAction.request.url
        let isConversation = targetURL?.host == "127.0.0.1" && targetURL?.port == port && targetURL?.path == "/"
        popupWindow.title = isConversation ? "iRIXI 对话" : "iRIXI 成果实时预览窗口"
        let popupWebView = WKWebView(frame: popupWindow.contentView!.bounds, configuration: configuration)
        popupWebView.autoresizingMask = [.width, .height]
        popupWebView.uiDelegate = self
        popupWebView.navigationDelegate = self
        popupWindow.contentView?.addSubview(popupWebView)
        let refreshAccessory = NSTitlebarAccessoryViewController()
        refreshAccessory.layoutAttribute = .right
        refreshAccessory.view = NSView(frame: NSRect(x: 0, y: 0, width: 72, height: 32))
        let refreshButton = NSButton(title: "刷新", target: self, action: #selector(reloadPage(_:)))
        refreshButton.bezelStyle = .rounded
        refreshButton.toolTip = "刷新当前成果预览"
        refreshButton.frame = NSRect(x: 2, y: 2, width: 64, height: 28)
        refreshAccessory.view.addSubview(refreshButton)
        popupWindow.addTitlebarAccessoryViewController(refreshAccessory)
        popupWindow.makeKeyAndOrderFront(nil)
        previewWindows.append(popupWindow)
        if let url = navigationAction.request.url, url.absoluteString != "about:blank" {
            popupWebView.load(navigationAction.request)
        }
        return popupWebView
    }

    // MARK: - WKNavigationDelegate (Handle confirmed downloads cleanly)

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url {
            if url.scheme == "irixi" && url.host == "restart-backend" {
                restartBackend()
                decisionHandler(.cancel)
                return
            }
            let path = url.path
            if path.hasSuffix("/patch") || path.hasSuffix("/zip") || path.hasSuffix("/document") {
                downloadDeliverable(from: url)
                decisionHandler(.cancel)
                return
            }
        }
        decisionHandler(.allow)
    }

    func downloadDeliverable(from url: URL) {
        URLSession.shared.dataTask(with: url) { data, response, error in
            let isZip = url.path.hasSuffix("/zip")
            let isDocument = url.path.hasSuffix("/document")
            let defaultName = isZip ? "irixi-confirmed-delivery.zip"
                : isDocument ? "irixi-confirmed-document.md" : "irixi-confirmed-delivery.patch"
            do {
                let body = try ConfirmedDeliveryDownload.validatedData(data: data, response: response, error: error, isDocument: isDocument)
                DispatchQueue.main.async {
                    let savePanel = NSSavePanel()
                    savePanel.nameFieldStringValue = defaultName
                    savePanel.title = "保存已确认的交付成果"
                    if savePanel.runModal() == .OK, let selectedUrl = savePanel.url {
                        let targetUrl = isDocument && selectedUrl.pathExtension.lowercased() != "md"
                            ? selectedUrl.appendingPathExtension("md") : selectedUrl
                        do { try body.write(to: targetUrl, options: .atomic) }
                        catch { self.showDownloadMessage("无法保存文件：\(error.localizedDescription)。原成果仍保留。") }
                    }
                }
            } catch {
                DispatchQueue.main.async { self.showDownloadMessage(error.localizedDescription) }
            }
        }.resume()
    }
}

@main
struct IrixiPersonalAgentApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }
}
