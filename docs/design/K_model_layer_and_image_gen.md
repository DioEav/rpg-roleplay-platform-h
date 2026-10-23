# K — 统一模型抽象层 + 生图管线

状态：实施中（Phase 0 起）。本文是实施级契约，子代理按此执行。

## 背景与问题

模型选择链路是断的。取证结论（file:line 见各节）：

- **catalog 早已落库**（`model_apis` / `model_entries` / `app_config.selected_model`），JSON 与 `DEFAULT_MODEL_CATALOG` 仅是**只读种子 / DB 空时 bootstrap**。`load_model_catalog()` 读到 DB 即返回，运行时不读 JSON（`model_registry.py:301-324`）。
- 真正的病根：**落库的内容来源是一坨过时的代码种子**（`DEFAULT_MODEL_CATALOG` 硬编码模型名），而非 provider 实时列表。改 DEFAULT 不生效（只在 DB 全空时跑一次），catalog 被冻结在首次 seed。
- 5 个断点：①配 key ≠ 自动拉真实模型列表（同步是手动）；②两个选择器，`ModelPicker.jsx` 调不存在的 `/api/models/catalog`（404 恒空），`AgentModelPicker.jsx` 调 `/api/models`（存在）；③`normalize_api_id` 两文件方向相反（registry: `AgentPlatform→vertex_ai`；credentials: 反向）；④`image_gen` 能力标签定义了却从没赋给任何模型（`model_probe.py:604`）；⑤偏好透传不校验，靠 `KNOWN_OFFLINE_MODELS` 黑名单 hack 兜（`model_registry.py:69`）。
- DB 结构本身 OK：`model_entries` 已区分 `display_name` vs `real_name`/`model_id`（`init.py:595`）。**断的是数据流，不是表结构。**

## 北星

模型清单的唯一权威 = **DB + provider 实时 `list_remote_models()`**。`DEFAULT_MODEL_CATALOG` 砍成 provider 骨架（不含杜撰模型名），配 key 即自动 sync 入库，display/real 双名在一处和解，前后端统一一个选择接口。生图模型 = catalog 里 `capabilities:["image_gen"]` 的 entry，从同一条 sync 路径进来，零硬编码模型名。

---

## Phase 0 — 统一模型层（本阶段全量执行）

### 跨子代理共享契约（所有 agent 必须一致）

1. **规范化定于一尊**：新建 `rpg/model_aliases.py`，导出 `normalize_api_id(api_id)` + `_API_ID_ALIASES`。**canonical = 小写 provider id**（`vertex_ai` / `openai` / `anthropic` / `deepseek` / `dashscope` / `doubao` / `hunyuan` / `minimax` / `siliconflow` / `openrouter` / `xiaomi_mimo`），即 registry 现有方向。`model_registry.py`、`user_credentials.py` 都 `from model_aliases import normalize_api_id`，删除各自的本地 alias 表。
2. **`/api/models` 响应形状（前端依赖）**：
   ```
   {ok, models:{apis:[{id, display_name, kind, enabled,
       models:[{id, real_name, display_name, enabled, capabilities:[...]}]}]},
    selected:{api_id, model_id, real_name, display_name, capabilities:[...]}}
   ```
3. **能力词表**：含 `image_gen`（文生图/图生图模型）。前端按 `capabilities` 客户端过滤；生图 UI 复用 `AgentModelPicker` 传 `capabilityFilter="image_gen"`。
4. **文件归属互斥**：每个 agent 只改自己名下文件，**绝不碰他人文件**。整合由主代理做。
5. **可启动性铁律**：`DEFAULT_MODEL_CATALOG` 砍骨架时，**保留 vertex_ai 真实可用 chat 模型 + 全部 embedding 模型**，`selected` 仍指向一个真实可用的 vertex flash 模型——否则 fresh/未 sync 实例的系统代理无默认模型可用、GM 直接挂。其它 provider 的 chat `models` 清空为 `[]`，靠用户 sync 填。

### API 格式（Chat Completions / Responses）

OpenAI 家族新增 `api_format`，不改 `kind`（`kind` 仍只表达 provider 路由族）：
- 取值：`chat_completions`（默认）/ `responses`；空串仅出现在凭据层，表示继承目录默认。
- 优先级：`user_api_credentials.api_format` > `model_apis.api_format` > `chat_completions`；只对 `kind in {openai, openai_compat}` 生效。
- 路由：`GameMaster` 按解析结果选 `_OpenAICompatBackend` 或 `_ResponsesBackend`；`agents/_harness.py` 的两个 OpenAI helper 在拿到 credential 后自分发，保持既有函数签名。
- Responses 请求契约：`instructions` + `input`、平铺 `tools`、`function_call_output`/`call_id`、`max_output_tokens`、`reasoning.effort`、`text.format`；默认 `store=False`（无状态，每回合发全量历史）。
- 兼容：旧凭据 `api_format=''` → 目录默认（chat），行为与改造前完全一致；`kind` 白名单、模型同步、定价、BYOK 均不变。
- 明确不在范围：embeddings、生图（Chat image modality），以及 Anthropic-only 的 `call_agent_tool_loop`。

### 文件归属与改动（4 路并发）

**Agent A — registry-core**　owns: `rpg/model_aliases.py`(NEW), `rpg/model_registry.py`
- 抽 `_API_ID_ALIASES` + `normalize_api_id` 到 `model_aliases.py`；`model_registry.py` 改为 import 复用（保留同名再导出以兼容现有 import）。
- `DEFAULT_MODEL_CATALOG` 砍骨架：非默认 provider 的 chat `models` 清空 `[]`；**保留** vertex_ai 真实 chat 模型 + 所有 provider 的 embedding 模型；`selected` 指真实 vertex flash。
- 删除 `KNOWN_OFFLINE_MODELS` / `_is_offline_model` / `_filter_offline_models` 及其在 `apply_user_overlay` 等处的调用点（调用处改为直接用列表，不再过滤）。
- 不改 DB schema。

**Agent B — credentials + sync + probe + migration**　owns: `rpg/platform_app/user_credentials.py`, `rpg/platform_app/user_models.py`, `rpg/model_probe.py`, `rpg/platform_app/db/migrations.py`(只追加新版本)
- `user_credentials.py`：删本地 normalize，改 `from model_aliases import normalize_api_id`。
- **配 key 自动 sync**：`set_credential()` 成功后，best-effort（try/except 非致命，**lazy import 防循环依赖**）调 `model_probe.list_remote_models()` → `user_models.replace_synced_models()`，把该用户该 provider 的真实模型写 `user_model_entries`。
- `migrations.py` 追加一个新版本：把存量 `user_api_credentials.api_id` 与 `user_model_entries.api_id` 规范化到 `normalize_api_id` 形（如 `AgentPlatform`→`vertex_ai`），幂等。
- `model_probe.py`：`get_capabilities` 加 image_gen 启发式（名字含 `imagen/seedream/wanx/dall-e/dalle/flux/stable-diffusion/sd3/image` → 加 `image_gen`）。
- 别动 model schema DDL（只追加数据规范化迁移）。

**Agent C — api + resolve**　owns: `rpg/routes/models.py`, `rpg/schemas/models.py`, `rpg/core/llm_backend.py`
- `routes/models.py`：注册 `GET /api/models/catalog` 作为 `GET /api/models` 的别名（返回完全相同 payload），消灭 404；确保响应 model 条目带 `capabilities`。
- `core/llm_backend.py`：`resolve_preferred_model` / `resolve_preferred_api` 对存的偏好做 catalog 存在性校验（用 `load_catalog_for_user`），不存在则回退 `first_user_model`——替代黑名单职责。
- 不碰 model_registry/credentials 内部实现，只调其公开函数。

**Agent D — frontend pickers**　owns: `frontend/src/components/ModelPicker.jsx`, `frontend/src/components/AgentModelPicker.jsx`, `frontend/src/api-client.js`
- `ModelPicker.jsx`：从 `/api/models/catalog`（坏）切到 `window.api.models.list()`（`GET /api/models`）；按嵌套 `models.apis[].models[]` 解析；provider 归一对齐后端 canonical（`vertex_ai` 非 `AgentPlatform`）。
- `AgentModelPicker.jsx`：删硬编码 `defaultModel='gemini-3.5-flash'`，默认值取后端 `selected`；加可选 `capabilityFilter` prop（按 `capabilities` 过滤模型，给生图 UI 复用）。
- `api-client.js`：`api.models.catalog` 指向 `/api/models`（或保留别名端点），消除死调用。

### 整合 & 验收（主代理）
- 全改动 `python -m py_compile`；`npm run build` 真构建。
- 循环依赖检查（B 的 lazy import）。
- 验收：①`/api/models` 与 `/api/models/catalog` 同源不 404；②配某 provider key 后该用户视图自动出现真实模型；③Vertex BYOK 凭据查找与 catalog 查找命中同一 canonical；④image 模型带 `image_gen`、前端可过滤；⑤偏好存了下线模型→自动回退、黑名单 hack 移除后无回归。

---

## Phase 1 — 生图基座（依赖 Phase 0）
- `generate_image` 工具（`ToolSpec`，scope=save，复用 dispatcher 用户级围栏）+ `POST /api/images/generate` 端点（照搬 audit-cards）。
- 异步 job（复用 `postproc_queue`）+ Redis SSE 回推 URL；前端复用 audit loading 范式。
- **存储抽象**：写盘抽成单函数 `store_image(bytes)->url`，本地落 `platform_data/ai_images/` + `GET /api/images/file/{id}` FileResponse；OSS 实现留接口（换这一个函数即可，前端零改）。
- 4 家 provider 图片适配（各家 API 形态不同：dashscope 万相异步 task-poll / doubao seedream / openai images / vertex imagen）。先 doubao + dashscope。
- 每用户限流（复用 dispatcher 限流位）防刷。

## Phase 1 实施契约（细 · 子代理按此执行）

### 共享接口（所有 Phase1 agent 一致）
- `store_image(data: bytes, *, user_id, kind, ext="png") -> str`：落 `platform_data/ai_images/`，返回相对 URL `/api/images/file/{id}`。**OSS 留接口**：日后只换此函数体，调用方零改。
- `ai_images` 表（migration v68）：`id, user_id, kind('cover'|'avatar'|'card'|'chat'|'game'|'persona'), api_id, model, prompt, params jsonb, url, status('pending'|'generating'|'done'|'failed'), error, created_at`。
- 适配器接口 `rpg/agents/image_gen/base.py`：`generate(prompt, params, *, api_id, model, api_key, base_url) -> list[bytes]`（provider 返 URL 则下载成 bytes 交 store_image）。`dispatch.py` 按 api_id/kind 路由 doubao/dashscope。
- 异步：生图一律走 `postproc_queue` 异步 job；executor/endpoint 只入队返回 `{image_id, status:'pending'}`；worker 调适配器→`store_image`→更新 `ai_images.status='done'`→经 SSE 事件总线发 `image_ready{image_id,url}`。
- BYOK：worker 内 `resolve_api_key(user_id, api_id)`，缺 key 标 `failed` + reason `credentials_required`。

### 确定性门控（per-turn，复用 pending_writes，不靠 LLM 自觉）
- `chat_pipeline.py` run_gm_phase 起点（line ~1016，与 `_turn_tool_ops=[]` 并列）加 `state.data["_turn_images_generated"]=0`。
- `generate_image` executor：**仅对自主 origin（llm_chat/autonomous_agent）计数**。`count>=1` → 不生图，入 `state.data["permissions"]["pending_writes"]`（path="generate_image", value=args），返回"本轮第 2 张需玩家确认"；否则 `count+=1` 入队异步 job。**ui_button/api_direct origin 不计数、直接入队**（用户点击即审批）。
- 审批：用户 approve → 复用 `POST /api/permissions/pending-write` → `approve_pending_write`/`apply_state_write_typed(force=True)` 识别 `path=="generate_image"` → 取 value 入队生图 job（而非 `_set_path`）。
- 强制性：即使 `permission_mode=full_access`，第 2 张也强制 pending（executor 主动入队，绕过 `_write_path_allowed` 的自动放行）。

### 两家 provider 契约（adapter agent 必须 fetch 官方文档核字段）
- **doubao（火山方舟 Ark）**：OpenAI 兼容，`POST {base}/images/generations`，base `https://ark.cn-beijing.volces.com/api/v3`，`Authorization: Bearer {ARK key}`，body `{model, prompt, size, seed?, watermark?, response_format:'url'|'b64_json', image?(图生图)}`，响应 `data[].url` 或 `data[].b64_json`。catalog kind=`openai_compat`。model 以 sync 到的真实名为准（`doubao-seedream-4-x` 等）。
- **dashscope（阿里百炼）**：异步。两套并存——旧 `POST /api/v1/services/aigc/text2image/image-synthesis`(wanx2.x-t2i) 与新 `POST /api/v1/services/aigc/image-generation/generation`(wan2.6-t2i,messages 格式)。fetch 官方文档选**当前推荐**那套。header 必带 `X-DashScope-Async: enable` + `Authorization: Bearer`；提交响应 `output.task_id`；轮询 `GET /api/v1/tasks/{task_id}` 直到 `output.task_status==SUCCEEDED`，图在 `output.results[].url` 或 `output.choices[0].message.content[0].image`。

### 文件归属（3 路并发，互斥）
- **P1-A storage**：新 `rpg/platform_app/api/images.py`（store_image + `GET /api/images/file/{id}` + ai_images CRUD）+ `migrations.py` 追加 v68。
- **P1-B provider**：新 `rpg/agents/image_gen/{__init__,base,doubao,dashscope,dispatch}.py`。fetch 官方文档定字段。
- **P1-C tool+endpoint+gate+async**：新 `rpg/tools_dsl/command_tools_image.py`(generate_image ToolSpec+executor+门控) + `command_tools_register.py`(末尾注册) + `chat_pipeline.py`(仅加计数器初始化一行) + `state/_mixins/pending.py`(approve 识别 generate_image) + `POST /api/images/generate` 端点 + worker 接 postproc_queue + SSE 发 image_ready。按 A 的 store_image / B 的 dispatch 接口写，整合时对接。

## Phase 2 — SFW 静态落点（依赖 Phase 1）
- 抽 `AvatarImg` 共用组件（有 URL 渲 `<img>` 否则首字母兜底），替换 5 处占位。
- 用户头像 / 角色卡头像 / 角色卡立绘（`avatar_path` 透传）。
- 剧本封面：`scripts` 加 `cover_image_url` 列 + 库列表/详情两视图渲染。

## Phase 2 实施契约（细 · 子代理按此执行）

### 共享接口
- **生图→附着目标**：`POST /api/images/generate` body 加可选 `attach:{type,id}`，type ∈ `user_avatar|card_avatar|script_cover`。worker `store_image` 完成后按 type 把 url 写目标(**ownership 校验**:card/script 必属该 user)：`character_cards.avatar_path`(card_avatar,id=card_id) / `users.avatar_url`(user_avatar,无 id) / `scripts.cover_image_url`(script_cover,id=script_id)。attach 透传进 `enqueue_image_generation` 的 payload，worker 末尾执行。
- **状态查询**：`GET /api/images/{id}` 返 `{id,status,url,error,kind}`，给前端 modal 轮询(每 2s 至 done/failed)。
- `scripts` 加 `cover_image_url text not null default ''`(migration **v69**)；script 列表/详情 API DTO 带出该字段(现有不带则 A 补)。
- 前端 `AvatarImg`：props `{src,name,size,shape,className}`，src 有值渲 `<img>`(onError 回退首字母)，否则首字母 div(复用现有 `.pl-card-avatar`/`gc-msg-avatar`/`tv-chat-avatar` 样式，className 传入)。
- 前端 `GenerateImageModal`：props `{open,onClose,kind,attach,defaultPrompt,onDone}`，内含 `<AgentModelPicker prefPrefix="image_gen" fallbackPrefix="gm" capabilityFilter="image_gen">` + prompt textarea + 生成按钮 → `window.api.images.generate({prompt,kind,api_id,model,attach})` → 轮询 `GET /api/images/{id}` 至 done → `onDone(url)`;`credentials_required` → 提示去配 key(复用现有范式)。

### 文件归属（3 路并发互斥）
- **P2-A backend**：`migrations.py`(v69 scripts.cover_image_url) + `image_jobs.py`(payload 收 attach + worker done 后写目标+ownership) + `platform_app/api/images.py`(generate 收 attach 透传 + 新增 `GET /api/images/{id}`)。script DTO 若不带 cover 字段,在其所在 api 文件补(只读取/补该字段,别动他人逻辑)。
- **P2-B frontend-components**：新 `frontend/src/components/AvatarImg.jsx` + 新 `frontend/src/components/GenerateImageModal.jsx` + `frontend/src/api-client.js`(加 `api.images.generate(body)` / `api.images.get(id)`)。
- **P2-C frontend-surfaces**：`frontend/src/pages/cards.jsx`(卡头像/立绘→AvatarImg + "AI 生成头像"按钮 attach card_avatar) + `frontend/src/platform-app.jsx`(用户头像→AvatarImg + "AI 生成"按钮 attach user_avatar) + `frontend/src/pages/scripts.jsx`(封面→AvatarImg + "生成封面"按钮 list&detail attach script_cover)。用 B 的组件(按上述 props),别自造。

## Phase 3 — 即时生图（依赖 Phase 1）
- 酒馆聊天 + 游戏消息流：`NarrativeBlock` 支持图片块；composer 生图按钮。
- 配额 / 保留策略（高频产图防撑盘）；OSS 接口在此前需就绪或同步上。

## Phase 3 实施契约（细 · 子代理按此执行）

### 共享接口
- `ai_images` 加 `save_id text`(nullable)(migration **v70**) + 索引 `(user_id, save_id, created_at desc)`。`create_image_record` 加 `save_id` 参数；`enqueue_image_generation` 加 `save_id`，透传 payload；worker 经 create_image_record 落库。
- **每日配额(确定性)**：`enqueue_image_generation` 起点查该 user 近 24h `ai_images` 行数(非 failed)，≥ `RPG_IMAGE_DAILY_CAP`(env,默认 50) 则**不入队**，返回 `{error:"quota_exceeded", status:"failed"}`(generate 端点/工具据此回报)。
- **list 端点**：`GET /api/images/list?save_id=X` → owner 校验 → `[{id,url,kind,prompt,status,created_at}]`(按 created_at)。
- `generate_image` 工具 executor 把 save 级 `save_id`(dispatcher 注入)透传给 enqueue；`POST /api/images/generate` body 收可选 `save_id`(composer 传)。
- `GenerateImageModal` 加可选 prop `saveId`,并进 generate body。
- SSE：worker 已发 `topic='image' op='ready' {image_id,url,kind}`(Phase 1)。前端订阅,对当前 save 追加图片块。
- 保留策略：提供 `cleanup_old_chat_images(days)` 函数(删 kind in chat/game 且超 N 天的 ai_images + 本地文件);**本期只提供函数,调度(worker 定时/cron)留待后续,在报告里标注**。

### 文件归属（3 路并发互斥）
- **P3-A backend**：`migrations.py`(v70) + `image_jobs.py`(enqueue 加 save_id+quota) + `platform_app/api/images.py`(generate 收 save_id + `GET /api/images/list` + 配额错误回报) + `platform_app/api/images.py` 里加 `cleanup_old_chat_images` + `tools_dsl/command_tools_image.py`(executor 透传 save_id)。
- **P3-B frontend-composer**：`frontend/src/game-composer.jsx`(加"生图"按钮→`GenerateImageModal kind saveId`) + `frontend/src/components/GenerateImageModal.jsx`(加 saveId prop 进 body) + `frontend/src/api-client.js`(加 `api.images.list(saveId)`)。
- **P3-C frontend-render**：`frontend/src/game-app.jsx`(ChatArea 末尾渲染本 save 生成图块:挂载时 `api.images.list(saveId)` 拉取 + 订阅 SSE `image` topic 实时追加) + `frontend/src/entries/game-console.jsx`(透传 saveId/接 SSE) + `frontend/src/tavern-app.jsx`(同样接入,复用 game 的渲染/SSE)。SSE 订阅看现有 `state-event-bridge.js` 怎么订阅 topic。

## Phase 4 — 人设图自动维护 + 历史（依赖 Phase 1）
- `character_cards` 加 `persona_hash` + `auto_image_sync`。
- 新表 `card_persona_images(id, card_id, image_url, persona_hash, card_row_version, source, status, is_current, prompt_snapshot, created_at)`；partial unique index 保证 `is_current` 每卡唯一；历史走 `card_id + created_at desc`。
- `user_cards.upsert_persona()` 返回后检测 `persona_hash` 变化且 `auto_image_sync=true` → 异步入队重生 → 完成翻 `is_current`。
- 历史查看 UI。

## Phase 4 实施契约（细 · 子代理按此执行）

### 共享接口
- **migration v71**：`character_cards` 加 `persona_hash text not null default ''` + `auto_image_sync boolean not null default false`；新表
  `card_persona_images(id bigint gen pk, card_id bigint not null references character_cards(id) on delete cascade, image_url text not null default '', persona_hash text not null default '', card_row_version bigint not null default 1, source text not null default 'manual', status text not null default 'done', is_current boolean not null default false, prompt_snapshot text not null default '', created_at timestamptz default now())`；`create unique index ... on card_persona_images(card_id) where is_current`（保证每卡当前图唯一）+ `index(card_id, created_at desc)`。
- **persona_hash**：`compute_persona_hash(card)` = `sha256(name||''||identity||''||appearance||''||personality||''||background)`（A 定义于 user_cards.py，导出复用）。
- **附着类型 persona_image**：worker 收 `attach={type:'persona_image', id:card_id, persona_hash, source}`，store_image 后(ownership 校验 card 属 user)：① 该卡所有行 `is_current=false` ② insert card_persona_images(is_current=true, image_url=url, persona_hash, card_row_version=卡当前 row_version, source, prompt_snapshot, status='done') ③ `update character_cards set avatar_path=url where id=card_id and user_id`。
- **helper(A 放 image_jobs.py)**：`list_persona_images(user_id, card_id)->[...]`(owner 校验,按 created_at desc) / `set_current_persona_image(user_id, card_id, image_id)`(校验归属→该卡 is_current 全 false→该 image_id 置 true→卡 avatar_path 设为该图 url)。auto_image_sync 开关写 user_cards.py。

### 钩子（A，user_cards.py）
- `upsert_persona` 和 `upsert_user_card`(card_type pc/persona)返回新行后：算 `new_hash=compute_persona_hash(row)`；读旧 `persona_hash`；**若变化且 `auto_image_sync=true`** → `enqueue_image_generation(user_id, prompt=人设拼成的提示, kind='persona', attach={type:'persona_image', id:card_id, persona_hash:new_hash, source:'auto_sync'})`(api_id/model 走 image_gen 偏好回退；缺 key 优雅 failed)；**无论是否触发,都把 `persona_hash` 更新为 new_hash**(下次比较用)。失败只 log 不影响 upsert 主流程。

### 文件归属（3 路并发互斥）
- **P4-A backend**：`migrations.py`(v71) + `user_cards.py`(compute_persona_hash + upsert 钩子 + auto_image_sync 开关函数) + `image_jobs.py`(worker persona_image 分支 + list/set_current helper)。
- **P4-B backend-api**：`platform_app/api/me.py` 加端点：`POST /api/me/character-cards/{id}/auto-image-sync`{enabled}、`POST /api/me/character-cards/{id}/generate-persona-image`(手动触发=enqueue persona_image，origin api_direct，source manual)、`GET /api/me/character-cards/{id}/persona-images`(历史)、`POST /api/me/character-cards/{id}/persona-images/{image_id}/set-current`(回滚)。调 A 的 helper。
- **P4-C frontend**：`frontend/src/pages/cards.jsx`(卡详情/编辑加 auto_image_sync 开关 + "AI 生成人设图"按钮[复用 GenerateImageModal 或直接调端点] + 人设图历史画廊:缩略图列+人设版本/时间+点击设为当前) + `frontend/src/api-client.js`(加对应 4 个方法)。

## 合规 / 存储 已决（用户拍板）
- **NSFW = 纯 BYOK 免责，平台不过滤**（provider 端仍会硬拒，UI 明示 + 落免责，复用 `policy_notice.py`）。
- **存储 = 本地起步，OSS 留接口**（写盘单函数抽象）。
- provider = doubao / dashscope / vertex_ai / openai 四家，先 doubao + dashscope。
