import fs from 'fs';
import { Server } from 'socket.io';

const io = new Server(3000, {
  cors: {
    origin: ["https://fusch.fun", "http://localhost:5173", "192.168.1.9:5173", "192.168.1.9"],
    methods: ["GET", "POST"]
  }
});

let drawCommands = [];

let partyState = false;

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
    // partystate true for 5 sec
    partyState = true;
    io.emit("partyState", partyState);
    setTimeout(() => {
      partyState = false;
      io.emit("partyState", partyState);
    }, 5000);
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
