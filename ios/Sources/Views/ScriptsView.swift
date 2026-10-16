import SwiftUI

// 剧本 Tab —— 对齐 web MobileScripts:剧本库浏览 + 快速开始新游戏。
struct ScriptsView: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.horizontalSizeClass) private var hsc   // 大屏:剧本改自适应网格
    @State private var scripts: [ScriptItem] = []
    @State private var loading = true
    @State private var query = ""
    @State private var filter = 0   // 0 全部 1 自创 2 订阅
    @State private var detail: ScriptItem?
    @State private var error: String?
    @State private var showPublicLibrary = false   // 公开剧本库 sheet

    private var filtered: [ScriptItem] {
        var base = scripts
        switch filter {
        case 1: base = base.filter { !($0.is_subscribed ?? false) }
        case 2: base = base.filter { $0.is_subscribed ?? false }
        default: break
        }
        guard !query.isEmpty else { return base }
        return base.filter { $0.display.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                WarmBackground()
                VStack(spacing: 0) {
                    header
                    searchBar
                    filterPills
                    content
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .task {
                await reload()
                if ProcessInfo.processInfo.environment["MEADHALL_WIZARD"] == "1", let s = scripts.first { wizardScript = s }
                if ProcessInfo.processInfo.environment["MEADHALL_EDITOR"] == "1", let s = scripts.first { editorScript = s }
                if ProcessInfo.processInfo.environment["MEADHALL_GEN"] == "1" { previewGen = true }
            }
            .sheet(item: $detail) { s in
                ScriptDetailSheet(script: s, onSubscriptionChanged: { await reload() })
                    .environmentObject(store)
            }
            .sheet(isPresented: $showPublicLibrary, onDismiss: { Task { await reload() } }) {
                PublicScriptLibrarySheet().environmentObject(store)
            }
            .fullScreenCover(item: $wizardScript) { s in NewGameView(scriptId: s.id, scriptTitle: s.display).environmentObject(store) }
            .fullScreenCover(item: $editorScript) { s in ScriptEditorView(script: s).environmentObject(store) }
            .sheet(isPresented: $previewGen) { GenImageSheet(suggestedStyle: "cover") { _, _ in } }   // MEADHALL_GEN=1 截图
        }
    }
    @State private var wizardScript: ScriptItem?
    @State private var editorScript: ScriptItem?   // MEADHALL_EDITOR=1 自动打开剧本编辑器(e2e)
    @State private var previewGen = false          // MEADHALL_GEN=1 预览生成单(截图)

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("剧本").font(Theme.serif(26, .semibold)).foregroundStyle(Theme.text)
            Text("\(filtered.count)").font(Theme.ui(13)).foregroundStyle(Theme.muted)
                .padding(.horizontal, 8).padding(.vertical, 2).background(Capsule().fill(Theme.panel2))
            Spacer()
            // 公开剧本库入口
            Button { showPublicLibrary = true } label: {
                HStack(spacing: 5) {
                    Image(systemName: "globe").font(.system(size: 12.5, weight: .medium))
                    Text(loc: "剧本库").font(Theme.ui(13, .medium))
                }
                .foregroundStyle(Theme.accent)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(Capsule().fill(Theme.accentSoft))
                .overlay(Capsule().stroke(Theme.accentEdge, lineWidth: 1))
            }
        }.padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 10)
    }
    private var searchBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").font(.system(size: 13)).foregroundStyle(Theme.muted2)
            TextField("搜索剧本", text: $query).font(Theme.ui(14)).foregroundStyle(Theme.text).tint(Theme.accent)
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line, lineWidth: 1))
        .padding(.horizontal, 16).padding(.bottom, 8)
    }
    private var filterPills: some View {
        HStack(spacing: 8) {
            ForEach(Array(["全部", "自创", "订阅"].enumerated()), id: \.offset) { i, t in
                Button { filter = i } label: {
                    Text(loc: t).font(Theme.ui(12.5, .medium)).foregroundStyle(filter == i ? Theme.onAccent : Theme.muted)
                        .padding(.horizontal, 13).padding(.vertical, 6)
                        .background(Capsule().fill(filter == i ? Theme.accent : Theme.panel2))
                }
            }
            Spacer()
        }.padding(.horizontal, 16).padding(.bottom, 8)
    }

    @ViewBuilder private var content: some View {
        if loading && scripts.isEmpty {
            Spacer(); ProgressView().tint(Theme.accent); Spacer()
        } else if filtered.isEmpty {
            VStack(spacing: 12) {
                Spacer()
                Image(systemName: "books.vertical").font(.system(size: 42)).foregroundStyle(Theme.muted2)
                Text("没有剧本").font(Theme.serif(18)).foregroundStyle(Theme.textQuiet)
                Text("在网页端导入剧本后会显示在这里。").font(Theme.ui(13)).foregroundStyle(Theme.muted)
                Spacer(); Spacer()
            }.frame(maxWidth: .infinity)
        } else {
            ScrollView {
                if let error { Text(error).font(Theme.ui(13)).foregroundStyle(Theme.danger).padding(.horizontal, 16) }
                if hsc == .regular {
                    // 大屏:自适应多列网格,充分利用宽内容区(复用同一 row 设计)。
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 260, maximum: 440), spacing: 12)], spacing: 12) {
                        ForEach(filtered) { s in
                            Button { detail = s } label: { row(s) }.buttonStyle(.plain)
                        }
                    }.padding(.horizontal, 16).padding(.bottom, 24)
                } else {
                    LazyVStack(spacing: 10) {
                        ForEach(filtered) { s in
                            Button { detail = s } label: { row(s) }.buttonStyle(.plain)
                        }
                    }.padding(.horizontal, 16).padding(.bottom, 24)
                }
            }
            .refreshable { await reload() }
        }
    }

    private func row(_ s: ScriptItem) -> some View {
        HStack(spacing: 13) {
            ServerImageThumb(base: store.serverURL, path: s.cover_image_url, style: .coverPortrait, width: 46, placeholderIcon: "book.closed")
            VStack(alignment: .leading, spacing: 4) {
                Text(s.display).font(Theme.ui(15.5, .medium)).foregroundStyle(Theme.text).lineLimit(2)
                Text("\(s.chapters)章 · \(wan(s.words))").font(Theme.ui(11.5)).foregroundStyle(Theme.muted)
                if s.is_subscribed ?? false {
                    Text("订阅").font(Theme.ui(9.5, .semibold)).foregroundStyle(Theme.accent)
                        .padding(.horizontal, 6).padding(.vertical, 1).background(Capsule().fill(Theme.accentSoft))
                }
            }
            Spacer()
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.muted2)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
        .contentShape(Rectangle())
    }
    private func wan(_ n: Int) -> String { locWordCount(n) }

    private func reload() async {
        loading = true; error = nil
        defer { loading = false }
        if store.demo { scripts = DemoData.scripts; return }
        do { scripts = try await store.api.scriptsList(base: store.serverURL) }
        catch { self.error = (error as? LocalizedError)?.errorDescription ?? "加载失败" }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 公开剧本库
// ─────────────────────────────────────────────────────────────────────────────
struct PublicScriptLibrarySheet: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var results: [ScriptItem] = []
    @State private var query = ""
    @State private var loading = false
    @State private var err: String?
    @State private var cloning: Int?   // id of script being cloned
    @State private var cloneErr: String?
    @State private var clonedIds: Set<Int> = []

    var body: some View {
        ZStack {
            WarmBackground()
            VStack(spacing: 0) {
                // 标题栏
                HStack(alignment: .center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(loc: "公开剧本库").font(Theme.serif(20, .semibold)).foregroundStyle(Theme.text)
                        Text(loc: "浏览并克隆公开剧本到你的账户").font(Theme.ui(12)).foregroundStyle(Theme.muted)
                    }
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark").font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Theme.muted).frame(width: 32, height: 32)
                            .background(Circle().fill(Theme.panel2))
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .accessibilityLabel(Text(loc: "关闭"))
                }
                .padding(.horizontal, 18).padding(.top, 16).padding(.bottom, 12)

                // 搜索栏
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").font(.system(size: 13)).foregroundStyle(Theme.muted2)
                    TextField(tr("搜索公开剧本…"), text: $query)
                        .font(Theme.ui(14)).foregroundStyle(Theme.text).tint(Theme.accent)
                        .submitLabel(.search)
                        .onSubmit { Task { await search() } }
                    if loading { ProgressView().tint(Theme.accent).scaleEffect(0.75) }
                }
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.panel))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line, lineWidth: 1))
                .padding(.horizontal, 16).padding(.bottom, 8)

                if let cloneErr {
                    Text(cloneErr).font(Theme.ui(12.5)).foregroundStyle(Theme.danger)
                        .padding(.horizontal, 18).padding(.bottom, 6)
                }

                // 列表
                if results.isEmpty && !loading {
                    VStack(spacing: 14) {
                        Spacer()
                        Image(systemName: "globe").font(.system(size: 44)).foregroundStyle(Theme.muted2)
                        Text(loc: query.isEmpty ? "输入关键词搜索公开剧本" : "没有找到匹配的公开剧本")
                            .font(Theme.ui(14)).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                        Spacer()
                    }.frame(maxWidth: .infinity)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 10) {
                            ForEach(results) { s in
                                publicRow(s)
                            }
                        }.padding(.horizontal, 16).padding(.bottom, 24)
                    }
                }
            }
        }
        .presentationDetents([.large])
        .presentationBackground(Theme.bg)
        .task { await search() }
    }

    private func publicRow(_ s: ScriptItem) -> some View {
        HStack(spacing: 13) {
            ServerImageThumb(base: store.serverURL, path: s.cover_image_url, style: .coverPortrait, width: 46, placeholderIcon: "book.closed")
            VStack(alignment: .leading, spacing: 4) {
                Text(s.display).font(Theme.ui(15, .medium)).foregroundStyle(Theme.text).lineLimit(2)
                Text("\(s.chapters)章 · \(locWordCount(s.words))").font(Theme.ui(11.5)).foregroundStyle(Theme.muted)
            }
            Spacer()
            if clonedIds.contains(s.id) {
                Image(systemName: "checkmark.circle.fill").font(.system(size: 18)).foregroundStyle(Theme.accent)
            } else if cloning == s.id {
                ProgressView().tint(Theme.accent).scaleEffect(0.85)
            } else {
                Button { Task { await clone(s) } } label: {
                    Text(loc: "克隆").font(Theme.ui(12.5, .semibold)).foregroundStyle(Theme.onAccent)
                        .padding(.horizontal, 13).padding(.vertical, 6)
                        .background(Capsule().fill(Theme.accent))
                }
                .buttonStyle(.plain)
                .disabled(store.demo)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
    }

    private func search() async {
        loading = true; err = nil
        defer { loading = false }
        if store.demo { results = DemoData.scripts; return }
        do { results = try await store.api.scriptsPublicList(base: store.serverURL, q: query) }
        catch { self.err = (error as? LocalizedError)?.errorDescription ?? "搜索失败" }
    }

    private func clone(_ s: ScriptItem) async {
        if store.demo { return }
        cloning = s.id; cloneErr = nil
        defer { cloning = nil }
        do {
            try await store.api.scriptCloneFromPublic(base: store.serverURL, id: s.id)
            clonedIds.insert(s.id)
        } catch {
            cloneErr = (error as? LocalizedError)?.errorDescription ?? "克隆失败"
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 剧本详情 + 快速开始
// ─────────────────────────────────────────────────────────────────────────────
struct ScriptDetailSheet: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let script: ScriptItem
    var onSubscriptionChanged: (() async -> Void)?

    @State private var starting = false
    @State private var err: String?
    @State private var showWizard = false
    @State private var showEditor = false

    // New sub-sheets
    @State private var showChapters = false
    @State private var showTimeline = false
    @State private var showVersions = false

    // Owned-script actions
    @State private var isPublic: Bool = false
    @State private var visibilityWorking = false
    @State private var forkWorking = false
    @State private var unsubWorking = false
    @State private var rebuildWorking = false
    @State private var confirmRebuild = false
    @State private var confirmUnsub = false
    @State private var actionMsg: String?
    @State private var actionIsError = false

    private var isOwned: Bool { !(script.is_subscribed ?? false) }
    private var isSubscribed: Bool { script.is_subscribed ?? false }

    var body: some View {
        ZStack {
            WarmBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    RoundedRectangle(cornerRadius: 3).fill(Theme.line).frame(width: 36, height: 4).frame(maxWidth: .infinity).padding(.top, 10)

                    // Header
                    HStack(spacing: 14) {
                        ServerImageThumb(base: store.serverURL, path: script.cover_image_url, style: .coverPortrait, width: 70, placeholderIcon: "book.closed")
                        VStack(alignment: .leading, spacing: 6) {
                            Text(script.display).font(Theme.serif(21, .semibold)).foregroundStyle(Theme.text)
                            Text("\(script.chapters)章 · \(wan(script.words))").font(Theme.ui(12.5)).foregroundStyle(Theme.muted)
                            HStack(spacing: 6) {
                                if isSubscribed {
                                    Text(loc: "订阅").font(Theme.ui(9.5, .semibold)).foregroundStyle(Theme.accent)
                                        .padding(.horizontal, 6).padding(.vertical, 2).background(Capsule().fill(Theme.accentSoft))
                                }
                                if script.is_public ?? false {
                                    Text(loc: "公开").font(Theme.ui(9.5, .semibold)).foregroundStyle(Theme.muted)
                                        .padding(.horizontal, 6).padding(.vertical, 2).background(Capsule().fill(Theme.panel2))
                                }
                            }
                        }
                        Spacer()
                    }
                    .padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 16)

                    // Info + Action message
                    Text("以这个剧本的世界观开始一段新冒险。快速开始会用默认设置(自由模式、本世界出身)建立存档并立即进入。")
                        .font(Theme.ui(13)).foregroundStyle(Theme.muted).lineSpacing(3)
                        .padding(.horizontal, 18).padding(.bottom, 12)

                    if let msg = actionMsg {
                        HStack(spacing: 8) {
                            Image(systemName: actionIsError ? "exclamationmark.circle" : "checkmark.circle")
                                .font(.system(size: 13))
                            Text(msg).font(Theme.ui(12.5))
                        }
                        .foregroundStyle(actionIsError ? Theme.danger : Theme.accent)
                        .padding(.horizontal, 18).padding(.bottom, 8)
                    }
                    if let e = err {
                        Text(e).font(Theme.ui(12.5)).foregroundStyle(Theme.danger).padding(.horizontal, 18).padding(.bottom, 8)
                    }

                    // Primary action
                    VStack(spacing: 10) {
                        Button { Task { await quickStart() } } label: {
                            HStack(spacing: 6) {
                                if starting { ProgressView().tint(Theme.onAccent).scaleEffect(0.8) }
                                else { Image(systemName: "play.fill").font(.system(size: 13)) }
                                Text(loc: starting ? "正在创建…" : "快速开始").font(Theme.ui(15.5, .semibold))
                            }
                            .foregroundStyle(Theme.onAccent).frame(maxWidth: .infinity).padding(.vertical, 13)
                            .background(Theme.accent, in: Capsule())
                        }.disabled(starting)

                        Button { showWizard = true } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "slider.horizontal.3").font(.system(size: 13))
                                Text(loc: "自定义开始(出生点/角色/贴原著…)").font(Theme.ui(14.5, .medium))
                            }
                            .foregroundStyle(Theme.accent).frame(maxWidth: .infinity).padding(.vertical, 12)
                            .background(Theme.accentSoft, in: Capsule()).overlay(Capsule().stroke(Theme.accentEdge, lineWidth: 1))
                        }

                        Button { showEditor = true } label: {
                            HStack(spacing: 6) {
                                Image(systemName: isSubscribed ? "doc.text.magnifyingglass" : "square.and.pencil").font(.system(size: 13))
                                Text(loc: isSubscribed ? "查看剧本资料(角色卡/世界书/正史)" : "编辑剧本(角色卡/世界书/正史)").font(Theme.ui(14.5, .medium))
                            }
                            .foregroundStyle(Theme.text).frame(maxWidth: .infinity).padding(.vertical, 12)
                            .background(Theme.panel, in: Capsule()).overlay(Capsule().stroke(Theme.line, lineWidth: 1))
                        }
                    }.padding(.horizontal, 18)

                    // ── 剧本内容浏览 ──────────────────────────────────────────
                    sectionDivider("剧本内容")

                    VStack(spacing: 8) {
                        subNavButton(icon: "list.bullet.rectangle", label: "章节", sub: "\(script.chapters)章") { showChapters = true }
                        subNavButton(icon: "clock.arrow.2.circlepath", label: "时间线", sub: "锚点与阶段") { showTimeline = true }
                        subNavButton(icon: "arrow.uturn.backward.circle", label: "版本历史", sub: "提交记录") { showVersions = true }
                    }.padding(.horizontal, 18)

                    // ── 管理操作 ──────────────────────────────────────────────
                    if isOwned {
                        sectionDivider("管理")
                        VStack(spacing: 8) {
                            // 公开/私密切换
                            visibilityToggleRow
                            // 重建向量索引
                            rebuildButton
                        }.padding(.horizontal, 18)
                    }

                    if isOwned {
                        sectionDivider("其他")
                        VStack(spacing: 8) {
                            // 复刻
                            forkButton
                        }.padding(.horizontal, 18)
                    }

                    if isSubscribed {
                        sectionDivider("订阅管理")
                        VStack(spacing: 8) {
                            unsubscribeButton
                        }.padding(.horizontal, 18)
                    }

                    Spacer(minLength: 32)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Theme.bg)
        .onAppear { isPublic = script.is_public ?? false }
        .fullScreenCover(isPresented: $showWizard) {
            NewGameView(scriptId: script.id, scriptTitle: script.display).environmentObject(store)
        }
        .fullScreenCover(isPresented: $showEditor) {
            ScriptEditorView(script: script).environmentObject(store)
        }
        .sheet(isPresented: $showChapters) {
            ScriptChaptersSheet(scriptId: script.id, scriptTitle: script.display)
                .environmentObject(store)
        }
        .sheet(isPresented: $showTimeline) {
            ScriptTimelineSheet(scriptId: script.id, scriptTitle: script.display)
                .environmentObject(store)
        }
        .sheet(isPresented: $showVersions) {
            ScriptVersionsSheet(scriptId: script.id, scriptTitle: script.display, isOwned: isOwned)
                .environmentObject(store)
        }
        .alert(tr("确认重建向量索引?"), isPresented: $confirmRebuild) {
            Button(tr("取消"), role: .cancel) {}
            Button(tr("重建")) { Task { await rebuildEmbeddings() } }
        } message: { Text(loc: "这将重新嵌入剧本全文，可能需要几分钟。") }
        .alert(tr("退订剧本?"), isPresented: $confirmUnsub) {
            Button(tr("取消"), role: .cancel) {}
            Button(tr("退订"), role: .destructive) { Task { await unsubscribe() } }
        } message: { Text(loc: "退订后此剧本将从你的列表中移除。") }
    }

    // ── 分节标题 ──────────────────────────────────────────────────────────────
    private func sectionDivider(_ title: String) -> some View {
        HStack {
            Text(loc: title).font(Theme.ui(11, .semibold)).foregroundStyle(Theme.accent).tracking(1.2)
            Rectangle().fill(Theme.line).frame(height: 1)
        }.padding(.horizontal, 18).padding(.top, 18).padding(.bottom, 10)
    }

    // ── 子页导航按钮 ──────────────────────────────────────────────────────────
    private func subNavButton(icon: String, label: String, sub: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon).font(.system(size: 15)).foregroundStyle(Theme.accent)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(loc: label).font(Theme.ui(14.5, .medium)).foregroundStyle(Theme.text)
                    Text(loc: sub).font(Theme.ui(11.5)).foregroundStyle(Theme.muted)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.muted2)
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .background(RoundedRectangle(cornerRadius: 13).fill(Theme.panel))
            .overlay(RoundedRectangle(cornerRadius: 13).stroke(Theme.line, lineWidth: 1))
            .contentShape(Rectangle())
        }.buttonStyle(.plain)
    }

    // ── 公开/私密切换 ─────────────────────────────────────────────────────────
    private var visibilityToggleRow: some View {
        HStack(spacing: 12) {
            Image(systemName: isPublic ? "globe" : "lock.fill").font(.system(size: 15))
                .foregroundStyle(isPublic ? Theme.accent : Theme.muted)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(loc: "公开发布").font(Theme.ui(14.5, .medium)).foregroundStyle(Theme.text)
                Text(loc: isPublic ? "其他用户可在剧本库中发现并克隆" : "仅自己可见").font(Theme.ui(11.5)).foregroundStyle(Theme.muted)
            }
            Spacer()
            if visibilityWorking {
                ProgressView().tint(Theme.accent).scaleEffect(0.8)
            } else {
                Toggle("", isOn: Binding(get: { isPublic }, set: { v in Task { await setVisibility(v) } }))
                    .tint(Theme.accent).labelsHidden()
                    .disabled(store.demo)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
        .background(RoundedRectangle(cornerRadius: 13).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 13).stroke(Theme.line, lineWidth: 1))
    }

    // ── 重建向量索引 ──────────────────────────────────────────────────────────
    private var rebuildButton: some View {
        Button { if !store.demo { confirmRebuild = true } } label: {
            HStack(spacing: 12) {
                if rebuildWorking {
                    ProgressView().tint(Theme.accent).scaleEffect(0.85).frame(width: 22)
                } else {
                    Image(systemName: "arrow.triangle.2.circlepath").font(.system(size: 15))
                        .foregroundStyle(Theme.muted).frame(width: 22)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(loc: rebuildWorking ? "重建中…" : "重建向量索引").font(Theme.ui(14.5, .medium)).foregroundStyle(Theme.text)
                    Text(loc: "重新嵌入剧本内容，改善 RAG 检索质量").font(Theme.ui(11.5)).foregroundStyle(Theme.muted)
                }
                Spacer()
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .background(RoundedRectangle(cornerRadius: 13).fill(Theme.panel))
            .overlay(RoundedRectangle(cornerRadius: 13).stroke(Theme.line, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(rebuildWorking || store.demo)
    }

    // ── 复刻 ──────────────────────────────────────────────────────────────────
    private var forkButton: some View {
        Button { Task { await fork() } } label: {
            HStack(spacing: 12) {
                if forkWorking {
                    ProgressView().tint(Theme.accent).scaleEffect(0.85).frame(width: 22)
                } else {
                    Image(systemName: "tuningfork").font(.system(size: 15))
                        .foregroundStyle(Theme.muted).frame(width: 22)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(loc: "复刻剧本").font(Theme.ui(14.5, .medium)).foregroundStyle(Theme.text)
                    Text(loc: "在你的账户下创建此剧本的独立副本").font(Theme.ui(11.5)).foregroundStyle(Theme.muted)
                }
                Spacer()
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .background(RoundedRectangle(cornerRadius: 13).fill(Theme.panel))
            .overlay(RoundedRectangle(cornerRadius: 13).stroke(Theme.line, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(forkWorking || store.demo)
    }

    // ── 退订 ──────────────────────────────────────────────────────────────────
    private var unsubscribeButton: some View {
        Button { confirmUnsub = true } label: {
            HStack(spacing: 12) {
                if unsubWorking {
                    ProgressView().tint(Theme.danger).scaleEffect(0.85).frame(width: 22)
                } else {
                    Image(systemName: "person.badge.minus").font(.system(size: 15))
                        .foregroundStyle(Theme.danger).frame(width: 22)
                }
                Text(loc: "退订此剧本").font(Theme.ui(14.5, .medium)).foregroundStyle(Theme.danger)
                Spacer()
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .background(RoundedRectangle(cornerRadius: 13).fill(Theme.panel))
            .overlay(RoundedRectangle(cornerRadius: 13).stroke(Theme.danger.opacity(0.3), lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(unsubWorking || store.demo)
    }

    // ── Actions ───────────────────────────────────────────────────────────────
    private func setVisibility(_ v: Bool) async {
        if store.demo { return }
        visibilityWorking = true; actionMsg = nil
        defer { visibilityWorking = false }
        do {
            try await store.api.scriptSetVisibility(base: store.serverURL, id: script.id, isPublic: v)
            isPublic = v
            showMsg(v ? "已设为公开" : "已设为私密", isError: false)
        } catch {
            showMsg((error as? LocalizedError)?.errorDescription ?? "操作失败", isError: true)
        }
    }

    private func rebuildEmbeddings() async {
        rebuildWorking = true; actionMsg = nil
        defer { rebuildWorking = false }
        do {
            try await store.api.scriptRebuildEmbeddings(base: store.serverURL, id: script.id)
            showMsg("重建任务已提交", isError: false)
        } catch {
            showMsg((error as? LocalizedError)?.errorDescription ?? "重建失败", isError: true)
        }
    }

    private func fork() async {
        if store.demo { return }
        forkWorking = true; actionMsg = nil
        defer { forkWorking = false }
        do {
            try await store.api.scriptFork(base: store.serverURL, id: script.id)
            showMsg("复刻成功，已添加到你的剧本", isError: false)
        } catch {
            showMsg((error as? LocalizedError)?.errorDescription ?? "复刻失败", isError: true)
        }
    }

    private func unsubscribe() async {
        if store.demo { return }
        unsubWorking = true; actionMsg = nil
        defer { unsubWorking = false }
        do {
            try await store.api.scriptUnsubscribe(base: store.serverURL, id: script.id)
            await onSubscriptionChanged?()
            dismiss()
        } catch {
            showMsg((error as? LocalizedError)?.errorDescription ?? "退订失败", isError: true)
        }
    }

    private func showMsg(_ msg: String, isError: Bool) {
        actionMsg = msg; actionIsError = isError
    }

    private func wan(_ n: Int) -> String { locWordCount(n) }

    private func quickStart() async {
        starting = true; err = nil
        defer { starting = false }
        if store.demo {
            // 演示:直接用第一个存档冒充进入
            dismiss()
            if let s = DemoData.saves.first { await store.launchGame(s) }
            return
        }
        // [round-4-P1] 出生点必须发后端期望的 dict({anchor_id:Int,...}),原来发裸 String 被静默忽略。
        let bps = await store.api.birthpoints(base: store.serverURL, scriptId: script.id)
        var body: [String: Any] = [
            "title": "\(script.display) · \(tr("新游戏"))",
            "script_id": script.id,
            "player_origin": "native",
        ]
        if let bp = bps.first, let aid = Int(bp.anchorId) {
            body["birthpoint"] = ["anchor_id": aid, "phase_label": bp.phase, "story_time_label": bp.label]
        }
        do {
            let saveId = try await store.api.newGame(base: store.serverURL, body: body)
            // 锁死项设置走 PATCH /settings(is_create=true);原来塞进 create body 被后端忽略 →
            // 快速开始的 free/loose 从不生效,玩家进的是后端默认 guided/strict。
            await store.api.saveSettings(base: store.serverURL, saveId: saveId, updates: [
                "foreknowledge_mode": "none", "steering_strength": "free",
            ], isCreate: true)
            // [round-4-P0] 必须先 activate 再进游戏台:/api/saves 只建档不激活运行时,
            // 漏掉则 GameConsole 的 /api/state 无活跃运行时 → 每次开局空/报错(对齐 NewGameView.create)。
            try await store.api.activateSave(base: store.serverURL, id: saveId)
            dismiss()
            store.openGame(id: saveId, title: "\(script.display) · \(tr("新游戏"))", scriptTitle: script.display)
        } catch {
            err = (error as? LocalizedError)?.errorDescription ?? "创建失败"
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 章节浏览
// ─────────────────────────────────────────────────────────────────────────────
struct ScriptChaptersSheet: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let scriptId: Int
    let scriptTitle: String

    @State private var chapters: [[String: Any]] = []
    @State private var loading = false
    @State private var err: String?
    @State private var selectedChapter: [String: Any]?   // tapped chapter meta
    @State private var showReader = false

    var body: some View {
        ZStack {
            WarmBackground()
            VStack(spacing: 0) {
                sheetHeader(title: "章节", sub: scriptTitle)
                if loading && chapters.isEmpty {
                    Spacer(); ProgressView().tint(Theme.accent); Spacer()
                } else if let err {
                    errorView(err)
                } else if chapters.isEmpty {
                    emptyView(icon: "doc.text", msg: "暂无章节数据")
                } else {
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(Array(chapters.enumerated()), id: \.offset) { _, ch in
                                chapterRow(ch)
                            }
                        }.padding(.horizontal, 16).padding(.bottom, 24)
                    }
                }
            }
        }
        .presentationDetents([.large])
        .presentationBackground(Theme.bg)
        .task { await load() }
        .sheet(isPresented: $showReader) {
            if let ch = selectedChapter {
                ChapterReaderSheet(scriptId: scriptId, chapter: ch).environmentObject(store)
            }
        }
    }

    private func chapterRow(_ ch: [String: Any]) -> some View {
        let idx = ch["index"] as? Int ?? 0
        let title = ch["title"] as? String ?? "第\(idx)章"
        let wc = ch["word_count"] as? Int ?? 0
        let summary = ch["summary"] as? String ?? ""

        return Button {
            selectedChapter = ch
            showReader = true
        } label: {
            HStack(spacing: 13) {
                Text("\(idx)").font(Theme.ui(13, .semibold)).foregroundStyle(Theme.accent)
                    .frame(width: 32, alignment: .trailing).monospacedDigit()
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(Theme.ui(14.5, .medium)).foregroundStyle(Theme.text).lineLimit(1)
                    if !summary.isEmpty {
                        Text(summary).font(Theme.ui(11.5)).foregroundStyle(Theme.muted).lineLimit(2)
                    }
                    if wc > 0 {
                        Text(locWordCount(wc)).font(Theme.ui(11)).foregroundStyle(Theme.muted2)
                    }
                }
                Spacer()
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.muted2)
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .background(RoundedRectangle(cornerRadius: 13).fill(Theme.panel))
            .overlay(RoundedRectangle(cornerRadius: 13).stroke(Theme.line, lineWidth: 1))
            .contentShape(Rectangle())
        }.buttonStyle(.plain)
    }

    private func load() async {
        loading = true; err = nil
        defer { loading = false }
        do { chapters = try await store.api.scriptChapters(base: store.serverURL, id: scriptId) }
        catch { self.err = (error as? LocalizedError)?.errorDescription ?? "加载失败" }
    }
}

// 章节正文阅读器
struct ChapterReaderSheet: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let scriptId: Int
    let chapter: [String: Any]

    @State private var content = ""
    @State private var loading = true

    private var chapterIndex: Int { chapter["index"] as? Int ?? 0 }
    private var chapterTitle: String { chapter["title"] as? String ?? "第\(chapterIndex)章" }

    var body: some View {
        ZStack {
            WarmBackground()
            VStack(spacing: 0) {
                sheetHeader(title: chapterTitle, sub: "第\(chapterIndex)章")
                if loading {
                    Spacer(); ProgressView().tint(Theme.accent); Spacer()
                } else {
                    ScrollView {
                        Text(content.isEmpty ? tr("(暂无正文)") : content)
                            .font(Theme.serif(15))
                            .foregroundStyle(content.isEmpty ? Theme.muted2 : Theme.text)
                            .lineSpacing(6)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                            .padding(.horizontal, 20).padding(.vertical, 16)
                    }
                }
            }
        }
        .presentationDetents([.large])
        .presentationBackground(Theme.bg)
        .task {
            let detail = await store.api.scriptChapterDetail(base: store.serverURL, id: scriptId, index: chapterIndex)
            content = (detail["content"] as? String) ?? (detail["text"] as? String) ?? ""
            loading = false
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 时间线
// ─────────────────────────────────────────────────────────────────────────────
struct ScriptTimelineSheet: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let scriptId: Int
    let scriptTitle: String

    @State private var data: [String: Any] = [:]
    @State private var loading = false
    @State private var err: String?

    private var anchors: [[String: Any]] { data["anchors"] as? [[String: Any]] ?? [] }
    private var phases: [[String: Any]] { data["phases"] as? [[String: Any]] ?? [] }

    var body: some View {
        ZStack {
            WarmBackground()
            VStack(spacing: 0) {
                sheetHeader(title: "时间线", sub: scriptTitle)
                if loading {
                    Spacer(); ProgressView().tint(Theme.accent); Spacer()
                } else if let err {
                    errorView(err)
                } else if anchors.isEmpty && phases.isEmpty {
                    emptyView(icon: "clock.arrow.2.circlepath", msg: "暂无时间线数据")
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            if !phases.isEmpty {
                                sectionLabel("阶段")
                                LazyVStack(spacing: 8) {
                                    ForEach(Array(phases.enumerated()), id: \.offset) { _, ph in
                                        phaseRow(ph)
                                    }
                                }.padding(.horizontal, 16)
                            }
                            if !anchors.isEmpty {
                                sectionLabel("锚点")
                                LazyVStack(spacing: 8) {
                                    ForEach(Array(anchors.enumerated()), id: \.offset) { _, a in
                                        anchorRow(a)
                                    }
                                }.padding(.horizontal, 16)
                            }
                        }.padding(.bottom, 24)
                    }
                }
            }
        }
        .presentationDetents([.large])
        .presentationBackground(Theme.bg)
        .task { await load() }
    }

    private func sectionLabel(_ t: String) -> some View {
        Text(loc: t).font(Theme.ui(11, .semibold)).foregroundStyle(Theme.accent).tracking(1.2)
            .padding(.horizontal, 18).padding(.top, 16).padding(.bottom, 8)
    }

    private func anchorRow(_ a: [String: Any]) -> some View {
        let label = (a["label"] as? String) ?? (a["title"] as? String) ?? (a["name"] as? String) ?? "—"
        let chMin = a["chapter_min"] as? Int
        let chMax = a["chapter_max"] as? Int
        let chap = a["chapter"] as? Int
        let kind = a["kind"] as? String ?? ""
        let chDisplay: String = {
            if let ch = chap { return "第\(ch)章" }
            if let lo = chMin, let hi = chMax { return lo == hi ? "第\(lo)章" : "第\(lo)–\(hi)章" }
            if let lo = chMin { return "第\(lo)章~" }
            return ""
        }()

        return HStack(alignment: .top, spacing: 12) {
            // Timeline dot
            VStack(spacing: 0) {
                Circle().fill(Theme.accent).frame(width: 8, height: 8).padding(.top, 6)
                Rectangle().fill(Theme.line).frame(width: 1).frame(maxHeight: .infinity)
            }.frame(width: 8)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(label).font(Theme.ui(14, .medium)).foregroundStyle(Theme.text)
                    Spacer()
                    if !chDisplay.isEmpty {
                        Text(chDisplay).font(Theme.ui(11, .semibold)).foregroundStyle(Theme.accent)
                            .padding(.horizontal, 7).padding(.vertical, 2).background(Capsule().fill(Theme.accentSoft))
                    }
                }
                if !kind.isEmpty {
                    Text(kind).font(Theme.ui(11.5)).foregroundStyle(Theme.muted)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.panel))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line, lineWidth: 1))
        }
    }

    private func phaseRow(_ ph: [String: Any]) -> some View {
        let label = (ph["label"] as? String) ?? (ph["title"] as? String) ?? (ph["name"] as? String) ?? "—"
        let chMin = ph["chapter_min"] as? Int
        let chMax = ph["chapter_max"] as? Int
        let chDisplay: String = {
            if let lo = chMin, let hi = chMax { return lo == hi ? "第\(lo)章" : "第\(lo)–\(hi)章" }
            if let lo = chMin { return "第\(lo)章~" }
            return ""
        }()
        let desc = (ph["description"] as? String) ?? (ph["summary"] as? String) ?? ""

        return VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(label).font(Theme.ui(14, .medium)).foregroundStyle(Theme.text)
                Spacer()
                if !chDisplay.isEmpty {
                    Text(chDisplay).font(Theme.ui(11, .semibold)).foregroundStyle(Theme.muted)
                        .padding(.horizontal, 7).padding(.vertical, 2).background(Capsule().fill(Theme.panel2))
                }
            }
            if !desc.isEmpty {
                Text(desc).font(Theme.ui(12.5)).foregroundStyle(Theme.muted).lineSpacing(2)
            }
        }
        .padding(.horizontal, 13).padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 13).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 13).stroke(Theme.line, lineWidth: 1))
    }

    private func load() async {
        loading = true; err = nil
        defer { loading = false }
        data = await store.api.scriptTimeline(base: store.serverURL, id: scriptId)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 版本历史
// ─────────────────────────────────────────────────────────────────────────────
struct ScriptVersionsSheet: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let scriptId: Int
    let scriptTitle: String
    let isOwned: Bool

    @State private var commits: [[String: Any]] = []
    @State private var loading = false
    @State private var err: String?
    @State private var checkingOut: String?   // commit_id in progress
    @State private var confirmCommit: [String: Any]?   // commit awaiting confirmation
    @State private var doneMsg: String?

    var body: some View {
        ZStack {
            WarmBackground()
            VStack(spacing: 0) {
                sheetHeader(title: "版本历史", sub: scriptTitle)
                if loading && commits.isEmpty {
                    Spacer(); ProgressView().tint(Theme.accent); Spacer()
                } else if let err {
                    errorView(err)
                } else if commits.isEmpty {
                    emptyView(icon: "arrow.uturn.backward.circle", msg: "暂无提交记录")
                } else {
                    if let doneMsg {
                        HStack(spacing: 8) {
                            Image(systemName: "checkmark.circle.fill").font(.system(size: 14)).foregroundStyle(Theme.accent)
                            Text(doneMsg).font(Theme.ui(13)).foregroundStyle(Theme.accent)
                        }
                        .padding(.horizontal, 18).padding(.vertical, 10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.accentSoft)
                    }
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(Array(commits.enumerated()), id: \.offset) { i, c in
                                commitRow(c, isFirst: i == 0)
                            }
                        }.padding(.horizontal, 16).padding(.bottom, 24)
                    }
                }
            }
        }
        .presentationDetents([.large])
        .presentationBackground(Theme.bg)
        .task { await load() }
        .alert(tr("回滚到此版本?"), isPresented: Binding(get: { confirmCommit != nil }, set: { if !$0 { confirmCommit = nil } })) {
            Button(tr("取消"), role: .cancel) { confirmCommit = nil }
            Button(tr("回滚"), role: .destructive) {
                if let c = confirmCommit { Task { await checkout(c) } }
            }
        } message: {
            let msg = confirmCommit.flatMap { $0["message"] as? String } ?? "此提交"
            Text("将回滚到：\(msg)\n此操作不可撤销。")
        }
    }

    private func commitRow(_ c: [String: Any], isFirst: Bool) -> some View {
        let message = c["message"] as? String ?? "—"
        let commitId = (c["commit_id"] as? String) ?? (c["id"] as? String) ?? ""
        let shortId = String(commitId.prefix(8))
        let createdAt = c["created_at"] as? String ?? ""
        let shortDate = String(createdAt.prefix(10))
        let isCurrent = isFirst

        return HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text(message).font(Theme.ui(14, .medium)).foregroundStyle(Theme.text).lineLimit(2)
                    if isCurrent {
                        Text(loc: "当前").font(Theme.ui(9.5, .semibold)).foregroundStyle(Theme.onAccent)
                            .padding(.horizontal, 6).padding(.vertical, 2).background(Capsule().fill(Theme.accent))
                    }
                }
                HStack(spacing: 8) {
                    Text(shortId).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.muted2)
                    if !shortDate.isEmpty {
                        Text(shortDate).font(Theme.ui(11)).foregroundStyle(Theme.muted2)
                    }
                }
            }
            Spacer()
            if !commitId.isEmpty {
                if checkingOut == commitId {
                    ProgressView().tint(Theme.accent).scaleEffect(0.8).padding(.top, 4)
                } else if !isCurrent {
                    Button {
                        confirmCommit = c
                    } label: {
                        Text(loc: "回滚").font(Theme.ui(12, .medium)).foregroundStyle(Theme.danger)
                            .padding(.horizontal, 11).padding(.vertical, 6)
                            .background(RoundedRectangle(cornerRadius: 8).stroke(Theme.danger.opacity(0.4), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .disabled(store.demo)
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(RoundedRectangle(cornerRadius: 13).fill(isCurrent ? Theme.accentSoft : Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 13).stroke(isCurrent ? Theme.accentEdge : Theme.line, lineWidth: 1))
    }

    private func checkout(_ c: [String: Any]) async {
        if store.demo { return }
        let commitId = (c["commit_id"] as? String) ?? (c["id"] as? String) ?? ""
        guard !commitId.isEmpty else { return }
        confirmCommit = nil
        checkingOut = commitId
        defer { checkingOut = nil }
        do {
            try await store.api.scriptCheckout(base: store.serverURL, id: scriptId, commitId: commitId)
            doneMsg = "已回滚到：\(c["message"] as? String ?? commitId)"
            await load()   // refresh list so new HEAD is marked current
        } catch {
            // surface error via doneMsg (reuse same slot with error styling not needed here, simplicity)
            doneMsg = (error as? LocalizedError)?.errorDescription ?? "回滚失败"
        }
    }

    private func load() async {
        loading = true; err = nil
        defer { loading = false }
        do { commits = try await store.api.scriptCommits(base: store.serverURL, id: scriptId) }
        catch { self.err = (error as? LocalizedError)?.errorDescription ?? "加载失败" }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 共用小组件(仅 ScriptsView.swift 内使用)
// ─────────────────────────────────────────────────────────────────────────────
/// 统一 sheet 标题栏(拖拽指示 + 标题 + 副标题 + 关闭)
private struct ScriptSheetHeader: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let sub: String
    var body: some View {
        VStack(spacing: 0) {
            RoundedRectangle(cornerRadius: 3).fill(Theme.line).frame(width: 36, height: 4)
                .frame(maxWidth: .infinity).padding(.top, 10).padding(.bottom, 12)
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(loc: title).font(Theme.serif(20, .semibold)).foregroundStyle(Theme.text)
                    if !sub.isEmpty {
                        Text(sub).font(Theme.ui(12)).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                }
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName: "xmark").font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.muted).frame(width: 32, height: 32)
                        .background(Circle().fill(Theme.panel2))
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .accessibilityLabel(Text(loc: "关闭"))
            }
            .padding(.horizontal, 18).padding(.bottom, 12)
            Rectangle().fill(Theme.line).frame(height: 1)
        }
    }
}

// Free function wrapper so call sites use sheetHeader(…) without needing to name the struct.
@ViewBuilder private func sheetHeader(title: String, sub: String) -> some View {
    ScriptSheetHeader(title: title, sub: sub)
}

@ViewBuilder private func errorView(_ msg: String) -> some View {
    VStack(spacing: 10) {
        Spacer()
        Image(systemName: "exclamationmark.triangle").font(.system(size: 36)).foregroundStyle(Theme.muted2)
        Text(msg).font(Theme.ui(13)).foregroundStyle(Theme.danger).multilineTextAlignment(.center)
        Spacer()
    }.frame(maxWidth: .infinity).padding(.horizontal, 24)
}

@ViewBuilder private func emptyView(icon: String, msg: String) -> some View {
    VStack(spacing: 12) {
        Spacer()
        Image(systemName: icon).font(.system(size: 40)).foregroundStyle(Theme.muted2)
        Text(loc: msg).font(Theme.ui(14)).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
        Spacer()
    }.frame(maxWidth: .infinity).padding(.horizontal, 24)
}
