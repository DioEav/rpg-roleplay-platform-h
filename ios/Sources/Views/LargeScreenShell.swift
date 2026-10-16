import SwiftUI

// ─────────────────────────────────────────────────────────────────────────────
// 大屏(iPad / Mac)原生适配 —— 底层按 horizontalSizeClass 分流:
//   · compact(iPhone) → 原 5-Tab 底栏 MainTabView(手机交互不变)
//   · regular(iPad / Designed-for-iPad on Mac)→ NavigationSplitView 侧边栏导航,
//     交互系统对齐 web 左侧导航 + 内容区(而非把手机底栏拉大)。
// 各分区视图(HomeView/ScriptsView/…)自带 NavigationStack,这里只提供外层侧栏 + 内容列。
// ─────────────────────────────────────────────────────────────────────────────

/// 自适应根:按尺寸类切换手机底栏 / 大屏侧栏。RootView 用它替代直接挂 MainTabView。
struct RootShell: View {
    @Environment(\.horizontalSizeClass) private var hsc

    var body: some View {
        if hsc == .regular {
            LargeScreenShell()
        } else {
            MainTabView()
        }
    }
}

/// 大屏分区(与手机 5 Tab 一一对应,rawValue == 原 tab index,便于 switchTab 复用)。
enum AppSection: Int, CaseIterable, Identifiable {
    case home = 0, scripts = 1, games = 2, characters = 3, me = 4
    var id: Int { rawValue }

    var title: String {
        switch self {
        case .home: return "主页"
        case .scripts: return "剧本"
        case .games: return "游戏"
        case .characters: return "角色"
        case .me: return "我的"
        }
    }
    var titleEN: String {
        switch self {
        case .home: return "Home"
        case .scripts: return "Scripts"
        case .games: return "Play"
        case .characters: return "Characters"
        case .me: return "Me"
        }
    }
    var icon: String {
        switch self {
        case .home: return "house"
        case .scripts: return "books.vertical"
        case .games: return "play.circle.fill"
        case .characters: return "person.crop.rectangle.stack"
        case .me: return "person.crop.circle"
        }
    }
}

struct LargeScreenShell: View {
    @EnvironmentObject var store: AppStore
    @State private var selection: AppSection? =
        AppSection(rawValue: Int(ProcessInfo.processInfo.environment["MEADHALL_TAB"] ?? "0") ?? 0) ?? .home
    @State private var columnVisibility: NavigationSplitViewVisibility = .all

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            sidebar
                .navigationSplitViewColumnWidth(min: 220, ideal: 256, max: 320)
        } detail: {
            detail
        }
        .navigationSplitViewStyle(.balanced)
        .tint(Theme.accent)
        // 游戏台仍走全屏沉浸呈现(大屏内部用侧栏面板,见 GameConsoleView 自适应)。
        .fullScreenCover(item: $store.activeGame) { launch in
            GameConsoleView(launch: launch).environmentObject(store)
        }
    }

    // ── 侧边栏(web 风左导航)──
    private var sidebar: some View {
        let isEN = (store.localeId.hasPrefix("en"))
        let acctName = store.user?.displayName ?? store.user?.username ?? ""
        return VStack(alignment: .leading, spacing: 0) {
            // 品牌字标
            HStack(spacing: 8) {
                Image(systemName: "sparkles")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.accent)
                Text("Meadhall")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(.primary)
            }
            .padding(.horizontal, 18).padding(.top, 18).padding(.bottom, 14)

            // 分区列表
            List(AppSection.allCases, selection: $selection) { sec in
                Label(isEN ? sec.titleEN : sec.title, systemImage: sec.icon)
                    .font(.system(size: 15, weight: selection == sec ? .semibold : .regular))
                    .tag(sec)
                    .listRowBackground(
                        selection == sec
                        ? RoundedRectangle(cornerRadius: 9).fill(Theme.accent.opacity(0.16))
                            .padding(.vertical, 2).padding(.horizontal, 6)
                        : nil
                    )
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)

            Divider().overlay(Theme.lineSoft)

            // 账户行(点进"我的")
            Button { selection = .me } label: {
                HStack(spacing: 10) {
                    ZStack {
                        Circle().fill(Theme.panel2).frame(width: 30, height: 30)
                        Text(String((acctName.first ?? "U")))
                            .font(.system(size: 13, weight: .bold)).foregroundStyle(Theme.accent)
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        Text(acctName.isEmpty ? (isEN ? "Account" : "账户") : acctName)
                            .font(.system(size: 13, weight: .medium)).foregroundStyle(.primary).lineLimit(1)
                        Text(store.loggedIn ? (isEN ? "Signed in" : "已登录") : (isEN ? "Guest" : "游客"))
                            .font(.system(size: 11)).foregroundStyle(Theme.muted)
                    }
                    Spacer()
                }
                .padding(.horizontal, 14).padding(.vertical, 12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .background(Theme.bgDeep)
    }

    // ── 内容列:渲染所选分区(各视图自带 NavigationStack)──
    @ViewBuilder private var detail: some View {
        switch selection ?? .home {
        case .home:       HomeView(switchTab: { selection = AppSection(rawValue: $0) ?? .home })
        case .scripts:    ScriptsView()
        case .games:      SavesView()
        case .characters: CharacterCardsView()
        case .me:         MeView(switchTab: { selection = AppSection(rawValue: $0) ?? .me })
        }
    }
}
