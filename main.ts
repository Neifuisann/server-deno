import "./config.ts";

import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket as WSWebSocket } from "npm:ws";
import type { RawData, WebSocketServer as _WSS } from "npm:ws"; // Use _WSS alias

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { Encoder } from "@evan/opus";

import {
  authenticateUser,
} from "./utils.ts";
import {
  getSupabaseClient,
  getChatHistory,
  createFirstMessage,
  createSystemPrompt,
  addConversation,
  getDeviceInfo,
  updateUserSessionTime,
} from "./supabase.ts";
import { setupWebSocketConnectionHandler } from "./websocket_handler.ts";

import {
  isDev,
  HOST,
  PORT,
  TTS_SAMPLE_RATE,
  TTS_FRAME_SIZE_BYTES,
  MIC_SAMPLE_RATE
} from "./config.ts";

// Opus encoder for TTS
const ttsEncoder = new Encoder({
  application: "audio",
  sample_rate: TTS_SAMPLE_RATE,
  channels: 1,
});

function createTtsBuffer() {
  let leftover = new Uint8Array(0);

  async function encodePcmChunk(rawPcm: Uint8Array): Promise<Uint8Array[]> {
    const combined = new Uint8Array(leftover.length + rawPcm.length);
    combined.set(leftover, 0);
    combined.set(rawPcm, leftover.length);

    const frames: Uint8Array[] = [];
    let offset = 0;
    while (offset + TTS_FRAME_SIZE_BYTES <= combined.length) {
      const slice = combined.subarray(offset, offset + TTS_FRAME_SIZE_BYTES);
      offset += TTS_FRAME_SIZE_BYTES;
      try {
        const opusData = ttsEncoder.encode(slice);
        frames.push(opusData);
      } catch (e) {
        console.error("Opus encode error:", e);
      }
    }
    leftover = combined.subarray(offset);
    return frames;
  }

  function reset() {
    leftover = new Uint8Array(0);
  }

  return { encodePcmChunk, reset };
}
const ttsState = createTtsBuffer();

// AudioFilter for Microphone Input
class AudioFilter {
  private highpassAlpha: number;
  private lowpassAlpha: number;
  private prevInputHighpass = 0;
  private prevOutputHighpass = 0;
  private prevOutputLowpass = 0;

  constructor(sampleRate = MIC_SAMPLE_RATE) {
    const highpass_cutoff = 300.0;
    const lowpass_cutoff = 3500.0;
    this.highpassAlpha = 1.0 / (1.0 + Math.tan(Math.PI * highpass_cutoff / sampleRate));
    this.lowpassAlpha  = Math.tan(Math.PI * lowpass_cutoff / sampleRate)
                       / (1 + Math.tan(Math.PI * lowpass_cutoff / sampleRate));
  }

  public processAudioInPlace(buffer: Uint8Array) {
    const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
    for (let i = 0; i < samples.length; i++) {
      let sample = samples[i];
      // highpass
      const inHigh = sample;
      const outHigh = this.highpassAlpha * (this.prevOutputHighpass + inHigh - this.prevInputHighpass);
      this.prevInputHighpass = inHigh;
      this.prevOutputHighpass = outHigh;
      // lowpass
      const inLow = outHigh;
      const outLow = this.lowpassAlpha * inLow + (1 - this.lowpassAlpha) * this.prevOutputLowpass;
      this.prevOutputLowpass = outLow;
      // gain (shift << 3 is multiply by 8)
      let finalOut = outLow * 8;
      // clip
      finalOut = Math.max(-32768, Math.min(32767, finalOut));
      samples[i] = finalOut;
    }
  }
}

function boostTtsVolumeInPlace(buffer: Uint8Array, factor = 2.0) {
    // Ensure factor is positive
    const safeFactor = Math.max(0, factor);
    const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
    for (let i = 0; i < samples.length; i++) {
        let val = samples[i] * safeFactor;
        // Clip the amplified value
        val = Math.max(-32768, Math.min(32767, val));
        samples[i] = val;
    }
}



console.log("Initializing server...");

// Create HTTP + WebSocket server
const server = createServer();
const wss: _WSS = new WebSocketServer({ noServer: true });

// Setup the main WebSocket connection listener
setupWebSocketConnectionHandler(wss);

// -----------------------------------------------------------------------------
// HTTP Server Upgrade Handler (Authentication)
// -----------------------------------------------------------------------------
server.on("upgrade", async (req, socket, head) => {
  console.log(`Incoming upgrade request from: ${req.socket.remoteAddress}`);
  try {
    const url = new URL(req.url || "/", `ws://${req.headers.host}`); // Need base for URL parsing
    const token = url.searchParams.get("token") || req.headers.authorization?.replace("Bearer ", "") || ""; // Allow token via query param or header

    if (!token) {
      console.log("Upgrade failed: No token provided.");
      socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer realm=\"Access to WebSocket\"\r\n\r\n");
      socket.destroy();
      return;
    }

    // Create a Supabase client scoped to the token for authentication
    const supabase = getSupabaseClient(token);

    // Authenticate using the token
    const user = await authenticateUser(supabase, token);
    console.log(`User authenticated via token: ${user.email}`); // Assuming user object has email

    // Proceed with WebSocket upgrade, passing context to the connection handler
    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log("WebSocket upgrade successful, emitting connection event.");
      wss.emit("connection", ws, {
        user,
        supabase, // Pass the scoped Supabase client
        timestamp: new Date().toISOString(),
      });
    });
  } catch (err) {
    // Log specific auth errors vs other errors
    if (err instanceof Error && err.message.includes("Authentication failed")) {
        console.error("Authentication failed:", err.message);
    } else {
        console.error("Upgrade handler error:", err);
    }
    // Send 401 on any failure during upgrade/auth
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
  }
});

// -----------------------------------------------------------------------------
// Launch server
// -----------------------------------------------------------------------------
server.listen(PORT, HOST, () => {
  console.log(`WebSocket server listening on ws://${HOST}:${PORT}/`);
  console.log(`Development mode: ${isDev}`);
});

// -----------------------------------------------------------------------------
// Graceful Shutdown Handler
// -----------------------------------------------------------------------------
Deno.addSignalListener("SIGINT", () => {
  console.log("\nReceived SIGINT, shutting down...");
  let serversClosed = 0;
  const totalServers = 2; // HTTP and WebSocket

  const checkExit = () => {
    serversClosed++;
    if (serversClosed >= totalServers) {
      console.log("All servers closed. Exiting.");
      Deno.exit(0);
    }
  };

  console.log("Closing HTTP server...");
  server.close((err) => {
    if (err) {
        console.error("Error closing HTTP server:", err);
    } else {
        console.log("HTTP server closed.");
    }
    checkExit();
  });

  console.log("Closing WebSocket server...");
  wss.close((err) => {
    if (err) {
        console.error("Error closing WebSocket server:", err);
    } else {
        console.log("WebSocket server closed.");
    }
    checkExit();
  });

  // Add a timeout as a safety measure
  setTimeout(() => {
    console.warn("Shutdown timeout reached. Forcing exit.");
    Deno.exit(1);
  }, 5000); // 5 seconds timeout

});

console.log("Server setup complete.");