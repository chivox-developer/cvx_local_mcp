**English** | [中文](./README.md)

# chivox-local-mcp

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
- [License](#license)

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
