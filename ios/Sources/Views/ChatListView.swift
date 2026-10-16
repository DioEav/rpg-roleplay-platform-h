import SwiftUI

struct ChatListView: View {
    @EnvironmentObject var store: AppStore
    @State private var chats: [TavernChat] = []
    @State private var loading = true
    @State private var error: String?
    @State private var creating = false
    @State private var showServer = false
    @State private var path: [Int] = []
    @State private var renameTarget: TavernChat?
    @State private var renameText = ""
    @State private var showRename = false

    var body: some View {
        NavigationStack(path: $path) {
            ZStack {
                WarmBackground()
                VStack(spacing: 0) {
                    header
                    content
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Int.self) { id in
                ChatView(chatId: id).environmentObject(store)
            }
            .sheet(isPresented: $showServer) { QuickSettingsSheet() }
            .alert("重命名对话", isPresented: $showRename) {
                TextField("标题", text: $renameText)
                Button("取消", role: .cancel) {}
                Button("保存") { Task { await doRename() } }
            }
            .task {
                await reload()
                if let raw = ProcessInfo.processInfo.environment["MEADHALL_OPEN_CHAT"],
                   let id = Int(raw), path.isEmpty { path.append(id) }
            }
        }
    }

    // 自定义品牌头(对齐原型)
    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            Button { showServer = true } label: {
                Image(systemName: "gearshape").font(.system(size: 18)).foregroundStyle(Theme.textQuiet)
                    .frame(width: 38, height: 38)
            }
            VStack(alignment: .leading, spacing: 3) {
                (Text("Meadhall").foregroundStyle(Theme.text)
                 + Text(".").foregroundStyle(Theme.accent))
                    .font(Theme.serif(27, .semibold))
                Text("在故事里,和他们对话").font(Theme.ui(11.5)).foregroundStyle(Theme.muted)
                    .tracking(0.5)
            }
            Spacer()
            Button(action: newChat) {
                Group {
                    if creating { ProgressView().tint(Theme.accent) }
                    else { Image(systemName: "plus").font(.system(size: 19)) }
                }
                .foregroundStyle(Theme.accent).frame(width: 40, height: 40)
                .background(Circle().fill(Theme.accentSoft))
                .overlay(Circle().stroke(Theme.accentEdge, lineWidth: 1))
            }.disabled(creating)
        }
        .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 12)
    }

    @ViewBuilder
    private var content: some View {
        if loading && chats.isEmpty {
            Spacer(); ProgressView().tint(Theme.accent); Spacer()
        } else if chats.isEmpty {
            emptyState
        } else {
            ScrollView {
                LazyVStack(spacing: 0) {
                    if let error { Text(error).font(Theme.ui(13)).foregroundStyle(Theme.danger).padding(16) }
                    ForEach(Array(chats.enumerated()), id: \.element.id) { idx, chat in
                        Button { path.append(chat.id) } label: { row(chat) }.buttonStyle(.plain)
                            .contextMenu {
                                Button { startRename(chat) } label: { Label("重命名", systemImage: "pencil") }
                                Button { Task { await archive(chat) } } label: { Label("归档", systemImage: "archivebox") }
                                Button(role: .destructive) { Task { await remove(chat) } } label: { Label("删除", systemImage: "trash") }
                            }
                        if idx < chats.count - 1 {
                            Rectangle().fill(Theme.lineSoft).frame(height: 1).padding(.leading, 72)
                        }
                    }
                }
                .padding(.bottom, 24)
            }
            .refreshable { await reload() }
        }
    }

    private func row(_ chat: TavernChat) -> some View {
        let blank = (chat.characterName ?? "").isEmpty
        return HStack(spacing: 13) {
            ZStack {
                Circle().fill(blank ? Theme.panel2 : Theme.accentSoft)
                Circle().stroke(blank ? Theme.line : Theme.accentEdge, lineWidth: 1)
                if blank {
                    Image(systemName: "plus").font(.system(size: 16)).foregroundStyle(Theme.muted)
                } else {
                    Text(String((chat.characterName ?? chat.displayTitle).prefix(1)))
                        .font(Theme.serif(19)).foregroundStyle(Theme.accent)
                }
            }
            .frame(width: 46, height: 46)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(chat.displayTitle).font(Theme.ui(15.5, .medium)).foregroundStyle(Theme.text).lineLimit(1)
                    Spacer()
                    Text(relTime(chat.updatedAt)).font(Theme.ui(10.5)).foregroundStyle(Theme.muted2).monospacedDigit()
                }
                Text(chat.lastSnippet ?? (chat.characterName ?? "新对话"))
                    .font(Theme.serif(13)).italic().foregroundStyle(Theme.muted).lineLimit(1)
            }
        }
        .padding(.horizontal, 18).padding(.vertical, 14)
        .contentShape(Rectangle())
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Spacer()
            Image(systemName: "bubble.left.and.bubble.right").font(.system(size: 44)).foregroundStyle(Theme.muted2)
            Text("还没有对话").font(Theme.serif(19)).foregroundStyle(Theme.textQuiet)
            Text("新建一个,直接开聊。").font(Theme.ui(13.5)).foregroundStyle(Theme.muted)
            Button(action: newChat) {
                Label("新建对话", systemImage: "plus").font(Theme.ui(14.5, .medium))
                    .foregroundStyle(Theme.onAccent).padding(.horizontal, 18).padding(.vertical, 11)
                    .background(Theme.accent, in: Capsule())
            }.padding(.top, 4)
            Spacer(); Spacer()
        }.frame(maxWidth: .infinity)
    }

    private func relTime(_ s: String?) -> String {
        guard let s, !s.isEmpty else { return "" }
        return String(s.prefix(10))
    }

    private func reload() async {
        loading = true; error = nil
        defer { loading = false }
        if store.demo { chats = DemoData.chats; return }
        do { chats = try await store.api.tavernList(base: store.serverURL) }
        catch { self.error = (error as? LocalizedError)?.errorDescription ?? "加载失败" }
    }

    private func startRename(_ chat: TavernChat) {
        renameTarget = chat; renameText = chat.displayTitle; showRename = true
    }
    private func doRename() async {
        guard let chat = renameTarget else { return }
        let title = renameText.trimmingCharacters(in: .whitespaces)
        guard !title.isEmpty else { return }
        if store.demo { mutateLocal(chat.id) { TavernChat(id: $0.id, title: title, characterName: $0.characterName, lastSnippet: $0.lastSnippet, updatedAt: $0.updatedAt) }; return }
        do { try await store.api.renameChat(base: store.serverURL, id: chat.id, title: title); await reload() } catch {}
    }
    private func archive(_ chat: TavernChat) async {
        if store.demo { chats.removeAll { $0.id == chat.id }; return }
        do { try await store.api.archiveChat(base: store.serverURL, id: chat.id, archived: true); await reload() } catch {}
    }
    private func remove(_ chat: TavernChat) async {
        if store.demo { chats.removeAll { $0.id == chat.id }; return }
        do { try await store.api.deleteChat(base: store.serverURL, id: chat.id); await reload() } catch {}
    }
    private func mutateLocal(_ id: Int, _ f: (TavernChat) -> TavernChat) {
        if let i = chats.firstIndex(where: { $0.id == id }) { chats[i] = f(chats[i]) }
    }

    private func newChat() {
        if store.demo { path.append(3); return }
        creating = true
        Task {
            defer { creating = false }
            do {
                let id = try await store.api.tavernCreateBlank(base: store.serverURL)
                await reload(); path.append(id)
            } catch { self.error = (error as? LocalizedError)?.errorDescription ?? "新建失败" }
        }
    }
}
