// index.js (Node ESM) — HTTP Audio (Range) + WS Sync (socket.io)
// ✅ No TypeScript syntax. Works with `node index.js`
// ✅ Robust session: startedAt set when first client connects OR when missing
// ✅ sessionId increments on every new session start (so clients can detect restarts)
// ✅ Optional admin endpoint to force-restart the session

import fs from "fs";
import path from "path";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import crypto from "crypto";

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: [
      "https://fusch.fun",
      "http://localhost:5173",
      "http://192.168.1.9:5173",
      "http://192.168.1.9"
    ],
    methods: ["GET", "POST"]
  }
});

// =====================
// AUDIO: HTTP file + WS sync state
// =====================
const AUDIO_FILE_PATH = path.resolve("./audio/set.wav"); // consider switching to mp3 later
const AUDIO_PUBLIC_URL = "/audio/set.wav";

// Session state (shared via WS)
const audioState = {
  url: AUDIO_PUBLIC_URL,
  startedAt: null,     // number | null
  sessionId: null      // string | null
};

function newSessionId() {
  // short readable id
  return crypto.randomBytes(6).toString("hex");
}

function ensureAudioSessionRunning(reason = "ensure") {
  // Start session when at least one client exists and session not running
  if (io.engine.clientsCount > 0 && audioState.startedAt === null) {
    audioState.startedAt = Date.now();
    audioState.sessionId = newSessionId();
    console.log(
      `[AUDIO] session started (${reason}) startedAt=${audioState.startedAt} sessionId=${audioState.sessionId} clients=${io.engine.clientsCount}`
    );
    io.emit("audio:state", audioState);
  }
}

function maybeResetAudioSession() {
  // Reset session when no clients connected
  if (io.engine.clientsCount === 0 && audioState.startedAt !== null) {
    console.log("[AUDIO] session reset (no clients)");
    audioState.startedAt = null;
    audioState.sessionId = null;
  }
}

// Range-supporting audio endpoint
app.get(AUDIO_PUBLIC_URL, (req, res) => {
  if (!fs.existsSync(AUDIO_FILE_PATH)) {
    res.status(404).send("Audio file not found");
    return;
  }

  const stat = fs.statSync(AUDIO_FILE_PATH);
  const fileSize = stat.size;
  const range = req.headers.range;

  // CORS for audio fetch
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", "audio/wav");
  // Good caching for static file (optional)
  res.setHeader("Cache-Control", "public, max-age=3600");

  if (!range) {
    res.setHeader("Content-Length", fileSize);
    fs.createReadStream(AUDIO_FILE_PATH).pipe(res);
    return;
  }

  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) {
    res.status(416).send("Malformed Range header");
    return;
  }

  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

  if (start >= fileSize || end >= fileSize || start > end) {
    res.status(416).setHeader("Content-Range", `bytes */${fileSize}`).end();
    return;
  }

  const chunkSize = end - start + 1;
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  res.setHeader("Content-Length", chunkSize);

  fs.createReadStream(AUDIO_FILE_PATH, { start, end }).pipe(res);
});

// health
app.get("/health", (_, res) => {
  res.json({
    ok: true,
    clients: io.engine.clientsCount,
    audioState
  });
});

// OPTIONAL: force start/restart session (useful for testing)
// Call: curl -X POST http://localhost:3000/admin/audio/restart
app.post("/admin/audio/restart", express.json(), (req, res) => {
  audioState.startedAt = Date.now();
  audioState.sessionId = newSessionId();
  console.log(
    `[AUDIO] session force-restarted startedAt=${audioState.startedAt} sessionId=${audioState.sessionId}`
  );
  io.emit("audio:state", audioState);
  res.json({ ok: true, audioState });
});

// =====================
// Your other state (kept minimal here)
// =====================
let drawCommands = [];
let partyState = false;
let shirtInterests = [];

try {
  shirtInterests = JSON.parse(fs.readFileSync("shirtInterests.json", "utf-8"));
} catch {
  console.log("No existing shirt interest data found.");
}

const psyUsers = new Map();      // socket.id -> {x,y,v,updatedAt}
const lastPsySentAt = new Map(); // socket.id -> ms

// =====================
// SOCKET.IO
// =====================
io.on("connection", (socket) => {
  console.log("[SOCKET] connected", socket.id, "clients:", io.engine.clientsCount);

  // Ensure session exists whenever someone connects
  ensureAudioSessionRunning("connect");

  // Send current audio state immediately (late join)
  socket.emit("audio:state", audioState);

  // ---- psy ----
  psyUsers.set(socket.id, { x: 0.5, y: 0.5, v: 0, updatedAt: Date.now() });

  socket.on("requestPsyUsers", () => {
    const list = Array.from(psyUsers.entries()).map(([id, s]) => ({ id, ...s }));
    socket.emit("psyUsers", list);
  });

  socket.on("psy:input", (data) => {
    if (!data || typeof data.x !== "number" || typeof data.y !== "number") return;

    const now = Date.now();
    const last = lastPsySentAt.get(socket.id) ?? 0;
    if (now - last < 33) return;
    lastPsySentAt.set(socket.id, now);

    const x = Math.min(1, Math.max(0, data.x));
    const y = Math.min(1, Math.max(0, data.y));
    const v = typeof data.v === "number" ? Math.min(2, Math.max(0, data.v)) : 0;

    const state = { x, y, v, updatedAt: now };
    psyUsers.set(socket.id, state);
    socket.broadcast.emit("psyUser", { id: socket.id, ...state });
  });

  // ---- canvas ----
  socket.on("requestCanvasState", () => socket.emit("canvasState", drawCommands));
  socket.on("draw", (data) => { drawCommands.push(data); socket.broadcast.emit("draw", data); });
  socket.on("placeImage", (data) => { drawCommands.push(data); io.emit("placeImage", data); });
  socket.on("clearCanvas", () => { drawCommands = []; io.emit("canvasState", drawCommands); });
  socket.on("undo", () => { drawCommands.pop(); io.emit("canvasState", drawCommands); });

  // ---- party ----
  socket.on("requestPartyState", () => socket.emit("partyState", partyState));
  socket.on("togglePartyState", () => {
    partyState = true;
    io.emit("partyState", partyState);
    setTimeout(() => {
      partyState = false;
      io.emit("partyState", partyState);
    }, 5000);
  });

  // ---- shirts ----
  socket.on("shirtInterest", (data) => {
    const entry = { name: data?.name, size: data?.size, timestamp: Date.now() };
    shirtInterests.push(entry);
    io.emit("newShirtInterest", entry);
  });
  socket.on("getShirtInterests", () => socket.emit("shirtInterests", shirtInterests));

  socket.on("disconnect", (reason) => {
    console.log("[SOCKET] disconnected", socket.id, "reason:", reason, "clients:", io.engine.clientsCount);

    lastPsySentAt.delete(socket.id);
    psyUsers.delete(socket.id);
    socket.broadcast.emit("psyUserLeft", { id: socket.id });

    maybeResetAudioSession();
  });
});

// periodic resync (late join + drift)
setInterval(() => {
  ensureAudioSessionRunning("interval");
  if (io.engine.clientsCount > 0 && audioState.startedAt) {
    io.emit("audio:state", audioState);
  }
}, 10000);

// Persist (optional)
setInterval(() => {
  fs.writeFileSync("canvasCommands.json", JSON.stringify(drawCommands));
  fs.writeFileSync("shirtInterests.json", JSON.stringify(shirtInterests));
}, 10000);

// =====================
// START
// =====================
const PORT = 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP + Socket.IO running on http://0.0.0.0:${PORT}`);
  console.log(`Audio available at: http://0.0.0.0:${PORT}${AUDIO_PUBLIC_URL}`);
});
