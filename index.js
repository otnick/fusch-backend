import fs from "fs";
import path from "path";
import express from "express";
import http from "http";
import { Server } from "socket.io";

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
// AUDIO: config + sync state
// =====================
const AUDIO_FILE_PATH = path.resolve("./audio/set.wav");

// Audio state: starts when at least 1 client connected; resets when 0
let audioState = {
  url: "/audio/set.wav",
  startedAt: null // Date.now() when "session" started
};

// Range-supporting audio endpoint
app.get("/audio/set.wav", (req, res) => {
  if (!fs.existsSync(AUDIO_FILE_PATH)) {
    res.status(404).send("Audio file not found");
    return;
  }

  const stat = fs.statSync(AUDIO_FILE_PATH);
  const fileSize = stat.size;
  const range = req.headers.range;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", "audio/wav");

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

// optional: healthcheck
app.get("/health", (_, res) => res.json({ ok: true }));

// =====================
// DEIN bisheriger State
// =====================
let drawCommands = [];
let partyState = false;
let shirtInterests = [];

try {
  const savedShirts = fs.readFileSync("shirtInterests.json", "utf-8");
  shirtInterests = JSON.parse(savedShirts);
} catch {
  console.log("No existing shirt interest data found.");
}

// =====================
// PSY MULTI-USER STATE (NEW)
// =====================
const psyUsers = new Map();      // socket.id -> {x,y,v,updatedAt}
const lastPsySentAt = new Map(); // socket.id -> ms

console.log("Server init");

// =====================
// SOCKET.IO logic
// =====================
io.on("connection", (socket) => {
  console.log("User connected", socket.id);

  // ---- audio session control ----
  // clientsCount is AFTER connection is established
  if (io.engine.clientsCount === 1) {
    audioState.startedAt = Date.now();
  }
  socket.emit("audio:state", audioState);
  // --------------------------------

  // ---- psy state ----
  psyUsers.set(socket.id, { x: 0.5, y: 0.5, v: 0, updatedAt: Date.now() });

  socket.on("requestPsyUsers", () => {
    const list = Array.from(psyUsers.entries()).map(([id, s]) => ({ id, ...s }));
    socket.emit("psyUsers", list);
  });

  socket.on("psy:input", (data) => {
    if (!data || typeof data.x !== "number" || typeof data.y !== "number") return;

    const now = Date.now();
    const last = lastPsySentAt.get(socket.id) ?? 0;
    if (now - last < 33) return; // ~30Hz server-side rate limit
    lastPsySentAt.set(socket.id, now);

    const x = Math.min(1, Math.max(0, data.x));
    const y = Math.min(1, Math.max(0, data.y));
    const v = typeof data.v === "number" ? Math.min(2, Math.max(0, data.v)) : 0;

    const state = { x, y, v, updatedAt: now };
    psyUsers.set(socket.id, state);

    // broadcast to everyone else
    socket.broadcast.emit("psyUser", { id: socket.id, ...state });
  });
  // --------------------

  // ---- existing canvas stuff ----
  socket.on("requestCanvasState", () => {
    socket.emit("canvasState", drawCommands);
  });

  socket.on("draw", (data) => {
    drawCommands.push(data);
    socket.broadcast.emit("draw", data);
  });

  socket.on("placeImage", (data) => {
    drawCommands.push(data);
    io.emit("placeImage", data);
  });

  socket.on("clearCanvas", () => {
    drawCommands = [];
    io.emit("canvasState", drawCommands);
  });

  socket.on("undo", () => {
    drawCommands.pop();
    io.emit("canvasState", drawCommands);
  });

  socket.on("redo", () => {
    const lastCommand = drawCommands[drawCommands.length - 1];
    if (lastCommand) {
      drawCommands.push(lastCommand);
      io.emit("draw", lastCommand);
    }
  });

  socket.on("requestPartyState", () => {
    socket.emit("partyState", partyState);
  });

  socket.on("togglePartyState", () => {
    partyState = true;
    io.emit("partyState", partyState);
    setTimeout(() => {
      partyState = false;
      io.emit("partyState", partyState);
    }, 5000);
  });

  socket.on("shirtInterest", (data) => {
    const entry = { name: data.name, size: data.size, timestamp: Date.now() };
    shirtInterests.push(entry);
    io.emit("newShirtInterest", entry);
  });

  socket.on("getShirtInterests", () => {
    socket.emit("shirtInterests", shirtInterests);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected", socket.id);

    // psy cleanup
    lastPsySentAt.delete(socket.id);
    psyUsers.delete(socket.id);
    socket.broadcast.emit("psyUserLeft", { id: socket.id });

    // audio session control: if last client left -> reset session
    if (io.engine.clientsCount === 0) {
      audioState.startedAt = null;
    }
  });
});

// Resync audio state occasionally (helps late joins if clocks drift a bit)
setInterval(() => {
  if (io.engine.clientsCount > 0 && audioState.startedAt) {
    io.emit("audio:state", audioState);
  }
}, 10000);

// Laden gespeicherter Canvas Commands
try {
  const savedCommands = fs.readFileSync("canvasCommands.json", "utf-8");
  drawCommands = JSON.parse(savedCommands);
} catch {
  console.log("No existing canvas commands found.");
}

// Persist
setInterval(() => {
  fs.writeFileSync("canvasCommands.json", JSON.stringify(drawCommands));
  fs.writeFileSync("shirtInterests.json", JSON.stringify(shirtInterests));
}, 10000);

// =====================
// START SERVER
// =====================
const PORT = 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP + Socket.IO running on http://0.0.0.0:${PORT}`);
  console.log(`Audio available at: http://0.0.0.0:${PORT}/audio/set.wav`);
});
