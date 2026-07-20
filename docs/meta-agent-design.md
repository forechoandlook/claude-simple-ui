# Meta Agent 设计说明

本文档描述 Claude Simple UI 内置 **Meta Agent** 的架构：会话存储、图片/VLM 处理、历史与 Resume、以及 **reasoning 不进 messages** 的约定。

实现入口：

| 层 | 路径 |
|----|------|
| 引擎 + 工具 + 落盘 | `src/agents/meta-agent.js` |
| HTTP / SSE API | `src/app.js`（`/api/ai/*`） |
| 前端面板 | `public/agent-panel.js` |

配置：`.ai_config.json`（服务端，gitignore）  
数据：`.ai/` 或环境变量 `AI_DATA_DIR`

---

## 1. 目标与边界

Meta Agent 是 **与 Claude / Codex / Grok 会话平行** 的「工作助手」，职责包括：

1. **活动复盘**：根据本机 agent 会话写日报 / 问答「我做了啥」
2. **项目查询**：会话、项目 notes、git、文件
3. **代码试验**：`write_file` + `run_command`（有危险命令拦截）
4. **看图（VLM）**：粘贴图片 → 路径引用 → 按需 `analyze_images`
5. **历史与 Resume**：同一 `sessionId` 下完整 tool / VLM 上下文可继续聊

**不做**：

- 不替代 Claude Code / Codex / Grok 的主 coding agent 循环
- 主对话 **不** 直接发 base64 多模态；像素只在 VLM 工具调用时读盘

---

## 2. 总体架构

```
Browser (agent-panel.js)
    │  SSE  POST /api/ai/chat | /api/ai/report
    │  REST GET/PUT /api/ai/config, sessions, reports…
    ▼
Express (src/app.js)
    │  auth + createMetaAgent(deps)
    ▼
meta-agent.js
    ├── OpenAI-compatible chat (stream + tools)
    ├── executeTool(...)          # 会话 / 文件 / git / shell / VLM
    ├── sessions/{id}/            # 落盘
    └── .ai_config.json           # key / model / VLM / auto_report
```

- API Key 在 **服务端**，不进前端 localStorage（与参考 zwytask 客户端配置不同）。
- 流式：`text/event-stream`，事件 `session` / `content` / `tool` / `done` / `error`。

---

## 3. 会话存储（Session）

同一 **Meta Agent sessionId** 下，对话与 VLM 同目录：

```
.ai/sessions/
  index.json                          # 轻量列表索引
  {sessionId}/
    meta.json                         # 标题、时间、条数、preview、vlmThreadIds
    messages.jsonl                    # 主对话，一行一条消息
    vlm/
      {threadId}.jsonl                # 每个看图线程单独文件
```

### 3.1 `messages.jsonl`

OpenAI 风格消息，供 **resume 时原样拼回** model 上下文：

| role | 内容 |
|------|------|
| `user` | 纯文本（可含 `[imgN](path)`） |
| `assistant` | 最终可见回复；若有工具则含 `tool_calls` |
| `tool` | `tool_call_id` + `content`（JSON 字符串结果） |

写入策略：每轮 chat 结束后 **整文件重写**（原子写 tmp → rename），保证与内存 `messages` 一致。

### 3.2 `meta.json`

供历史列表与 UI：

- `id`, `title`, `createdAt`, `updatedAt`
- `messageCount`, `preview`（首条 user 摘要）
- `vlmThreadIds`（可选，便于排查）
- `model`（可选）

### 3.3 索引与生命周期

- `index.json`：`id / title / updatedAt / messageCount / preview`
- 最多约 **200** 个会话；超出按 `updatedAt` 删整目录
- 删会话 = `rm -rf sessions/{sessionId}/`（含全部 `vlm/*`）
- 旧布局（`session.json`、`vlm.jsonl`、`vlm/*.json`、flat、全局 `.ai/vlm/`）启动时迁移

### 3.4 报告

日报等仍用项目根 `.ai_reports.json`（按 day key），与 chat session 分离。

---

## 4. 图片处理设计

### 4.1 原则

| 原则 | 说明 |
|------|------|
| 路径引用，不塞像素 | 主模型只看到文本里的路径 |
| 按需 VLM | 需要 OCR / 描述时才 `analyze_images` |
| 多线程多文件 | 每次「新一批图」可新建 `threadId`，不互相覆盖 |
| 同线程可追问 | 同一 `thread_id` 多轮，历史在对应 jsonl |

### 4.2 粘贴 / 选图流程

```
用户粘贴图片
    → POST /api/upload-image  （落盘，如 /tmp/…）
    → 输入框插入 [img1](/abs/path.png)
    → 本地缩略图仅预览
    → 发送时只提交 text（含 [imgN](path)）
```

- **不** 把 data URL 放进 `/api/ai/chat` body。
- 与主 Chat 区 `![name](path)` 思路一致，Meta Agent 使用 `[imgN](path)` 便于模型识别。

### 4.3 System 约定（摘要）

- 正文出现 `[imgN](path)` / `![alt](path)` 时，**不能假装已看见像素**
- 需要看图 → `analyze_images`，从引用提取绝对路径
- 追问同一批图 → 带上次返回的 `thread_id` + 新 `prompt`

### 4.4 `analyze_images` 工具

| 参数 | 说明 |
|------|------|
| `prompt` | 必填，本次问题 |
| `image_paths` / `images` | 首次必填（或从 prompt 里解析 `[imgN](…)`） |
| `thread_id` | 可选；有则加载该线程历史再问 |

返回：

```json
{
  "ok": true,
  "analysis": "…",
  "thread_id": "uuid",
  "session_id": "meta-session-uuid",
  "image_paths": ["…"],
  "turns": 2
}
```

执行上下文：`runLoop` 传入 `chatSessionId`，线程落在该 Meta session 的 `vlm/` 下。

### 4.5 VLM 线程文件 `vlm/{threadId}.jsonl`

```jsonl
{"type":"meta","id":"…","sessionId":"…","imagePaths":["/a.png","/b.png"],"updatedAt":…}
{"type":"message","role":"user","content":[…]}
{"type":"message","role":"assistant","content":"分析文本"}
{"type":"message","role":"user","content":"追问"}
{"type":"message","role":"assistant","content":"…"}
```

- 盘上 **去掉 base64**，`image_url` 存占位；加载时按 `imagePaths` 再读盘 hydrate。
- 多图同一次调用：一个 thread，`imagePaths` 多个路径。
- 另一次新图分析：新 `threadId` → 新文件。

### 4.6 VLM 配置

`.ai_config.json` 可配独立 `vlm_url` / `vlm_key` / `vlm_model`；空则回退主模型配置。  
**注意**：主 chat 已是纯文本；VLM 仅在 tool 内调用，不再在 chat 请求体里切换 multimodal。

---

## 5. 历史查看与 Resume

### 5.1 历史列表

- UI：「历史」页 / 「☰ 历史」
- `GET /api/ai/sessions` → 标题、preview、时间、条数
- 支持搜索；删除调 `DELETE /api/ai/sessions/:id`

### 5.2 查看

- `GET /api/ai/sessions/:id` → 读 `meta` + 整份 `messages.jsonl`
- 前端回放：user / assistant / tool chip（含 tool 结果）

### 5.3 Resume

```
1. 用户打开历史 session → chatSessionId = id，渲染历史
2. 再发一条 → POST /api/ai/chat { sessionId, message }
3. 服务端 getChatSession → 拼 system + 全量 messages + 新 user
4. runLoop(…, { chatSessionId }) → tool / VLM 仍属该 session
5. saveChatSession 写回 messages.jsonl + meta.json
```

要点：

- Resume **依赖完整 tool 消息链**（含 `tool_calls` + `tool`），不能只存 user/assistant 摘要
- `localStorage.ma_last_session_id`：再次打开面板时尝试恢复上次会话
- VLM 追问：模型从历史 tool 结果里拿 `thread_id`，或用户消息里的路径再分析

### 5.4 新对话

清空 `chatSessionId`；首条消息创建新 UUID，落新目录。

---

## 6. Reasoning（思考链）与 messages

### 6.1 结论

**Reasoning / thinking 内容默认不进入 `messages.jsonl`，也不回传拼进下一轮 API messages。**

### 6.2 实现依据

`runLoop` 流式只处理：

```js
// 仅累积可见回复
if (d?.content) { content += d.content; … }
// 以及 tool_calls 增量
if (d?.tool_calls) { … }
```

未读取、未落盘例如：

- `delta.reasoning_content`
- `delta.reasoning`
- `delta.thinking`
- `message.reasoning_*`

落盘的 assistant 消息形态仅为：

```json
{ "role": "assistant", "content": "<可见正文或 null>", "tool_calls": [ …可选 ] }
```

或纯文本：

```json
{ "role": "assistant", "content": "<最终回答>" }
```

### 6.3 为何如此

1. **Resume 稳定**：多数 OpenAI 兼容接口不接受把 thinking 原样塞回 messages
2. **体积与隐私**：思考链往往很长，且可能含中间敏感推断
3. **展示分离**：若将来要展示 thinking，应走独立字段/文件（如 `reasoning.jsonl`），与 `messages.jsonl` 解耦

### 6.4 可选后续（未做）

| 方案 | 说明 |
|------|------|
| UI 仅流式展示 | 读 `reasoning_content` 实时显示，**不**写入 messages |
| 旁路落盘 | `sessions/{id}/reasoning/{turn}.txt`，resume 不读 |
| Provider 特殊 | 若某 API 强制要求 reasoning 回传，再加适配层 |

部分模型（如配置里的 mimo）在请求侧显式 `thinking: disabled`，进一步避免 thinking 噪声。

---

## 7. 工具一览

| Tool | 用途 |
|------|------|
| `list_sessions` | 列 Claude/Codex/Grok 会话元数据 |
| `list_projects` | 按 cwd 聚合 |
| `search_activity` | 活动搜索 |
| `get_session_summary` | 读某会话消息摘要 |
| `get_project_notes` / `set_project_notes` | 项目 goal/notes |
| `git_status` / `git_log` | Git |
| `list_files` / `read_file` / `write_file` | 文件 |
| `run_command` | Shell（超时 + 危险命令拦截） |
| `analyze_images` | VLM |
| `generate_activity_digest` | 结构化活动快照 |
| `save_report` / `list_reports` / `get_report` | 工作报告 |

会改状态：`set_project_notes`, `write_file`, `run_command`, `save_report`。

---

## 8. API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/PUT | `/api/ai/config` | 配置（key 不回显明文） |
| POST | `/api/ai/chat` | SSE 对话（text + sessionId） |
| POST | `/api/ai/report` | SSE 生成报告 |
| GET | `/api/ai/sessions` | 历史列表 |
| GET | `/api/ai/sessions/:id` | 完整会话（resume 源） |
| DELETE | `/api/ai/sessions/:id` | 删除 |
| GET | `/api/ai/reports` / `:day` | 报告 |
| GET | `/api/ai/digest` | 活动 digest |

图片上传复用：`POST /api/upload-image`。

---

## 9. 自动日报

- 配置：`auto_report`, `auto_report_hour`, `auto_report_days`
- 前端定时器：整点后 10 分钟内触发一次 `POST /api/ai/report`（`localStorage` 记 `ai_last_auto_report` 防重复）

---

## 10. 安全与运维

- 危险 shell 模式拦截；`run_command` 超时默认 60s，上限 180s
- `write_file` 拒绝系统关键路径
- `read_file` / 上传有大小上限
- `.ai/`、`.ai_config.json`、`.ai_reports.json` 应在 gitignore
- Hub 模式：数据 API 走选中 edge（与现有 `X-Machine-Id` 一致）

---

## 11. 数据流小结

```
[粘贴图] → 磁盘 path → [imgN](path) 写入 user 文本
                              ↓
[发送] → messages.jsonl 追加 user
                              ↓
[模型] → 可能 tool_calls（含 analyze_images）
                              ↓
              ┌───────────────┴───────────────┐
              ↓                               ↓
     业务 tool 结果                    VLM: 读盘 → 多模态 API
              ↓                      → vlm/{threadId}.jsonl
              └───────────────┬───────────────┘
                              ↓
              assistant content（无 reasoning）
                              ↓
              整包写回 messages.jsonl + meta.json
```

**Resume** = 再读该 `sessionId` 的 `messages.jsonl`（+ 需要时的 `vlm/*.jsonl`）继续循环。

---

## 12. 相关文件

- `src/agents/meta-agent.js` — 引擎、工具、JSONL 存储
- `src/app.js` — `/api/ai/*`
- `public/agent-panel.js` — UI：对话 / 历史 / 报告 / 配置
- `public/style.css` — 面板样式
- `.env.example` — `AI_DATA_DIR` 说明
- `README.md` — 功能表摘要

---

*文档对应实现阶段：Meta Agent 初版 + 路径引用 VLM + session 目录 JSONL + 历史 Resume。若后续把 reasoning 独立落盘或 UI 展示，在 §6.4 扩展即可，无需改动 messages 契约。*
