import SwiftUI
import UniformTypeIdentifiers

// 技能 / 人格 skill —— 对齐 web Skill 页:导入角色扮演「人格 skill」(skill.md 上传 / GitHub 拉取)
// → 后端蒸馏成可见角色卡 + 人设图(/api/me/persona-skills);纯数据、每用户隔离。
struct SkillsView: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss

    @State private var items: [PersonaSkillItem] = []
    @State private var loading = true
    @State private var showImport = false
    @State private var repoUrl = ""
    @State private var importing = false
    @State private var showFile = false
    @State private var msg: String?
    @State private var deleteTarget: PersonaSkillItem?

    var body: some View {
        NavigationStack {
            ZStack {
                WarmBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        Text("把角色扮演「人格 skill」(skill.md 或 GitHub 公开仓库)导入,自动蒸馏成可见角色卡 + 人设图,进角色库随处可用。")
                            .font(Theme.ui(12.5)).foregroundStyle(Theme.muted).lineSpacing(3)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Button { showImport = true } label: {
                            Label("导入人格 skill", systemImage: "square.and.arrow.down")
                                .font(Theme.ui(14.5, .semibold)).foregroundStyle(Theme.onAccent)
                                .frame(maxWidth: .infinity).padding(.vertical, 12).background(Theme.accent, in: Capsule())
                        }.disabled(store.demo)
                        if store.demo {
                            Text("演示模式不可导入;登录后可填 GitHub 链接或上传 .md。").font(Theme.ui(11.5)).foregroundStyle(Theme.muted2)
                        }
                        Text("我的人格 skill").font(Theme.ui(11, .semibold)).foregroundStyle(Theme.accent).tracking(1.2).padding(.top, 4)
                        if loading {
                            ProgressView().tint(Theme.accent).frame(maxWidth: .infinity).padding(.vertical, 20)
                        } else if items.isEmpty {
                            VStack(spacing: 8) {
                                Image(systemName: "spark").font(.system(size: 30)).foregroundStyle(Theme.muted2)
                                Text("还没有导入的人格 skill。").font(Theme.ui(13)).foregroundStyle(Theme.muted)
                            }.frame(maxWidth: .infinity).padding(.vertical, 30)
                        } else {
                            ForEach(items) { it in row(it) }
                        }
                    }.padding(16)
                }
            }
            .navigationTitle("技能").navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bg, for: .navigationBar).toolbarBackground(.visible, for: .navigationBar)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() }.foregroundStyle(Theme.accent) } }
            .task { await load(); if ProcessInfo.processInfo.environment["MEADHALL_SKILL_IMPORT"] == "1" { showImport = true } }
            .sheet(isPresented: $showImport) { importSheet }
            .fileImporter(isPresented: $showFile,
                          allowedContentTypes: [UTType(filenameExtension: "md") ?? .plainText, .plainText, .text],
                          allowsMultipleSelection: false) { result in handleFile(result) }
            .confirmationDialog("删除「\(deleteTarget?.display ?? "")」的 skill 登记?(已生成的角色卡保留)",
                                isPresented: Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } }),
                                titleVisibility: .visible, presenting: deleteTarget) { it in
                Button("删除", role: .destructive) { Task { await remove(it) } }
                Button("取消", role: .cancel) {}
            }
            .alert("人格 skill", isPresented: Binding(get: { msg != nil }, set: { if !$0 { msg = nil } })) {
                Button("好") {}
            } message: { Text(msg ?? "") }
        }
    }

    private func row(_ it: PersonaSkillItem) -> some View {
        HStack(spacing: 12) {
            if let a = it.avatar_path, !a.isEmpty, !store.demo {
                ServerImageView(base: store.serverURL, path: a).frame(width: 44, height: 44).clipShape(RoundedRectangle(cornerRadius: 9))
            } else {
                ZStack { RoundedRectangle(cornerRadius: 9).fill(Theme.panel2)
                    Image(systemName: "spark").font(.system(size: 16)).foregroundStyle(Theme.accent) }.frame(width: 44, height: 44)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(it.display).font(Theme.ui(14, .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                Text("\(it.sourceLabel) · 已生成角色卡").font(Theme.ui(11)).foregroundStyle(Theme.muted2)
            }
            Spacer()
            Button { deleteTarget = it } label: { Image(systemName: "trash").font(.system(size: 14)).foregroundStyle(Theme.danger) }
                .disabled(store.demo)
        }
        .padding(11).background(RoundedRectangle(cornerRadius: 12).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line, lineWidth: 1))
    }

    private var importSheet: some View {
        NavigationStack {
            ZStack {
                WarmBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("GitHub 链接").font(Theme.ui(12.5)).foregroundStyle(Theme.muted)
                            TextField("https://github.com/owner/repo", text: $repoUrl)
                                .font(Theme.ui(13.5)).foregroundStyle(Theme.text).tint(Theme.accent)
                                .autocorrectionDisabled().textInputAutocapitalization(.never).keyboardType(.URL)
                                .padding(.horizontal, 10).padding(.vertical, 10)
                                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.panel2))
                                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line, lineWidth: 1))
                            Text("公开仓库地址,拉取其中 skill.md / 角色档案蒸馏成角色卡 + 人设图。").font(Theme.ui(11)).foregroundStyle(Theme.muted2)
                        }
                        HStack { Rectangle().fill(Theme.lineSoft).frame(height: 1); Text("或").font(Theme.ui(11)).foregroundStyle(Theme.muted2); Rectangle().fill(Theme.lineSoft).frame(height: 1) }
                        Button { showFile = true } label: {
                            Label("选择 .md 文件", systemImage: "doc").font(Theme.ui(14)).foregroundStyle(Theme.accent)
                                .frame(maxWidth: .infinity).padding(.vertical, 11)
                                .background(Theme.panel2, in: RoundedRectangle(cornerRadius: 10))
                                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line, lineWidth: 1))
                        }
                        Button { Task { await importGithub() } } label: {
                            HStack(spacing: 6) { if importing { ProgressView().tint(Theme.onAccent).scaleEffect(0.7) }
                                Text(importing ? "导入中…" : "从 GitHub 导入").font(Theme.ui(14.5, .semibold)) }
                            .foregroundStyle(Theme.onAccent).frame(maxWidth: .infinity).padding(.vertical, 12)
                            .background((repoUrl.trimmingCharacters(in: .whitespaces).isEmpty || importing) ? Theme.muted2 : Theme.accent, in: Capsule())
                        }.disabled(repoUrl.trimmingCharacters(in: .whitespaces).isEmpty || importing)
                        Spacer()
                    }.padding(16)
                }
            }
            .navigationTitle("导入人格 skill").navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bg, for: .navigationBar).toolbarBackground(.visible, for: .navigationBar)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { showImport = false }.foregroundStyle(Theme.textQuiet) } }
        }
        .presentationDetents([.medium, .large])
    }

    private func load() async {
        loading = true; defer { loading = false }
        if store.demo { items = []; return }
        items = (try? await store.api.personaSkills(base: store.serverURL)) ?? []
    }
    private func importGithub() async {
        let url = repoUrl.trimmingCharacters(in: .whitespaces); guard !url.isEmpty, !store.demo else { return }
        importing = true; defer { importing = false }
        do {
            let r = try await store.api.importPersonaSkill(base: store.serverURL, source: "github", repoUrl: url)
            showImport = false; repoUrl = ""
            await load()
            msg = "已生成角色卡「\(r.cardName)」" + (r.imageStatus == "queued" ? "(人设图生成中)" : "")
        } catch { msg = (error as? LocalizedError)?.errorDescription ?? "导入失败" }
    }
    private func handleFile(_ result: Result<[URL], Error>) {
        guard case .success(let urls) = result, let url = urls.first, !store.demo else { return }
        Task {
            importing = true; defer { importing = false }
            let need = url.startAccessingSecurityScopedResource()
            defer { if need { url.stopAccessingSecurityScopedResource() } }
            guard let content = try? String(contentsOf: url, encoding: .utf8) else { msg = "读取文件失败"; return }
            do {
                let r = try await store.api.importPersonaSkill(base: store.serverURL, source: "upload",
                                                               filename: url.lastPathComponent, content: content)
                showImport = false
                await load()
                msg = "已生成角色卡「\(r.cardName)」" + (r.imageStatus == "queued" ? "(人设图生成中)" : "")
            } catch { msg = (error as? LocalizedError)?.errorDescription ?? "导入失败" }
        }
    }
    private func remove(_ it: PersonaSkillItem) async {
        if store.demo { return }
        do { try await store.api.deletePersonaSkill(base: store.serverURL, id: it.id); await load() }
        catch { msg = (error as? LocalizedError)?.errorDescription ?? "删除失败" }
    }
}
