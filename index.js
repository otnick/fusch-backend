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

  // Sende aktuellen Canvas-Zustand an neue Clients
  socket.on("requestCanvasState", () => {
    socket.emit("canvasState", drawCommands);
  });

  // Zeichnung empfangen & an andere senden
  socket.on("draw", (data) => {
    drawCommands.push(data);
    socket.broadcast.emit("draw", data);
  });

  // Bild empfangen & an andere senden
  socket.on("placeImage", (data) => {
    drawCommands.push(data);
    io.emit("placeImage", data);
  });

  // Canvas löschen
  socket.on("clearCanvas", () => {
    drawCommands = [];
    io.emit("canvasState", drawCommands);
  });

  // Letzte Aktion rückgängig machen
  socket.on("undo", () => {
    drawCommands.pop();
    io.emit("canvasState", drawCommands);
  });

  // Letzte Aktion wiederholen
  socket.on("redo", () => {
    const lastCommand = drawCommands[drawCommands.length - 1];
    if (lastCommand) {
      drawCommands.push(lastCommand);
      io.emit("draw", lastCommand);
    }
  });

  // Party-Modus
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

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

// Laden gespeicherter Daten
try {
  const savedCommands = fs.readFileSync("canvasCommands.json", "utf-8");
  drawCommands = JSON.parse(savedCommands);
} catch (err) {
  console.log("No existing canvas commands found.");
}

// Speichert alle 5 Sekunden den aktuellen Canvas-Zustand
setInterval(() => {
  fs.writeFileSync("canvasCommands.json", JSON.stringify(drawCommands));
}, 5000);
