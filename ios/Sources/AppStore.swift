import Foundation
import SwiftUI

@MainActor
final class AppStore: ObservableObject {
    static let defaultServer = "https://rpg-roleplay.stellatrix.icu"

    @Published var serverURL: String {
        didSet { UserDefaults.standard.set(serverURL, forKey: "server_url") }
    }
    /// 界面语言("zh-CN" / "zh-TW" / "en")。改动即时重渲染整树并持久化。
    @Published var language: String {
        didSet {
            UserDefaults.standard.set(language, forKey: "app_language")
            AppLanguage.apply(language)
        }
    }
    var localeId: String { AppLanguage.localeId(for: language) }
    @Published var user: APIUser?
    @Published var booting = true
    @Published var loginError: String?
    @Published var working = false
    @Published var demo = false   // 演示/游客模式:本地 mock 数据,不联网(供体验 + App Store 审核)

    @Published var activeGame: GameLaunch?   // 非空 → 全屏呈现游戏台(剧情对话)
    @Published var launching = false

    let api = API()

    init() {
        // 开发/测试可用环境变量 MEADHALL_SERVER 覆盖默认服务器(simctl 用 SIMCTL_CHILD_ 前缀传入)。
        let envOverride = ProcessInfo.processInfo.environment["MEADHALL_SERVER"]
        self.serverURL = envOverride
            ?? UserDefaults.standard.string(forKey: "server_url")
            ?? AppStore.defaultServer
        // 测试可用 MEADHALL_LANG 覆盖(simctl 用 SIMCTL_CHILD_ 前缀)。
        let lang = ProcessInfo.processInfo.environment["MEADHALL_LANG"] ?? AppLanguage.resolveInitial()
        self.language = lang
        AppLanguage.apply(lang)   // init 内 didSet 不触发,手动应用一次
    }

    /// 切换界面语言:即时改 UI + 持久化 + 同步后端偏好(与 web 共享 pref.ui_language)。
    func setLanguage(_ code: String) {
        guard code != language else { return }
        language = code
        if !demo { Task { try? await api.setPreferences(base: serverURL, ["pref.ui_language": code]) } }
    }

    var loggedIn: Bool { user != nil }

    /// 启动时用已有 cookie 探活 /api/auth/me。
    func bootstrap() async {
        booting = true
        defer { booting = false }
        // 开发/测试:注入已有会话 cookie 直接登录(不输密码),用于对生产做真机 e2e。生产构建无此 env。
        if let ck = ProcessInfo.processInfo.environment["MEADHALL_COOKIE"], !ck.isEmpty,
           let host = URL(string: serverURL)?.host,
           let c = HTTPCookie(properties: [.domain: host, .path: "/", .name: "rpg_session", .value: ck, .secure: true, .init(rawValue: "HttpOnly"): true]) {
            HTTPCookieStorage.shared.setCookie(c)
        }
        if ProcessInfo.processInfo.environment["MEADHALL_DEMO"] == "1" {
            enterDemo()
            if ProcessInfo.processInfo.environment["MEADHALL_OPEN_GAME"] == "1", let s = DemoData.saves.first {
                activeGame = GameLaunch(id: s.id, title: s.display, scriptTitle: s.scriptTitle)
            }
            return
        }
        user = try? await api.me(base: serverURL)
    }

    func login(username: String, password: String) async {
        loginError = nil
        working = true
        defer { working = false }
        do {
            user = try await api.login(base: serverURL, username: username, password: password)
        } catch {
            loginError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func enterDemo() {
        demo = true
        user = APIUser(id: 0, username: "demo", displayName: "演示", role: "user")
    }

    func logout() async {
        if !demo { await api.logout(base: serverURL) }
        demo = false
        user = nil
    }

    /// 进入游戏:先激活存档(真实模式),再全屏呈现游戏台。
    func launchGame(_ save: SaveItem) async {
        launching = true
        defer { launching = false }
        if !demo {
            do { try await api.activateSave(base: serverURL, id: save.id) }
            catch {
                loginError = (error as? LocalizedError)?.errorDescription ?? "进入游戏失败"
                return
            }
        }
        activeGame = GameLaunch(id: save.id, title: save.display, scriptTitle: save.scriptTitle)
    }

    /// 直接进入指定存档(已激活,例如 /api/new 之后)。
    func openGame(id: Int, title: String, scriptTitle: String?) {
        activeGame = GameLaunch(id: id, title: title, scriptTitle: scriptTitle)
    }

    func exitGame() { activeGame = nil }

    /// 切换服务器:清掉旧服务器 cookie + 当前登录态,回到登录页。
    func applyServer(_ newURL: String) async {
        let trimmed = newURL.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        api.clearCookies(for: serverURL)
        serverURL = trimmed
        user = nil
        await bootstrap()
    }

    /// 扫码免登录:切到该服务器 + 消费桌面端 desktop-login token → 直接登录(扫码登录)。
    /// 返回是否登录成功(失败时 user 仍为 nil,调用方提示)。
    func scanLogin(base: String, token: String) async -> Bool {
        let trimmed = base.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return false }
        api.clearCookies(for: serverURL)
        serverURL = trimmed
        user = (try? await api.desktopLogin(base: trimmed, token: token)) ?? nil
        return user != nil
    }

    /// 扫邀请链接 → 轻量注册自己的账号加入该自部署服务器。返回错误文案(nil=成功)。
    func scanInviteRegister(base: String, invite: String, username: String, password: String) async -> String? {
        let trimmed = base.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return "服务器地址无效" }
        api.clearCookies(for: serverURL)
        serverURL = trimmed
        do {
            user = try await api.registerInvite(base: trimmed, invite: invite, username: username, password: password)
            return user == nil ? "注册失败" : nil
        } catch let APIError.http(_, msg) { return msg.isEmpty ? "注册失败" : msg }
        catch { return "注册失败,请重试" }
    }
}
