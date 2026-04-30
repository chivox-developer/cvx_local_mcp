#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { spawn, ChildProcess } from "node:child_process";
import WebSocket from "ws";

function log(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) {
  const entry = {
    time: new Date().toISOString(),
    level,
    msg: message,
    ...meta,
  };
  console.error(JSON.stringify(entry));
}

// ========== 流式录音会话管理 ==========

interface RecordingSession {
  sessionId: string;
  soxProcess: ChildProcess | null;
  ws: WebSocket;
  chunkSize: number;
  chunkIntervalMs: number;
  buffer: Buffer;
  pushTimer: ReturnType<typeof setInterval> | null;
  stopped: boolean;
  error: string | null;
}

const activeSessions = new Map<string, RecordingSession>();
const sessionWsUrls = new Map<string, string>();

function startPushingChunks(session: RecordingSession) {
  session.pushTimer = setInterval(() => {
    if (session.buffer.length < session.chunkSize && !session.stopped) {
      return;
    }

    if (session.buffer.length === 0) {
      if (session.stopped && session.pushTimer) {
        clearInterval(session.pushTimer);
        session.pushTimer = null;
      }
      return;
    }

    const chunkLen = Math.min(session.chunkSize, session.buffer.length);
    const chunk = session.buffer.subarray(0, chunkLen);
    session.buffer = session.buffer.subarray(chunkLen);

    try {
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(chunk);
      }
    } catch (err) {
      log("error", "推送音频块失败", { error: String(err), sessionId: session.sessionId });
      session.error = String(err);
    }

    if (session.stopped && session.buffer.length === 0 && session.pushTimer) {
      clearInterval(session.pushTimer);
      session.pushTimer = null;
    }
  }, session.chunkIntervalMs);
}

// ========== 本地 tool 定义 ==========

const LOCAL_TOOLS = [
  {
    name: "create_stream_session",
    description: "创建流式评测会话 - 建立到评测服务的连接,返回 session_id 和 WebSocket 地址。客户端可通过 start_recording 开始录音评测。",
    inputSchema: {
      type: "object" as const,
      properties: {
        core_type: { type: "string", description: "评测类型,如 en.word.score、en.sent.score、cn.sent.raw 等" },
        ref_text: { type: "string", description: "评测参考文本" },
        audio_type: { type: "string", default: "mp3", description: "音频格式: mp3, wav, pcm 等 (默认 mp3)" },
        sample_rate: { type: "number", default: 16000, description: "采样率 (默认 16000)" },
        rank: { type: "number", default: 100, description: "评分制: 4 或 100 (默认 100)" },
      },
      required: ["core_type", "ref_text"],
    },
  },
  {
    name: "start_recording",
    description: "开始麦克风录音 - 启动实时录音并通过 WebSocket 将音频流推送到指定的流式评测会话。需要先调用 create_stream_session 获取 session_id。",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string", description: "流式评测会话 ID" },
        chunk_size: { type: "number", default: 3200, description: "每次推送的音频块大小 bytes (默认 3200)" },
        chunk_interval_ms: { type: "number", default: 100, description: "音频块推送间隔 ms (默认 100)" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "stop_recording",
    description: "停止录音并获取评测结果 - 停止麦克风录音,将剩余音频发送完毕,然后获取评测结果。",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string", description: "流式评测会话 ID" },
        timeout: { type: "number", default: 30, description: "等待超时秒数 (默认 30)" },
      },
      required: ["session_id"],
    },
  },
];

const LOCAL_TOOL_NAMES = new Set(LOCAL_TOOLS.map(t => t.name));

// ========== 主程序 ==========

async function main() {
  const remoteUrl: string = process.env.MCP_REMOTE_URL || "https://mcp.cloud.chivox.com";

  const apiKey = process.env.MCP_API_KEY;
  const httpHeaders: Record<string, string> = {};
  if (apiKey) {
    httpHeaders["Authorization"] = `Bearer ${apiKey}`;
  }

  let remoteClient = new Client({
    name: "chivox-local-mcp",
    version: "1.0.0",
  });

  async function connectRemote() {
    remoteClient = new Client({
      name: "chivox-local-mcp",
      version: "1.0.0",
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(remoteUrl),
      { requestInit: { headers: httpHeaders } }
    );
    await remoteClient.connect(transport);
    log("info", "已连接远程 MCP 服务", { url: remoteUrl });
  }

  async function callWithReconnect<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      log("warn", "远程调用失败，尝试重连", { error: String(err) });
      try {
        await connectRemote();
        return await fn();
      } catch (retryErr) {
        log("error", "重连后调用仍然失败", { error: String(retryErr) });
        throw retryErr;
      }
    }
  }

  await connectRemote();

  // ========== 创建本地 Stdio 代理服务 ==========
  const server = new Server(
    { name: "chivox-local-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // 代理 tools/list：透传远程 tool 列表 + 本地 tool
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const remoteResult = await callWithReconnect(() => remoteClient.listTools(request.params));
    const filteredRemoteTools = remoteResult.tools.filter(t => !LOCAL_TOOL_NAMES.has(t.name));
    return {
      tools: [...filteredRemoteTools, ...LOCAL_TOOLS],
    };
  });

  // 代理 tools/call：拦截本地 tool，其余透传远程
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    log("info", "tool 调用", { tool: request.params.name });

    // --- Intercept: create_stream_session ---
    if (request.params.name === "create_stream_session") {
      log("info", "创建流式评测会话");
      const result = await callWithReconnect(() =>
        remoteClient.callTool(request.params)
      );
      // 解析响应，保存 ws_url
      try {
        const content = (result as any)?.content;
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type === "text" && typeof item.text === "string") {
              const parsed = JSON.parse(item.text);
              if (parsed.session_id && parsed.ws_url) {
                sessionWsUrls.set(parsed.session_id, parsed.ws_url);
                log("info", "已保存会话 ws_url", { session_id: parsed.session_id, ws_url: parsed.ws_url });
              }
            }
          }
        }
      } catch (e) {
        log("warn", "解析 create_stream_session 响应失败", { error: String(e) });
      }
      return result;
    }

    // --- Intercept: start_recording ---
    if (request.params.name === "start_recording") {
      const args = request.params.arguments as Record<string, unknown> | undefined;
      const sessionId = args?.session_id as string;
      const chunkSize = Number(args?.chunk_size) || 3200;
      const chunkIntervalMs = Number(args?.chunk_interval_ms) || 100;

      if (!sessionId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "session_id is required" }) }], isError: true };
      }
      if (activeSessions.has(sessionId)) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "session already recording" }) }], isError: true };
      }

      // 优先使用 create_stream_session 返回的 ws_url，否则降级拼接
      const wsUrl = sessionWsUrls.get(sessionId)
        ?? remoteUrl.replace(/^http/, "ws").replace(/\/+$/, "") + `/ws/audio/${sessionId}`;
      sessionWsUrls.delete(sessionId);
      const wsHeaders: Record<string, string> = {};
      if (apiKey) {
        wsHeaders["Authorization"] = `Bearer ${apiKey}`;
      }
      const ws = new WebSocket(wsUrl, { headers: wsHeaders });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("WebSocket connect timeout")), 10000);
        ws.on("open", () => { clearTimeout(timer); resolve(); });
        ws.on("error", (err) => { clearTimeout(timer); reject(err); });
      });
      log("info", "WebSocket 已连接", { wsUrl });

      const session: RecordingSession = {
        sessionId,
        soxProcess: null,
        ws,
        chunkSize,
        chunkIntervalMs,
        buffer: Buffer.alloc(0),
        pushTimer: null,
        stopped: false,
        error: null,
      };

      // Start sox recording
      const soxArgs = ["-q", "-t", "mp3", "-r", "16000", "-c", "1", "-"];
      session.soxProcess = spawn("rec", soxArgs);
      log("info", "开始录音", { sessionId, pid: session.soxProcess.pid });

      session.soxProcess.stdout?.on("data", (data: Buffer) => {
        session.buffer = Buffer.concat([session.buffer, data]);
      });

      session.soxProcess.stderr?.on("data", (data: Buffer) => {
        log("warn", "sox stderr", { data: data.toString() });
      });

      session.soxProcess.on("error", (err) => {
        log("error", "sox 进程错误", { error: String(err) });
        session.error = String(err);
      });

      session.soxProcess.on("exit", (code) => {
        log("info", "sox 进程退出", { code, sessionId });
        session.stopped = true;
      });

      activeSessions.set(sessionId, session);
      startPushingChunks(session);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: "recording", session_id: sessionId, ws_url: wsUrl, chunk_size: chunkSize }) }],
      };
    }

    // --- Intercept: stop_recording ---
    if (request.params.name === "stop_recording") {
      const args = request.params.arguments as Record<string, unknown> | undefined;
      const sessionId = args?.session_id as string;
      const timeout = Number(args?.timeout) || 30;

      if (!sessionId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "session_id is required" }) }], isError: true };
      }

      const session = activeSessions.get(sessionId);
      if (!session) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "no active recording for this session_id" }) }], isError: true };
      }

      // Stop sox process
      if (session.soxProcess && !session.stopped) {
        session.soxProcess.kill("SIGTERM");
        log("info", "已停止录音", { sessionId });
      }
      session.stopped = true;

      // Wait for buffer to drain
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (session.buffer.length === 0 && session.pushTimer === null) {
            clearInterval(check);
            resolve();
          }
        }, 50);
        setTimeout(() => { clearInterval(check); resolve(); }, 5000);
      });

      // Send stop command and wait for result via WebSocket
      const result = await new Promise<unknown>((resolve, reject) => {
        const wsTimeout = setTimeout(() => reject(new Error("等待评测结果超时")), timeout * 1000);

        session.ws.on("message", (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "result") {
              clearTimeout(wsTimeout);
              resolve(msg.data);
            } else if (msg.type === "error") {
              clearTimeout(wsTimeout);
              reject(new Error(JSON.stringify(msg.data)));
            }
          } catch { /* ignore parse errors */ }
        });

        session.ws.send(JSON.stringify({ cmd: "stop" }));
      });

      session.ws.close();
      activeSessions.delete(sessionId);
      log("info", "会话已清理", { sessionId });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }

    // --- 默认：透传远程 tool 调用 ---
    const params = { ...request.params };
    const args = params.arguments as Record<string, unknown> | undefined;
    if (args?.audio_file_path && typeof args.audio_file_path === "string") {
      const filePath = args.audio_file_path;
      log("info", "读取本地音频文件并转为 base64", { filePath });
      const fileData = readFileSync(filePath);
      args.audio_base64 = fileData.toString("base64");
      delete args.audio_file_path;
      params.arguments = args;
    }

    const result = await callWithReconnect(() => remoteClient.callTool(params));
    return result;
  });

  // ========== 启动 Stdio 传输 ==========
  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
  log("info", "Stdio 代理已启动");

  // ========== 优雅关闭 ==========
  async function shutdown(signal: string) {
    log("info", "收到关闭信号，开始优雅关闭", { signal });
    // 清理所有活跃录音会话
    for (const [id, session] of activeSessions) {
      if (session.soxProcess && !session.stopped) {
        session.soxProcess.kill("SIGTERM");
      }
      if (session.pushTimer) {
        clearInterval(session.pushTimer);
      }
      if (session.ws) {
        session.ws.close();
      }
      log("info", "清理录音会话", { sessionId: id });
    }
    activeSessions.clear();
    try { await remoteClient.close(); } catch {}
    try { await server.close(); } catch {}
    log("info", "优雅关闭完成");
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log("error", "启动失败", { error: String(err) });
  process.exit(1);
});
