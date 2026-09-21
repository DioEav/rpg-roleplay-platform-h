# 已知问题与待办优化（Deferred Optimizations / Known Issues）

> 本文档记录已诊断、已定位但**尚未实施**的优化项与已知限制,按主题分组。
> 每项附根因、影响面与建议方向,供排期决策。完成一项就把它移到对应主题的「已完成」小节。
> 最后更新: 2026-09

---

## 1. 游戏控制台启动性能

### 已完成(2026-09)

- **六个启动端点解除事件循环阻塞**:`/api/state`、`/api/platform`、`/api/scripts`、`/api/saves`、`/api/library`、`/api/auth/me` 从 `async def` 改为同步 `def`(FastAPI 自动进线程池)。此前协程内的同步 DB/深拷贝会卡死单 worker 事件循环,浏览器并行请求在服务端被迫串行。回归锁: `rpg/tests/unit/test_boot_endpoints_sync.py`。
- **前端平台组并行化**: `data-loader.js` 的 `fetchUserLists` 把 scripts/saves/library 三请求并行(此前顺序 await)。
- **模型选择器共享快照 + 单飞请求**: `AgentModelPicker` 模块级 store,同页 N 实例共用一次拉取;localStorage stale-while-revalidate(TTL 5 分钟,只存元数据不含密钥)。
- **启动打点**: 进游戏控制台后控制台输出 `[data-loader] boot: ...` 与每请求毫秒数,用于持续定位。

### 基线数字(打点实测)

| 阶段 | 修复前 | 端点解锁后 |
|---|---|---|
| platform 组(auth.me + platform.info + scripts/saves/library) | 22645ms | 7185ms |
| state(/api/state 全量含目录) | 9298ms | 2233ms |
| **总** | **22645ms** | **7185ms** |

每请求(端点解锁后): platform.info 3722ms · scripts.list 3226ms · saves.list 2562ms · auth.me 233ms · library.list 183ms。

### 待办(Phase 2,按 ROI 排序)

1. **启动请求去重**: `/api/platform` 的 `overview()` 已经返回 scripts/saves/settings/assets 全量列表,`data-loader.js` 却又并行拉 `/api/scripts`、`/api/saves`、`/api/library` —— 同样数据一进来查两遍。方向: data-loader 直接消费 `platform.info` 自带列表构建 `platform.scripts/saves/recent_assets`,砍掉三个请求(预期 platform 组 7.2s → ≈3.7s)。**核对点**: `expose(row)` 字段形状与 `normalizeScript/normalizeSave` 的兼容性;`overview` 的 50 条上限语义。
2. **`/api/state` 目录瘦身**: state payload 携带整份每用户模型目录(`_payload` → `load_catalog_for_user` ≈ 6-7 次 DB 读 + `_redact_catalog` 两遍全目录深拷贝),只为渲染模型选择器。方向: models 从 state payload 拆出,选择器自拉 `/api/models`(游戏台 picker 本就自拉)。**影响面**: `_currentModelLabel`(game-composer)读 `gameState.models`,需同步改造。完成后 state 线预期降到几百 ms,并减少与 platform 组的 GIL 竞争。
3. **`branch_counts` 相关子查询改写**: `workspace/listing.py` overview 里对用户全部 branch_commit 逐行 `exists` 回表数分支数,存档回合多时线性变重(platform.info 3.7s 的头号嫌疑)。方向: JOIN + GROUP BY 改写,或迁移到 saves 端点并加索引。
4. **分阶段挂载**: splash 只等登录态判定即退场,React 壳先渲染骨架,数据经 `rpg-data-ready` 事件流入。体验最优但所有同步读 `window.MOCK_STATE` 的组件都要加骨架态,改动面大。
5. **dev 模式提示**: vite dev 首屏天然慢于构建产物,量化性能请以 build 后为准。

---

## 2. 模型选择浮层(游戏台/设置页)

### 已完成(2026-09)

- 加载状态机三分支: 加载中(轻占位,不渲染表单)/ 加载失败(错误条+重试)/ 就绪。不再把"加载中"与"真没配 key"混为一谈。
- 空列表文案二分: 无任何凭据 →「没有可用模型(先配 API key)」;有凭据但无可见模型 →「没有可显示的模型(可能已隐藏/目录为空/未同步)」——不再把后者甩锅给 key。
- stale 快照上屏期间显示「正在同步最新模型列表…」提示。

### 已知设计行为(非 bug,但容易被误解)

选择器(游戏浮层/设置页选择器)只显示**同时满足**以下条件的模型;「模型管理」是管理视图,会显示全部(带开关):

- 供应商已配 key 且未在模型管理里关掉供应商开关;
- 模型的可见性开关(模型管理里每个模型的开关)是开 —— 关掉的模型是用户刻意从选择器隐藏的;
- 非"仅嵌入"模型(聊天选择器不显示 RAG 嵌入模型,防止误选)。

若模型管理看得到、浮层找不到,对照上表即能定位是哪一层关闭。

### 待办

1. **可见性隐藏的透明提示**(低优先): 浮层里若有模型因可见性开关/仅嵌入被过滤,可加一行"另有 N 个模型未显示(见模型管理)" —— 避免用户误以为模型丢了。
2. **`/api/models` 部分失败的可观测性**: 目录腿失败时已进错误态,但服务端日志侧无专门标记,可考虑加一条。

---

## 3. 设置页「隐私 · 公开范围」—— 5 个控件未接线(2026-09 审计)

审计结论: 7 个控件里只有「公开个人主页」端到端真实生效(后端 `/api/u/{username}/achievements` 读 `preferences->>'public_profile'`,未开启时 404 不泄露存在性)。其余:

| 控件 | 状态 | 根因 |
|---|---|---|
| 允许搜索(`searchable`) | 死开关 | 前后端均无读者;且平台根本没有"用户搜索"功能可被它管(`/api/search` 只覆盖剧本/存档/卡片/世界书/记忆/NPC) |
| 资料字段可见性(逐项配置) | **保存必失败** | 前端 POST `/api/profile/visibility`(api-client.js),后端**不存在**该路由;字段本身(real_name/gender/birthday/location/email/phone)真实存在于 profile_extras 表 |
| 匿名用量统计(`share_usage`) | 死开关 | 无任何收集代码,无读者(失效方向安全:承诺不收集,确实没收集) |
| 崩溃报告(`share_crash`) | 死开关 | 同上 |
| 个性化推荐(`personalized`) | 死开关 | 同上,且推荐功能本身不存在 |
| ads_track | 死开关 | 同上(仅桌面) |

方向(未排期): (a) 最诚实 —— 移除死控件只留真实生效的; (b) 补实现 —— visibility 端点 + 公开资料页按字段过滤 + 用户搜索理会 `searchable`; (c) 混合。

---

## 4. 原生客户端与 Web 端的功能差异

Web 端模型参数页 2026-09 起有: NSFW 第 5 档「不介入(none)」、强度二值按钮、Mirostat 移除、分组预览。以下原生客户端**未同步**,同一账号跨端会看到不同界面:

- `mobile/app/(app)/model-params.tsx`: NSFW 仍 4 档(无「不介入」)、仍有 Mirostat 控件、强度仍是滑杆。
- `ios/Sources/Views/ModelParamsView.swift`: 同上(注意 NSFW 档位白名单若不含 `none`,Web 存的 `none` 会被原生端静默显示为默认档)。

方向: 原生端补齐 5 档 + 移除 Mirostat;或接受差异并在文档声明。

---

## 5. 其它已记录项

- **Reasoning Effort 下拉(设置→模型设置)**: 写 `settings.reasoning_effort`,后端无读取者 → 已整体隐藏(`SHOW_REASONING_EFFORT = false`,桌面+移动)。思考深度的真实入口是「每模型思考开关」(Extended Thinking),仅 anthropic/vertex_ai/openai/deepseek 四家生效,其余供应商后端刻意不发思考字段。接线或移除未排期。
- **Mirostat**: 本平台不可用(OpenAI 兼容协议不透传,仅 llama.cpp/Ollama 原生端点支持),Web 端控件已移除;后端无读者;i18n 键(`agent_picker`/`settings.modelparams.mirostat*`)保留备将来接原生直连通道。
- **数据共享开关的"失效方向"**: share_usage/share_crash/personalized/ads_track 四个死开关失效方向安全 —— 承诺不收集且确实无收集代码。若将来接入遥测,务必先接开关再接收集。
