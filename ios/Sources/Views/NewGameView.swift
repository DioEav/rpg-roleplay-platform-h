import SwiftUI

// 新游戏向导 —— 对齐 web MobileNewGame:出生点 → 角色 → 出身与引导 → 故事意图/确认。
// 把核心建档选择(贴原著/引导强度、出生点、角色、穿越出身)交给玩家,而非"快速开始"默认档。
struct NewGameView: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let scriptId: Int
    let scriptTitle: String

    @State private var step = 0
    @State private var birthpoints: [Birthpoint] = []
    @State private var selectedBp: String?
    @State private var cards: [CharacterCardItem] = []
    @State private var charMode = 0          // 0 选已有 / 1 新建
    @State private var selectedCard: Int?
    @State private var newName = ""
    @State private var newRole = ""
    @State private var newBg = ""
    @State private var origin = "native"
    @State private var steering = "guided"
    @State private var foreknowledge = "none"
    // npc_awareness / spoiler_guard 已下架(死设置,后端零读取点),不再收集。
    @State private var storyIntent = ""
    @State private var saveName = ""
    @State private var loading = true
    @State private var creating = false
    @State private var err: String?

    private let steps = ["出生点", "角色", "出身与引导", "确认"]

    var body: some View {
        NavigationStack {
            ZStack {
                WarmBackground()
                VStack(spacing: 0) {
                    progressBar
                    ScrollView {
                        VStack(alignment: .leading, spacing: 18) {
                            switch step {
                            case 0: stepBirthpoint
                            case 1: stepCharacter
                            case 2: stepOriginSteering
                            default: stepConfirm
                            }
                        }.padding(16).padding(.bottom, 20)
                    }
                    bottomBar
                }
            }
            .navigationTitle("新游戏 · \(scriptTitle)").navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bg, for: .navigationBar).toolbarBackground(.visible, for: .navigationBar)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.foregroundStyle(Theme.textQuiet) } }
            .task {
                await load()
                if let s = ProcessInfo.processInfo.environment["MEADHALL_WIZSTEP"], let n = Int(s) { step = n }
            }
        }
    }

    private var progressBar: some View {
        HStack(spacing: 6) {
            ForEach(steps.indices, id: \.self) { i in
                VStack(spacing: 4) {
                    Capsule().fill(i <= step ? Theme.accent : Theme.line).frame(height: 3)
                    Text(steps[i]).font(Theme.ui(10.5, i == step ? .semibold : .regular))
                        .foregroundStyle(i == step ? Theme.accent : Theme.muted2)
                }
            }
        }.padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 6)
    }

    // MARK: 步骤 0 出生点
    @ViewBuilder private var stepBirthpoint: some View {
        sectionTitle("从哪里开始", "选择故事的切入点(时间线锚点)。")
        if loading { ProgressView().tint(Theme.accent).frame(maxWidth: .infinity).padding(.vertical, 20) }
        else if birthpoints.isEmpty {
            Text("这个剧本没有可选出生点,将从序章开始。").font(Theme.ui(13)).foregroundStyle(Theme.muted)
        } else {
            ForEach(birthpoints) { bp in
                pickRow(title: bp.label, sub: bp.sub, detail: bp.summary, selected: selectedBp == bp.anchorId) {
                    selectedBp = bp.anchorId
                }
            }
        }
    }

    // MARK: 步骤 1 角色
    @ViewBuilder private var stepCharacter: some View {
        sectionTitle("你扮演谁", "选一张已有角色卡,或新建一个。")
        seg(["0": "选择已有", "1": "新建角色"], order: ["0", "1"], sel: "\(charMode)") { charMode = Int($0) ?? 0 }
        if charMode == 0 {
            if cards.isEmpty { Text("还没有角色卡。可切到「新建角色」。").font(Theme.ui(13)).foregroundStyle(Theme.muted) }
            else {
                ForEach(cards) { c in
                    pickRow(title: c.display, sub: c.subtitle, detail: nil, selected: selectedCard == c.id) { selectedCard = c.id }
                }
            }
        } else {
            field("名字", text: $newName, placeholder: "角色名")
            field("身份 / 角色", text: $newRole, placeholder: "如:流浪的旅人")
            fieldMulti("背景设定", text: $newBg, placeholder: "简述这个角色的来历(可选)")
        }
    }

    // MARK: 步骤 2 出身与引导
    @ViewBuilder private var stepOriginSteering: some View {
        sectionTitle("出身", "你以什么方式来到这个世界。")
        seg(["soul": "灵魂穿越", "body": "整体穿越", "dual": "双魂同体", "native": "本世界人"],
            order: ["soul", "body", "dual", "native"], sel: origin) { origin = $0 }
        sectionTitle("引导强度", "rail=贴原著重现 / guided=软引导 / free=自由发挥。")
        seg(["rail": "贴原著", "guided": "软引导", "free": "自由"], order: ["rail", "guided", "free"], sel: steering) { steering = $0 }
        sectionTitle("元知识", nil)
        rowLabel("你对剧情的了解")
        seg(["none": "一无所知", "partial": "略知一二", "omniscient": "全知"], order: ["none", "partial", "omniscient"], sel: foreknowledge) { foreknowledge = $0 }
    }

    // MARK: 步骤 3 确认
    @ViewBuilder private var stepConfirm: some View {
        sectionTitle("故事意图", "你想让这段故事往哪个方向走?(可选)")
        fieldMulti("", text: $storyIntent, placeholder: "如:我想活下去,并找出这个世界崩坏的真相。")
        sectionTitle("存档名", nil)
        field("", text: $saveName, placeholder: "\(scriptTitle) · \(tr("新游戏"))")
        summaryCard
        if let err { Text(err).font(Theme.ui(13)).foregroundStyle(Theme.danger) }
    }

    private var summaryCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            kv("出生点", birthpoints.first { $0.anchorId == selectedBp }?.label ?? "序章")
            kv("角色", charMode == 0 ? (cards.first { $0.id == selectedCard }?.display ?? "未选") : (newName.isEmpty ? "新建(未命名)" : newName))
            kv("出身", originLabel(origin))
            kv("引导", steeringLabel(steering))
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
    }

    // MARK: 底部导航
    private var bottomBar: some View {
        HStack(spacing: 10) {
            if step > 0 {
                Button { withAnimation { step -= 1 } } label: {
                    Text("上一步").font(Theme.ui(15, .medium)).foregroundStyle(Theme.text)
                        .frame(maxWidth: .infinity).padding(.vertical, 13)
                        .background(Theme.panel2, in: Capsule()).overlay(Capsule().stroke(Theme.line, lineWidth: 1))
                }
            }
            if step < steps.count - 1 {
                Button { withAnimation { step += 1 } } label: {
                    Text("下一步").font(Theme.ui(15, .semibold)).foregroundStyle(Theme.onAccent)
                        .frame(maxWidth: .infinity).padding(.vertical, 13).background(Theme.accent, in: Capsule())
                }
            } else {
                Button { Task { await create() } } label: {
                    HStack(spacing: 6) { if creating { ProgressView().tint(Theme.onAccent).scaleEffect(0.8) }
                        Text(loc: creating ? "创建中…" : "开始游戏").font(Theme.ui(15, .semibold)) }
                    .foregroundStyle(Theme.onAccent).frame(maxWidth: .infinity).padding(.vertical, 13).background(Theme.accent, in: Capsule())
                }.disabled(creating)
            }
        }.padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 12)
        .background(Theme.bgDeep.opacity(0.7))
    }

    // MARK: 组件
    private func sectionTitle(_ t: String, _ sub: String?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(loc: t).font(Theme.serif(17, .semibold)).foregroundStyle(Theme.text)
            if let sub { Text(sub).font(Theme.ui(12)).foregroundStyle(Theme.muted) }
        }.padding(.top, 4)
    }
    private func pickRow(title: String, sub: String, detail: String?, selected: Bool, _ tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle").font(.system(size: 18))
                    .foregroundStyle(selected ? Theme.accent : Theme.muted2).padding(.top, 1)
                VStack(alignment: .leading, spacing: 3) {
                    Text(loc: title).font(Theme.ui(14.5, .medium)).foregroundStyle(Theme.text)
                    if !sub.isEmpty { Text(sub).font(Theme.ui(11.5)).foregroundStyle(Theme.muted) }
                    if let detail, !detail.isEmpty { Text(detail).font(Theme.ui(11.5)).foregroundStyle(Theme.muted2).lineLimit(2) }
                }
                Spacer()
            }
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12).fill(selected ? Theme.accentSoft : Theme.panel))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(selected ? Theme.accentEdge : Theme.line, lineWidth: 1))
        }.buttonStyle(.plain)
    }
    private func field(_ label: String, text: Binding<String>, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            if !label.isEmpty { Text(loc: label).font(Theme.ui(12.5)).foregroundStyle(Theme.muted) }
            TextField(placeholder, text: text).font(Theme.ui(14)).foregroundStyle(Theme.text).tint(Theme.accent)
                .padding(.horizontal, 11).padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.panel2)).overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line, lineWidth: 1))
        }
    }
    private func fieldMulti(_ label: String, text: Binding<String>, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            if !label.isEmpty { Text(loc: label).font(Theme.ui(12.5)).foregroundStyle(Theme.muted) }
            ZStack(alignment: .topLeading) {
                if text.wrappedValue.isEmpty { Text(placeholder).font(Theme.ui(14)).foregroundStyle(Theme.muted2).padding(.horizontal, 13).padding(.vertical, 11) }
                TextEditor(text: text).font(Theme.ui(14)).foregroundStyle(Theme.text).tint(Theme.accent).scrollContentBackground(.hidden).padding(7).frame(height: 90)
            }
            .background(RoundedRectangle(cornerRadius: 10).fill(Theme.panel2)).overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line, lineWidth: 1))
        }
    }
    private func kv(_ k: String, _ v: String) -> some View {
        HStack { Text(k).font(Theme.ui(12.5)).foregroundStyle(Theme.muted).frame(width: 64, alignment: .leading)
            Text(v).font(Theme.ui(13)).foregroundStyle(Theme.text); Spacer() }
    }
    private func originLabel(_ o: String) -> String { ["soul": "灵魂穿越", "body": "整体穿越", "dual": "双魂同体", "native": "本世界人"][o] ?? o }
    private func steeringLabel(_ s: String) -> String { ["rail": "贴原著", "guided": "软引导", "free": "自由"][s] ?? s }

    // MARK: 逻辑
    private func load() async {
        loading = true; defer { loading = false }
        if store.demo {
            birthpoints = [Birthpoint(anchorId: "demo1", label: "序章 · 觉醒", phase: "第一卷", chapterMin: 1, chapterMax: 1, summary: "你在陌生的世界里醒来。")]
            cards = []; selectedBp = "demo1"; return
        }
        birthpoints = await store.api.birthpoints(base: store.serverURL, scriptId: scriptId)
        selectedBp = birthpoints.first?.anchorId
        cards = (try? await store.api.characterCards(base: store.serverURL)) ?? []
    }

    private func create() async {
        creating = true; err = nil; defer { creating = false }
        let title = saveName.trimmingCharacters(in: .whitespaces).isEmpty ? "\(scriptTitle) · \(tr("新游戏"))" : saveName.trimmingCharacters(in: .whitespaces)
        if store.demo { dismiss(); if let s = DemoData.saves.first { await store.launchGame(s) }; return }
        // /api/saves 建档 body(对齐 web __createAndEnterSave):出生点为 dict、角色走 character_id/new_card、
        // 引导/元知识等「设置」不在建档 body 里,建档后另发 PATCH /settings(is_create=true)。
        var body: [String: Any] = ["title": title, "script_id": scriptId, "player_origin": origin]
        if let bp = birthpoints.first(where: { $0.anchorId == selectedBp }), let aid = Int(bp.anchorId) {
            var d: [String: Any] = ["anchor_id": aid, "phase_label": bp.phase, "story_time_label": bp.label]
            if let cm = bp.chapterMin { d["chapter_min"] = cm }
            if let cx = bp.chapterMax { d["chapter_max"] = cx }
            body["birthpoint"] = d
        }
        if charMode == 0, let cid = selectedCard {
            body["character_id"] = cid; body["character_kind"] = "user_card"
        } else if charMode == 1 {
            var nc: [String: Any] = [:]
            if !newName.isEmpty { nc["name"] = newName }
            if !newRole.isEmpty { nc["role"] = newRole }
            if !newBg.isEmpty { nc["background"] = newBg }
            if !nc.isEmpty { body["new_card"] = nc }
        }
        let intent = storyIntent.trimmingCharacters(in: .whitespacesAndNewlines)
        if !intent.isEmpty { body["story_intent"] = intent }
        do {
            let saveId = try await store.api.newGame(base: store.serverURL, body: body)
            // 应用引导强度/元知识(建档项)。npc_awareness/spoiler_guard 已下架(死设置)。
            await store.api.saveSettings(base: store.serverURL, saveId: saveId, updates: [
                "steering_strength": steering, "foreknowledge_mode": foreknowledge,
            ], isCreate: true)
            // 进入前必须激活存档(加载运行时 + 设为当前),否则游戏台 /api/state 无活动运行时。
            // 激活失败必须上报并中止:否则玩家进游戏台时服务端无运行时,首屏空白/报错。
            do { try await store.api.activateSave(base: store.serverURL, id: saveId) }
            catch { self.err = (error as? LocalizedError)?.errorDescription ?? "激活存档失败"; return }
            dismiss()
            store.openGame(id: saveId, title: title, scriptTitle: scriptTitle)
        } catch { self.err = (error as? LocalizedError)?.errorDescription ?? "创建失败" }
    }
}
