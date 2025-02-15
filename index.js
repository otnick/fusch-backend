import fs from "fs";
import { Server } from "socket.io";

const io = new Server(3000, {
  cors: {
    origin: ["https://fusch.fun", "http://localhost:5173", "192.168.1.9:5173", "192.168.1.9"],
    methods: ["GET", "POST"]
  }
});

let canvasState = "";

console.log("Server started");

io.on("connection", (socket) => {
  console.log("User connected");

  // Sende den aktuellen Canvas-Zustand an neue Benutzer
  socket.on("requestCanvasState", () => {
    if (canvasState) {
      socket.emit("canvasState", canvasState);
    }
  });

  socket.on("draw", (data) => {
    socket.broadcast.emit("draw", data);
  });

  socket.on("saveCanvasState", (state) => {
    canvasState = state;
    fs.writeFileSync("canvasState.txt", state);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

// Lade den Canvas-Zustand beim Start
try {
  canvasState = fs.readFileSync("canvasState.txt", "utf-8");
} catch (err) {
  console.log("No existing canvas state found.");
}
