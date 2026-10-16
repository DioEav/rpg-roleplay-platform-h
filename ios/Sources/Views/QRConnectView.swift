import SwiftUI
import AVFoundation

// ─────────────────────────────────────────────────────────────────────────────
// 扫码连接自建服务器 —— 扫桌面端/自部署服务器显示的局域网二维码(内容=http://ip:port/),
// 设为当前服务器并探活;配「美观的连接动画」(扫描取景框 + 烛光脉冲连接态)。
// 桌面 lan:qr 编码的就是纯 URL,这里扫到 URL → 探 /api/health → 成功即切换服务器。
// ─────────────────────────────────────────────────────────────────────────────

struct QRConnectView: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    var onConnected: (String) -> Void

    enum Phase: Equatable { case scanning, connecting(String), success(String), failed(String) }
    @State private var phase: Phase = .scanning
    @State private var camDenied = false
    // 扫到的二维码可能是:① 裸服务器地址(仅连接)② 登录链接 desktop-login?token=(扫码免登录)
    // ③ 邀请链接 /Login.html?invite=(注册自己的账号 → 用系统浏览器打开 web 注册页)。
    enum ScanAction: Equatable { case connect, login(String), invite(String) }
    @State private var pendingAction: ScanAction = .connect

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            switch phase {
            case .scanning:
                if camDenied { permissionDenied } else { scanner }
            default:
                ConnectingAnimation(phase: phase,
                                    onRetry: { phase = .scanning },
                                    onDone: { base in onScanDone(base) })
                    .transition(.opacity)
            }
            VStack {
                HStack {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                            .frame(width: 40, height: 40).background(.ultraThinMaterial, in: Circle())
                    }.accessibilityLabel(Text(loc: "关闭窗口"))
                    Spacer()
                }.padding(16)
                Spacer()
            }
        }
        .task {
            switch ProcessInfo.processInfo.environment["MEADHALL_SCAN_DEMO"] {   // 截图用
            case "connecting": phase = .connecting("http://192.168.x.x:7860"); return
            case "success": phase = .success("http://192.168.x.x:7860"); return
            case "failed": phase = .failed("无法连接,请检查地址与网络"); return
            default: break
            }
            await checkCamera()
        }
        .animation(.easeInOut(duration: 0.3), value: phase)
    }

    // ── 扫描态:相机 + 取景框 ──
    private var scanner: some View {
        ZStack {
            QRCameraView { code in handleScan(code) }.ignoresSafeArea()
            ScanReticle()
            VStack {
                Spacer()
                VStack(spacing: 6) {
                    Text(loc: "扫描自建服务器的二维码").font(Theme.serif(18, .semibold)).foregroundStyle(.white)
                    Text(loc: "在桌面端「局域网/分享」里打开二维码,对准取景框").font(Theme.ui(12.5)).foregroundStyle(.white.opacity(0.7))
                        .multilineTextAlignment(.center)
                }.padding(.bottom, 60).padding(.horizontal, 36)
            }
        }
    }

    private var permissionDenied: some View {
        VStack(spacing: 14) {
            Image(systemName: "camera.fill").font(.system(size: 40)).foregroundStyle(.white.opacity(0.7))
            Text(loc: "需要相机权限才能扫码").font(Theme.ui(15, .medium)).foregroundStyle(.white)
            Text(loc: "请在「设置 → Meadhall → 相机」开启,或手动输入服务器地址。")
                .font(Theme.ui(12.5)).foregroundStyle(.white.opacity(0.6)).multilineTextAlignment(.center).padding(.horizontal, 40)
            Button { UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!) } label: {
                Text(loc: "打开设置").font(Theme.ui(15, .semibold)).foregroundStyle(Theme.onAccent)
                    .padding(.horizontal, 22).padding(.vertical, 11).background(Theme.accent, in: Capsule())
            }
        }
    }

    private func checkCamera() async {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: camDenied = false
        case .notDetermined: camDenied = !(await AVCaptureDevice.requestAccess(for: .video))
        default: camDenied = true
        }
    }

    private func handleScan(_ raw: String) {
        guard case .scanning = phase else { return }
        guard let parsed = parseScannedURL(raw) else {
            phase = .failed("二维码不是有效的服务器地址"); return
        }
        pendingAction = parsed.action
        // 邀请链接:不走连接动画,直接用系统浏览器打开 web 注册页(复用网页轻量注册),随即关闭。
        if case .invite(let token) = parsed.action {
            let enc = token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? token
            if let u = URL(string: "\(parsed.base)/Login.html?invite=\(enc)") { UIApplication.shared.open(u) }
            dismiss(); return
        }
        phase = .connecting(parsed.base)
        Task {
            let r = await store.api.probeServer(base: parsed.base)
            if !r.ok { await MainActor.run { phase = .failed(r.info) }; return }
            if case .login(let token) = parsed.action {
                let ok = await store.scanLogin(base: parsed.base, token: token)
                await MainActor.run { phase = ok ? .success(parsed.base)
                    : .failed("扫码登录失败,二维码可能已过期 —— 请在桌面端重新打开登录二维码") }
            } else {
                await MainActor.run { phase = .success(parsed.base) }
            }
        }
    }

    // 连接动画结束(.success → onDone):connect 设服务器;login 已在 scanLogin 里登录,只需关闭
    // (不能再 onConnected,那会 applyServer 把刚拿到的登录态清掉)。
    private func onScanDone(_ base: String) {
        if case .login = pendingAction { dismiss() }
        else { onConnected(base); dismiss() }
    }

    /// 解析扫到的二维码:抽出服务器 base(scheme://host:port,丢弃 path/query)并识别动作。
    /// 登录二维码 = …/api/auth/desktop-login?token=… ;邀请二维码 = …/Login.html?invite=… 。
    private func parseScannedURL(_ raw: String) -> (base: String, action: ScanAction)? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        if !s.hasPrefix("http://") && !s.hasPrefix("https://") {
            if s.contains(".") || s.contains(":") { s = "http://" + s } else { return nil }
        }
        guard let u = URL(string: s), let scheme = u.scheme, let host = u.host else { return nil }
        var base = "\(scheme)://\(host)"
        if let port = u.port { base += ":\(port)" }
        let items = URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems ?? []
        if u.path.hasSuffix("/api/auth/desktop-login"),
           let tok = items.first(where: { $0.name == "token" })?.value, !tok.isEmpty {
            return (base, .login(tok))
        }
        if let inv = items.first(where: { $0.name == "invite" })?.value, !inv.isEmpty {
            return (base, .invite(inv))
        }
        return (base, .connect)
    }
}

// ── 取景框(动态扫描线 + 四角)──
private struct ScanReticle: View {
    @State private var sweep = false
    private let size: CGFloat = 240
    var body: some View {
        ZStack {
            Color.black.opacity(0.55).ignoresSafeArea()
                .mask {
                    Rectangle().overlay(
                        RoundedRectangle(cornerRadius: 22).frame(width: size, height: size).blendMode(.destinationOut)
                    ).compositingGroup()
                }
            ZStack {
                RoundedRectangle(cornerRadius: 22).stroke(Theme.accent.opacity(0.5), lineWidth: 1).frame(width: size, height: size)
                ForEach(0..<4) { i in corner.rotationEffect(.degrees(Double(i) * 90)) }
                // 扫描线
                Rectangle()
                    .fill(LinearGradient(colors: [.clear, Theme.accent, .clear], startPoint: .leading, endPoint: .trailing))
                    .frame(width: size - 24, height: 2)
                    .shadow(color: Theme.accent, radius: 6)
                    .offset(y: sweep ? size/2 - 16 : -size/2 + 16)
            }
            .frame(width: size, height: size)
            .onAppear { withAnimation(.easeInOut(duration: 1.8).repeatForever(autoreverses: true)) { sweep = true } }
        }
    }
    private var corner: some View {
        Path { p in p.move(to: .init(x: 0, y: 26)); p.addLine(to: .zero); p.addLine(to: .init(x: 26, y: 0)) }
            .stroke(Theme.accent, style: .init(lineWidth: 3, lineCap: .round))
            .frame(width: 26, height: 26)
            .offset(x: -(240/2) + 13, y: -(240/2) + 13)
    }
}

// ── 连接动画(烛光脉冲环 → 成功/失败)──
private struct ConnectingAnimation: View {
    let phase: QRConnectView.Phase
    var onRetry: () -> Void
    var onDone: (String) -> Void
    @State private var pulse = false
    @State private var ring = false

    var body: some View {
        VStack(spacing: 26) {
            ZStack {
                // 脉冲外环(连接中)
                if isConnecting {
                    ForEach(0..<3) { i in
                        Circle().stroke(Theme.accent.opacity(0.5), lineWidth: 1.5)
                            .frame(width: 120, height: 120)
                            .scaleEffect(ring ? 2.1 : 1).opacity(ring ? 0 : 0.6)
                            .animation(.easeOut(duration: 2).repeatForever(autoreverses: false).delay(Double(i) * 0.6), value: ring)
                    }
                }
                Circle().fill(centerColor.opacity(0.16)).frame(width: 120, height: 120)
                Circle().stroke(centerColor.opacity(0.5), lineWidth: 1.5).frame(width: 120, height: 120)
                    .scaleEffect(pulse && isConnecting ? 1.06 : 1)
                Image(systemName: centerIcon).font(.system(size: 42, weight: .light)).foregroundStyle(centerColor)
                    .contentTransition(.symbolEffect(.replace))
            }
            VStack(spacing: 6) {
                Text(loc: title).font(Theme.serif(20, .semibold)).foregroundStyle(.white)
                Text(subtitle).font(Theme.ui(13)).foregroundStyle(.white.opacity(0.65))
                    .multilineTextAlignment(.center).padding(.horizontal, 40)
            }
            if case .failed = phase {
                Button { onRetry() } label: {
                    Text(loc: "重新扫描").font(Theme.ui(15, .semibold)).foregroundStyle(Theme.onAccent)
                        .padding(.horizontal, 24).padding(.vertical, 12).background(Theme.accent, in: Capsule())
                }
            }
        }
        .onAppear {
            pulse = true; ring = true
            if case .success(let url) = phase, !isDemo {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { onDone(url) }
            }
        }
        .onChange(of: isSuccess) { _, ok in
            if ok, !isDemo, case .success(let url) = phase {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { onDone(url) }
            }
        }
    }

    private var isDemo: Bool { ProcessInfo.processInfo.environment["MEADHALL_SCAN_DEMO"] != nil }
    private var isConnecting: Bool { if case .connecting = phase { return true }; return false }
    private var isSuccess: Bool { if case .success = phase { return true }; return false }
    private var centerColor: Color { if case .failed = phase { return Theme.danger }; if case .success = phase { return Theme.accent }; return Theme.accent }
    private var centerIcon: String {
        switch phase { case .success: return "checkmark"; case .failed: return "xmark"; default: return "server.rack" }
    }
    private var title: String {
        switch phase { case .connecting: return "正在连接服务器…"; case .success: return "连接成功"; case .failed: return "连接失败"; default: return "" }
    }
    private var subtitle: String {
        switch phase {
        case .connecting(let u): return prettyHost(u)
        case .success(let u): return prettyHost(u)   // 显示所连服务器地址
        case .failed(let e): return e
        default: return ""
        }
    }
    private func prettyHost(_ url: String) -> String {
        url.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: "")
    }
}

// ── AVFoundation 二维码相机 ──
struct QRCameraView: UIViewControllerRepresentable {
    var onCode: (String) -> Void
    func makeUIViewController(context: Context) -> QRCameraVC { let vc = QRCameraVC(); vc.onCode = onCode; return vc }
    func updateUIViewController(_ vc: QRCameraVC, context: Context) {}
}

final class QRCameraVC: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?
    private var fired = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let p = AVCaptureVideoPreviewLayer(session: session)
        p.videoGravity = .resizeAspectFill
        p.frame = view.bounds
        view.layer.addSublayer(p)
        preview = p
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in self?.session.startRunning() }
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); preview?.frame = view.bounds }
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if session.isRunning { session.stopRunning() }
    }
    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !fired, let obj = objects.first as? AVMetadataMachineReadableCodeObject, let s = obj.stringValue else { return }
        fired = true
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        onCode?(s)
    }
}
