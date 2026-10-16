# 蜜酒厅（Meadhall）— Android 客户端(BYO-server)

Expo / React Native 0.85 原生 Android 客户端,连接你自己部署的蜜酒厅后端
(与仓库里 `ios/` 的 BYO-server 定位一致)。由社区贡献(PR #58,@dragonjay-lyj),
主仓维护。

## 构建

```bash
cd mobile
npm install
npm run build:apk   # = expo prebuild --platform android && cd android && ./gradlew assembleRelease
```

- `android/` 目录由 `expo prebuild` 生成,**不入仓**(见 `.gitignore`)。
- 本仓不含 EAS 配置(无 `eas.json`);构建走上面的本地 gradle 路径。
- **签名**:release 签名密钥不在仓里,按标准 gradle 流程自备 keystore
  (`~/.gradle/gradle.properties` 或环境变量注入),CI 不代签。

## 安全姿态(如实说明)

- `app.json` 里 `usesCleartextTraffic: true` = **应用全局允许明文 HTTP**。
  这是 BYO-server 的现实取舍:自部署后端常跑在局域网 `http://192.168.x.x:7860`,
  而 Android 网络安全配置(NSC)只能按域名/字面 IP 白名单、无法表达"任意私网网段",
  所以无法既支持任意 LAN 地址又只对 LAN 放行明文。
- 推荐:公网访问一律走 HTTPS(反代 + 证书);明文仅限可信局域网。
- 会话凭据存 `expo-secure-store`(Android Keystore 加密),不落明文 AsyncStorage。

## 已知边界

- 后端没有 `GET /api/scripts/{id}` 单剧本端点,剧本详情用
  `birthpoints` / `chapters` / `worldbook` / `canon-entities` / `timeline` 组合接口
  (`src/api/index.ts` 与后端全量路由表逐条核对过)。
