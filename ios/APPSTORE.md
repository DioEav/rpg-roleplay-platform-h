# Meadhall iOS — App Store 提审 Runbook

Bundle ID: `icu.stellatrix.chat` · Team: `YOUR_TEAM_ID` · 版本: `1.0.0 (1)` · 最低 iOS 17.0 · iPhone + iPad

工程是 XcodeGen 生成的:**改了 `project.yml` 后先 `xcodegen generate`**,再用 Xcode 打开 `Meadhall.xcodeproj`。

---

## 已就绪(代码侧)

- [x] 真机架构 Release 编译通过(`xcodebuild -destination 'generic/platform=iOS' -configuration Release CODE_SIGNING_ALLOWED=NO build`)
- [x] `DEVELOPMENT_TEAM = YOUR_TEAM_ID`、自动签名
- [x] `ITSAppUsesNonExemptEncryption = false`(免出口合规弹窗)
- [x] AppIcon 1024 集 + 显示名 Meadhall
- [x] iPad 大屏适配(NavigationSplitView)+ 全方向;iPhone 竖屏
- [x] PhotosPicker 用 PHPicker(进程外),**无需** NSPhotoLibraryUsageDescription

## 只能你来做(需 Apple 账号,我无法代登/代签)

1. **Apple Developer Program**:确认 `YOUR_TEAM_ID` 已付费在册(否则不能上架)。
2. **Distribution 证书**:本机目前只有 *Apple Development* 证书,缺 *Apple Distribution*。
   - 最省事:Xcode → Settings → Accounts → 选团队 → Manage Certificates → ＋ → Apple Distribution。
3. **App Store Connect 建 App 记录**:appstoreconnect.apple.com → My Apps → ＋ → New App
   - 平台 iOS,Bundle ID 选 `icu.stellatrix.chat`(若没注册过,先到 Certificates, Identifiers & Profiles → Identifiers 注册)。
   - 填名称、主语言、分类(建议 工具 / 娱乐)。
4. **填合规与隐私**(审核会查):
   - App Privacy:本 App 是 **BYO-server 通用客户端**,不自带账号体系强绑;按实际数据采集如实填(连用户自填服务器,内容由所连服务器/LLM 管控)。
   - 年龄分级:RPG 对话客户端,据实选(若所连服务器可能含成人内容,分级要保守)。
   - 登录信息:给审核员一个可登录的官方服务器测试账号(或说明可自建)。

## 出包 + 上传(拿到 Distribution 证书后)

**推荐用 Xcode**(自动签名最稳):
1. `cd ios && xcodegen generate`
2. Xcode 打开 → 顶部目标设备选 *Any iOS Device (arm64)* → Product → Archive
3. Organizer → Distribute App → App Store Connect → Upload(自动签名会按需建分发描述文件)

**或命令行**(需先建好分发证书/描述文件):
```bash
cd ios && xcodegen generate
xcodebuild -scheme Meadhall -configuration Release \
  -archivePath build/Meadhall.xcarchive -destination 'generic/platform=iOS' archive
xcodebuild -exportArchive -archivePath build/Meadhall.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath build/export
# 上传(需 App Store Connect API Key:Issuer ID + Key ID + .p8):
xcrun altool --upload-app -f build/export/Meadhall.ipa -t ios \
  --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>
# 或:xcrun notarytool 不适用上架;用 Transporter.app 拖 .ipa 上传亦可。
```

## ⚠️ 审核风险(自行评估)

桌面端当初放弃 Mac App Store,是因沙盒内核封死内置 PostgreSQL + NSFW 红线。iOS 这版是**客户端**(不内置服务端、内容服务端管控),按「BYO-server 工具」定位提审,但仍可能被审核员就「可连任意服务器/UGC 成人内容」质询。准备好:内容审核说明、举报/屏蔽机制说明、保守年龄分级。被拒则按 Resolution Center 回应。
