import SwiftUI

@main
struct MeadhallApp: App {
    @StateObject private var store = AppStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .task { await store.bootstrap() }
                .tint(Theme.accent)
                .preferredColorScheme(.dark)
                .environment(\.locale, Locale(identifier: store.localeId))
                .id(store.language)   // 切换语言 → 整树重建,Text 重新查表即时生效
        }
    }
}

struct RootView: View {
    @EnvironmentObject var store: AppStore

    var body: some View {
        ZStack {
            WarmBackground()
            Group {
                if store.booting {
                    VStack(spacing: 14) {
                        ProgressView().tint(Theme.accent)
                        Text("连接中…").foregroundStyle(Theme.muted).font(Theme.ui(13))
                    }
                } else if store.loggedIn {
                    RootShell()   // 自适应:iPhone=底栏 / iPad·Mac=侧栏(大屏原生适配)
                } else {
                    LoginView()
                }
            }
        }
    }
}
