import SwiftUI

// 我的 Tab —— 资料 + 统计 + 完整设置(模型/密钥/参数/记忆/权限/偏好/服务器)。
struct MeView: View {
    @EnvironmentObject var store: AppStore
    var switchTab: (Int) -> Void

    @State private var stats: MeStats?
    @State private var sheet: MeSheet?
    @State private var providers: [PickerProvider] = []
    @State private var currentModelId = ""
    @State private var modelLabel = "默认模型"

    enum MeSheet: Identifiable { case model, models, params, modules, memory, perms, prefs, server, usage, editProfile, achievements, account, skills
        var id: Int { hashValue } }
    @State private var showLogout = false
    @State private var avatarURL: String?

    var body: some View {
        NavigationStack {
            ZStack {
                WarmBackground()
                ScrollView {
                    VStack(spacing: 16) {
                        hero.onTapGesture { sheet = .editProfile }
                        statsBar
                        group("我的") {
                            navRow("编辑资料", value: nil, "person.text.rectangle") { sheet = .editProfile }
                            rowDivider; navRow("成就", value: nil, "rosette") { sheet = .achievements }
                        }
                        group("模型") {
                            navRow("默认模型", value: modelLabel, "cpu") { sheet = .model }
                            rowDivider; navRow("模型与密钥", value: "BYOK", "key") { sheet = .models }
                            rowDivider; navRow("模型参数", value: nil, "slider.horizontal.3") { sheet = .params }
                            rowDivider; navRow("模块模型", value: "按模块分配", "square.stack.3d.up") { sheet = .modules }
                        }
                        group("对话") {
                            navRow("记忆", value: nil, "brain") { sheet = .memory }
                            rowDivider; navRow("权限", value: nil, "lock.shield") { sheet = .perms }
                            rowDivider; navRow("偏好", value: nil, "switch.2") { sheet = .prefs }
                        }
                        group("内容") {
                            // 「角色卡」已有底部 Tab,这里不再重复入口(用户反馈:内容区莫名多了个角色卡)。
                            navRow("技能", value: "导入人格 skill", "spark") { sheet = .skills }
                            rowDivider; navRow("用量", value: nil, "chart.bar") { sheet = .usage }
                            rowDivider; navRow("服务器", value: serverHost, "server.rack") { sheet = .server }
                        }
                        group("账号与数据") {
                            navRow("账号与数据", value: nil, "person.badge.shield.checkmark") { sheet = .account }
                        }
                        aboutGroup
                        logoutButton
                    }.padding(16)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .task {
                await load()
                switch ProcessInfo.processInfo.environment["MEADHALL_SHEET"] {
                case "params": sheet = .params
                case "models": sheet = .models
                case "memory": sheet = .memory
                case "perms": sheet = .perms
                case "prefs": sheet = .prefs
                case "modules": sheet = .modules
                case "usage": sheet = .usage
                case "server": sheet = .server
                case "account": sheet = .account
                case "achievements": sheet = .achievements
                case "editProfile": sheet = .editProfile
                case "skills": sheet = .skills
                default: break
                }
            }
            .sheet(item: $sheet) { which in sheetView(which) }
        }
    }

    @ViewBuilder private func sheetView(_ which: MeSheet) -> some View {
        switch which {
        case .model:
            ModelPickerView(providers: providers, currentId: currentModelId) { m in
                modelLabel = m.display; currentModelId = m.id
                if !store.demo { Task { try? await store.api.selectModel(base: store.serverURL, apiId: m.apiId, modelId: m.id, saveId: nil) } }
            }
        case .models: ModelsView().environmentObject(store)
        case .params: ModelParamsView().environmentObject(store)
        case .modules: ModuleModelsView().environmentObject(store)
        case .usage: UsageView().environmentObject(store)
        case .editProfile: EditProfileView().environmentObject(store)
        case .achievements: AchievementsView().environmentObject(store)
        case .memory: MemoryView().environmentObject(store)
        case .perms: PermissionsView().environmentObject(store)
        case .prefs: PreferencesView().environmentObject(store)
        case .server: ServerSettingsView().environmentObject(store)
        case .account: AccountDataView().environmentObject(store)
        case .skills: SkillsView().environmentObject(store)
        }
    }

    private var hero: some View {
        HStack(spacing: 14) {
            if store.demo {
                ZStack { Circle().fill(Theme.accentSoft); Circle().stroke(Theme.accentEdge, lineWidth: 1)
                    Text(String((store.user?.displayName ?? store.user?.username ?? "U").prefix(1)))
                        .font(Theme.serif(26)).foregroundStyle(Theme.accent)
                }.frame(width: 64, height: 64)
            } else {
                ImageSetControl(
                    base: store.serverURL, currentURL: avatarURL, style: .avatarCircle, width: 64,
                    canEdit: true, placeholderIcon: "person.fill",
                    upload: { data, mime in try await store.api.uploadProfileAvatar(base: store.serverURL, data: data, mime: mime) },
                    generate: { prompt, size in
                        let id = try await store.api.enqueueImage(base: store.serverURL, prompt: prompt, kind: "avatar", size: size, attach: ["type": "user_avatar"])
                        return try await store.api.awaitImage(base: store.serverURL, id: id)
                    },
                    remove: { try await store.api.resetProfileAvatar(base: store.serverURL) },
                    onUpdated: { v in avatarURL = v; store.user?.avatarURL = v })
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(store.user?.displayName ?? store.user?.username ?? "用户").font(Theme.serif(20, .semibold)).foregroundStyle(Theme.text)
                Text(loc: store.demo ? "演示模式" : "@\(store.user?.username ?? "")").font(Theme.ui(12.5)).foregroundStyle(Theme.muted)
                if let role = store.user?.role, !role.isEmpty {
                    Text(role).font(Theme.ui(10, .semibold)).foregroundStyle(Theme.accent)
                        .padding(.horizontal, 7).padding(.vertical, 2).background(Capsule().fill(Theme.accentSoft))
                }
            }
            Spacer()
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 16).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Theme.line, lineWidth: 1))
    }

    private var statsBar: some View {
        HStack(spacing: 0) {
            stat(fmtHours(stats?.playHours ?? 0), "时长")
            divider; stat("\(stats?.rounds ?? 0)", "回合")
            divider; stat("\(stats?.branches ?? 0)", "分支")
            divider; stat("\(stats?.streak ?? 0)", "连签")
        }
        .padding(.vertical, 14)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
    }
    private func stat(_ n: String, _ l: String) -> some View {
        VStack(spacing: 3) {
            Text(n).font(Theme.ui(18, .semibold)).foregroundStyle(Theme.text).monospacedDigit()
            Text(loc: l).font(Theme.ui(11)).foregroundStyle(Theme.muted)
        }.frame(maxWidth: .infinity)
    }
    private var divider: some View { Rectangle().fill(Theme.lineSoft).frame(width: 1, height: 26) }

    private func group<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(loc: title).font(Theme.ui(11, .semibold)).foregroundStyle(Theme.muted2).tracking(1).padding(.leading, 4)
            VStack(spacing: 0) { content() }
                .background(RoundedRectangle(cornerRadius: 14).fill(Theme.panel))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
        }
    }
    private var aboutGroup: some View {
        VStack(spacing: 0) {
            infoRow("版本", "1.0.0")
            rowDivider; infoRow("应用", "Meadhall")
        }
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
    }

    private var logoutButton: some View {
        Button { showLogout = true } label: {
            Text(loc: store.demo ? "退出演示" : "退出登录").font(Theme.ui(15, .medium)).foregroundStyle(Theme.danger)
                .frame(maxWidth: .infinity).padding(.vertical, 14)
                .background(RoundedRectangle(cornerRadius: 14).fill(Theme.panel))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
        }
        .confirmationDialog(store.demo ? "退出演示?" : "退出登录?", isPresented: $showLogout, titleVisibility: .visible) {
            Button(store.demo ? "退出演示" : "退出登录", role: .destructive) { Task { await store.logout() } }
            Button("取消", role: .cancel) {}
        }
    }

    private func navRow(_ title: String, value: String?, _ icon: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon).font(.system(size: 15)).foregroundStyle(Theme.accent).frame(width: 24)
                Text(loc: title).font(Theme.ui(15)).foregroundStyle(Theme.text)
                Spacer()
                if let value { Text(loc: value).font(Theme.ui(13)).foregroundStyle(Theme.muted).lineLimit(1) }
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.muted2)
            }.padding(.horizontal, 14).padding(.vertical, 14).contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
    private func infoRow(_ title: String, _ value: String) -> some View {
        HStack { Text(loc: title).font(Theme.ui(15)).foregroundStyle(Theme.text); Spacer(); Text(loc: value).font(Theme.ui(13)).foregroundStyle(Theme.muted) }
            .padding(.horizontal, 14).padding(.vertical, 14)
    }
    private var rowDivider: some View { Rectangle().fill(Theme.lineSoft).frame(height: 1).padding(.leading, 50) }

    private var serverHost: String { URL(string: store.serverURL)?.host ?? store.serverURL }
    private func fmtHours(_ h: Double) -> String { h >= 1 ? String(format: "%.0fh", h) : "0h" }

    private func load() async {
        avatarURL = store.user?.avatarURL
        if store.demo { stats = DemoData.stats; providers = DemoData.providers; currentModelId = DemoData.selectedModelId; modelLabel = DemoData.selectedModelDisplay; return }
        if let s = try? await store.api.meStats(base: store.serverURL) { stats = s }
        if let r = try? await store.api.models(base: store.serverURL) {
            providers = r.pickerProviders
            if let sel = r.selected { currentModelId = sel.modelName; if !sel.display.isEmpty { modelLabel = sel.display } }
        }
    }
}
