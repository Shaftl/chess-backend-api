// backend/server.js
require("dotenv").config();

const http = require("http");
const app = require("./app");
const { initSockets } = require("./socket");

const PORT = process.env.PORT || 4000;
const server = http.createServer(app);

// init sockets (attaches Socket.IO to the HTTP server)
initSockets(server, process.env.SOCKET_ORIGIN || "http://localhost:3000");

server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
