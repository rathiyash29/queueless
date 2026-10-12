// server.js - the starting point. Run with:  npm start
// It creates the Express web server, attaches Socket.IO, and serves the frontend files.
const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
require("./db");                                   // loads server/.env
const { readToken } = require("./auth");
const makeRoutes = require("./routes");

if (!process.env.JWT_SECRET) {
  console.log("JWT_SECRET is missing. Copy server/.env.example to server/.env and fill it in.");
  process.exit(1);
}

const app = express();
const httpServer = http.createServer(app);         // Express and Socket.IO share one server
const io = new Server(httpServer);

// ---------- Socket.IO: only logged-in users may connect ----------
// The browser sends its JWT when connecting. If it is not valid, the connection is refused.
io.use((socket, next) => {
  try {
    socket.user = readToken(socket.handshake.auth.token);
    next();
  } catch (e) {
    next(new Error("Please login first"));
  }
});

io.on("connection", (socket) => {
  // Each user gets a private "room" named after their id. Admins also join the "admins" room.
  // The server sends updates to rooms, so a student only hears about their own queue.
  socket.join("user:" + socket.user.id);
  if (socket.user.role === "admin") socket.join("admins");
});

// ---------- Express ----------
app.use(express.json());                           // lets routes read JSON sent by fetch()
app.use("/api", makeRoutes(io));                   // all API routes live under /api
app.use(express.static(path.join(__dirname, "..", "public")));  // serves the HTML/CSS/JS files

// Error handler: any error thrown in a route ends up here and is sent back as JSON.
app.use((err, req, res, next) => {
  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON" });
  }
  console.log("Server error:", err);
  res.status(500).json({ error: "Something went wrong on the server" });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log("QueueLess running at http://localhost:" + PORT);
});
