import SwiftUI

struct LoginView: View {
    @EnvironmentObject var store: AppStore
    @State private var username = ""
    @State private var password = ""
    @State private var showServer = false
    @State private var showScan = false
    @State private var authSheet: AuthSheet?
    @FocusState private var focus: Field?
    enum Field { case user, pass }
    enum AuthSheet: Identifiable { case register, otp, forgot; var id: Int { hashValue } }

    var body: some View {
        ZStack {
            WarmBackground()
            ScrollView {
                VStack(spacing: 0) {
                    HStack {
                        Spacer()
                        Button { showServer = true } label: {
                            Image(systemName: "gearshape").font(.system(size: 18)).foregroundStyle(Theme.textQuiet)
                                .frame(width: 44, height: 44).contentShape(Rectangle())
                        }.accessibilityLabel(Text("服务器设置"))
                    }.padding(.horizontal, 8).padding(.top, 6)

                    Spacer(minLength: 48)
                    VStack(spacing: 12) {
                        Image(systemName: "bubble.left.and.bubble.right.fill")
                            .font(.system(size: 46)).foregroundStyle(Theme.accent)
                        (Text("Meadhall").foregroundStyle(Theme.text)
                         + Text(".").foregroundStyle(Theme.accent))
                            .font(Theme.serif(36, .semibold))
                        // 登录前先选服务器(在线 / 自部署),登录请求即发往所选服务器,不串数据。
                        Button { showServer = true } label: {
                            HStack(spacing: 7) {
                                Image(systemName: isOfficial ? "cloud.fill" : "server.rack").font(.system(size: 11))
                                Text(loc: isOfficial ? "在线服务" : "自部署").font(Theme.ui(12, .semibold))
                                Text(serverHost).font(Theme.ui(11.5)).foregroundStyle(Theme.muted).lineLimit(1)
                                Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.muted2)
                            }
                            .foregroundStyle(Theme.accent)
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(Capsule().fill(Theme.panel)).overlay(Capsule().stroke(Theme.line, lineWidth: 1))
                        }
                    }

                    VStack(spacing: 12) {
                        field(icon: "person", placeholder: "用户名 / 邮箱", isSecure: false) {
                            TextField("", text: $username)
                                .textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                                .focused($focus, equals: .user).submitLabel(.next).onSubmit { focus = .pass }
                        }
                        field(icon: "lock", placeholder: "密码", isSecure: true) {
                            SecureField("", text: $password)
                                .textContentType(.password).focused($focus, equals: .pass)
                                .submitLabel(.go).onSubmit(doLogin)
                        }
                    }.padding(.top, 30)

                    if let err = store.loginError {
                        Text(err).font(Theme.ui(13)).foregroundStyle(Theme.danger)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 12)
                    }

                    Button(action: doLogin) {
                        HStack { if store.working { ProgressView().tint(Theme.onAccent) }
                            Text("登录").font(Theme.ui(16, .semibold)) }
                        .foregroundStyle(Theme.onAccent).frame(maxWidth: .infinity).padding(.vertical, 14)
                        .background(canLogin ? Theme.accent : Theme.panel3, in: RoundedRectangle(cornerRadius: 14))
                    }.disabled(!canLogin || store.working).padding(.top, 18)

                    HStack(spacing: 10) {
                        line; Text("或").font(Theme.ui(12)).foregroundStyle(Theme.muted2); line
                    }.padding(.vertical, 16)

                    Button { store.enterDemo() } label: {
                        Text("体验演示(无需登录)").font(Theme.ui(15, .medium)).foregroundStyle(Theme.textQuiet)
                            .frame(maxWidth: .infinity).padding(.vertical, 13)
                            .background(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
                    }

                    // 扫码登录 / 加入自部署:扫桌面端「登录二维码」免登录进自己的号,或「邀请二维码」注册加入。
                    Button { showScan = true } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "qrcode.viewfinder").font(.system(size: 15))
                            Text(loc: "扫码登录 / 加入自部署").font(Theme.ui(15, .medium))
                        }
                        .foregroundStyle(Theme.accent).frame(maxWidth: .infinity).padding(.vertical, 13)
                        .background(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
                    }.padding(.top, 10)

                    HStack(spacing: 0) {
                        authLink("注册账号") { authSheet = .register }
                        dot; authLink("验证码登录") { authSheet = .otp }
                        dot; authLink("忘记密码") { authSheet = .forgot }
                    }.padding(.top, 18)
                    Spacer(minLength: 30)
                }
                .frame(maxWidth: 460).frame(maxWidth: .infinity)
                .padding(.horizontal, 26)
            }
        }
        .task {
            switch ProcessInfo.processInfo.environment["MEADHALL_AUTH"] {   // e2e 截图
            case "register": authSheet = .register
            case "otp": authSheet = .otp
            case "forgot": authSheet = .forgot
            default: break
            }
        }
        .sheet(isPresented: $showServer) { ServerSettingsView() }
        .fullScreenCover(isPresented: $showScan) {
            // 扫到登录二维码 → QRConnectView 内部直接登录(store.user 置好 → 自动进主界面);
            // 扫到裸服务器地址 → 设为当前服务器;扫到邀请链接 → 系统浏览器打开网页注册页。
            QRConnectView { url in Task { await store.applyServer(url) } }.environmentObject(store)
        }
        .sheet(item: $authSheet) { which in
            switch which {
            case .register: RegisterView().environmentObject(store)
            case .otp: OTPLoginView().environmentObject(store)
            case .forgot: ForgotPasswordView().environmentObject(store)
            }
        }
    }
    private var dot: some View { Text("·").font(Theme.ui(12)).foregroundStyle(Theme.muted2).padding(.horizontal, 8) }
    private func authLink(_ t: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { Text(loc: t).font(Theme.ui(13, .medium)).foregroundStyle(Theme.accent) }
    }

    private var line: some View { Rectangle().fill(Theme.lineSoft).frame(height: 1) }

    private func field<Content: View>(icon: String, placeholder: String, isSecure: Bool, @ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon).font(.system(size: 14)).foregroundStyle(Theme.muted).frame(width: 18)
            ZStack(alignment: .leading) {
                if (isSecure ? password : username).isEmpty {
                    Text(placeholder).font(Theme.ui(15)).foregroundStyle(Theme.muted2)
                }
                content().font(Theme.ui(15)).foregroundStyle(Theme.text).tint(Theme.accent)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 14)
        .background(Theme.panel, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line, lineWidth: 1))
    }

    private var canLogin: Bool { !username.isEmpty && !password.isEmpty }
    private var serverHost: String { URL(string: store.serverURL)?.host ?? store.serverURL }
    private var isOfficial: Bool { store.serverURL == AppStore.defaultServer }
    private func doLogin() { focus = nil; Task { await store.login(username: username, password: password) } }
}
