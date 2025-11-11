// server.js
require("dotenv").config();

const http = require("http");
const mongoose = require("mongoose");
const app = require("./app");
const { initSockets } = require("./socket");

const PORT = process.env.PORT || 4000;
const SOCKET_ORIGIN = process.env.SOCKET_ORIGIN || "http://localhost:3000";
const server = http.createServer(app);

function startServer() {
  try {
    initSockets(server, SOCKET_ORIGIN);
    server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
  } catch (err) {
    console.error("Failed to init sockets / start server:", err);
    process.exit(1);
  }
}

/**
 * If the app (app.js) already triggered mongoose.connect(), it will emit events we can listen to.
 * If app.js didn't start the connection, we attempt to connect here using process.env.MONGODB_URI.
 */
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/chessapp";

if (mongoose.connection.readyState === 1) {
  console.log("Mongoose already connected.");
  startServer();
} else {
  console.log(
    "Connecting to MongoDB:",
    MONGODB_URI.startsWith("mongodb://localhost")
      ? "local (fallback)"
      : "URI from env"
  );
  mongoose
    .connect(MONGODB_URI, {
      // recommended options
      useNewUrlParser: true,
      useUnifiedTopology: true,
      // you can add wtimeoutMS, serverSelectionTimeoutMS if you want explicit timeouts
      serverSelectionTimeoutMS: 10000,
    })
    .then(() => {
      console.log("MongoDB connected");
      startServer();
    })
    .catch((err) => {
      console.error("Mongo connect error", err);
      // Don't start server if DB connect fails (prevents buffering timeouts in runtime logic).
      // If you want to start the server anyway, call startServer() here — but that caused your earlier buffering errors.
      process.exit(1);
    });
}
