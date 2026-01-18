// index.js (Node ESM) — HTTP Audio (Range) + WS Sync (socket.io)
// Local-friendly CORS (Origin reflection) + OPTIONS support for Range
// Run: node index.js

import fs from "fs";
import path from "path";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import crypto from "crypto";

const app = express();
const server = http.createServer(app);

// === Allowed origins (LOCAL + PROD) ===
const ALLOWED_ORIGINS = new Set([
  "https://fusch.fun",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://192.168.1.9:5173",
  "http://192.168.1.9"
]);

// =====================
// Socket.IO (CORS)
// =====================
const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      // allow no-origin (curl, health checks)
      if (!origin) return cb(null, true);
      return cb(null, ALLOWED_ORIGINS.has(origin));
    },
    methods: ["GET", "POST"],
    credentials: true
  }
});

// =====================
// AUDIO: HTTP file + WS sync state
// =====================
const AUDIO_FILE_PATH = path.resolve("./audio/set.mp3");
const AUDIO_PUBLIC_URL = "/audio/set.mp3";

// Load audioState from file if it exists
let audioState = {
  url: AUDIO_PUBLIC_URL,
  startedAt: null,  // number | null
  sessionId: null   // string | null
};

try {
  const savedState = JSON.parse(fs.readFileSync("audioState.json", "utf-8"));
  audioState = savedState;
  console.log("[AUDIO] Session wiederhergestellt:", savedState);
} catch {
  console.log("[AUDIO] Neue Session wird erstellt");
}

function newSessionId() {
  return crypto.randomBytes(6).toString("hex");
}

function saveAudioState() {
  try {
    fs.writeFileSync("audioState.json", JSON.stringify(audioState));
  } catch (err) {
    console.error("[AUDIO] Fehler beim Speichern:", err);
  }
}

function ensureAudioSessionRunning(reason = "ensure") {
  if (io.engine.clientsCount > 0 && audioState.startedAt === null) {
    audioState.startedAt = Date.now();
    audioState.sessionId = newSessionId();
    
    // Sofort speichern
    saveAudioState();
    
    console.log(
      `[AUDIO] session started (${reason}) startedAt=${audioState.startedAt} sessionId=${audioState.sessionId} clients=${io.engine.clientsCount}`
    );
    io.emit("audio:state", audioState);
  }
}

function maybeResetAudioSession() {
  // Session bleibt erhalten, auch wenn keine Clients da sind
  if (io.engine.clientsCount === 0 && audioState.startedAt !== null) {
    console.log("[AUDIO] Alle Clients weg - Session läuft weiter (persistent)");
    // audioState wird NICHT zurückgesetzt
  }
}

// ---- CORS helper for AUDIO endpoints ----
function setAudioCors(req, res) {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    // for local debugging, you can keep this; for strict prod, reject instead
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range,Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length");
  res.setHeader("Accept-Ranges", "bytes");
}

// IMPORTANT: respond to preflight (OPTIONS)
app.options(AUDIO_PUBLIC_URL, (req, res) => {
  setAudioCors(req, res);
  res.status(204).end();
});

// Range-supporting audio endpoint
app.get(AUDIO_PUBLIC_URL, (req, res) => {
  if (!fs.existsSync(AUDIO_FILE_PATH)) {
    res.status(404).send("Audio file not found");
    return;
  }

  const stat = fs.statSync(AUDIO_FILE_PATH);
  const fileSize = stat.size;
  const range = req.headers.range;

  setAudioCors(req, res);

  res.setHeader("Content-Type", "audio/mp3");
  res.setHeader("Cache-Control", "no-store"); // local dev: avoid caching weirdness

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
  res.json({ ok: true, clients: io.engine.clientsCount, audioState });
});

// optional: restart session manually
app.post("/admin/audio/restart", express.json(), (_, res) => {
  audioState.startedAt = Date.now();
  audioState.sessionId = newSessionId();
  saveAudioState();
  console.log(`[AUDIO] force restart startedAt=${audioState.startedAt} sessionId=${audioState.sessionId}`);
  io.emit("audio:state", audioState);
  res.json({ ok: true, audioState });
});

// =====================
// Your other state
// =====================
let drawCommands = [];
let partyState = false;
let shirtInterests = [];

try {
  shirtInterests = JSON.parse(fs.readFileSync("shirtInterests.json", "utf-8"));
} catch {}

const psyUsers = new Map();
const lastPsySentAt = new Map();

try {
  drawCommands = JSON.parse(fs.readFileSync("canvasCommands.json", "utf-8"));
} catch {}

io.on("connection", (socket) => {
  console.log("[SOCKET] connected", socket.id, "clients:", io.engine.clientsCount);

  ensureAudioSessionRunning("connect");
  socket.emit("audio:state", audioState);

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

  socket.on("requestCanvasState", () => socket.emit("canvasState", drawCommands));
  socket.on("draw", (data) => { drawCommands.push(data); socket.broadcast.emit("draw", data); });
  socket.on("placeImage", (data) => { drawCommands.push(data); io.emit("placeImage", data); });
  socket.on("clearCanvas", () => { drawCommands = []; io.emit("canvasState", drawCommands); });
  socket.on("undo", () => { drawCommands.pop(); io.emit("canvasState", drawCommands); });

  socket.on("requestPartyState", () => socket.emit("partyState", partyState));
  socket.on("togglePartyState", () => {
    partyState = true;
    io.emit("partyState", partyState);
    setTimeout(() => {
      partyState = false;
      io.emit("partyState", partyState);
    }, 5000);
  });

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

    setTimeout(() => maybeResetAudioSession(), 0);
  });
});

setInterval(() => {
  ensureAudioSessionRunning("interval");
  if (io.engine.clientsCount > 0 && audioState.startedAt) io.emit("audio:state", audioState);
}, 10000);

// Regelmäßiges Speichern - jetzt auch mit audioState
setInterval(() => {
  try {
    saveAudioState();
    fs.writeFileSync("canvasCommands.json", JSON.stringify(drawCommands));
    fs.writeFileSync("shirtInterests.json", JSON.stringify(shirtInterests));
  } catch {}
}, 10000);

const PORT = 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP + Socket.IO running on http://0.0.0.0:${PORT}`);
  console.log(`Audio available at: http://0.0.0.0:${PORT}${AUDIO_PUBLIC_URL}`);
});