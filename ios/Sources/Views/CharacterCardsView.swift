import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

// 角色 Tab —— 对齐 web MobileCards:角色卡库(增删改查 + 导入/公开/删除)。
// 顶层分三段:我的 / NPC / 在线
struct CharacterCardsView: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.horizontalSizeClass) private var hsc   // 大屏:角色卡改自适应网格
    // ── 段切换 ──
    @State private var segment = 0   // 0=我的  1=NPC  2=在线

    // ── 我的 ──
    @State private var cards: [CharacterCardItem] = []
    @State private var loading = true
    @State private var error: String?
    @State private var query = ""
    @State private var filter = 0    // 0 全部 1 已固定 2 已公开
    @State private var detail: CharacterCardItem?
    @State private var editing: CharacterCardItem?
    @State private var showEditor = false
    @State private var showImportMenu = false
    @State private var showJsonPaste = false
    @State private var photoItem: PhotosPickerItem?
    @State private var showPhotoPicker = false
    @State private var showFileImporter = false
    @State private var importing = false
    @State private var deleteTarget: CharacterCardItem?
    @State private var shareItem: ShareItem?

    // ── NPC ──
    @State private var npcCards: [(script: ScriptItem, cards: [CharacterCardItem])] = []
    @State private var npcLoading = false
    @State private var npcError: String?
    @State private var npcScriptFilter: Int? = nil   // nil=全部, 否则 scriptId
    @State private var npcQuery = ""
    @State private var npcDetail: CharacterCardItem?
    @State private var promotingIds: Set<Int> = []
    @State private var promotedIds: Set<Int> = []

    // ── 在线/社区 ──
    @State private var onlineCards: [CharacterCardItem] = []
    @State private var onlineLoading = false
    @State private var onlineError: String?
    @State private var onlineQuery = ""
    @State private var onlineQueryDebounce = ""
    @State private var cloningIds: Set<Int> = []
    @State private var clonedIds: Set<Int> = []

    // 我的 — 过滤
    private var filtered: [CharacterCardItem] {
        var c = cards
        if filter == 1 { c = c.filter { $0.pinned == true } }
        if filter == 2 { c = c.filter { $0.is_public == true } }
        if !query.isEmpty { c = c.filter { $0.display.localizedCaseInsensitiveContains(query) || ($0.identity ?? "").localizedCaseInsensitiveContains(query) } }
        return c
    }

    // NPC — 过滤
    private var npcFiltered: [CharacterCardItem] {
        var all: [CharacterCardItem]
        if let sid = npcScriptFilter {
            all = npcCards.first(where: { $0.script.id == sid })?.cards ?? []
        } else {
            all = npcCards.flatMap { $0.cards }
        }
        if !npcQuery.isEmpty {
            all = all.filter { $0.display.localizedCaseInsensitiveContains(npcQuery) || ($0.identity ?? "").localizedCaseInsensitiveContains(npcQuery) }
        }
        return all
    }

    var body: some View {
        NavigationStack {
            ZStack {
                WarmBackground()
                VStack(spacing: 0) {
                    header
                    segmentPicker
                    switch segment {
                    case 0: myContent
                    case 1: npcContent
                    default: onlineContent
                    }
                }
                if importing { Color.black.opacity(0.3).ignoresSafeArea(); ProgressView("导入中…").tint(Theme.accent).padding(18).background(RoundedRectangle(cornerRadius: 12).fill(Theme.panel)) }
            }
            .toolbar(.hidden, for: .navigationBar)
            .task {
                await reload()
                if ProcessInfo.processInfo.environment["MEADHALL_CARD"] == "1", let c = cards.first { detail = c }   // e2e 截图
            }
            // 我的
            .sheet(item: $detail) { c in CardDetailView(card: c) { Task { await reload() } }.environmentObject(store) }
            .sheet(isPresented: $showEditor) { CardEditorView(card: editing) { Task { await reload() } }.environmentObject(store) }
            .confirmationDialog("删除角色卡「\(deleteTarget?.name ?? "")」?此操作不可撤销。", isPresented: Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } }), titleVisibility: .visible, presenting: deleteTarget) { c in
                Button("删除", role: .destructive) { Task { try? await store.api.cardDelete(base: store.serverURL, id: c.id); await reload() } }
                Button("取消", role: .cancel) {}
            }
            .sheet(isPresented: $showJsonPaste) { JsonPasteSheet { json in Task { await importJson(json) } } }
            .confirmationDialog("导入角色卡", isPresented: $showImportMenu, titleVisibility: .visible) {
                Button("从相册选图片(PNG)") { showPhotoPicker = true }
                Button("选择文件(PNG/JSON/WEBP)") { showFileImporter = true }
                Button("粘贴 JSON") { showJsonPaste = true }
                Button("取消", role: .cancel) {}
            }
            .photosPicker(isPresented: $showPhotoPicker, selection: $photoItem, matching: .images)
            .onChange(of: photoItem) { _, item in
                guard let item else { return }
                Task { if let data = try? await item.loadTransferable(type: Data.self) { await importTavern(data, "card.png", "image/png") }; photoItem = nil }
            }
            .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.png, .json, .image, .item], allowsMultipleSelection: false) { result in
                if case .success(let urls) = result, let url = urls.first {
                    let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                    if let data = try? Data(contentsOf: url) {
                        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                        Task { await importTavern(data, url.lastPathComponent, mime) }
                    }
                }
            }
            // NPC 详情
            .sheet(item: $npcDetail) { c in NpcDetailView(card: c, onPromote: { promoted in Task { await promoteNpc(promoted) } }).environmentObject(store) }
            // 分享
            .sheet(item: $shareItem) { item in ActivityView(items: [item.url]) }
        }
    }

    // MARK: – Header

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("角色").font(Theme.serif(26, .semibold)).foregroundStyle(Theme.text)
            if segment == 0 {
                Text("\(filtered.count)").font(Theme.ui(13)).foregroundStyle(Theme.muted)
                    .padding(.horizontal, 8).padding(.vertical, 2).background(Capsule().fill(Theme.panel2))
            }
            Spacer()
            if segment == 0 {
                Button { showImportMenu = true } label: { Image(systemName: "square.and.arrow.down").font(.system(size: 16)).foregroundStyle(Theme.textQuiet).frame(width: 44, height: 44).contentShape(Rectangle()) }
                    .accessibilityLabel(Text("导入角色卡"))
                Button { editing = nil; showEditor = true } label: {
                    Image(systemName: "plus").font(.system(size: 19)).foregroundStyle(Theme.accent).frame(width: 38, height: 38)
                        .background(Circle().fill(Theme.accentSoft)).overlay(Circle().stroke(Theme.accentEdge, lineWidth: 1))
                }.accessibilityLabel(Text("新建角色卡"))
            }
        }.padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 8)
    }

    // MARK: – Segment picker

    private var segmentPicker: some View {
        HStack(spacing: 0) {
            ForEach(Array(["我的", "NPC", "在线"].enumerated()), id: \.offset) { i, t in
                Button {
                    segment = i
                    if i == 1 && npcCards.isEmpty { Task { await reloadNpc() } }
                    if i == 2 && onlineCards.isEmpty { Task { await reloadOnline(q: "") } }
                } label: {
                    Text(loc: t).font(Theme.ui(14, .medium))
                        .foregroundStyle(segment == i ? Theme.accent : Theme.muted)
                        .frame(maxWidth: .infinity).padding(.vertical, 10)
                        .overlay(alignment: .bottom) {
                            if segment == i { Rectangle().frame(height: 2).foregroundStyle(Theme.accent) }
                        }
                }
            }
        }
        .background(Theme.panel)
        .overlay(alignment: .bottom) { Rectangle().frame(height: 1).foregroundStyle(Theme.line) }
    }

    // MARK: – 我的

    @ViewBuilder private var myContent: some View {
        searchBar(query: $query, placeholder: "搜索角色卡")
        filterPills
        myListContent
    }

    private var filterPills: some View {
        HStack(spacing: 8) {
            ForEach(Array(["全部", "已固定", "已公开"].enumerated()), id: \.offset) { i, t in
                Button { filter = i } label: {
                    Text(loc: t).font(Theme.ui(12.5, .medium)).foregroundStyle(filter == i ? Theme.onAccent : Theme.muted)
                        .padding(.horizontal, 13).padding(.vertical, 6).background(Capsule().fill(filter == i ? Theme.accent : Theme.panel2))
                }
            }
            Spacer()
        }.padding(.horizontal, 16).padding(.bottom, 8)
    }

    @ViewBuilder private var myListContent: some View {
        if loading && cards.isEmpty { Spacer(); ProgressView().tint(Theme.accent); Spacer() }
        else if filtered.isEmpty {
            VStack(spacing: 12) {
                Spacer()
                Image(systemName: "person.crop.rectangle.stack").font(.system(size: 42)).foregroundStyle(Theme.muted2)
                Text(loc: query.isEmpty ? "还没有角色卡" : "没有匹配的角色卡").font(Theme.serif(18)).foregroundStyle(Theme.textQuiet)
                if query.isEmpty { Text("点右上角 + 新建,或导入酒馆卡。").font(Theme.ui(13)).foregroundStyle(Theme.muted) }
                Spacer(); Spacer()
            }.frame(maxWidth: .infinity)
        } else {
            ScrollView {
                if let error { Text(error).font(Theme.ui(13)).foregroundStyle(Theme.danger).padding(.horizontal, 16) }
                if hsc == .regular {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 260, maximum: 440), spacing: 12)], spacing: 12) {
                        ForEach(filtered) { c in myCardCell(c) }
                    }.padding(16)
                } else {
                    LazyVStack(spacing: 10) {
                        ForEach(filtered) { c in myCardCell(c) }
                    }.padding(16)
                }
            }.refreshable { await reload() }
        }
    }

    // 单元格(列表/网格共用):点开详情 + 长按上下文菜单。
    private func myCardCell(_ c: CharacterCardItem) -> some View {
        Button { detail = c } label: { cardRow(c) }.buttonStyle(.plain)
            .contextMenu {
                Button { editing = c; showEditor = true } label: { Label("编辑", systemImage: "pencil") }
                Button { Task { try? await store.api.cardVisibility(base: store.serverURL, id: c.id, isPublic: !(c.is_public ?? false)); await reload() } } label: { Label(c.is_public == true ? "取消公开" : "公开", systemImage: "globe") }
                Button { Task { await exportCard(c, asPng: false) } } label: { Label("导出 JSON", systemImage: "square.and.arrow.up") }
                Button { Task { await exportCard(c, asPng: true) } } label: { Label("导出 PNG", systemImage: "photo") }
                Button(role: .destructive) { deleteTarget = c } label: { Label("删除", systemImage: "trash") }
            }
    }

    // MARK: – NPC

    @ViewBuilder private var npcContent: some View {
        searchBar(query: $npcQuery, placeholder: "搜索 NPC")
        npcScriptPills
        npcListContent
    }

    @ViewBuilder private var npcScriptPills: some View {
        if !npcCards.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    Button {
                        npcScriptFilter = nil
                    } label: {
                        Text(loc: "全部").font(Theme.ui(12.5, .medium))
                            .foregroundStyle(npcScriptFilter == nil ? Theme.onAccent : Theme.muted)
                            .padding(.horizontal, 13).padding(.vertical, 6)
                            .background(Capsule().fill(npcScriptFilter == nil ? Theme.accent : Theme.panel2))
                    }
                    ForEach(npcCards, id: \.script.id) { item in
                        Button {
                            npcScriptFilter = item.script.id
                        } label: {
                            Text(item.script.display).font(Theme.ui(12.5, .medium))
                                .foregroundStyle(npcScriptFilter == item.script.id ? Theme.onAccent : Theme.muted)
                                .padding(.horizontal, 13).padding(.vertical, 6)
                                .background(Capsule().fill(npcScriptFilter == item.script.id ? Theme.accent : Theme.panel2))
                        }
                    }
                }.padding(.horizontal, 16)
            }.padding(.bottom, 8)
        }
    }

    @ViewBuilder private var npcListContent: some View {
        if npcLoading && npcCards.isEmpty { Spacer(); ProgressView().tint(Theme.accent); Spacer() }
        else if npcFiltered.isEmpty {
            VStack(spacing: 12) {
                Spacer()
                Image(systemName: "person.2.fill").font(.system(size: 42)).foregroundStyle(Theme.muted2)
                Text(loc: npcQuery.isEmpty ? "暂无 NPC 角色卡" : "没有匹配的 NPC").font(Theme.serif(18)).foregroundStyle(Theme.textQuiet)
                if npcQuery.isEmpty { Text("NPC 从剧本角色卡自动聚合,去剧本编辑器添加。").font(Theme.ui(13)).foregroundStyle(Theme.muted) }
                Spacer(); Spacer()
            }.frame(maxWidth: .infinity)
        } else {
            ScrollView {
                if let err = npcError { Text(err).font(Theme.ui(13)).foregroundStyle(Theme.danger).padding(.horizontal, 16) }
                LazyVStack(spacing: 10) {
                    ForEach(npcFiltered) { c in npcCardCell(c) }
                }.padding(16)
            }.refreshable { await reloadNpc() }
        }
    }

    private func npcCardCell(_ c: CharacterCardItem) -> some View {
        Button { npcDetail = c } label: {
            HStack(spacing: 13) {
                avatarView(c, size: 44)
                VStack(alignment: .leading, spacing: 3) {
                    Text(c.display).font(Theme.ui(15.5, .medium)).foregroundStyle(Theme.text).lineLimit(1)
                    if let id = c.identity, !id.isEmpty {
                        Text(id).font(Theme.serif(13)).italic().foregroundStyle(Theme.muted).lineLimit(1)
                    }
                    if c.enabled == false {
                        Text(loc: "已禁用").font(Theme.ui(11)).foregroundStyle(Theme.danger)
                    }
                }
                Spacer()
                if promotedIds.contains(c.id) {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.accent).font(.system(size: 16))
                } else if promotingIds.contains(c.id) {
                    ProgressView().tint(Theme.accent).scaleEffect(0.75)
                } else {
                    Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.muted2)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: 14).fill(Theme.panel)).overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
            .contentShape(Rectangle())
        }.buttonStyle(.plain)
    }

    // MARK: – 在线/社区

    @ViewBuilder private var onlineContent: some View {
        searchBar(query: $onlineQuery, placeholder: "搜索社区卡库", onSubmit: { Task { await reloadOnline(q: onlineQuery) } })
        onlineListContent
    }

    @ViewBuilder private var onlineListContent: some View {
        if onlineLoading && onlineCards.isEmpty { Spacer(); ProgressView().tint(Theme.accent); Spacer() }
        else if onlineCards.isEmpty {
            VStack(spacing: 12) {
                Spacer()
                Image(systemName: "globe").font(.system(size: 42)).foregroundStyle(Theme.muted2)
                Text(loc: "暂无社区卡").font(Theme.serif(18)).foregroundStyle(Theme.textQuiet)
                Text("搜索关键词或等待社区卡上传后刷新。").font(Theme.ui(13)).foregroundStyle(Theme.muted)
                Spacer(); Spacer()
            }.frame(maxWidth: .infinity)
        } else {
            ScrollView {
                if let err = onlineError { Text(err).font(Theme.ui(13)).foregroundStyle(Theme.danger).padding(.horizontal, 16) }
                LazyVStack(spacing: 10) {
                    ForEach(onlineCards) { c in onlineCardCell(c) }
                }.padding(16)
            }.refreshable { await reloadOnline(q: onlineQuery) }
        }
    }

    private func onlineCardCell(_ c: CharacterCardItem) -> some View {
        HStack(spacing: 13) {
            avatarView(c, size: 44)
            VStack(alignment: .leading, spacing: 3) {
                Text(c.display).font(Theme.ui(15.5, .medium)).foregroundStyle(Theme.text).lineLimit(1)
                Text(c.subtitle).font(Theme.serif(13)).italic().foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer()
            if clonedIds.contains(c.id) {
                Text(loc: "已克隆").font(Theme.ui(12, .medium)).foregroundStyle(Theme.accent)
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(Capsule().fill(Theme.accentSoft))
            } else if cloningIds.contains(c.id) {
                ProgressView().tint(Theme.accent).scaleEffect(0.8)
            } else {
                Button {
                    Task { await cloneCard(c) }
                } label: {
                    Text(loc: "克隆").font(Theme.ui(12, .medium)).foregroundStyle(Theme.onAccent)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(Capsule().fill(Theme.accent))
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.panel)).overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
        .contentShape(Rectangle())
    }

    // MARK: – Shared helpers

    @ViewBuilder private func avatarView(_ c: CharacterCardItem, size: CGFloat) -> some View {
        if let av = c.avatar, !av.isEmpty {
            AsyncImage(url: absoluteImageURL(base: store.serverURL, path: av)) { img in img.resizable().scaledToFill() } placeholder: { Circle().fill(Theme.accentSoft) }
                .frame(width: size, height: size).clipShape(Circle())
        } else {
            ZStack { Circle().fill(Theme.accentSoft); Circle().stroke(Theme.accentEdge, lineWidth: 1)
                Text(String(c.display.prefix(1))).font(Theme.serif(size * 0.4)).foregroundStyle(Theme.accent)
            }.frame(width: size, height: size)
        }
    }

    private func cardRow(_ c: CharacterCardItem) -> some View {
        HStack(spacing: 13) {
            avatarView(c, size: 50)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(c.display).font(Theme.ui(15.5, .medium)).foregroundStyle(Theme.text).lineLimit(1)
                    if c.pinned == true { Image(systemName: "pin.fill").font(.system(size: 9)).foregroundStyle(Theme.accent) }
                    if c.is_public == true { Image(systemName: "globe").font(.system(size: 9)).foregroundStyle(Theme.muted2) }
                }
                Text(c.subtitle).font(Theme.serif(13)).italic().foregroundStyle(Theme.muted).lineLimit(2)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.muted2)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.panel)).overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
        .contentShape(Rectangle())
    }

    // Shared search bar
    @ViewBuilder private func searchBar(query: Binding<String>, placeholder: String, onSubmit: (() -> Void)? = nil) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").font(.system(size: 13)).foregroundStyle(Theme.muted2)
            if let onSubmit {
                TextField(placeholder, text: query).font(Theme.ui(14)).foregroundStyle(Theme.text).tint(Theme.accent).submitLabel(.search).onSubmit { onSubmit() }
            } else {
                TextField(placeholder, text: query).font(Theme.ui(14)).foregroundStyle(Theme.text).tint(Theme.accent)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.panel)).overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line, lineWidth: 1))
        .padding(.horizontal, 16).padding(.bottom, 8)
    }

    // MARK: – Network

    private func reload() async {
        loading = true; error = nil; defer { loading = false }
        if store.demo {
            cards = [CharacterCardItem(id: 1, name: "莉莉", identity: "废土幸存者", personality: "警惕而坚韧", avatar_url: "https://picsum.photos/seed/lili_av/200/200", card_type: "user",
                full_name: nil, background: "在末世废墟中独自求生的少女。", appearance: "短发,眼神锐利。", speech_style: "简短,戒备。",
                current_status: nil, secrets: nil, aliases: ["小莉"], tags: ["废土", "幸存者"], token_budget: 450, importance: 100, enabled: true, is_public: false, pinned: true, uses: 12, updated_at: nil)]
            return
        }
        do { cards = try await store.api.characterCards(base: store.serverURL) }
        catch { self.error = (error as? LocalizedError)?.errorDescription ?? "加载失败" }
    }

    private func reloadNpc() async {
        npcLoading = true; npcError = nil; defer { npcLoading = false }
        if store.demo {
            npcCards = []
            return
        }
        do {
            let scripts = try await store.api.scriptsList(base: store.serverURL)
            var result: [(script: ScriptItem, cards: [CharacterCardItem])] = []
            for s in scripts {
                let cs = (try? await store.api.scriptCards(base: store.serverURL, scriptId: s.id)) ?? []
                if !cs.isEmpty { result.append((script: s, cards: cs)) }
            }
            npcCards = result
        } catch {
            npcError = (error as? LocalizedError)?.errorDescription ?? "NPC 加载失败"
        }
    }

    private func reloadOnline(q: String) async {
        onlineLoading = true; onlineError = nil; defer { onlineLoading = false }
        if store.demo { onlineCards = []; return }
        do { onlineCards = try await store.api.cardsPublicList(base: store.serverURL, q: q) }
        catch { self.onlineError = (error as? LocalizedError)?.errorDescription ?? "加载失败" }
    }

    private func importTavern(_ data: Data, _ name: String, _ mime: String) async {
        importing = true; defer { importing = false }
        do { try await store.api.cardImportTavern(base: store.serverURL, fileData: data, filename: name, mime: mime); await reload() }
        catch { self.error = (error as? LocalizedError)?.errorDescription ?? "导入失败" }
    }

    private func importJson(_ json: String) async {
        importing = true; defer { importing = false }
        do { try await store.api.cardImportJson(base: store.serverURL, json: json, aiSplit: false); await reload() }
        catch { self.error = (error as? LocalizedError)?.errorDescription ?? "导入失败" }
    }

    private func exportCard(_ c: CharacterCardItem, asPng: Bool) async {
        if store.demo { return }
        do {
            let url = asPng ? try await store.api.cardExportPng(base: store.serverURL, id: c.id)
                            : try await store.api.cardExportTavern(base: store.serverURL, id: c.id)
            shareItem = ShareItem(url: url)
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "导出失败"
        }
    }

    private func promoteNpc(_ c: CharacterCardItem) async {
        if store.demo { return }
        promotingIds.insert(c.id)
        defer { promotingIds.remove(c.id) }
        // Build upsert body from NPC fields, WITHOUT "id" so backend creates a new user card.
        var body: [String: Any] = [
            "name": c.name ?? c.display,
            "identity": c.identity ?? "",
            "personality": c.personality ?? "",
            "full_name": c.full_name ?? "",
            "background": c.background ?? "",
            "appearance": c.appearance ?? "",
            "speech_style": c.speech_style ?? "",
            "current_status": c.current_status ?? "",
            "secrets": c.secrets ?? "",
            "aliases": c.aliases ?? [],
            "tags": c.tags ?? [],
            "token_budget": c.token_budget ?? 450,
            "importance": c.importance ?? 100,
            "enabled": true,
            "card_type": "user",
        ]
        if let p = c.priority { body["priority"] = p }
        do {
            _ = try await store.api.cardUpsert(base: store.serverURL, body: body)
            promotedIds.insert(c.id)
        } catch {
            npcError = (error as? LocalizedError)?.errorDescription ?? "提升失败"
        }
    }

    private func cloneCard(_ c: CharacterCardItem) async {
        if store.demo { return }
        cloningIds.insert(c.id)
        defer { cloningIds.remove(c.id) }
        do {
            try await store.api.cardCloneFromPublic(base: store.serverURL, id: c.id)
            clonedIds.insert(c.id)
        } catch {
            self.onlineError = (error as? LocalizedError)?.errorDescription ?? "克隆失败"
        }
    }
}

// MARK: – NPC 详情/提升

struct NpcDetailView: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let card: CharacterCardItem
    var onPromote: (CharacterCardItem) -> Void
    @State private var promoted = false
    @State private var promoting = false

    var body: some View {
        NavigationStack {
            ZStack {
                WarmBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        // Avatar + name header
                        HStack(spacing: 14) {
                            if let av = card.avatar, !av.isEmpty {
                                ServerImageThumb(base: store.serverURL, path: av, style: .avatarCircle, width: 64, placeholderIcon: "person.fill")
                            } else {
                                ZStack { Circle().fill(Theme.accentSoft); Circle().stroke(Theme.accentEdge, lineWidth: 1)
                                    Text(String(card.display.prefix(1))).font(Theme.serif(24)).foregroundStyle(Theme.accent) }.frame(width: 64, height: 64)
                            }
                            VStack(alignment: .leading, spacing: 4) {
                                Text(card.display).font(Theme.serif(21, .semibold)).foregroundStyle(Theme.text)
                                if let id = card.identity, !id.isEmpty { Text(id).font(Theme.ui(13)).foregroundStyle(Theme.muted) }
                                if card.enabled == false {
                                    Text(loc: "已禁用").font(Theme.ui(11, .medium)).foregroundStyle(Theme.danger)
                                        .padding(.horizontal, 8).padding(.vertical, 2).background(Capsule().fill(Theme.danger.opacity(0.12)))
                                }
                            }
                            Spacer()
                        }
                        // Promote button
                        Button {
                            promoting = true
                            onPromote(card)
                            // optimistic: mark promoted after short delay (actual result handled by parent's promotedIds)
                            Task { try? await Task.sleep(nanoseconds: 300_000_000); promoted = true; promoting = false }
                        } label: {
                            HStack(spacing: 6) {
                                if promoting { ProgressView().tint(Theme.onAccent).scaleEffect(0.8) }
                                else if promoted { Image(systemName: "checkmark").font(.system(size: 13, weight: .semibold)) }
                                else { Image(systemName: "arrow.up.circle").font(.system(size: 13)) }
                                Text(loc: promoted ? "已提升为我的角色卡" : "提升为我的角色卡").font(Theme.ui(14, .medium))
                            }
                            .foregroundStyle(Theme.onAccent).frame(maxWidth: .infinity).padding(.vertical, 12)
                            .background(RoundedRectangle(cornerRadius: 12).fill(promoted ? Theme.muted2 : Theme.accent))
                        }
                        .disabled(promoted || promoting || store.demo)
                        // Fields
                        if let a = card.aliases, !a.isEmpty { tagRow("别名", a) }
                        if let t = card.tags, !t.isEmpty { tagRow("标签", t) }
                        prose("背景", card.background); prose("外貌", card.appearance); prose("性格", card.personality)
                        prose("说话风格", card.speech_style); prose("当前状态", card.current_status); prose("秘密", card.secrets)
                    }.padding(16)
                }
            }
            .navigationTitle(card.display).navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bg, for: .navigationBar).toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() }.foregroundStyle(Theme.textQuiet) }
            }
        }
    }
    @ViewBuilder private func prose(_ label: String, _ v: String?) -> some View {
        if let v, !v.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(loc: label).font(Theme.ui(11, .semibold)).foregroundStyle(Theme.accent).tracking(1)
                Text(v).font(Theme.serif(14.5)).foregroundStyle(Theme.text).lineSpacing(4)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func tagRow(_ label: String, _ items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(loc: label).font(Theme.ui(11, .semibold)).foregroundStyle(Theme.muted).tracking(1)
            HStack(spacing: 6) { ForEach(items, id: \.self) { Text($0).font(Theme.ui(11.5)).foregroundStyle(Theme.text).padding(.horizontal, 8).padding(.vertical, 3).background(Capsule().fill(Theme.panel2)) } }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: – 角色卡详情

struct CardDetailView: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let card: CharacterCardItem
    var onChanged: () -> Void
    @State private var showEditor = false
    @State private var shareItem: ShareItem?
    @State private var exporting = false
    @State private var exportError: String?

    var body: some View {
        NavigationStack {
            ZStack {
                WarmBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        HStack(spacing: 14) {
                            if let av = card.avatar, !av.isEmpty {
                                ServerImageThumb(base: store.serverURL, path: av, style: .avatarCircle, width: 64, placeholderIcon: "person.fill")
                            } else {
                                ZStack { Circle().fill(Theme.accentSoft); Circle().stroke(Theme.accentEdge, lineWidth: 1)
                                    Text(String(card.display.prefix(1))).font(Theme.serif(24)).foregroundStyle(Theme.accent) }.frame(width: 64, height: 64)
                            }
                            VStack(alignment: .leading, spacing: 4) {
                                Text(card.display).font(Theme.serif(21, .semibold)).foregroundStyle(Theme.text)
                                if let id = card.identity, !id.isEmpty { Text(id).font(Theme.ui(13)).foregroundStyle(Theme.muted) }
                            }
                            Spacer()
                        }
                        PersonaImagesView(card: card, editable: false).environmentObject(store)
                        if let a = card.aliases, !a.isEmpty { tagRow("别名", a) }
                        if let t = card.tags, !t.isEmpty { tagRow("标签", t) }
                        prose("背景", card.background); prose("外貌", card.appearance); prose("性格", card.personality)
                        prose("说话风格", card.speech_style); prose("当前状态", card.current_status); prose("秘密", card.secrets)
                        // Export buttons
                        if !store.demo {
                            VStack(spacing: 10) {
                                if let exportError { Text(exportError).font(Theme.ui(12)).foregroundStyle(Theme.danger) }
                                HStack(spacing: 10) {
                                    exportButton("导出酒馆卡(JSON)", "doc.text") { await doExport(asPng: false) }
                                    exportButton("导出 PNG", "photo") { await doExport(asPng: true) }
                                }
                            }
                        }
                    }.padding(16)
                }
            }
            .navigationTitle(card.display).navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bg, for: .navigationBar).toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() }.foregroundStyle(Theme.textQuiet) }
                ToolbarItem(placement: .confirmationAction) { Button("编辑") { showEditor = true }.foregroundStyle(Theme.accent) }
            }
            .sheet(isPresented: $showEditor) { CardEditorView(card: card) { onChanged(); dismiss() }.environmentObject(store) }
            .sheet(item: $shareItem) { item in ActivityView(items: [item.url]) }
        }
    }

    private func exportButton(_ title: String, _ icon: String, _ action: @escaping () async -> Void) -> some View {
        Button { Task { await action() } } label: {
            HStack(spacing: 5) {
                if exporting { ProgressView().tint(Theme.accent).scaleEffect(0.7) }
                else { Image(systemName: icon).font(.system(size: 12)) }
                Text(loc: title).font(Theme.ui(13, .medium))
            }
            .foregroundStyle(Theme.accent).frame(maxWidth: .infinity).padding(.vertical, 9)
            .background(RoundedRectangle(cornerRadius: 11).fill(Theme.accentSoft))
            .overlay(RoundedRectangle(cornerRadius: 11).stroke(Theme.accentEdge, lineWidth: 1))
        }.disabled(exporting)
    }

    private func doExport(asPng: Bool) async {
        exporting = true; exportError = nil; defer { exporting = false }
        do {
            let url = asPng ? try await store.api.cardExportPng(base: store.serverURL, id: card.id)
                            : try await store.api.cardExportTavern(base: store.serverURL, id: card.id)
            shareItem = ShareItem(url: url)
        } catch {
            exportError = (error as? LocalizedError)?.errorDescription ?? "导出失败"
        }
    }

    @ViewBuilder private func prose(_ label: String, _ v: String?) -> some View {
        if let v, !v.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(loc: label).font(Theme.ui(11, .semibold)).foregroundStyle(Theme.accent).tracking(1)
                Text(v).font(Theme.serif(14.5)).foregroundStyle(Theme.text).lineSpacing(4)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func tagRow(_ label: String, _ items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(loc: label).font(Theme.ui(11, .semibold)).foregroundStyle(Theme.muted).tracking(1)
            HStack(spacing: 6) { ForEach(items, id: \.self) { Text($0).font(Theme.ui(11.5)).foregroundStyle(Theme.text).padding(.horizontal, 8).padding(.vertical, 3).background(Capsule().fill(Theme.panel2)) } }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: – 人设图(完整立绘)

// 海报点开进灯箱显示完整图;下方缩略条切换/查看;可 AI 生成或上传。
struct PersonaImagesView: View {
    @EnvironmentObject var store: AppStore
    let card: CharacterCardItem
    var editable: Bool = true   // 仅编辑模式显示「上传/AI生成/切换当前」等控件;查看模式只读
    @State private var personas: [PersonaImage] = []
    @State private var loading = true
    @State private var busy = false
    @State private var err: String?
    @State private var photoItem: PhotosPickerItem?
    @State private var showPhoto = false
    @State private var showGen = false
    @State private var lightboxURL: String?

    private var current: PersonaImage? { personas.first { $0.is_current == true } ?? personas.first }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(loc: "人设图").font(Theme.ui(11, .semibold)).foregroundStyle(Theme.accent).tracking(1.2)
                Spacer()
                if busy { ProgressView().tint(Theme.accent).scaleEffect(0.7) }
            }
            poster
            if personas.count > 1 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(personas) { p in stripThumb(p) }
                    }
                }
            }
            if editable {
                HStack(spacing: 10) {
                    actionButton("上传人设图", "square.and.arrow.up") { showPhoto = true }
                    actionButton("AI 生成", "sparkles") { showGen = true }
                }
            }
            if let err { Text(err).font(Theme.ui(11.5)).foregroundStyle(Theme.danger) }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 16).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Theme.line, lineWidth: 1))
        .task { await load() }
        .photosPicker(isPresented: $showPhoto, selection: $photoItem, matching: .images)
        .onChange(of: photoItem) { _, item in if let item { upload(item) } }
        .sheet(isPresented: $showGen) {
            GenImageSheet(suggestedStyle: "avatar") { prompt, _ in generate(prompt) }
        }
        .fullScreenCover(item: Binding(get: { lightboxURL.map { LBURL(url: $0) } }, set: { lightboxURL = $0?.url })) { lb in
            ImageLightbox(base: store.serverURL, path: lb.url)
        }
    }
    private struct LBURL: Identifiable { let url: String; var id: String { url } }

    @ViewBuilder private var poster: some View {
        if let c = current, let u = c.image_url, !u.isEmpty {
            // 海报=完整人设图,点开看大图(完整链接,非头像缩略)
            Button { lightboxURL = u } label: {
                AsyncImage(url: absoluteImageURL(base: store.serverURL, path: u),
                           transaction: .init(animation: .easeOut(duration: 0.35))) { phase in
                    switch phase {
                    case .success(let img): img.resizable().scaledToFit().frame(maxWidth: .infinity, maxHeight: 360)
                    case .empty: ZStack { Theme.panel2; ProgressView().tint(Theme.accent) }.frame(height: 200)
                    default: ZStack { Theme.panel2; Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.muted2) }.frame(height: 160)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 13).stroke(Theme.line, lineWidth: 1))
                .overlay(alignment: .bottomTrailing) {
                    Image(systemName: "arrow.up.left.and.arrow.down.right").font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.white).padding(7).background(.ultraThinMaterial, in: Circle()).padding(8)
                }
            }.buttonStyle(PressableStyle())
        } else if loading {
            ZStack { Theme.panel2; ProgressView().tint(Theme.accent) }
                .frame(maxWidth: .infinity).frame(height: 160)
                .clipShape(RoundedRectangle(cornerRadius: 13))
        } else {
            VStack(spacing: 6) {
                Image(systemName: "photo.artframe").font(.system(size: 30)).foregroundStyle(Theme.muted2)
                Text(loc: "还没有人设图,上传或 AI 生成一张。").font(Theme.ui(12)).foregroundStyle(Theme.muted)
            }
            .frame(maxWidth: .infinity).frame(height: 130)
            .background(RoundedRectangle(cornerRadius: 13).fill(Theme.panel2))
        }
    }
    private func stripThumb(_ p: PersonaImage) -> some View {
        Button {
            if editable && p.is_current != true { Task { await setCurrent(p) } }
            else if let u = p.image_url { lightboxURL = u }   // 查看模式 / 当前图 → 点开看大图
        } label: {
            ServerImageThumb(base: store.serverURL, path: p.image_url, style: .avatarSquare, width: 54, placeholderIcon: "photo")
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.accent, lineWidth: p.is_current == true ? 2 : 0))
        }.buttonStyle(PressableStyle())
    }
    private func actionButton(_ title: String, _ icon: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) { Image(systemName: icon).font(.system(size: 12)); Text(loc: title).font(Theme.ui(13, .medium)) }
                .foregroundStyle(Theme.accent).frame(maxWidth: .infinity).padding(.vertical, 9)
                .background(RoundedRectangle(cornerRadius: 11).fill(Theme.accentSoft))
                .overlay(RoundedRectangle(cornerRadius: 11).stroke(Theme.accentEdge, lineWidth: 1))
        }.buttonStyle(PressableStyle()).disabled(busy || store.demo)
    }

    private func load() async {
        loading = true; defer { loading = false }
        if store.demo { personas = DemoData.personaImages; return }
        personas = (try? await store.api.personaImages(base: store.serverURL, cardId: card.id)) ?? []
    }
    private func setCurrent(_ p: PersonaImage) async {
        busy = true; err = nil; defer { busy = false }
        do { try await store.api.setCurrentPersona(base: store.serverURL, cardId: card.id, imageId: p.id); await load() }
        catch { err = (error as? LocalizedError)?.errorDescription ?? "设置失败" }
    }
    private func upload(_ item: PhotosPickerItem) {
        Task {
            busy = true; err = nil; defer { busy = false }
            guard let data = try? await item.loadTransferable(type: Data.self) else { err = "读取图片失败"; photoItem = nil; return }
            let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.88) ?? data
            do { _ = try await store.api.uploadPersonaImage(base: store.serverURL, cardId: card.id, data: jpeg, mime: "image/jpeg"); await load() }
            catch { err = (error as? LocalizedError)?.errorDescription ?? "上传失败" }
            photoItem = nil
        }
    }
    private func generate(_ prompt: String) {
        Task {
            busy = true; err = nil; defer { busy = false }
            do {
                let id = try await store.api.generatePersonaImage(base: store.serverURL, cardId: card.id, prompt: prompt)
                _ = try await store.api.awaitImage(base: store.serverURL, id: id)
                await load()
            } catch { err = (error as? LocalizedError)?.errorDescription ?? "生成失败" }
        }
    }
}

// MARK: – 角色卡编辑器

struct CardEditorView: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let card: CharacterCardItem?
    var onSaved: () -> Void
    // Basic
    @State private var name = ""; @State private var identity = ""; @State private var fullName = ""
    @State private var aliases = ""; @State private var tags = ""
    // Profile
    @State private var background = ""; @State private var appearance = ""; @State private var personality = ""
    @State private var speech = ""; @State private var status = ""; @State private var secrets = ""
    @State private var sampleDialogue = ""
    // Settings
    @State private var budget = 450.0; @State private var enabled = true
    @State private var importance = 100; @State private var priority = 100
    @State private var scopePublic = false
    // Avatar upload
    @State private var avatarPhotoItem: PhotosPickerItem?
    @State private var showAvatarPicker = false
    @State private var avatarUploading = false
    @State private var avatarErr: String?
    // Save state
    @State private var saving = false; @State private var err: String?

    var body: some View {
        NavigationStack {
            ZStack {
                WarmBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if let c = card {   // 仅已存在的卡可编辑人设图(新建卡先保存)
                            PersonaImagesView(card: c, editable: true).environmentObject(store)
                            // 头像上传区(单独一行)
                            avatarUploadSection(c)
                        }
                        group("基本") {
                            field("名字 *", $name, "角色名"); field("全名", $fullName, "可选"); field("身份 / 角色", $identity, "如:废土幸存者")
                            field("别名(逗号分隔)", $aliases, "小莉, Lily"); field("标签(逗号分隔)", $tags, "废土, 幸存者")
                        }
                        group("人物档案") {
                            multi("背景", $background); multi("外貌", $appearance); multi("性格", $personality)
                            multi("说话风格", $speech); multi("当前状态", $status); multi("秘密", $secrets)
                            multi("示例对话", $sampleDialogue)
                        }
                        group("设定") {
                            VStack(alignment: .leading, spacing: 6) {
                                HStack { Text("Token 预算").font(Theme.ui(13.5)).foregroundStyle(Theme.text); Spacer(); Text("\(Int(budget))").font(Theme.ui(13)).foregroundStyle(Theme.muted).monospacedDigit() }
                                Slider(value: $budget, in: 100...1200, step: 50).tint(Theme.accent)
                            }
                            stepperRow("重要性", value: $importance, range: 0...1000)
                            stepperRow("优先级", value: $priority, range: 0...1000)
                            Toggle(isOn: $enabled) { Text("启用").font(Theme.ui(14)).foregroundStyle(Theme.text) }.tint(Theme.accent)
                            Toggle(isOn: $scopePublic) { Text("公开").font(Theme.ui(14)).foregroundStyle(Theme.text) }.tint(Theme.accent)
                        }
                        if let err { Text(err).font(Theme.ui(13)).foregroundStyle(Theme.danger) }
                    }.padding(16)
                }
            }
            .navigationTitle(card == nil ? "新建角色卡" : "编辑角色卡").navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bg, for: .navigationBar).toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.foregroundStyle(Theme.textQuiet) }
                ToolbarItem(placement: .confirmationAction) { Button(saving ? "保存中…" : "保存") { Task { await save() } }.foregroundStyle(Theme.accent).disabled(saving || name.trimmingCharacters(in: .whitespaces).isEmpty) }
            }
            .onAppear { fill() }
            .photosPicker(isPresented: $showAvatarPicker, selection: $avatarPhotoItem, matching: .images)
            .onChange(of: avatarPhotoItem) { _, item in
                guard let item, let c = card else { return }
                Task { await uploadAvatar(item, for: c) }
            }
        }
    }

    // 头像上传区(仅已有 id 的卡)
    @ViewBuilder private func avatarUploadSection(_ c: CharacterCardItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(loc: "头像").font(Theme.ui(11, .semibold)).foregroundStyle(Theme.accent).tracking(1.2)
            HStack(spacing: 12) {
                if let av = c.avatar, !av.isEmpty {
                    AsyncImage(url: absoluteImageURL(base: store.serverURL, path: av)) { img in img.resizable().scaledToFill() } placeholder: { Circle().fill(Theme.accentSoft) }
                        .frame(width: 54, height: 54).clipShape(Circle())
                        .overlay(Circle().stroke(Theme.line, lineWidth: 1))
                } else {
                    ZStack { Circle().fill(Theme.accentSoft); Circle().stroke(Theme.accentEdge, lineWidth: 1)
                        Text(String(c.display.prefix(1))).font(Theme.serif(22)).foregroundStyle(Theme.accent) }.frame(width: 54, height: 54)
                }
                Button {
                    showAvatarPicker = true
                } label: {
                    HStack(spacing: 5) {
                        if avatarUploading { ProgressView().tint(Theme.accent).scaleEffect(0.75) }
                        else { Image(systemName: "photo.badge.plus").font(.system(size: 13)) }
                        Text(loc: "上传头像").font(Theme.ui(13, .medium))
                    }
                    .foregroundStyle(Theme.accent).padding(.horizontal, 14).padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Theme.accentSoft))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.accentEdge, lineWidth: 1))
                }.disabled(avatarUploading || store.demo)
            }
            if let avatarErr { Text(avatarErr).font(Theme.ui(11.5)).foregroundStyle(Theme.danger) }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.panel)).overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
    }

    private func group<C: View>(_ t: String, @ViewBuilder _ c: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(loc: t).font(Theme.ui(11, .semibold)).foregroundStyle(Theme.accent).tracking(1.2)
            VStack(alignment: .leading, spacing: 10) { c() }.padding(14)
                .background(RoundedRectangle(cornerRadius: 14).fill(Theme.panel)).overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
        }
    }
    private func field(_ l: String, _ t: Binding<String>, _ ph: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(loc: l).font(Theme.ui(12)).foregroundStyle(Theme.muted)
            TextField(ph, text: t).font(Theme.ui(14)).foregroundStyle(Theme.text).tint(Theme.accent)
                .padding(.horizontal, 10).padding(.vertical, 8).background(RoundedRectangle(cornerRadius: 8).fill(Theme.panel2)).overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line, lineWidth: 1))
        }
    }
    private func multi(_ l: String, _ t: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(loc: l).font(Theme.ui(12)).foregroundStyle(Theme.muted)
            TextEditor(text: t).font(Theme.ui(14)).foregroundStyle(Theme.text).tint(Theme.accent).scrollContentBackground(.hidden).padding(6).frame(height: 70)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.panel2)).overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line, lineWidth: 1))
        }
    }
    private func stepperRow(_ label: String, value: Binding<Int>, range: ClosedRange<Int>) -> some View {
        HStack {
            Text(loc: label).font(Theme.ui(13.5)).foregroundStyle(Theme.text)
            Spacer()
            Stepper(value: value, in: range, step: 10) {
                Text("\(value.wrappedValue)").font(Theme.ui(13)).foregroundStyle(Theme.muted).monospacedDigit()
            }.tint(Theme.accent)
        }
    }
    private func fill() {
        guard let c = card else { return }
        name = c.name ?? ""; identity = c.identity ?? ""; fullName = c.full_name ?? ""
        aliases = (c.aliases ?? []).joined(separator: ", "); tags = (c.tags ?? []).joined(separator: ", ")
        background = c.background ?? ""; appearance = c.appearance ?? ""; personality = c.personality ?? ""
        speech = c.speech_style ?? ""; status = c.current_status ?? ""; secrets = c.secrets ?? ""
        budget = Double(c.token_budget ?? 450); enabled = c.enabled ?? true
        importance = c.importance ?? 100; priority = c.priority ?? 100
        scopePublic = c.is_public ?? false
        // sample_dialogue is not on CharacterCardItem model; will start empty (backed by body key)
    }
    private func save() async {
        saving = true; err = nil; defer { saving = false }
        if store.demo { dismiss(); return }
        func splitList(_ s: String) -> [String] { s.split(whereSeparator: { $0 == "," || $0 == "，" }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
        var body: [String: Any] = [
            "name": name.trimmingCharacters(in: .whitespaces), "full_name": fullName, "identity": identity,
            "background": background, "appearance": appearance, "personality": personality,
            "speech_style": speech, "current_status": status, "secrets": secrets,
            "aliases": splitList(aliases), "tags": splitList(tags), "token_budget": Int(budget), "enabled": enabled,
            "importance": importance, "priority": priority,
            "scope": scopePublic ? "public" : "private",
        ]
        if !sampleDialogue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            body["sample_dialogue"] = sampleDialogue
        }
        if let c = card { body["id"] = c.id }
        do { _ = try await store.api.cardUpsert(base: store.serverURL, body: body); onSaved(); dismiss() }
        catch { self.err = (error as? LocalizedError)?.errorDescription ?? "保存失败" }
    }
    private func uploadAvatar(_ item: PhotosPickerItem, for c: CharacterCardItem) async {
        avatarUploading = true; avatarErr = nil; defer { avatarUploading = false; avatarPhotoItem = nil }
        guard let data = try? await item.loadTransferable(type: Data.self) else { avatarErr = "读取图片失败"; return }
        let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.88) ?? data
        do { _ = try await store.api.uploadUserCardAvatar(base: store.serverURL, cardId: c.id, data: jpeg, mime: "image/jpeg") }
        catch { avatarErr = (error as? LocalizedError)?.errorDescription ?? "上传失败" }
    }
}

// MARK: – 粘贴 JSON 导入

struct JsonPasteSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var json = ""
    var onImport: (String) -> Void
    var body: some View {
        NavigationStack {
            ZStack { WarmBackground()
                VStack(alignment: .leading, spacing: 10) {
                    Text("粘贴酒馆角色卡 JSON").font(Theme.ui(13)).foregroundStyle(Theme.muted)
                    TextEditor(text: $json).font(Theme.ui(13).monospaced()).foregroundStyle(Theme.text).tint(Theme.accent)
                        .scrollContentBackground(.hidden).padding(8).frame(maxHeight: .infinity)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.panel)).overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line, lineWidth: 1))
                }.padding(16)
            }
            .navigationTitle("导入 JSON").navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bg, for: .navigationBar).toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.foregroundStyle(Theme.textQuiet) }
                ToolbarItem(placement: .confirmationAction) { Button("导入") { onImport(json); dismiss() }.foregroundStyle(Theme.accent).disabled(json.trimmingCharacters(in: .whitespaces).isEmpty) }
            }
        }
    }
}

// MARK: – Local helpers

private struct ShareItem: Identifiable { let id = UUID(); let url: URL }
