# Meadhall — 原生 iOS 客户端(SwiftUI)

一个**通用对话客户端**:连接官方服务器或用户自建/他人自建的同款后端（Meadhall）平台。
登录后用酒馆(Tavern)对话接口:对话列表 / 新建 / 打开历史 / 流式收发 / 沉浸式拟人开关。

> 定位是「BYO-server 工具」——内容由所连服务器/LLM 负责,客户端只是管道。这点对 App Store
> 过审很关键(见下方「提审注意」)。

---

## 1. 工程结构

```
ios/
  project.yml              # XcodeGen 工程定义(不手维护 .xcodeproj)
  Sources/
    MeadhallApp.swift    # @main + RootView(登录/主界面切换)
    AppStore.swift         # 全局状态(服务器地址 / 登录态 / API)
    API.swift              # 网络层(cookie 会话 + SSE 流式)
    Models.swift           # 后端 DTO + 本地模型
    Info.plist             # 含 BYO-server 的 ATS 放行
    Assets.xcassets/       # AppIcon(占位图,可替换)+ AccentColor
    Views/
      LoginView.swift
      ServerSettingsView.swift
      ChatListView.swift
      ChatView.swift
  scripts/archive.sh       # 一键 archive + 导出 ipa(供上传)
```

后端契约(已对齐线上 Meadhall):
- `POST /api/auth/login {username,password}` → 写 `rpg_session` cookie
- `GET  /api/auth/me` → 启动探活(已登录则跳过登录页)
- `GET  /api/tavern/chats` / `POST /api/tavern/chats` / `POST /api/tavern/chats/{id}/activate`
- `GET  /api/state`(历史 + tavern.immersive)
- `POST /api/chat {message}` → SSE(`event: token|stage|done|error`)
- `POST /api/tavern/chats/{id}/immersive {enabled}`

---

## 2. 本地构建 / 运行(已验证)

需要:macOS + Xcode 16+(本机用 Xcode 26.5 验证)、`brew install xcodegen`。

```bash
cd ios
xcodegen generate                 # 生成 Meadhall.xcodeproj
open Meadhall.xcodeproj          # 或用下面的命令行

# 命令行构建到模拟器
xcodebuild -project Meadhall.xcodeproj -scheme Meadhall \
  -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -configuration Debug build CODE_SIGNING_ALLOWED=NO
```

调试用环境变量(simctl 加 `SIMCTL_CHILD_` 前缀):
- `MEADHALL_SERVER=http://localhost:7860` 覆盖默认服务器(本地后端=免登录 admin 时可直接进)
- `MEADHALL_OPEN_CHAT=<id>` 启动后自动进入某对话(验证聊天页)

默认服务器:`https://rpg-roleplay.stellatrix.icu`(用户可在登录页右上角「服务器」里改成自建地址)。

---

## 3. 上架 App Store(你来做的部分 —— 你有开发者账号)

> 这些步骤需要**你的 Apple 账号**,我没法替你提交。按顺序做即可。

### 3.1 一次性配置
1. **Bundle ID**:`icu.stellatrix.chat`(可改)。到 [developer.apple.com](https://developer.apple.com) →
   Certificates, Identifiers & Profiles → Identifiers → 注册这个 App ID。
2. **签名团队**:`open Meadhall.xcodeproj` → 选中 Meadhall target → Signing & Capabilities →
   勾 *Automatically manage signing* → 选你的 Team。(或在 `project.yml` 里填 `DEVELOPMENT_TEAM`
   再 `xcodegen generate`。)
3. **App 记录**:[App Store Connect](https://appstoreconnect.apple.com) → 我的 App → 新建 App,
   填名称、主语言、Bundle ID、SKU。

### 3.2 打包上传
```bash
cd ios && ./scripts/archive.sh        # archive → 导出 ipa(改脚本里的 TEAM_ID)
```
或在 Xcode:Product → Archive → Distribute App → App Store Connect → Upload。
上传后构建会出现在 App Store Connect 对应版本的「构建」里。

### 3.3 版本元数据(App Store Connect 填)
- **年龄分级**:选 **17+**(含「成人/暗示性主题」「不频繁的成人/暗示性内容」据实勾)。
- **App 隐私**:本 app 只把账号凭据发到用户指定的服务器,不接第三方 SDK、不收集分析。
  按实际填(基本可全选「不收集」,登录凭据属「与你绑定、用于 App 功能」)。
- **隐私清单**:如审核要求 `PrivacyInfo.xcprivacy`,加一个声明「无追踪、无第三方数据收集」即可。
- **截图**:用模拟器截(6.9" = iPhone 17 Pro Max,6.5" 备用)。
  `xcrun simctl io <udid> screenshot out.png`,准备 登录页 / 对话列表 / 聊天页 三张。

### 3.4 提审备注(Review Notes —— 重要,降低拒审率)
在「App 审核信息 → 备注」里写清楚(中英都行),建议照抄要点:
- 本 app 是连接**用户指定服务器**的通用对话客户端(BYO-server utility),类似通用 API/聊天客户端。
- 内容由用户连接的服务器与 LLM 生成与管控,客户端不内置/不预置任何成人内容。
- 默认审核环境为干净状态;请用我们提供的**演示账号**登录体验:`<给一个干净的演示账号>`。
- `NSAllowsArbitraryLoads=YES` 的原因:允许用户连接自建/局域网服务器(可能为 http),
  官方默认服务器为 https。
- 已设 17+ 分级。

> 风险提示(我之前讲过):若服务器默认体验能产出色情内容,审核仍可能据 1.1.4 拒。
> 最稳的是给审核用的演示账号/默认服务器是 SFW 干净态;NSFW 用户走自己的服务器/网页端。

---

## 4. 现状 / 待办
- [x] 登录(cookie 会话)、对话列表、打开历史、沉浸式开关、流式聊天 UI —— 模拟器连真后端验证通过。
- [ ] LLM 流式实发:本地测试库无模型凭据,需连有凭据的服务器实测(代码走同一套 URLSession+SSE)。
- [ ] 替换占位 AppIcon(`Assets.xcassets/AppIcon.appiconset/icon-1024.png`)为正式图。
- [ ] 注册 OTP/邮箱验证码登录(后端有 `/api/auth/login-code/*`,如需可加)。
- [ ] 提审用的演示账号 + 默认服务器干净态确认。
