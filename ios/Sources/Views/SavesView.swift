import SwiftUI

// 游戏 Tab —— 两段可左右滑动切换:游戏对话(剧情存档)⇄ 酒馆对话(角色卡对话)。
// 游戏存档 → 全屏游戏台(store.launchGame);酒馆对话 → 推入 ChatView。
struct SavesView: View {
    @EnvironmentObject var store: AppStore
    @State private var saves: [SaveItem] = []
    @State private var tavern: [TavernChat] = []
    @State private var loading = true
    @State private var query = ""
    @State private var error: String?
    @State private var seg = 0          // 0 游戏对话 / 1 酒馆对话
    @State private var path: [Int] = []
    @State private var creating = false
    @State private var renameTarget: SaveItem?
    @State private var renameText = ""
    @State private var showRename = false
    @State private var detailSave: SaveItem?
    @State private var deleteTarget: SaveItem?
    @State private var activeSaveId: Int?
    @State private var archivedTavern: [TavernChat] = []
    @State private var showArchived = false
    @State private var tavernRenameTarget: TavernChat?
    @State private var tavernRenameText = ""
    @State private var showTavernRename = false
    @State private var tavernDeleteTarget: TavernChat?
    @State private var sortMode = 0          // 0 最近 / 1 名称 / 2 回合数
    @State private var showSort = false
    @State private var showImporter = false
    @State private var importMsg: String?

    private var gameSaves: [SaveItem] {
        var base = saves.filter { !$0.isTavern }
        if !query.isEmpty {
            base = base.filter { $0.display.localizedCaseInsensitiveContains(query) || ($0.scriptTitle ?? "").localizedCaseInsensitiveContains(query) }
        }
        switch sortMode {
        case 1: base.sort { $0.display.localizedCompare($1.display) == .orderedAscending }
        case 2: base.sort { $0.turns > $1.turns }
        default: break   // 0 = 后端默认顺序(最近游玩)
        }
        return base
    }
    private var tavernChats: [TavernChat] {
        guard !query.isEmpty else { return tavern }
        return tavern.filter { $0.displayTitle.localizedCaseInsensitiveContains(query) || ($0.characterName ?? "").localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        NavigationStack(path: $path) {
            ZStack {
                WarmBackground()
                VStack(spacing: 0) {
                    header
                    segmented
                    searchBar
                    TabView(selection: $seg) {
                        gamePage.tag(0)
                        tavernPage.tag(1)
                    }
                    .tabViewStyle(.page(indexDisplayMode: .never))
                    .animation(.easeInOut(duration: 0.2), value: seg)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Int.self) { id in ChatView(chatId: id).environmentObject(store) }
            .alert("重命名存档", isPresented: $showRename) {
                TextField("标题", text: $renameText)
                Button("取消", role: .cancel) {}
                Button("保存") { Task { await doRename() } }
            }
            .sheet(item: $detailSave) { s in SaveDetailView(save: s) { Task { await reload() } }.environmentObject(store) }
            .confirmationDialog("删除存档「\(deleteTarget?.display ?? "")」?此操作不可撤销。", isPresented: Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } }), titleVisibility: .visible, presenting: deleteTarget) { s in
                Button("删除", role: .destructive) { Task { await remove(s) } }
                Button("取消", role: .cancel) {}
            }
            .alert("重命名对话", isPresented: $showTavernRename) {
                TextField("标题", text: $tavernRenameText)
                Button("取消", role: .cancel) {}
                Button("保存") { Task { await doTavernRename() } }
            }
            .confirmationDialog("删除对话「\(tavernDeleteTarget?.displayTitle ?? "")」?此操作不可撤销。", isPresented: Binding(get: { tavernDeleteTarget != nil }, set: { if !$0 { tavernDeleteTarget = nil } }), titleVisibility: .visible, presenting: tavernDeleteTarget) { c in
                Button("删除", role: .destructive) { Task { await removeTavern(c) } }
                Button("取消", role: .cancel) {}
            }
            .confirmationDialog("排序方式", isPresented: $showSort, titleVisibility: .visible) {
                Button("最近游玩") { sortMode = 0 }
                Button("名称") { sortMode = 1 }
                Button("回合数") { sortMode = 2 }
                Button("取消", role: .cancel) {}
            }
            .fileImporter(isPresented: $showImporter, allowedContentTypes: [.json, .zip], allowsMultipleSelection: false) { result in
                if case .success(let urls) = result, let url = urls.first { Task { await importSave(url) } }
            }
            .alert("导入存档", isPresented: Binding(get: { importMsg != nil }, set: { if !$0 { importMsg = nil } })) {
                Button("好") {}
            } message: { Text(importMsg ?? "") }
            .task {
                if ProcessInfo.processInfo.environment["MEADHALL_GSEG"] == "1" { seg = 1 }
                await reload()
                if let raw = ProcessInfo.processInfo.environment["MEADHALL_OPEN_CHAT"], let id = Int(raw), path.isEmpty {
                    seg = 1; path.append(id)
                }
            }
        }
    }

    // MARK: 顶部
    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("游戏").font(Theme.serif(26, .semibold)).foregroundStyle(Theme.text)
            Text("\(seg == 0 ? gameSaves.count : tavernChats.count)").font(Theme.ui(13)).foregroundStyle(Theme.muted)
                .padding(.horizontal, 8).padding(.vertical, 2).background(Capsule().fill(Theme.panel2))
            Spacer()
            if seg == 0 {
                Button { showSort = true } label: {
                    Image(systemName: "arrow.up.arrow.down").font(.system(size: 15)).foregroundStyle(Theme.muted)
                        .frame(width: 40, height: 40).background(Circle().fill(Theme.panel2))
                }.accessibilityLabel(Text("排序"))
                Button { showImporter = true } label: {
                    Image(systemName: "square.and.arrow.down").font(.system(size: 15)).foregroundStyle(Theme.accent)
                        .frame(width: 40, height: 40).background(Circle().fill(Theme.accentSoft)).overlay(Circle().stroke(Theme.accentEdge, lineWidth: 1))
                }.disabled(store.demo).accessibilityLabel(Text("导入存档"))
            }
            if seg == 1 {
                Button(action: newTavern) {
                    Group { if creating { ProgressView().tint(Theme.accent).scaleEffect(0.8) } else { Image(systemName: "plus").font(.system(size: 17)) } }
                        .foregroundStyle(Theme.accent).frame(width: 40, height: 40)
                        .background(Circle().fill(Theme.accentSoft)).overlay(Circle().stroke(Theme.accentEdge, lineWidth: 1))
                }.disabled(creating).accessibilityLabel(Text("新建对话"))
            }
        }
        .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 8)
    }

    private var segmented: some View {
        HStack(spacing: 4) {
            segButton("游戏对话", 0)
            segButton("酒馆对话", 1)
        }
        .padding(3)
        .background(RoundedRectangle(cornerRadius: 11).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 11).stroke(Theme.line, lineWidth: 1))
        .padding(.horizontal, 16).padding(.bottom, 8)
    }
    private func segButton(_ title: String, _ idx: Int) -> some View {
        Button { withAnimation(.easeInOut(duration: 0.2)) { seg = idx } } label: {
            Text(loc: title).font(Theme.ui(13.5, .medium)).foregroundStyle(seg == idx ? Theme.onAccent : Theme.muted)
                .frame(maxWidth: .infinity).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 8).fill(seg == idx ? Theme.accent : Color.clear))
        }.buttonStyle(.plain)
    }

    private var searchBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").font(.system(size: 13)).foregroundStyle(Theme.muted2)
            TextField(seg == 0 ? "搜索存档" : "搜索对话", text: $query).font(Theme.ui(14)).foregroundStyle(Theme.text).tint(Theme.accent)
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line, lineWidth: 1))
        .padding(.horizontal, 16).padding(.bottom, 8)
    }

    // MARK: 游戏对话页
    @ViewBuilder private var gamePage: some View {
        if loading && saves.isEmpty {
            VStack { Spacer(); ProgressView().tint(Theme.accent); Spacer() }
        } else if gameSaves.isEmpty {
            emptyState(icon: "tray", title: query.isEmpty ? "还没有存档" : "没有匹配的存档",
                       hint: query.isEmpty ? "到「剧本」里挑一个开始新游戏。" : nil)
        } else {
            ScrollView {
                LazyVStack(spacing: 10) {
                    if let error { Text(error).font(Theme.ui(13)).foregroundStyle(Theme.danger) }
                    ForEach(gameSaves) { s in
                        Button { Task { await store.launchGame(s) } } label: { saveRow(s) }.buttonStyle(.plain)
                            .contextMenu {
                                Button { detailSave = s } label: { Label("存档详情 / 分支", systemImage: "info.circle") }
                                if s.id != activeSaveId { Button { Task { await setCurrent(s) } } label: { Label("设为当前", systemImage: "play.circle") } }
                                Button { startRename(s) } label: { Label("重命名", systemImage: "pencil") }
                                Button(role: .destructive) { deleteTarget = s } label: { Label("删除", systemImage: "trash") }
                            }
                    }
                }.padding(.horizontal, 16).padding(.bottom, 24)
            }.refreshable { await reload() }
        }
    }

    // MARK: 酒馆对话页
    @ViewBuilder private var tavernPage: some View {
        if loading && tavern.isEmpty {
            VStack { Spacer(); ProgressView().tint(Theme.accent); Spacer() }
        } else if tavernChats.isEmpty {
            emptyState(icon: "bubble.left.and.bubble.right", title: query.isEmpty ? "还没有酒馆对话" : "没有匹配的对话",
                       hint: query.isEmpty ? "点右上角 + 新建一个角色卡对话。" : nil)
        } else {
            ScrollView {
                LazyVStack(spacing: 10) {
                    ForEach(tavernChats) { c in
                        Button { path.append(c.id) } label: { tavernRow(c) }.buttonStyle(.plain)
                            .contextMenu { tavernMenu(c, archived: false) }
                    }
                    if !archivedTavern.isEmpty && query.isEmpty {
                        Button { withAnimation { showArchived.toggle() } } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "archivebox").font(.system(size: 12)).foregroundStyle(Theme.muted)
                                Text("已归档 (\(archivedTavern.count))").font(Theme.ui(12.5, .medium)).foregroundStyle(Theme.muted)
                                Spacer()
                                Image(systemName: showArchived ? "chevron.up" : "chevron.down").font(.system(size: 11)).foregroundStyle(Theme.muted2)
                            }.padding(.horizontal, 14).padding(.vertical, 10)
                            .background(RoundedRectangle(cornerRadius: 10).fill(Theme.panel2))
                        }.buttonStyle(.plain).padding(.top, 6)
                        if showArchived {
                            ForEach(archivedTavern) { c in
                                Button { path.append(c.id) } label: { tavernRow(c).opacity(0.7) }.buttonStyle(.plain)
                                    .contextMenu { tavernMenu(c, archived: true) }
                            }
                        }
                    }
                }.padding(.horizontal, 16).padding(.bottom, 24)
            }.refreshable { await reload() }
        }
    }

    @ViewBuilder private func tavernMenu(_ c: TavernChat, archived: Bool) -> some View {
        if !archived {
            Button { startTavernRename(c) } label: { Label("重命名", systemImage: "pencil") }
            Button { Task { await autotitleChat(c) } } label: { Label("自动命名", systemImage: "textformat.abc") }
            Button { Task { await archiveChat(c, true) } } label: { Label("归档", systemImage: "archivebox") }
        } else {
            Button { Task { await archiveChat(c, false) } } label: { Label("取消归档", systemImage: "tray.and.arrow.up") }
        }
        Button(role: .destructive) { tavernDeleteTarget = c } label: { Label("删除", systemImage: "trash") }
    }

    // MARK: 行
    private func saveRow(_ s: SaveItem) -> some View {
        let cur = s.id == activeSaveId || s.isCurrent
        return HStack(spacing: 13) {
            ZStack {
                Circle().fill(cur ? Theme.accentSoft : Theme.panel2)
                Circle().stroke(cur ? Theme.accentEdge : Theme.line, lineWidth: 1)
                Image(systemName: cur ? "play.fill" : "bookmark.fill")
                    .font(.system(size: 15)).foregroundStyle(cur ? Theme.accent : Theme.muted)
            }.frame(width: 44, height: 44)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(s.display).font(Theme.ui(15.5, .medium)).foregroundStyle(Theme.text).lineLimit(1)
                    if cur {
                        Text("当前").font(Theme.ui(9.5, .semibold)).foregroundStyle(Theme.accent)
                            .padding(.horizontal, 6).padding(.vertical, 1).background(Capsule().fill(Theme.accentSoft))
                    }
                }
                Text(subtitle(s)).font(Theme.serif(12.5)).italic().foregroundStyle(Theme.muted).lineLimit(1)
                if let snip = s.snippet { Text(snip).font(Theme.ui(11.5)).foregroundStyle(Theme.muted2).lineLimit(1) }
            }
            Spacer()
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.muted2)
        }
        .padding(.horizontal, 14).padding(.vertical, 13)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(cur ? Theme.accentEdge : Theme.line, lineWidth: 1))
        .contentShape(Rectangle())
    }

    private func tavernRow(_ c: TavernChat) -> some View {
        let blank = (c.characterName ?? "").isEmpty
        return HStack(spacing: 13) {
            ZStack {
                Circle().fill(blank ? Theme.panel2 : Theme.accentSoft)
                Circle().stroke(blank ? Theme.line : Theme.accentEdge, lineWidth: 1)
                if blank { Image(systemName: "bubble.left").font(.system(size: 14)).foregroundStyle(Theme.muted) }
                else { Text(String((c.characterName ?? c.displayTitle).prefix(1))).font(Theme.serif(18)).foregroundStyle(Theme.accent) }
            }.frame(width: 44, height: 44)
            VStack(alignment: .leading, spacing: 3) {
                Text(c.displayTitle).font(Theme.ui(15.5, .medium)).foregroundStyle(Theme.text).lineLimit(1)
                Text(c.lastSnippet ?? (c.characterName ?? "新对话")).font(Theme.serif(12.5)).italic().foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.muted2)
        }
        .padding(.horizontal, 14).padding(.vertical, 13)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
        .contentShape(Rectangle())
    }

    private func emptyState(icon: String, title: String, hint: String?) -> some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: icon).font(.system(size: 42)).foregroundStyle(Theme.muted2)
            Text(loc: title).font(Theme.serif(18)).foregroundStyle(Theme.textQuiet)
            if let hint { Text(loc: hint).font(Theme.ui(13)).foregroundStyle(Theme.muted) }
            Spacer(); Spacer()
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func subtitle(_ s: SaveItem) -> String {
        var parts: [String] = []
        if let st = s.scriptTitle { parts.append(st) }
        if s.turns > 0 { parts.append(String(format: tr("第%lld回合"), s.turns)) }
        if s.branches > 0 { parts.append(String(format: tr("%lld分支"), s.branches)) }
        if let u = s.updated { parts.append(u) }
        return parts.joined(separator: " · ")
    }

    private func newTavern() {
        if store.demo { path.append(3); return }
        creating = true
        Task {
            defer { creating = false }
            do { let id = try await store.api.tavernCreateBlank(base: store.serverURL); await reload(); path.append(id) }
            catch { self.error = (error as? LocalizedError)?.errorDescription ?? "新建失败" }
        }
    }

    private func setCurrent(_ s: SaveItem) async {
        if store.demo { return }
        try? await store.api.activateSave(base: store.serverURL, saveId: s.id); await reload()
    }
    private func startRename(_ s: SaveItem) { renameTarget = s; renameText = s.display; showRename = true }
    private func doRename() async {
        guard let s = renameTarget else { return }
        let t = renameText.trimmingCharacters(in: .whitespaces); guard !t.isEmpty else { return }
        if store.demo { return }
        try? await store.api.renameSave(base: store.serverURL, saveId: s.id, title: t); await reload()
    }
    private func remove(_ s: SaveItem) async {
        if store.demo { saves.removeAll { $0.id == s.id }; return }
        try? await store.api.deleteSave(base: store.serverURL, saveId: s.id); await reload()
    }

    private func startTavernRename(_ c: TavernChat) { tavernRenameTarget = c; tavernRenameText = c.displayTitle; showTavernRename = true }
    private func doTavernRename() async {
        guard let c = tavernRenameTarget else { return }
        let t = tavernRenameText.trimmingCharacters(in: .whitespaces); guard !t.isEmpty, !store.demo else { return }
        try? await store.api.renameChat(base: store.serverURL, id: c.id, title: t); await reload()
    }
    private func autotitleChat(_ c: TavernChat) async {
        if store.demo { return }
        _ = try? await store.api.autotitle(base: store.serverURL, id: c.id); await reload()
    }
    private func archiveChat(_ c: TavernChat, _ archived: Bool) async {
        if store.demo { return }
        try? await store.api.archiveChat(base: store.serverURL, id: c.id, archived: archived); await reload()
    }
    private func removeTavern(_ c: TavernChat) async {
        if store.demo { tavern.removeAll { $0.id == c.id }; return }
        try? await store.api.deleteChat(base: store.serverURL, id: c.id); await reload()
    }

    private func importSave(_ url: URL) async {
        if store.demo { importMsg = "演示模式不可导入"; return }
        let needStop = url.startAccessingSecurityScopedResource()
        defer { if needStop { url.stopAccessingSecurityScopedResource() } }
        do { _ = try await store.api.importSave(base: store.serverURL, fileURL: url); await reload(); importMsg = "已导入" }
        catch { importMsg = (error as? LocalizedError)?.errorDescription ?? "导入失败" }
    }

    private func reload() async {
        loading = true; error = nil
        defer { loading = false }
        if store.demo { saves = DemoData.saves; tavern = DemoData.chats; return }
        // [round-3-P2] 三个请求并发:原来 activeSaveId 在 savesList/tavernList 之后串行,
        //   导致首屏列表已渲染但「当前」标记要等最后一拍才出现。async let 让其同拍解析。
        async let savesF = store.api.savesList(base: store.serverURL)
        async let tavernF = store.api.tavernList(base: store.serverURL)
        async let archivedF = store.api.tavernList(base: store.serverURL, archived: true)
        async let activeF = store.api.activeSaveId(base: store.serverURL)
        do { saves = try await savesF }
        catch { self.error = (error as? LocalizedError)?.errorDescription ?? "加载失败" }
        tavern = (try? await tavernF) ?? []
        archivedTavern = (try? await archivedF) ?? []
        activeSaveId = await activeF
    }
}
