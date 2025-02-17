import fs from 'fs';
import { Server } from 'socket.io';

const io = new Server(3000, {
  cors: {
    origin: ["https://fusch.fun", "http://localhost:5173", "192.168.1.9:5173", "192.168.1.9"],
    methods: ["GET", "POST"]
  }
});

let drawCommands = [];

console.log("Server started");

io.on("connection", (socket) => {
  console.log("User connected");

  socket.on("requestCanvasState", () => {
    socket.emit("canvasState", drawCommands);
  });

  socket.on("draw", (data) => {
    drawCommands.push(data);
    socket.broadcast.emit("draw", data);
  });

  socket.on("clearCanvas", () => {
    drawCommands = [];
    io.emit("canvasState", drawCommands);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

try {
  const savedCommands = fs.readFileSync("canvasCommands.json", "utf-8");
  drawCommands = JSON.parse(savedCommands);
} catch (err) {
  console.log("No existing canvas commands found.");
}

setInterval(() => {
  fs.writeFileSync("canvasCommands.json", JSON.stringify(drawCommands));
}, 5000);
