import SwiftUI

// 5-Tab 外壳,1:1 对齐 web mobile_v2:主页 / 剧本 / 游戏 / 角色 / 我的。
// 「游戏」= 存档列表(进入游戏台);游戏台本身是全屏呈现(fullScreenCover),无 Tab 栏。
struct MainTabView: View {
    @EnvironmentObject var store: AppStore
    @State private var tab = Int(ProcessInfo.processInfo.environment["MEADHALL_TAB"] ?? "0") ?? 0

    init() {
        let a = UITabBarAppearance()
        a.configureWithOpaqueBackground()
        a.backgroundColor = UIColor(Theme.bgDeep)
        a.shadowColor = UIColor(Theme.lineSoft)
        UITabBar.appearance().standardAppearance = a
        UITabBar.appearance().scrollEdgeAppearance = a
    }

    var body: some View {
        TabView(selection: $tab) {
            HomeView(switchTab: { tab = $0 }).tag(0)
                .tabItem { Label("主页", systemImage: "house") }
            ScriptsView().tag(1)
                .tabItem { Label("剧本", systemImage: "books.vertical") }
            SavesView().tag(2)
                .tabItem { Label("游戏", systemImage: "play.circle.fill") }
            CharacterCardsView().tag(3)
                .tabItem { Label("角色", systemImage: "person.crop.rectangle.stack") }
            MeView(switchTab: { tab = $0 }).tag(4)
                .tabItem { Label("我的", systemImage: "person.crop.circle") }
        }
        .tint(Theme.accent)
        .fullScreenCover(item: $store.activeGame) { launch in
            GameConsoleView(launch: launch).environmentObject(store)
        }
    }
}
