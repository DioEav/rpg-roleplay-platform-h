import SwiftUI

// ─────────────────────────────────────────────────────────────────────────────
// 剧本编辑器(对齐 web /md-editor)—— 原生大屏 IDE:
//   · 左栏(master):实体类型切换(角色卡 / 世界书 / 正史)+ 实体列表(+ 新建)
//   · 右栏(detail):角色卡可编辑表单(创建/更新/删除/启停);世界书、正史 v1 只读浏览
// 自适应:regular(iPad/Mac)双栏并列;compact(iPhone)NavigationStack 推栈。
// 订阅(非自创)剧本只读:不显示「新建/保存/删除」,仅浏览。
// 架构上预留 worldbook/canon 的可编辑化(后端已有 PATCH canon;世界书编辑接口待补)。
// ─────────────────────────────────────────────────────────────────────────────

enum ScriptEntityKind: Int, CaseIterable, Identifiable {
    case cards = 0, worldbook = 1, canon = 2
    var id: Int { rawValue }
    var title: String {
        switch self { case .cards: return "角色卡"; case .worldbook: return "世界书"; case .canon: return "正史" }
    }
    var icon: String {
        switch self { case .cards: return "person.crop.rectangle.stack"; case .worldbook: return "globe.asia.australia"; case .canon: return "books.vertical" }
    }
    var editable: Bool { self == .cards }   // v1:仅角色卡可编辑
}

enum EditorSelection: Hashable {
    case newCard
    case card(Int)
    case worldbook(Int)
    case canon(Int)
}

struct ScriptEditorView: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var hsc
    let script: ScriptItem

    @State private var kind: ScriptEntityKind = .cards
    @State private var cards: [CharacterCardItem] = []
    @State private var worldbook: [WorldbookEntryItem] = []
    @State private var canon: [CanonEntityItem] = []
    @State private var loading = false
    @State private var loadErr: String?
    @State private var selection: EditorSelection?
    @State private var query = ""
    @State private var coverURL: String?

    private var canEdit: Bool { !(script.is_subscribed ?? false) }

    var body: some View {
        Group {
            if hsc == .regular {
                regularLayout
            } else {
                compactLayout
            }
        }
        .task {
            if coverURL == nil { coverURL = script.cover_image_url }
            await reload()
            applyTestSelection()   // MEADHALL_EDITOR_SEL=card|worldbook|canon|new(e2e 截图)
        }
    }

    private func applyTestSelection() {
        guard let sel = ProcessInfo.processInfo.environment["MEADHALL_EDITOR_SEL"] else { return }
        switch sel {
        case "new": kind = .cards; selection = .newCard
        case "card": kind = .cards; if let c = cards.first { selection = .card(c.id) }
        case "worldbook": kind = .worldbook; if let w = worldbook.first { selection = .worldbook(w.id) }
        case "canon": kind = .canon; if let k = canon.first { selection = .canon(k.id) }
        default: break
        }
    }

    // ── 大屏:并列双栏 ──
    private var regularLayout: some View {
        ZStack {
            WarmBackground()
            HStack(spacing: 0) {
                masterPane
                    .frame(width: 360)
                    .background(Theme.bgDeep)
                Divider().overlay(Theme.line)
                detailPane
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    // ── iPhone:推栈 ──
    private var compactLayout: some View {
        NavigationStack {
            ZStack { WarmBackground(); masterPane }
                .navigationDestination(item: $selection) { sel in
                    detailFor(sel)
                        .background(WarmBackground().ignoresSafeArea())
                }
        }
    }

    // ── 左栏:标题 + 类型切换 + 列表 ──
    private var masterPane: some View {
        VStack(spacing: 0) {
            header
            typeSwitcher
            searchBar
            if let loadErr {
                Text(loadErr).font(Theme.ui(12.5)).foregroundStyle(Theme.danger)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.vertical, 6)
            }
            entityList
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 11) {
            ImageSetControl(
                base: store.serverURL, currentURL: coverURL, style: .coverPortrait, width: 44,
                canEdit: canEdit && !store.demo, placeholderIcon: "book.closed",
                upload: { data, mime in try await store.api.uploadScriptCover(base: store.serverURL, scriptId: script.id, data: data, mime: mime) },
                generate: { prompt, size in
                    let id = try await store.api.enqueueImage(base: store.serverURL, prompt: prompt, kind: "cover", size: size,
                                                              attach: ["type": "script_cover", "script_id": script.id])
                    return try await store.api.awaitImage(base: store.serverURL, id: id)
                },
                onUpdated: { coverURL = $0 })
            VStack(alignment: .leading, spacing: 2) {
                Text(loc: "剧本编辑器").font(Theme.ui(11, .semibold)).foregroundStyle(Theme.accent).tracking(1.4)
                Text(script.display).font(Theme.serif(18, .semibold)).foregroundStyle(Theme.text).lineLimit(2)
            }
            Spacer()
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.muted).frame(width: 32, height: 32)
                    .background(Circle().fill(Theme.panel2))
                    .frame(width: 44, height: 44)   // 44pt 触控区(HIG)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel(Text(loc: "关闭窗口"))
        }
        .padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 12)
    }

    private var typeSwitcher: some View {
        HStack(spacing: 6) {
            ForEach(ScriptEntityKind.allCases) { k in
                Button {
                    if kind != k { kind = k; selection = nil; query = "" }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: k.icon).font(.system(size: 11.5))
                        Text(loc: k.title).font(Theme.ui(12.5, .medium))
                    }
                    .foregroundStyle(kind == k ? Theme.onAccent : Theme.muted)
                    .frame(maxWidth: .infinity).padding(.vertical, 8)
                    .background(Capsule().fill(kind == k ? Theme.accent : Theme.panel2))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 16).padding(.bottom, 10)
    }

    private var searchBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(Theme.muted2)
            TextField(tr("搜索"), text: $query).font(Theme.ui(13.5)).foregroundStyle(Theme.text).tint(Theme.accent)
        }
        .padding(.horizontal, 11).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 9).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(Theme.line, lineWidth: 1))
        .padding(.horizontal, 16).padding(.bottom, 8)
    }

    @ViewBuilder private var entityList: some View {
        if loading {
            Spacer(); ProgressView().tint(Theme.accent); Spacer()
        } else {
            ScrollView {
                LazyVStack(spacing: 7) {
                    if kind == .cards && canEdit {
                        Button { selection = .newCard } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "plus.circle.fill").font(.system(size: 15))
                                Text(loc: "新建角色卡").font(Theme.ui(13.5, .medium))
                                Spacer()
                            }
                            .foregroundStyle(Theme.accent).padding(.horizontal, 13).padding(.vertical, 11)
                            .background(RoundedRectangle(cornerRadius: 11).fill(Theme.accentSoft))
                            .overlay(RoundedRectangle(cornerRadius: 11).stroke(Theme.accentEdge, lineWidth: 1))
                            .overlay(alignment: .leading) {
                                if isSelected(.newCard) { Rectangle().fill(Theme.accent).frame(width: 3).clipShape(Capsule()) }
                            }
                        }.buttonStyle(.plain)
                    }
                    switch kind {
                    case .cards: ForEach(filteredCards) { c in listRow(.card(c.id), c.display, c.subtitle, badge: (c.enabled == false) ? "停用" : nil, avatarPath: c.avatar) }
                    case .worldbook: ForEach(filteredWorldbook) { e in listRow(.worldbook(e.id), e.display, (e.content ?? "").prefix(40).description, badge: (e.enabled == false) ? "停用" : nil) }
                    case .canon: ForEach(filteredCanon) { e in listRow(.canon(e.id), e.display, e.subtitle, badge: nil) }
                    }
                    if currentCount == 0 && !loading {
                        VStack(spacing: 8) {
                            Image(systemName: kind.icon).font(.system(size: 30)).foregroundStyle(Theme.muted2)
                            Text(loc: emptyText).font(Theme.ui(12.5)).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                        }.frame(maxWidth: .infinity).padding(.top, 40).padding(.horizontal, 20)
                    }
                }.padding(.horizontal, 16).padding(.bottom, 24)
            }
            .refreshable { await reload() }
        }
    }

    private func listRow(_ sel: EditorSelection, _ title: String, _ sub: String, badge: String?, avatarPath: String? = nil) -> some View {
        Button { selection = sel } label: {
            HStack(spacing: 10) {
                if kind == .cards {
                    ServerImageThumb(base: store.serverURL, path: avatarPath, style: .avatarCircle, width: 34, placeholderIcon: "person.fill")
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(Theme.ui(14.5, .medium)).foregroundStyle(Theme.text).lineLimit(1)
                    if !sub.isEmpty { Text(sub).font(Theme.ui(11.5)).foregroundStyle(Theme.muted).lineLimit(1) }
                }
                Spacer()
                if let badge {
                    Text(loc: badge).font(Theme.ui(9.5, .semibold)).foregroundStyle(Theme.muted)
                        .padding(.horizontal, 6).padding(.vertical, 1).background(Capsule().fill(Theme.panel2))
                }
                if hsc != .regular { Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.muted2) }
            }
            .padding(.horizontal, 13).padding(.vertical, 11)
            .background(RoundedRectangle(cornerRadius: 11).fill(isSelected(sel) ? Theme.accentSoft : Theme.panel))
            .overlay(RoundedRectangle(cornerRadius: 11).stroke(isSelected(sel) ? Theme.accentEdge : Theme.line, lineWidth: 1))
            .overlay(alignment: .leading) {
                if isSelected(sel) && hsc == .regular { Rectangle().fill(Theme.accent).frame(width: 3).clipShape(Capsule()) }
            }
            .contentShape(Rectangle())
        }.buttonStyle(.plain)
    }

    private func isSelected(_ sel: EditorSelection) -> Bool { hsc == .regular && selection == sel }

    // ── 右栏 ──
    @ViewBuilder private var detailPane: some View {
        if let sel = selection {
            detailFor(sel)
        } else {
            VStack(spacing: 12) {
                Image(systemName: kind.icon).font(.system(size: 46)).foregroundStyle(Theme.muted2)
                Text(loc: kind.editable ? "选择左侧条目编辑,或新建一个" : "选择左侧条目查看")
                    .font(Theme.ui(14)).foregroundStyle(Theme.muted)
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder private func detailFor(_ sel: EditorSelection) -> some View {
        switch sel {
        case .newCard:
            ScriptCardForm(scriptId: script.id, card: nil, editable: canEdit,
                           onSaved: { saved in Task { await reload(); selection = .card(saved.id) } },
                           onDeleted: { selection = nil; Task { await reload() } })
                .id("new")
        case .card(let id):
            ScriptCardForm(scriptId: script.id, card: cards.first { $0.id == id }, editable: canEdit,
                           onSaved: { _ in Task { await reload() } },
                           onDeleted: { selection = nil; Task { await reload() } })
                .id(id)
        case .worldbook(let id):
            if let e = worldbook.first(where: { $0.id == id }) { WorldbookDetailView(entry: e) } else { missing }
        case .canon(let id):
            if let e = canon.first(where: { $0.id == id }) { CanonDetailView(entity: e) } else { missing }
        }
    }
    private var missing: some View {
        Text(loc: "该条目已不存在").font(Theme.ui(14)).foregroundStyle(Theme.muted)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // ── 数据 / 过滤 ──
    private var filteredCards: [CharacterCardItem] {
        query.isEmpty ? cards : cards.filter { $0.display.localizedCaseInsensitiveContains(query) }
    }
    private var filteredWorldbook: [WorldbookEntryItem] {
        query.isEmpty ? worldbook : worldbook.filter { $0.display.localizedCaseInsensitiveContains(query) || ($0.content ?? "").localizedCaseInsensitiveContains(query) }
    }
    private var filteredCanon: [CanonEntityItem] {
        query.isEmpty ? canon : canon.filter { $0.display.localizedCaseInsensitiveContains(query) }
    }
    private var currentCount: Int {
        switch kind { case .cards: return filteredCards.count; case .worldbook: return filteredWorldbook.count; case .canon: return filteredCanon.count }
    }
    private var emptyText: String {
        switch kind {
        case .cards: return canEdit ? "还没有角色卡。点上方「新建」开始。" : "这个剧本还没有角色卡。"
        case .worldbook: return "这个剧本还没有世界书条目。"
        case .canon: return "这个剧本还没有正史实体。"
        }
    }

    private func reload() async {
        loading = (cards.isEmpty && worldbook.isEmpty && canon.isEmpty)
        loadErr = nil
        defer { loading = false }
        if store.demo {
            cards = DemoData.scriptCards; worldbook = DemoData.scriptWorldbook; canon = DemoData.scriptCanon
            return
        }
        do {
            async let c = store.api.scriptCards(base: store.serverURL, scriptId: script.id)
            async let w = store.api.scriptWorldbook(base: store.serverURL, scriptId: script.id)
            async let k = store.api.scriptCanon(base: store.serverURL, scriptId: script.id)
            cards = try await c; worldbook = try await w; canon = try await k
        } catch {
            loadErr = (error as? LocalizedError)?.errorDescription ?? "加载失败"
        }
    }
}

// ── 角色卡编辑表单(嵌入右栏;创建/更新/删除/启停)──
struct ScriptCardForm: View {
    @EnvironmentObject var store: AppStore
    let scriptId: Int
    let card: CharacterCardItem?
    let editable: Bool
    var onSaved: (CharacterCardItem) -> Void
    var onDeleted: () -> Void

    @State private var name = ""; @State private var identity = ""; @State private var fullName = ""
    @State private var aliases = ""; @State private var tags = ""
    @State private var background = ""; @State private var appearance = ""; @State private var personality = ""
    @State private var speech = ""; @State private var status = ""; @State private var secrets = ""
    @State private var budget = 450.0; @State private var enabled = true; @State private var firstChapter = 0.0
    @State private var saving = false; @State private var err: String?; @State private var confirmDelete = false
    @State private var avatarPath: String?

    private var isNew: Bool { card == nil }

    var body: some View {
        VStack(spacing: 0) {
            headerBar   // 固定顶栏:标题 + 保存(长表单滚动时也始终可达)
            ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let c = card {
                    HStack(spacing: 14) {
                        ImageSetControl(
                            base: store.serverURL, currentURL: avatarPath, style: .avatarCircle, width: 72,
                            canEdit: editable && !store.demo, placeholderIcon: "person.fill",
                            upload: { data, mime in try await store.api.uploadScriptCardAvatar(base: store.serverURL, scriptId: scriptId, cardId: c.id, data: data, mime: mime) },
                            generate: { prompt, size in
                                let id = try await store.api.enqueueImage(base: store.serverURL, prompt: prompt, kind: "avatar", size: size,
                                                                          attach: ["type": "card_avatar", "card_id": c.id, "script_id": scriptId])
                                return try await store.api.awaitImage(base: store.serverURL, id: id)
                            },
                            onUpdated: { avatarPath = $0 })
                        VStack(alignment: .leading, spacing: 4) {
                            Text(loc: "头像").font(Theme.ui(12.5, .medium)).foregroundStyle(Theme.text)
                            Text(loc: editable ? "点头像换图:相册上传或 AI 生成。" : "订阅剧本头像只读。")
                                .font(Theme.ui(11.5)).foregroundStyle(Theme.muted).lineSpacing(2)
                        }
                        Spacer()
                    }
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Theme.panel)).overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
                } else {
                    Text(loc: "保存后可为这张卡设置头像(上传 / AI 生成)。")
                        .font(Theme.ui(12)).foregroundStyle(Theme.muted2)
                        .padding(.horizontal, 2)
                }
                if !editable {
                    Label { Text(loc: "订阅剧本为只读,不能编辑角色卡。") } icon: { Image(systemName: "lock.fill") }
                        .font(Theme.ui(12.5)).foregroundStyle(Theme.muted)
                        .padding(11).frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.panel2))
                }
                group("基本") {
                    field("名字 *", $name, "角色名"); field("全名", $fullName, "可选"); field("身份 / 角色", $identity, "如:女主角")
                    field("别名(逗号分隔)", $aliases, "小莉, Lily"); field("标签(逗号分隔)", $tags, "学院, 反派")
                }
                group("人物档案") {
                    multi("背景", $background); multi("外貌", $appearance); multi("性格", $personality)
                    multi("说话风格", $speech); multi("当前状态", $status); multi("秘密", $secrets)
                }
                group("卡片设定") {
                    stepperRow("首次出场章节", $firstChapter, range: 0...2000)
                    sliderRow("Token 预算", $budget, range: 100...1200, step: 50)
                    Toggle(isOn: $enabled) { Text(loc: "启用(参与检索)").font(Theme.ui(14)).foregroundStyle(Theme.text) }
                        .tint(Theme.accent).disabled(!editable)
                }
                if let err { Text(err).font(Theme.ui(13)).foregroundStyle(Theme.danger) }
                if editable && !isNew {
                    Button(role: .destructive) { confirmDelete = true } label: {
                        HStack(spacing: 6) { Image(systemName: "trash"); Text(loc: "删除这张角色卡") }
                            .font(Theme.ui(14, .medium)).foregroundStyle(Theme.danger)
                            .frame(maxWidth: .infinity).padding(.vertical, 11)
                            .background(RoundedRectangle(cornerRadius: 11).stroke(Theme.danger.opacity(0.4), lineWidth: 1))
                    }
                }
            }.padding(18).frame(maxWidth: 720, alignment: .leading)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .frame(maxWidth: .infinity)
        .onAppear { fill() }
        .alert(tr("删除角色卡?"), isPresented: $confirmDelete) {
            Button(tr("取消"), role: .cancel) {}
            Button(tr("删除"), role: .destructive) { Task { await remove() } }
        } message: { Text(loc: "删除后无法恢复。") }
        .toolbar { ToolbarItemGroup(placement: .keyboard) { Spacer(); Button(tr("完成")) { endEditing() } } }
    }

    private func endEditing() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    // 固定顶栏(不随表单滚动消失)
    private var headerBar: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(loc: isNew ? "新建角色卡" : "编辑角色卡").font(Theme.serif(20, .semibold)).foregroundStyle(Theme.text)
            Spacer()
            if editable {
                Button { Task { await save() } } label: {
                    HStack(spacing: 6) {
                        if saving { ProgressView().tint(Theme.onAccent).scaleEffect(0.8) }
                        Text(loc: saving ? "保存中…" : "保存").font(Theme.ui(14.5, .semibold))
                    }
                    .foregroundStyle(Theme.onAccent).padding(.horizontal, 18).padding(.vertical, 9)
                    .background(Capsule().fill(name.trimmingCharacters(in: .whitespaces).isEmpty ? Theme.muted2 : Theme.accent))
                }
                .disabled(saving || name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(.horizontal, 18).padding(.vertical, 12)
        .background(Theme.bg)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
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
            TextField(ph, text: t).font(Theme.ui(14)).foregroundStyle(Theme.text).tint(Theme.accent).disabled(!editable)
                .padding(.horizontal, 10).padding(.vertical, 8).background(RoundedRectangle(cornerRadius: 8).fill(Theme.panel2)).overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line, lineWidth: 1))
        }
    }
    private func multi(_ l: String, _ t: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(loc: l).font(Theme.ui(12)).foregroundStyle(Theme.muted)
            TextEditor(text: t).font(Theme.ui(14)).foregroundStyle(Theme.text).tint(Theme.accent).scrollContentBackground(.hidden).padding(6).frame(height: 80).disabled(!editable)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.panel2)).overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line, lineWidth: 1))
        }
    }
    private func sliderRow(_ l: String, _ v: Binding<Double>, range: ClosedRange<Double>, step: Double) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack { Text(loc: l).font(Theme.ui(13.5)).foregroundStyle(Theme.text); Spacer(); Text("\(Int(v.wrappedValue))").font(Theme.ui(13)).foregroundStyle(Theme.muted).monospacedDigit() }
            Slider(value: v, in: range, step: step).tint(Theme.accent).disabled(!editable)
        }
    }
    private func stepperRow(_ l: String, _ v: Binding<Double>, range: ClosedRange<Double>) -> some View {
        HStack {
            Text(loc: l).font(Theme.ui(13.5)).foregroundStyle(Theme.text)
            Spacer()
            Stepper(value: v, in: range, step: 1) {
                Text(Int(v.wrappedValue) == 0 ? tr("未设") : "\(Int(v.wrappedValue))").font(Theme.ui(13)).foregroundStyle(Theme.muted).monospacedDigit()
            }.disabled(!editable).fixedSize()
        }
    }

    private func fill() {
        guard let c = card else { return }
        name = c.name ?? ""; identity = c.identity ?? ""; fullName = c.full_name ?? ""
        aliases = (c.aliases ?? []).joined(separator: ", "); tags = (c.tags ?? []).joined(separator: ", ")
        background = c.background ?? ""; appearance = c.appearance ?? ""; personality = c.personality ?? ""
        speech = c.speech_style ?? ""; status = c.current_status ?? ""; secrets = c.secrets ?? ""
        budget = Double(c.token_budget ?? 450); enabled = c.enabled ?? true; firstChapter = Double(c.first_revealed_chapter ?? 0)
        avatarPath = c.avatar
    }
    private func save() async {
        saving = true; err = nil; defer { saving = false }
        if store.demo { return }
        func splitList(_ s: String) -> [String] { s.split(whereSeparator: { $0 == "," || $0 == "，" }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
        var body: [String: Any] = [
            "name": name.trimmingCharacters(in: .whitespaces), "full_name": fullName, "identity": identity,
            "background": background, "appearance": appearance, "personality": personality,
            "speech_style": speech, "current_status": status, "secrets": secrets,
            "aliases": splitList(aliases), "tags": splitList(tags),
            "token_budget": Int(budget), "enabled": enabled, "first_revealed_chapter": Int(firstChapter),
        ]
        if let c = card { body["id"] = c.id }
        do {
            let saved = try await store.api.scriptCardUpsert(base: store.serverURL, scriptId: scriptId, body: body)
            onSaved(saved)
        } catch { self.err = (error as? LocalizedError)?.errorDescription ?? "保存失败" }
    }
    private func remove() async {
        guard let c = card else { return }
        do { try await store.api.scriptCardDelete(base: store.serverURL, scriptId: scriptId, cardId: c.id); onDeleted() }
        catch { self.err = (error as? LocalizedError)?.errorDescription ?? "删除失败" }
    }
}

// ── 世界书条目(只读)──
struct WorldbookDetailView: View {
    let entry: WorldbookEntryItem
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text(entry.display).font(Theme.serif(22, .semibold)).foregroundStyle(Theme.text)
                if let keys = entry.keys, !keys.isEmpty {
                    FlowKeys(keys: keys)
                }
                readonlyBlock("内容", entry.content ?? "")
                HStack(spacing: 14) {
                    metaPill("优先级", "\(entry.priority ?? 0)")
                    if entry.enabled == false { metaPill("状态", tr("停用")) }
                }
            }.padding(18).frame(maxWidth: 720, alignment: .leading)
        }.frame(maxWidth: .infinity)
    }
}

// ── 正史实体(只读)──
struct CanonDetailView: View {
    let entity: CanonEntityItem
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text(entity.display).font(Theme.serif(22, .semibold)).foregroundStyle(Theme.text)
                HStack(spacing: 10) {
                    if let t = entity.type, !t.isEmpty { metaPill("类型", t) }
                    metaPill("重要度", "\(entity.importance ?? 0)")
                    if let fc = entity.first_revealed_chapter, fc > 0 { metaPill("首现", "第\(fc)章") }
                }
                if let fn = entity.full_name, !fn.isEmpty { readonlyBlock("全名", fn) }
                if let id = entity.identity, !id.isEmpty { readonlyBlock("身份", id) }
                readonlyBlock("摘要", entity.summary ?? "")
                if let bg = entity.background, !bg.isEmpty { readonlyBlock("背景", bg) }
            }.padding(18).frame(maxWidth: 720, alignment: .leading)
        }.frame(maxWidth: .infinity)
    }
}

// ── 只读小组件 ──
@ViewBuilder private func readonlyBlock(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 5) {
        Text(loc: label).font(Theme.ui(11, .semibold)).foregroundStyle(Theme.accent).tracking(1.0)
        Text(value.isEmpty ? "—" : value).font(Theme.ui(14)).foregroundStyle(value.isEmpty ? Theme.muted2 : Theme.text).lineSpacing(4)
            .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
            .padding(13).background(RoundedRectangle(cornerRadius: 12).fill(Theme.panel)).overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line, lineWidth: 1))
    }
}
private func metaPill(_ label: String, _ value: String) -> some View {
    HStack(spacing: 5) {
        Text(loc: label).font(Theme.ui(11)).foregroundStyle(Theme.muted)
        Text(value).font(Theme.ui(12, .semibold)).foregroundStyle(Theme.text)
    }
    .padding(.horizontal, 10).padding(.vertical, 5).background(Capsule().fill(Theme.panel2))
}

private struct FlowKeys: View {
    let keys: [String]
    var body: some View {
        // 简单换行排布(少量关键词)
        WrapHStack(keys, spacing: 6) { k in
            Text(k).font(Theme.ui(11.5)).foregroundStyle(Theme.accent)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Capsule().fill(Theme.accentSoft)).overlay(Capsule().stroke(Theme.accentEdge, lineWidth: 1))
        }
    }
}

// 极简流式换行容器(用于关键词标签)。
private struct WrapHStack<Data: RandomAccessCollection, Content: View>: View where Data.Element: Hashable {
    let data: Data; let spacing: CGFloat; let content: (Data.Element) -> Content
    init(_ data: Data, spacing: CGFloat = 6, @ViewBuilder content: @escaping (Data.Element) -> Content) {
        self.data = data; self.spacing = spacing; self.content = content
    }
    var body: some View {
        var width: CGFloat = 0; var rows: [[Data.Element]] = [[]]
        let limit: CGFloat = 640
        for el in data {
            let w: CGFloat = CGFloat(String(describing: el).count) * 14 + 24
            if width + w > limit { rows.append([el]); width = w }
            else { rows[rows.count - 1].append(el); width += w + spacing }
        }
        return VStack(alignment: .leading, spacing: spacing) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: spacing) { ForEach(row, id: \.self) { content($0) } }
            }
        }
    }
}
