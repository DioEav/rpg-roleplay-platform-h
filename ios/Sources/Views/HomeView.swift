import SwiftUI

// 主页 —— 对齐 web MobileHome:继续游戏 + 统计 + 最近剧本 + 最近存档 + 快捷入口。
struct HomeView: View {
    @EnvironmentObject var store: AppStore
    var switchTab: (Int) -> Void

    @State private var scripts: [ScriptItem] = []
    @State private var saves: [SaveItem] = []
    @State private var stats: MeStats?
    @State private var loading = true
    @State private var activeSaveId: Int?

    private var gameSaves: [SaveItem] { saves.filter { !$0.isTavern } }
    private var current: SaveItem? { gameSaves.first(where: { $0.id == activeSaveId }) ?? gameSaves.first(where: { $0.isCurrent }) ?? gameSaves.first }
    private var branchAgg: Int { gameSaves.reduce(0) { $0 + $1.branches } }

    var body: some View {
        ZStack {
            WarmBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    if loading && saves.isEmpty && scripts.isEmpty {
                        ProgressView().tint(Theme.accent).frame(maxWidth: .infinity).padding(.top, 40)
                    } else {
                        continueCard
                        statsBar
                        recentScripts
                        recentSaves
                        shortcuts
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 28)
            }
            .refreshable { await reload() }
        }
        .task { await reload() }
    }

    // MARK: header
    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(Theme.accentSoft).overlay(RoundedRectangle(cornerRadius: 9).stroke(Theme.accentEdge, lineWidth: 1))
                .frame(width: 38, height: 38)
                .overlay(Text("S").font(Theme.serif(20, .semibold)).foregroundStyle(Theme.accent))
            VStack(alignment: .leading, spacing: 2) {
                Text("Meadhall").font(Theme.ui(18, .semibold)).foregroundStyle(Theme.text)
                Text(verbatim: "\(tr(greeting)), \(store.user?.displayName ?? store.user?.username ?? tr("旅人"))")
                    .font(Theme.ui(12)).foregroundStyle(Theme.muted)
            }
            Spacer()
            Button { switchTab(4) } label: {
                ZStack { Circle().fill(Theme.accentSoft); Circle().stroke(Theme.accentEdge, lineWidth: 1)
                    Text(String((store.user?.displayName ?? store.user?.username ?? "U").prefix(1)))
                        .font(Theme.serif(17)).foregroundStyle(Theme.accent)
                }.frame(width: 44, height: 44).contentShape(Rectangle())
            }.accessibilityLabel(Text("个人中心"))
        }
        .padding(.top, 6)
    }

    // MARK: 继续游戏
    @ViewBuilder private var continueCard: some View {
        if let cur = current {
            VStack(alignment: .leading, spacing: 12) {
                Text("继续游戏").font(Theme.ui(11, .semibold)).foregroundStyle(Theme.accent).tracking(1)
                Text(cur.display).font(Theme.serif(22, .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                Text(subtitle(cur)).font(Theme.ui(12.5)).foregroundStyle(Theme.muted).lineLimit(1)
                HStack(spacing: 10) {
                    Button { Task { await store.launchGame(cur) } } label: {
                        HStack(spacing: 6) {
                            if store.launching { ProgressView().tint(Theme.onAccent).scaleEffect(0.8) }
                            else { Image(systemName: "play.fill").font(.system(size: 13)) }
                            Text("进入游戏").font(Theme.ui(14.5, .semibold))
                        }
                        .foregroundStyle(Theme.onAccent).padding(.horizontal, 18).padding(.vertical, 11)
                        .background(Theme.accent, in: Capsule())
                    }.disabled(store.launching)
                    Button { switchTab(2) } label: {
                        Text("存档").font(Theme.ui(14, .medium)).foregroundStyle(Theme.text)
                            .padding(.horizontal, 16).padding(.vertical, 11)
                            .background(Theme.panel2, in: Capsule())
                            .overlay(Capsule().stroke(Theme.line, lineWidth: 1))
                    }
                    Spacer()
                }
            }
            .padding(16)
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Theme.panel))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Theme.accentEdge, lineWidth: 1))
        } else {
            VStack(alignment: .leading, spacing: 10) {
                Text("开始冒险").font(Theme.ui(11, .semibold)).foregroundStyle(Theme.accent).tracking(1)
                Text(verbatim: scripts.isEmpty ? tr("先导入一个剧本") : String(format: tr("从 %lld 个剧本里挑一个开始"), scripts.count))
                    .font(Theme.serif(20, .semibold)).foregroundStyle(Theme.text)
                Button { switchTab(1) } label: {
                    Text("浏览剧本").font(Theme.ui(14.5, .semibold)).foregroundStyle(Theme.onAccent)
                        .padding(.horizontal, 18).padding(.vertical, 11).background(Theme.accent, in: Capsule())
                }.padding(.top, 2)
            }
            .padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Theme.panel))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Theme.line, lineWidth: 1))
        }
    }

    // MARK: 统计
    private var statsBar: some View {
        HStack(spacing: 0) {
            stat("\(scripts.count)", "剧本", accent: true)
            divider; stat("\(gameSaves.count)", "存档")
            divider; stat("\(branchAgg)", "分支")
            divider; stat("\(stats?.assets ?? 0)", "库资产")
        }
        .padding(.vertical, 14)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
    }
    private func stat(_ n: String, _ l: String, accent: Bool = false) -> some View {
        VStack(spacing: 3) {
            Text(n).font(Theme.ui(20, .semibold)).foregroundStyle(accent ? Theme.accent : Theme.text).monospacedDigit()
            Text(loc: l).font(Theme.ui(11)).foregroundStyle(Theme.muted)
        }.frame(maxWidth: .infinity)
    }
    private var divider: some View { Rectangle().fill(Theme.lineSoft).frame(width: 1, height: 28) }

    // MARK: 最近剧本
    @ViewBuilder private var recentScripts: some View {
        if !scripts.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                sectionHead("最近剧本") { switchTab(1) }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(scripts.prefix(4)) { s in
                            Button { switchTab(1) } label: { scriptCard(s) }.buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }
    private func scriptCard(_ s: ScriptItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ServerImageThumb(base: store.serverURL, path: s.cover_image_url, style: .coverPortrait, width: 110, explicitHeight: 64, placeholderIcon: "book.closed")
            Text(s.display).font(Theme.ui(13.5, .medium)).foregroundStyle(Theme.text).lineLimit(1).frame(width: 110, alignment: .leading)
            Text("\(s.chapters)章 · \(wan(s.words))").font(Theme.ui(10.5)).foregroundStyle(Theme.muted)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line, lineWidth: 1))
    }

    // MARK: 最近存档
    @ViewBuilder private var recentSaves: some View {
        if !gameSaves.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                sectionHead("最近存档") { switchTab(2) }
                VStack(spacing: 0) {
                    ForEach(Array(gameSaves.prefix(3).enumerated()), id: \.element.id) { idx, s in
                        Button { Task { await store.launchGame(s) } } label: { saveRow(s) }.buttonStyle(.plain)
                        if idx < min(gameSaves.count, 3) - 1 { Rectangle().fill(Theme.lineSoft).frame(height: 1).padding(.leading, 50) }
                    }
                }
                .background(RoundedRectangle(cornerRadius: 14).fill(Theme.panel))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
            }
        }
    }
    private func saveRow(_ s: SaveItem) -> some View {
        let cur = s.id == activeSaveId || s.isCurrent
        return HStack(spacing: 12) {
            ZStack {
                Circle().fill(cur ? Theme.accentSoft : Theme.panel2)
                Image(systemName: cur ? "play.fill" : "bookmark.fill")
                    .font(.system(size: 13)).foregroundStyle(cur ? Theme.accent : Theme.muted)
            }.frame(width: 34, height: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text(s.display).font(Theme.serif(15)).foregroundStyle(Theme.text).lineLimit(1)
                Text(subtitle(s)).font(Theme.ui(11)).foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.muted2)
        }
        .padding(.horizontal, 14).padding(.vertical, 12).contentShape(Rectangle())
    }

    // MARK: 快捷入口
    private var shortcuts: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
            quick("剧本库", "books.vertical") { switchTab(1) }
            quick("角色卡", "person.crop.rectangle.stack") { switchTab(3) }
            quick("存档管理", "tray.full") { switchTab(2) }
            quick("个人中心", "person.crop.circle") { switchTab(4) }
        }
    }
    private func quick(_ t: String, _ icon: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon).font(.system(size: 16)).foregroundStyle(Theme.accent).frame(width: 26)
                Text(loc: t).font(Theme.ui(14, .medium)).foregroundStyle(Theme.text)
                Spacer()
            }
            .padding(.horizontal, 14).padding(.vertical, 14)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.panel))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line, lineWidth: 1))
        }
    }

    private func sectionHead(_ t: String, _ all: @escaping () -> Void) -> some View {
        HStack {
            Text(loc: t).font(Theme.ui(15, .semibold)).foregroundStyle(Theme.text)
            Spacer()
            Button("全部", action: all).font(Theme.ui(12.5)).foregroundStyle(Theme.muted)
        }
    }

    private func subtitle(_ s: SaveItem) -> String {
        var parts: [String] = []
        if let st = s.scriptTitle { parts.append(st) }
        if s.branches > 0 { parts.append(String(format: tr("%lld分支"), s.branches)) }
        if let u = s.updated { parts.append(u) }
        return parts.joined(separator: " · ")
    }
    private var greeting: String {
        let h = Calendar.current.component(.hour, from: Date())
        switch h { case 5..<12: return "上午好"; case 12..<18: return "下午好"; default: return "晚上好" }
    }
    private func wan(_ n: Int) -> String { locWordCount(n) }

    private func reload() async {
        loading = true
        defer { loading = false }
        if store.demo {
            scripts = DemoData.scripts; saves = DemoData.saves; stats = DemoData.stats; return
        }
        async let sc = try? store.api.scriptsList(base: store.serverURL)
        async let sv = try? store.api.savesList(base: store.serverURL)
        async let st = try? store.api.meStats(base: store.serverURL)
        async let aid = store.api.activeSaveId(base: store.serverURL)
        scripts = (await sc) ?? scripts
        saves = (await sv) ?? saves
        if let s = await st { stats = s }
        activeSaveId = await aid
    }
}
