# chivox-local-mcp

[English](#english-version) | 中文

驰声语音评测 MCP 本地代理 — 让 AI 助手具备语音评测能力。

通过 [Model Context Protocol](https://modelcontextprotocol.io/) 将驰声评测服务接入 Claude Desktop、Claude Code、Cursor 等 AI 工具，支持中英文单词、句子、段落评测，以及实时麦克风录音评测。

---

## 目录

- [项目概述](#项目概述)
- [架构设计](#架构设计)
- [快速上手](#快速上手)
- [各平台配置详解](#各平台配置详解)
- [使用场景与示例](#使用场景与示例)
- [评测类型 (core_type) 参考](#评测类型-core_type-参考)
- [工具 API 参考](#工具-api-参考)
- [评测结果详解](#评测结果详解)
- [环境变量](#环境变量)
- [常见问题与排障](#常见问题与排障)
- [开发指南](#开发指南)
- [License](#license)

---

## 项目概述

### 解决什么问题

AI 助手（如 Claude）本身不具备语音评测能力，也无法直接访问麦克风。`chivox-local-mcp` 作为 MCP 本地代理，解决了两个关键问题：

1. **本地硬件访问** — 通过 SoX 调用本地麦克风录音，让 AI 助手能实时捕获用户语音
2. **远程服务桥接** — 将本地音频流通过 WebSocket 推送到驰声远程评测服务，获取专业的发音评分

### 核心能力

| 能力 | 说明 |
|---|---|
| 实时录音评测 | 启动麦克风 → 实时推送音频 → 获取评分 |
| 音频文件评测 | 读取本地音频文件 → 自动转 base64 → 远程评测 |
| 中文评测 | 单字（汉字/拼音）、词句、段落、口语表达 |
| 英文评测 | 单词、句子、段落、纠音、自然拼读、选择题 |
| 自动重连 | 远程服务断连后自动重连，保障稳定性 |
| 优雅关闭 | 收到退出信号时清理所有录音进程和 WebSocket 连接 |

### 技术栈

- **运行时**：Node.js >= 18（ESM 模块）
- **语言**：TypeScript（编译为 ES2022）
- **协议**：MCP SDK `@modelcontextprotocol/sdk ^1.12.0`
- **音频采集**：SoX `rec` 命令（MP3, 16kHz, 单声道）
- **流式传输**：`ws ^8.20.0` WebSocket 客户端
- **传输层**：Stdio（AI 客户端 ↔ 代理）+ HTTP/WS（代理 ↔ 远程服务）

---

## 架构设计

```
┌─────────────────┐     stdio      ┌──────────────────────────┐    HTTP/WS    ┌─────────────────┐
│  Claude Desktop │ ◄────────────► │    chivox-local-mcp      │ ◄──────────► │ Remote Chivox   │
│  / Claude Code  │                │      (本地代理)           │              │ MCP Server      │
│  / Cursor       │                │                          │              │                 │
└─────────────────┘                │  ┌──────────┐            │              └─────────────────┘
                                   │  │ SoX 录音  │            │
                                   │  │ (麦克风)   │            │
                                   │  └──────────┘            │
                                   └──────────────────────────┘
```

### 数据流

**实时录音评测流程：**

```
用户说话 → 麦克风 → SoX (rec) → stdout 音频流 → Node.js Buffer
    → 定时切片(100ms/3200bytes) → WebSocket 推送 → 远程评测引擎
    → 评测结果 JSON → WebSocket 返回 → AI 解读并呈现给用户
```

**音频文件评测流程：**

```
AI 调用 tool(audio_file_path="/path/to/file.mp3")
    → 本地代理拦截 → readFileSync → base64 编码
    → 替换为 audio_base64 参数 → HTTP 转发到远程服务
    → 评测结果返回 → AI 解读并呈现给用户
```

### 三层通信协议

| 层级 | 协议 | 用途 |
|---|---|---|
| AI 客户端 ↔ 本地代理 | **stdio** | MCP 协议通信（JSON-RPC over stdin/stdout） |
| 本地代理 ↔ 远程服务 | **HTTP** (StreamableHTTP) | 工具列表查询、非流式评测调用 |
| 本地代理 ↔ 远程服务 | **WebSocket** | 实时音频流推送、评测结果接收 |

---

## 快速上手

### 第 1 步：确认环境

```bash
# 检查 Node.js 版本（需 >= 18）
node -v

# 检查 SoX 是否已安装（可选，仅实时录音需要）
rec --version
```

**安装 SoX（如需实时录音）：**

```bash
# macOS
brew install sox

# Ubuntu / Debian
sudo apt-get install sox

# Windows
# 从 https://sox.sourceforge.net/ 下载安装，并添加到 PATH
```

### 第 2 步：安装

**方式一：源码安装（推荐开发者）**

```bash
git clone https://git.chivox.com/CLOUD_DEV/cvx_local_mcp.git
cd cvx_local_mcp
npm install
npm run build
```

**方式二：构建脚本安装**

```bash
git clone https://git.chivox.com/CLOUD_DEV/cvx_local_mcp.git
cd cvx_local_mcp
bash scripts/build.sh
```

### 第 3 步：配置到 AI 客户端

> 详见下方「各平台配置详解」章节。

### 第 4 步：重启 AI 客户端并开始使用

重启客户端后，直接用自然语言对话：

```
你：请评测我的英语发音，文本是 Good morning
AI：(自动启动录音) 录音中，请说 Good morning，说完告诉我
你：说完了
AI：评测结果：总分 92，准确度 95，流利度 88...
```

---

## 各平台配置详解

### Claude Desktop

编辑配置文件：

- **macOS**：`~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**：`%APPDATA%\Claude\claude_desktop_config.json`

**源码安装方式（使用默认云服务）：**

```json
{
  "mcpServers": {
    "chivox": {
      "command": "node",
      "args": ["/absolute/path/to/cvx_local_mcp/dist/index.js"]
    }
  }
}
```

**源码安装方式（指定自定义服务地址）：**

```json
{
  "mcpServers": {
    "chivox": {
      "command": "node",
      "args": ["/absolute/path/to/cvx_local_mcp/dist/index.js"],
      "env": {
        "MCP_REMOTE_URL": "http://your-server:8080",
        "MCP_API_KEY": "your-api-key"
      }
    }
  }
}
```

**全局安装方式：**

```json
{
  "mcpServers": {
    "chivox": {
      "command": "chivox-local-mcp"
    }
  }
}
```

> 不设置 `MCP_REMOTE_URL` 时默认连接 `https://mcp.cloud.chivox.com`。`MCP_API_KEY` 仅在远程服务要求认证时需要。

### Claude Code (CLI)

```bash
# 源码安装方式（使用默认云服务）
claude mcp add chivox -- \
  node /absolute/path/to/cvx_local_mcp/dist/index.js

# 全局安装方式（使用默认云服务）
claude mcp add chivox -- chivox-local-mcp

# 指定自定义服务地址
claude mcp add chivox -- \
  env MCP_REMOTE_URL=http://your-server:8080 \
  env MCP_API_KEY=your-api-key \
  chivox-local-mcp
```

验证是否添加成功：

```bash
claude mcp list
```

### Cursor

在 Cursor 设置中添加 MCP Server 配置，格式与 Claude Desktop 相同。

### 其他 MCP 客户端

任何支持 MCP 协议的客户端均可接入，只需配置：

- **command**：`node /path/to/dist/index.js` 或 `chivox-local-mcp`
- **环境变量**：`MCP_REMOTE_URL`（选填，默认 `https://mcp.cloud.chivox.com`）、`MCP_API_KEY`（选填）

---

## 使用场景与示例

### 场景一：实时麦克风录音评测

AI 会自动调用三个工具（`create_stream_session` → `start_recording` → `stop_recording`），用户只需对着麦克风朗读。

**你可以这样说：**

```
"评测我的英语发音，文本是 How are you"
"我想练习中文朗读，文本是 春眠不觉晓"
"帮我测试这个句子的发音：The quick brown fox jumps over the lazy dog"
```

**完整对话流程：**

```
你：帮我评测英语发音，句子是 I love programming
AI：好的，我来创建评测会话并启动录音。
    (调用 create_stream_session → start_recording)
    录音已开始，请对着麦克风说 "I love programming"。说完后告诉我。
你：说完了
AI：(调用 stop_recording)
    评测结果如下：
    - 总分：88/100
    - 准确度：90
    - 流利度：85
    - 完整度：100
    其中 "programming" 的 /ɡr/ 音素得分偏低(72)，建议注意舌位...
```

### 场景二：音频文件评测

已有录音文件时，直接告诉 AI 文件路径。支持 mp3、wav 等常见格式。

**你可以这样说：**

```
"评测这个音频 /Users/me/recordings/hello.mp3，文本是 Hello world"
"帮我给这个录音打分 ~/test.wav，内容是 你好世界"
```

> 本地代理会自动将文件读取并转为 base64 传输，无需手动处理。

### 场景三：发音纠正

AI 不仅打分，还能指出具体哪个音素发音有问题，并给出改进建议。

**你可以这样说：**

```
"帮我纠正 beautiful 这个单词的发音"
"我读了一句 She sells seashells，帮我看看哪里不标准"
```

### 场景四：批量词汇评测

同时评测多个单词的发音。

```
"帮我评测这几个单词的发音：apple, banana, cherry"
```

### 场景五：口语选择题 / 半开放题

适用于教育场景的互动式口语测试。

```
"出一道英语口语选择题来测试我"
"模拟一个买咖啡的对话场景来评测我的口语"
```

---

## 评测类型 (core_type) 参考

`core_type` 是创建流式评测会话时的关键参数，决定了评测引擎的评判方式。

### 英文评测类型

| core_type | 说明 | 适用场景 |
|---|---|---|
| `en.word.score` | 英文单词评分 | 单个单词发音评测 |
| `en.sent.score` | 英文句子评分 | 句子朗读评测 |
| `en.para.score` | 英文段落评分 | 段落/课文朗读评测 |
| `en.word.pron` | 英文单词纠音 | 单词发音纠正，返回音素级详情 |
| `en.sent.pron` | 英文句子纠音 | 句子发音纠正 |

### 中文评测类型

| core_type | 说明 | 适用场景 |
|---|---|---|
| `cn.sent.raw` | 中文词句评测（汉字） | 中文句子朗读评测 |
| `cn.sent.score` | 中文词句评分 | 中文句子评分 |
| `cn.para.score` | 中文段落评分 | 中文段落/课文朗读 |
| `cn.word.raw` | 中文单字评测（汉字） | 单个汉字发音评测 |

> AI 助手通常会根据你的描述自动选择合适的 `core_type`，无需手动指定。

---

## 工具 API 参考

### 本地工具（实时录音评测）

AI 会按顺序自动调用以下三个工具，用户无需手动操作：

```
create_stream_session → start_recording → [用户朗读] → stop_recording
```

#### 1. `create_stream_session`

创建流式评测会话，返回 `session_id` 和 WebSocket 地址。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `core_type` | string | 是 | — | 评测类型，见「评测类型参考」 |
| `ref_text` | string | 是 | — | 评测参考文本（用户需要朗读的内容） |
| `audio_type` | string | 否 | `mp3` | 音频格式：`mp3`、`wav`、`pcm` |
| `sample_rate` | number | 否 | `16000` | 采样率（Hz） |
| `rank` | number | 否 | `100` | 评分制：`4`（四分制）或 `100`（百分制） |

**返回示例：**

```json
{
  "session_id": "abc123",
  "ws_url": "ws://your-server:8080/ws/audio/abc123"
}
```

#### 2. `start_recording`

启动本地麦克风录音，通过 WebSocket 将音频流实时推送到评测服务。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `session_id` | string | 是 | — | 来自 `create_stream_session` 的会话 ID |
| `chunk_size` | number | 否 | `3200` | 每次推送的音频块大小（bytes） |
| `chunk_interval_ms` | number | 否 | `100` | 音频块推送间隔（ms） |

**内部行为：**

1. 建立 WebSocket 连接到 `ws://[host]:[port]/ws/audio/[session_id]`
2. 启动 SoX 录音进程：`rec -q -t mp3 -r 16000 -c 1 -`
3. 将 SoX stdout 输出的音频数据写入内存 Buffer
4. 按 `chunk_interval_ms` 间隔从 Buffer 中取出 `chunk_size` 大小的数据，通过 WebSocket 发送

**返回示例：**

```json
{
  "status": "recording",
  "session_id": "abc123",
  "ws_url": "ws://your-server:8080/ws/audio/abc123",
  "chunk_size": 3200
}
```

#### 3. `stop_recording`

停止录音，等待剩余音频发送完毕，获取评测结果。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `session_id` | string | 是 | — | 会话 ID |
| `timeout` | number | 否 | `30` | 等待评测结果的超时秒数 |

**内部行为：**

1. 终止 SoX 录音进程（SIGTERM）
2. 等待 Buffer 中剩余音频数据全部发送完毕（最长等待 5 秒）
3. 通过 WebSocket 发送 `{"cmd": "stop"}` 指令
4. 等待远程服务返回 `{"type": "result", "data": {...}}` 评测结果
5. 关闭 WebSocket 连接，清理会话资源

### 远程代理工具（音频文件评测）

这些工具由远程驰声 MCP 服务提供，本地代理负责透传。当参数中包含 `audio_file_path` 时，代理会自动将本地文件转为 `audio_base64`。

**音频输入方式（三选一）：**

| 参数 | 说明 |
|---|---|
| `audio_file_path` | 本地文件路径，代理自动读取转 base64 |
| `audio_base64` | 已编码的 base64 音频数据 |
| `audio_url` | 音频文件的网络 URL |

#### 中文评测工具

| 工具 | 说明 | 适用场景 |
|---|---|---|
| `cn_word_raw_eval` | 单字评测（汉字输入） | 评测"中"的发音 |
| `cn_word_pinyin_eval` | 单字评测（拼音输入） | 评测"zhōng"的发音 |
| `cn_sentence_eval` | 词句评测 | 评测"你好世界"的朗读 |
| `cn_paragraph_eval` | 段落朗读评测 | 评测一段中文课文 |
| `cn_rec_eval` | 有限分支识别评测 | 从预设选项中识别用户发音 |
| `cn_aitalk_eval` | AI Talk 口语评测 | 中文口语表达能力评测 |

#### 英文评测工具

| 工具 | 说明 | 适用场景 |
|---|---|---|
| `en_word_eval` | 单词评测 | 评测"Hello"的发音 |
| `en_word_correction` | 单词纠音 | 给出发音纠正建议 |
| `en_vocab_eval` | 词语评测 | 同时评测多个单词 |
| `en_sentence_eval` | 句子评测 | 评测整句朗读 |
| `en_sentence_correction` | 句子纠音 | 句子发音纠正建议 |
| `en_paragraph_eval` | 段落朗读评测 | 评测一段英文课文 |
| `en_phonics_eval` | 自然拼读评测 | 评测自然拼读发音 |
| `en_choice_eval` | 口语选择题 | 口语选择题评测 |
| `en_semi_open_eval` | 半开放题评测 | 场景对话等半开放题型 |
| `en_realtime_eval` | 实时朗读评测 | 实时反馈朗读质量 |

---

## 评测结果详解

评测返回的 JSON 结果包含多维度评分：

| 字段 | 说明 | 取值范围 |
|---|---|---|
| `overall` | 综合总分 | 0–100 |
| `accuracy` | 准确度得分（发音是否正确） | 0–100 |
| `pron` | 发音得分（综合音素质量） | 0–100 |
| `fluency.overall` | 流利度得分（语速、停顿） | 0–100 |
| `integrity` | 完整度得分（是否完整朗读） | 0–100 |
| `details[]` | 每个单词/音节的详细评分 | 数组 |
| `details[].phone[]` | 音素级别得分 | 数组 |
| `details[].stress[]` | 重音/声调得分 | 数组 |

**结果示例（英文句子评测）：**

```json
{
  "overall": 88,
  "accuracy": 90,
  "pron": 87,
  "fluency": {
    "overall": 85
  },
  "integrity": 100,
  "details": [
    {
      "word": "Hello",
      "score": 92,
      "phone": [
        { "phone": "HH", "score": 95 },
        { "phone": "AH", "score": 88 },
        { "phone": "L", "score": 93 },
        { "phone": "OW", "score": 90 }
      ]
    },
    {
      "word": "world",
      "score": 84,
      "phone": [
        { "phone": "W", "score": 90 },
        { "phone": "ER", "score": 75 },
        { "phone": "L", "score": 88 },
        { "phone": "D", "score": 82 }
      ]
    }
  ]
}
```

---

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `MCP_REMOTE_URL` | 否 | 远程驰声 MCP 服务地址（默认 `https://mcp.cloud.chivox.com`） |
| `MCP_API_KEY` | 否 | API 认证密钥（远程服务开启认证时需要） |

如未设置 `MCP_REMOTE_URL`，将自动连接驰声官方云服务 `https://mcp.cloud.chivox.com`。环境变量通过 AI 客户端配置中的 `env` 字段传入，无需在系统中全局设置。

---

## 常见问题与排障

### 安装与环境

**Q: 录音时提示找不到 `rec` 命令？**

A: 需要安装 SoX：

```bash
# macOS
brew install sox

# Ubuntu / Debian
sudo apt-get install sox

# Windows
# 从 https://sox.sourceforge.net/ 下载安装，添加到 PATH
```

安装后验证：`rec --version`

**Q: Node.js 版本不满足要求？**

A: 本项目要求 Node.js >= 18。推荐使用 [nvm](https://github.com/nvm-sh/nvm) 管理版本：

```bash
nvm install 18
nvm use 18
```

### 连接问题

**Q: 连接远程服务失败？**

A: 排查步骤：

1. 检查 `MCP_REMOTE_URL` 格式是否正确（需包含协议和端口，如 `http://your-server:8080`）；未设置时默认为 `https://mcp.cloud.chivox.com`
2. 确认远程服务已启动且网络可达：`curl http://your-server:8080`
3. 如有防火墙，确认端口已放行
4. 检查 `MCP_API_KEY` 是否正确（如远程服务要求认证）

**Q: WebSocket 连接超时？**

A: WebSocket 连接默认 10 秒超时。检查远程服务是否支持 WebSocket 连接，路径格式为 `ws://[host]:[port]/ws/audio/[session_id]`。

### 评测问题

**Q: 评测返回所有得分为 0？**

A: 可能原因：

- 录音中无有效语音（环境太安静或太嘈杂）
- 音频内容与参考文本（`ref_text`）不匹配
- 音频质量问题（采样率过低、格式不支持）
- 录音时间过短，未捕获到完整语音

**Q: 录音时间过长导致评测失败？**

A: 单词评测对音频时长有限制。录音开始后尽快朗读目标文本并结束。句子和段落评测对时长限制较宽松。

**Q: 评测结果中某些音素得分异常？**

A: 可能原因：

- 背景噪音干扰
- 麦克风距离过远或过近
- 朗读速度过快或过慢

### 平台兼容性

**Q: Windows 系统可以使用吗？**

A: 可以。需要：

1. 安装 Node.js >= 18
2. 从 [SoX 官网](https://sox.sourceforge.net/) 下载 Windows 版本并添加到 PATH
3. 配置方式与 macOS 相同

**Q: 不安装 SoX 可以使用吗？**

A: 可以使用音频文件评测功能（所有远程代理工具）。实时麦克风录音评测需要 SoX。

### 日志与调试

代理以 JSON 格式将日志输出到 stderr，可在终端中手动启动查看：

```bash
MCP_REMOTE_URL=http://your-server:8080 node /path/to/dist/index.js
```

日志示例：

```json
{"time":"2026-04-20T10:00:00.000Z","level":"info","msg":"已连接远程 MCP 服务","url":"http://your-server:8080"}
{"time":"2026-04-20T10:00:01.000Z","level":"info","msg":"Stdio 代理已启动"}
{"time":"2026-04-20T10:00:05.000Z","level":"info","msg":"tool 调用","tool":"create_stream_session"}
```

---

## 开发指南

### 项目结构

```
cvx_local_mcp/
├── src/
│   └── index.ts          # 主源码（MCP 代理服务）
├── dist/                  # 编译输出
│   ├── index.js           # 可执行入口
│   └── index.d.ts         # 类型声明
├── scripts/
│   └── build.sh           # 构建/检查/发布脚本
├── docs/
│   └── index.html         # HTML 文档页
├── package.json
├── tsconfig.json
└── README.md
```

### 开发命令

```bash
npm install               # 安装依赖
npm run build             # 编译 TypeScript
npm run rebuild           # 清理并重新编译
npm run start             # 启动服务（需设置环境变量）
npm run publish:check     # 编译 + 发布前检查
npm run publish:release   # 编译 + 检查 + 发布到 npm
```

### 源码核心模块

`src/index.ts` 约 378 行，结构清晰：

| 模块 | 行数 | 功能 |
|---|---|---|
| 日志 | 15–23 | 结构化 JSON 日志输出到 stderr |
| 会话管理 | 25–73 | `RecordingSession` 接口、Buffer 管理、定时切片推送 |
| 本地工具定义 | 77–118 | 三个本地 tool 的 JSON Schema 定义 |
| 主程序 | 124–378 | 远程连接、重连逻辑、工具路由、优雅关闭 |

### 关键实现细节

**音频切片推送**：`startPushingChunks()` 使用 `setInterval` 定时（默认 100ms）从 Buffer 中提取固定大小（默认 3200 bytes）的音频块，通过 WebSocket 二进制帧发送。当录音停止且 Buffer 清空后自动停止定时器。

**工具路由策略**：

- `create_stream_session` — 直接转发到远程（远程创建会话并返回 session_id）
- `start_recording` — 本地拦截处理（建立 WebSocket、启动 SoX、管理 Buffer）
- `stop_recording` — 本地拦截处理（停止 SoX、等待 Buffer 排空、发送 stop 指令、接收结果）
- 其他工具 — 透传到远程（如有 `audio_file_path` 则先转 base64）

**自动重连**：`callWithReconnect()` 包装器在远程调用失败时自动重新建立 HTTP 连接并重试一次。

---

## License

MIT

---

## English Version

English | [中文](#chivox-local-mcp)

Chivox Speech Evaluation MCP Local Proxy — Bring speech evaluation capabilities to AI assistants.

Integrate Chivox speech evaluation services into AI tools like Claude Desktop, Claude Code, and Cursor via the [Model Context Protocol](https://modelcontextprotocol.io/). Supports Chinese and English word, sentence, and paragraph evaluation, as well as real-time microphone recording evaluation.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Platform Configuration](#platform-configuration)
- [Usage Scenarios & Examples](#usage-scenarios--examples)
- [Evaluation Types (core_type) Reference](#evaluation-types-core_type-reference)
- [Tool API Reference](#tool-api-reference)
- [Evaluation Results](#evaluation-results)
- [Environment Variables](#environment-variables)
- [FAQ & Troubleshooting](#faq--troubleshooting)
- [Development Guide](#development-guide)
- [License](#license-1)

---

## Overview

### What Problem Does It Solve

AI assistants (like Claude) cannot natively evaluate speech pronunciation or access the microphone. `chivox-local-mcp` serves as a local MCP proxy that solves two key problems:

1. **Local Hardware Access** — Uses SoX to capture microphone audio, enabling AI assistants to capture user speech in real time
2. **Remote Service Bridging** — Pushes local audio streams via WebSocket to the Chivox remote evaluation service for professional pronunciation scoring

### Core Capabilities

| Capability | Description |
|---|---|
| Real-time Recording Evaluation | Start microphone → stream audio in real time → get scores |
| Audio File Evaluation | Read local audio files → auto-convert to base64 → remote evaluation |
| Chinese Evaluation | Single characters (hanzi/pinyin), words & sentences, paragraphs, oral expression |
| English Evaluation | Words, sentences, paragraphs, pronunciation correction, phonics, choice questions |
| Auto-reconnect | Automatically reconnects after remote service disconnection |
| Graceful Shutdown | Cleans up all recording processes and WebSocket connections on exit signals |

### Tech Stack

- **Runtime**: Node.js >= 18 (ESM modules)
- **Language**: TypeScript (compiled to ES2022)
- **Protocol**: MCP SDK `@modelcontextprotocol/sdk ^1.12.0`
- **Audio Capture**: SoX `rec` command (MP3, 16kHz, mono)
- **Streaming**: `ws ^8.20.0` WebSocket client
- **Transport**: Stdio (AI client ↔ proxy) + HTTP/WS (proxy ↔ remote service)

---

## Architecture

```
┌─────────────────┐     stdio      ┌──────────────────────────┐    HTTP/WS    ┌─────────────────┐
│  Claude Desktop │ ◄────────────► │    chivox-local-mcp      │ ◄──────────► │ Remote Chivox   │
│  / Claude Code  │                │     (Local Proxy)        │              │ MCP Server      │
│  / Cursor       │                │                          │              │                 │
└─────────────────┘                │  ┌──────────┐            │              └─────────────────┘
                                   │  │ SoX Rec   │            │
                                   │  │ (Mic)     │            │
                                   │  └──────────┘            │
                                   └──────────────────────────┘
```

### Data Flow

**Real-time Recording Evaluation:**

```
User speaks → Microphone → SoX (rec) → stdout audio stream → Node.js Buffer
    → Timed chunking (100ms/3200bytes) → WebSocket push → Remote evaluation engine
    → Evaluation result JSON → WebSocket return → AI interprets and presents to user
```

**Audio File Evaluation:**

```
AI calls tool(audio_file_path="/path/to/file.mp3")
    → Local proxy intercepts → readFileSync → base64 encoding
    → Replaces with audio_base64 parameter → HTTP forward to remote service
    → Evaluation result returned → AI interprets and presents to user
```

### Three-Layer Communication Protocol

| Layer | Protocol | Purpose |
|---|---|---|
| AI Client ↔ Local Proxy | **stdio** | MCP protocol communication (JSON-RPC over stdin/stdout) |
| Local Proxy ↔ Remote Service | **HTTP** (StreamableHTTP) | Tool listing, non-streaming evaluation calls |
| Local Proxy ↔ Remote Service | **WebSocket** | Real-time audio streaming, evaluation result reception |

---

## Quick Start

### Step 1: Check Prerequisites

```bash
# Check Node.js version (>= 18 required)
node -v

# Check if SoX is installed (optional, only needed for real-time recording)
rec --version
```

**Install SoX (if real-time recording is needed):**

```bash
# macOS
brew install sox

# Ubuntu / Debian
sudo apt-get install sox

# Windows
# Download from https://sox.sourceforge.net/ and add to PATH
```

### Step 2: Install

**Option 1: Install from source (recommended for developers)**

```bash
git clone https://git.chivox.com/CLOUD_DEV/cvx_local_mcp.git
cd cvx_local_mcp
npm install
npm run build
```

**Option 2: Build script**

```bash
git clone https://git.chivox.com/CLOUD_DEV/cvx_local_mcp.git
cd cvx_local_mcp
bash scripts/build.sh
```

### Step 3: Configure AI Client

> See the "Platform Configuration" section below.

### Step 4: Restart AI Client and Start Using

After restarting the client, use natural language:

```
You: Please evaluate my English pronunciation, the text is "Good morning"
AI: (starts recording) Recording... please say "Good morning", tell me when you're done
You: I'm done
AI: Evaluation result: Overall score 92, Accuracy 95, Fluency 88...
```

---

## Platform Configuration

### Claude Desktop

Edit the configuration file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

**From source (using default cloud service):**

```json
{
  "mcpServers": {
    "chivox": {
      "command": "node",
      "args": ["/absolute/path/to/cvx_local_mcp/dist/index.js"]
    }
  }
}
```

**From source (with custom server URL):**

```json
{
  "mcpServers": {
    "chivox": {
      "command": "node",
      "args": ["/absolute/path/to/cvx_local_mcp/dist/index.js"],
      "env": {
        "MCP_REMOTE_URL": "http://your-server:8080",
        "MCP_API_KEY": "your-api-key"
      }
    }
  }
}
```

**Global install:**

```json
{
  "mcpServers": {
    "chivox": {
      "command": "chivox-local-mcp"
    }
  }
}
```

> When `MCP_REMOTE_URL` is not set, it defaults to `https://mcp.cloud.chivox.com`. `MCP_API_KEY` is only needed when the remote service requires authentication.

### Claude Code (CLI)

```bash
# From source (using default cloud service)
claude mcp add chivox -- \
  node /absolute/path/to/cvx_local_mcp/dist/index.js

# Global install (using default cloud service)
claude mcp add chivox -- chivox-local-mcp

# With custom server URL
claude mcp add chivox -- \
  env MCP_REMOTE_URL=http://your-server:8080 \
  env MCP_API_KEY=your-api-key \
  chivox-local-mcp
```

Verify it was added successfully:

```bash
claude mcp list
```

### Cursor

Add MCP Server configuration in Cursor settings, using the same format as Claude Desktop.

### Other MCP Clients

Any MCP-compatible client can integrate. Simply configure:

- **command**: `node /path/to/dist/index.js` or `chivox-local-mcp`
- **Environment variables**: `MCP_REMOTE_URL` (optional, defaults to `https://mcp.cloud.chivox.com`), `MCP_API_KEY` (optional)

---

## Usage Scenarios & Examples

### Scenario 1: Real-time Microphone Recording Evaluation

The AI automatically calls three tools (`create_stream_session` → `start_recording` → `stop_recording`). Users just speak into the microphone.

**You can say:**

```
"Evaluate my English pronunciation, the text is How are you"
"I want to practice Chinese reading, the text is 春眠不觉晓"
"Test my pronunciation of this sentence: The quick brown fox jumps over the lazy dog"
```

**Full conversation flow:**

```
You: Evaluate my English pronunciation, the sentence is "I love programming"
AI: OK, I'll create an evaluation session and start recording.
    (calls create_stream_session → start_recording)
    Recording started. Please say "I love programming" into your microphone. Tell me when you're done.
You: I'm done
AI: (calls stop_recording)
    Evaluation results:
    - Overall: 88/100
    - Accuracy: 90
    - Fluency: 85
    - Integrity: 100
    The /ɡr/ phoneme in "programming" scored lower (72), consider adjusting tongue position...
```

### Scenario 2: Audio File Evaluation

For existing audio files, just tell the AI the file path. Supports mp3, wav, and other common formats.

**You can say:**

```
"Evaluate this audio /Users/me/recordings/hello.mp3, the text is Hello world"
"Score this recording ~/test.wav, the content is 你好世界"
```

> The local proxy automatically reads and converts the file to base64 — no manual processing needed.

### Scenario 3: Pronunciation Correction

The AI not only scores but also identifies specific phoneme issues and provides improvement suggestions.

**You can say:**

```
"Help me correct the pronunciation of beautiful"
"I read the sentence She sells seashells, check what's not standard"
```

### Scenario 4: Batch Vocabulary Evaluation

Evaluate multiple words at once.

```
"Evaluate my pronunciation of these words: apple, banana, cherry"
```

### Scenario 5: Oral Choice Questions / Semi-open Questions

Interactive oral tests for educational scenarios.

```
"Give me an English oral choice question to test me"
"Simulate a coffee-ordering dialogue to evaluate my speaking"
```

---

## Evaluation Types (core_type) Reference

`core_type` is the key parameter when creating a streaming evaluation session. It determines how the evaluation engine judges pronunciation.

### English Evaluation Types

| core_type | Description | Use Case |
|---|---|---|
| `en.word.score` | English word scoring | Single word pronunciation evaluation |
| `en.sent.score` | English sentence scoring | Sentence reading evaluation |
| `en.para.score` | English paragraph scoring | Paragraph/text reading evaluation |
| `en.word.pron` | English word correction | Word pronunciation correction with phoneme-level details |
| `en.sent.pron` | English sentence correction | Sentence pronunciation correction |

### Chinese Evaluation Types

| core_type | Description | Use Case |
|---|---|---|
| `cn.sent.raw` | Chinese word/sentence evaluation (hanzi) | Chinese sentence reading evaluation |
| `cn.sent.score` | Chinese word/sentence scoring | Chinese sentence scoring |
| `cn.para.score` | Chinese paragraph scoring | Chinese paragraph/text reading |
| `cn.word.raw` | Chinese single character evaluation (hanzi) | Single Chinese character pronunciation evaluation |

> The AI assistant will usually auto-select the appropriate `core_type` based on your description — no need to specify manually.

---

## Tool API Reference

### Local Tools (Real-time Recording Evaluation)

The AI automatically calls these three tools in sequence. No manual operation needed:

```
create_stream_session → start_recording → [user reads aloud] → stop_recording
```

#### 1. `create_stream_session`

Creates a streaming evaluation session and returns `session_id` and WebSocket address.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `core_type` | string | Yes | — | Evaluation type, see "Evaluation Types Reference" |
| `ref_text` | string | Yes | — | Reference text (what the user should read aloud) |
| `audio_type` | string | No | `mp3` | Audio format: `mp3`, `wav`, `pcm` |
| `sample_rate` | number | No | `16000` | Sample rate (Hz) |
| `rank` | number | No | `100` | Scoring scale: `4` (4-point) or `100` (100-point) |

**Response example:**

```json
{
  "session_id": "abc123",
  "ws_url": "ws://your-server:8080/ws/audio/abc123"
}
```

#### 2. `start_recording`

Starts local microphone recording and pushes the audio stream to the evaluation service via WebSocket.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `session_id` | string | Yes | — | Session ID from `create_stream_session` |
| `chunk_size` | number | No | `3200` | Audio chunk size per push (bytes) |
| `chunk_interval_ms` | number | No | `100` | Audio chunk push interval (ms) |

**Internal behavior:**

1. Establishes WebSocket connection to `ws://[host]:[port]/ws/audio/[session_id]`
2. Starts SoX recording process: `rec -q -t mp3 -r 16000 -c 1 -`
3. Writes SoX stdout audio data to an in-memory Buffer
4. Extracts `chunk_size` bytes from the Buffer at `chunk_interval_ms` intervals and sends via WebSocket

**Response example:**

```json
{
  "status": "recording",
  "session_id": "abc123",
  "ws_url": "ws://your-server:8080/ws/audio/abc123",
  "chunk_size": 3200
}
```

#### 3. `stop_recording`

Stops recording, waits for remaining audio to be sent, and retrieves evaluation results.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `session_id` | string | Yes | — | Session ID |
| `timeout` | number | No | `30` | Timeout in seconds for waiting on evaluation results |

**Internal behavior:**

1. Terminates the SoX recording process (SIGTERM)
2. Waits for all remaining audio data in the Buffer to be sent (up to 5 seconds)
3. Sends `{"cmd": "stop"}` command via WebSocket
4. Waits for remote service to return `{"type": "result", "data": {...}}` evaluation result
5. Closes WebSocket connection and cleans up session resources

### Remote Proxy Tools (Audio File Evaluation)

These tools are provided by the remote Chivox MCP service and proxied through the local agent. When `audio_file_path` is included in parameters, the proxy automatically converts local files to `audio_base64`.

**Audio input methods (choose one):**

| Parameter | Description |
|---|---|
| `audio_file_path` | Local file path, proxy auto-reads and converts to base64 |
| `audio_base64` | Pre-encoded base64 audio data |
| `audio_url` | Audio file URL |

#### Chinese Evaluation Tools

| Tool | Description | Use Case |
|---|---|---|
| `cn_word_raw_eval` | Single character evaluation (hanzi input) | Evaluate pronunciation of "中" |
| `cn_word_pinyin_eval` | Single character evaluation (pinyin input) | Evaluate pronunciation of "zhōng" |
| `cn_sentence_eval` | Word/sentence evaluation | Evaluate reading of "你好世界" |
| `cn_paragraph_eval` | Paragraph reading evaluation | Evaluate a Chinese text passage |
| `cn_rec_eval` | Limited-branch recognition evaluation | Identify user pronunciation from preset options |
| `cn_aitalk_eval` | AI Talk oral evaluation | Chinese oral expression evaluation |

#### English Evaluation Tools

| Tool | Description | Use Case |
|---|---|---|
| `en_word_eval` | Word evaluation | Evaluate pronunciation of "Hello" |
| `en_word_correction` | Word correction | Provide pronunciation correction suggestions |
| `en_vocab_eval` | Vocabulary evaluation | Evaluate multiple words at once |
| `en_sentence_eval` | Sentence evaluation | Evaluate sentence reading |
| `en_sentence_correction` | Sentence correction | Sentence pronunciation correction suggestions |
| `en_paragraph_eval` | Paragraph reading evaluation | Evaluate an English text passage |
| `en_phonics_eval` | Phonics evaluation | Evaluate phonics pronunciation |
| `en_choice_eval` | Oral choice questions | Oral choice question evaluation |
| `en_semi_open_eval` | Semi-open question evaluation | Scenario dialogues and semi-open question types |
| `en_realtime_eval` | Real-time reading evaluation | Real-time reading quality feedback |

---

## Evaluation Results

Evaluation results are returned as JSON with multi-dimensional scores:

| Field | Description | Range |
|---|---|---|
| `overall` | Overall score | 0–100 |
| `accuracy` | Accuracy score (correct pronunciation) | 0–100 |
| `pron` | Pronunciation score (overall phoneme quality) | 0–100 |
| `fluency.overall` | Fluency score (speed, pauses) | 0–100 |
| `integrity` | Integrity score (complete reading) | 0–100 |
| `details[]` | Detailed scores for each word/syllable | Array |
| `details[].phone[]` | Phoneme-level scores | Array |
| `details[].stress[]` | Stress/tone scores | Array |

**Example result (English sentence evaluation):**

```json
{
  "overall": 88,
  "accuracy": 90,
  "pron": 87,
  "fluency": {
    "overall": 85
  },
  "integrity": 100,
  "details": [
    {
      "word": "Hello",
      "score": 92,
      "phone": [
        { "phone": "HH", "score": 95 },
        { "phone": "AH", "score": 88 },
        { "phone": "L", "score": 93 },
        { "phone": "OW", "score": 90 }
      ]
    },
    {
      "word": "world",
      "score": 84,
      "phone": [
        { "phone": "W", "score": 90 },
        { "phone": "ER", "score": 75 },
        { "phone": "L", "score": 88 },
        { "phone": "D", "score": 82 }
      ]
    }
  ]
}
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `MCP_REMOTE_URL` | No | Remote Chivox MCP service URL (defaults to `https://mcp.cloud.chivox.com`) |
| `MCP_API_KEY` | No | API authentication key (needed when remote service requires auth) |

If `MCP_REMOTE_URL` is not set, it automatically connects to the Chivox official cloud service at `https://mcp.cloud.chivox.com`. Environment variables are passed via the `env` field in the AI client configuration — no need to set them globally.

---

## FAQ & Troubleshooting

### Installation & Environment

**Q: `rec` command not found when recording?**

A: You need to install SoX:

```bash
# macOS
brew install sox

# Ubuntu / Debian
sudo apt-get install sox

# Windows
# Download from https://sox.sourceforge.net/ and add to PATH
```

Verify after installation: `rec --version`

**Q: Node.js version doesn't meet requirements?**

A: This project requires Node.js >= 18. We recommend using [nvm](https://github.com/nvm-sh/nvm) to manage versions:

```bash
nvm install 18
nvm use 18
```

### Connection Issues

**Q: Failed to connect to remote service?**

A: Troubleshooting steps:

1. Check that `MCP_REMOTE_URL` format is correct (include protocol and port, e.g., `http://your-server:8080`); defaults to `https://mcp.cloud.chivox.com` when not set
2. Confirm remote service is running and reachable: `curl http://your-server:8080`
3. If there's a firewall, confirm the port is open
4. Check that `MCP_API_KEY` is correct (if remote service requires auth)

**Q: WebSocket connection timeout?**

A: WebSocket connection has a 10-second timeout by default. Check that the remote service supports WebSocket connections with the path format `ws://[host]:[port]/ws/audio/[session_id]`.

### Evaluation Issues

**Q: All evaluation scores are 0?**

A: Possible causes:

- No valid speech in recording (environment too quiet or too noisy)
- Audio content doesn't match reference text (`ref_text`)
- Audio quality issues (sample rate too low, unsupported format)
- Recording too short, didn't capture complete speech

**Q: Recording too long causes evaluation failure?**

A: Word evaluation has audio duration limits. Start reading the target text promptly after recording begins. Sentence and paragraph evaluations have more lenient duration limits.

**Q: Some phoneme scores seem abnormal?**

A: Possible causes:

- Background noise interference
- Microphone too far or too close
- Reading too fast or too slow

### Platform Compatibility

**Q: Can I use this on Windows?**

A: Yes. You need:

1. Install Node.js >= 18
2. Download Windows version of SoX from [SoX website](https://sox.sourceforge.net/) and add to PATH
3. Configuration is the same as macOS

**Q: Can I use this without SoX?**

A: You can use audio file evaluation features (all remote proxy tools). Real-time microphone recording evaluation requires SoX.

### Logs & Debugging

The proxy outputs structured JSON logs to stderr. You can manually run it in a terminal to view:

```bash
node /path/to/dist/index.js
```

Log examples:

```json
{"time":"2026-04-20T10:00:00.000Z","level":"info","msg":"已连接远程 MCP 服务","url":"https://mcp.cloud.chivox.com"}
{"time":"2026-04-20T10:00:01.000Z","level":"info","msg":"Stdio 代理已启动"}
{"time":"2026-04-20T10:00:05.000Z","level":"info","msg":"tool 调用","tool":"create_stream_session"}
```

---

## Development Guide

### Project Structure

```
cvx_local_mcp/
├── src/
│   └── index.ts          # Main source (MCP proxy service)
├── dist/                  # Compiled output
│   ├── index.js           # Executable entry
│   └── index.d.ts         # Type declarations
├── scripts/
│   └── build.sh           # Build/check/publish script
├── docs/
│   └── index.html         # HTML documentation page
├── package.json
├── tsconfig.json
└── README.md
```

### Development Commands

```bash
npm install               # Install dependencies
npm run build             # Compile TypeScript
npm run rebuild           # Clean and recompile
npm run start             # Start service
npm run publish:check     # Compile + pre-publish check
npm run publish:release   # Compile + check + publish to npm
```

### Core Source Modules

`src/index.ts` is ~378 lines with a clear structure:

| Module | Lines | Function |
|---|---|---|
| Logging | 15–23 | Structured JSON logging to stderr |
| Session Management | 25–73 | `RecordingSession` interface, Buffer management, timed chunk pushing |
| Local Tool Definitions | 77–118 | JSON Schema definitions for three local tools |
| Main Program | 124–378 | Remote connection, reconnection logic, tool routing, graceful shutdown |

### Key Implementation Details

**Audio Chunk Pushing**: `startPushingChunks()` uses `setInterval` to periodically (default 100ms) extract fixed-size (default 3200 bytes) audio chunks from the Buffer and send them as WebSocket binary frames. The timer stops automatically when recording ends and the Buffer is empty.

**Tool Routing Strategy**:

- `create_stream_session` — Forwarded directly to remote (remote creates session and returns session_id)
- `start_recording` — Intercepted locally (establishes WebSocket, starts SoX, manages Buffer)
- `stop_recording` — Intercepted locally (stops SoX, waits for Buffer drain, sends stop command, receives result)
- Other tools — Proxied to remote (if `audio_file_path` present, converts to base64 first)

**Auto-reconnect**: `callWithReconnect()` wrapper automatically re-establishes the HTTP connection and retries once when a remote call fails.

---

## License

MIT
