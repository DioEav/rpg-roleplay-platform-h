import SwiftUI

/// 服务器设置:连官方服务器或用户自建服务器(BYO-server)。
struct ServerSettingsView: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @State private var applying = false
    @State private var showScan = false
    @State private var mode = 0   // 0=在线服务 1=自部署

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.bg.ignoresSafeArea()
                Form {
                    Section {
                        Picker("", selection: $mode) {
                            Text(loc: "在线服务").tag(0); Text(loc: "自部署").tag(1)
                        }.pickerStyle(.segmented)
                            .onChange(of: mode) { _, m in if m == 0 { draft = AppStore.defaultServer } else if draft == AppStore.defaultServer { draft = "" } }
                            .listRowBackground(Theme.bg)
                    } footer: {
                        Text(mode == 0 ? "连接 Meadhall 官方在线服务。" : "连接你自建/他人自建的服务器(同一套后端)。切换服务器会退出当前登录,数据互不相通。")
                            .foregroundStyle(Theme.muted2)
                    }

                    if mode == 0 {
                        Section {
                            HStack(spacing: 12) {
                                Image(systemName: "cloud.fill").font(.system(size: 20)).foregroundStyle(Theme.accent)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("官方在线服务").font(Theme.ui(15, .medium)).foregroundStyle(Theme.text)
                                    Text(URL(string: AppStore.defaultServer)?.host ?? "").font(Theme.ui(12)).foregroundStyle(Theme.muted)
                                }
                                Spacer()
                                if store.serverURL == AppStore.defaultServer { Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.accent) }
                            }.listRowBackground(Theme.panel)
                        }
                    } else {
                        Section {
                            TextField("http://192.168.x.x:7860", text: $draft)
                                .font(Theme.ui(15)).foregroundStyle(Theme.text).tint(Theme.accent)
                                .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                                .listRowBackground(Theme.panel)
                            Button { showScan = true } label: {
                                Label { Text("扫码连接") } icon: { Image(systemName: "qrcode.viewfinder") }
                                    .foregroundStyle(Theme.accent)
                            }.listRowBackground(Theme.panel)
                        } header: {
                            Text("自部署服务器地址").foregroundStyle(Theme.muted)
                        } footer: {
                            Text("在桌面端/自部署服务器打开局域网二维码,扫一下即可连接。")
                                .foregroundStyle(Theme.muted2)
                        }
                    }

                    if store.loggedIn {
                        Section {
                            Button(role: .destructive) {
                                Task { await store.logout(); dismiss() }
                            } label: { Text("退出登录").foregroundStyle(Theme.danger) }
                                .listRowBackground(Theme.panel)
                        }
                    }
                }
                .scrollContentBackground(.hidden)
            }
            .navigationTitle("服务器")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bg, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }.foregroundStyle(Theme.textQuiet)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(applying ? "应用中…" : "保存") { apply() }
                        .foregroundStyle(Theme.accent)
                        .disabled(applying || draft.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear {
                if draft.isEmpty { draft = store.serverURL }
                mode = (store.serverURL == AppStore.defaultServer) ? 0 : 1
                if ProcessInfo.processInfo.environment["MEADHALL_SCAN"] == "1" { showScan = true }
            }
            .fullScreenCover(isPresented: $showScan) {
                QRConnectView { url in
                    draft = url
                    applying = true
                    Task { await store.applyServer(url); applying = false; dismiss() }
                }.environmentObject(store)
            }
        }
    }

    private func apply() {
        applying = true
        Task { await store.applyServer(draft); applying = false; dismiss() }
    }
}
