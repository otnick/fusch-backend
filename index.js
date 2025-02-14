import fs from "fs";
import { Server } from "socket.io";
import mongoose from "mongoose";
import dotenv from "dotenv";

// MongoDB verbinden
dotenv.config();
const username = encodeURIComponent(process.env.DB_USERNAME);
const password = encodeURIComponent(process.env.DB_PASSWORD);

await mongoose.connect(`mongodb+srv://${username}:${password}@fuschcluster.3nozk.mongodb.net/?retryWrites=true&w=majority&appName=FuschCluster`);

const CanvasState = mongoose.model('CanvasState', new mongoose.Schema({ data: String }));

const io = new Server(3000, {
  cors: {
    origin: ["http://localhost:5173", "https://fusch.fun"]
  }
});

io.on("connection", async (socket) => {
  console.log("User connected");

  // Lade den gespeicherten Zustand
  const savedState = await CanvasState.findOne();
  if (savedState) {
    socket.emit("canvasState", savedState.data);
  }

  socket.on("draw", (data) => {
    socket.broadcast.emit("draw", data);
  });

  socket.on("saveCanvasState", async (state) => {
    await CanvasState.updateOne({}, { data: state }, { upsert: true });
  });

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

console.log("Socket.IO server running on port 3000");
