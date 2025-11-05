// scripts/test-game.js
const { io } = require("socket.io-client");

const SERVER = process.env.SOCKET_URL || "http://localhost:4000";
const ROOM = "test-room-" + Date.now();

function wait(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function run() {
  console.log("Starting test against", SERVER, "room:", ROOM);

  const a = io(SERVER, { transports: ["websocket"], auth: {} });
  const b = io(SERVER, { transports: ["websocket"], auth: {} });

  const events = { a: [], b: [] };

  a.on("connect", () => console.log("A connected", a.id));
  b.on("connect", () => console.log("B connected", b.id));

  a.on("room-update", (r) => {
    events.a.push(["room-update", r]);
  });
  b.on("room-update", (r) => {
    events.b.push(["room-update", r]);
  });

  a.on("player-assigned", (d) => {
    console.log("A assigned", d);
  });
  b.on("player-assigned", (d) => {
    console.log("B assigned", d);
  });

  a.on("opponent-move", (m) => {
    console.log("A got opponent-move", m);
  });
  b.on("opponent-move", (m) => {
    console.log("B got opponent-move", m);
  });

  a.on("game-over", (g) => {
    console.log("A game-over", g);
  });
  b.on("game-over", (g) => {
    console.log("B game-over", g);
  });

  // join both
  a.emit("join-room", { roomId: ROOM, user: { username: "A" } });
  b.emit("join-room", { roomId: ROOM, user: { username: "B" } });

  await wait(400);

  // Try a legal move from A (white) - if A got 'w' seat
  // We will attempt moves; server will reject if wrong color.
  a.emit("make-move", { roomId: ROOM, move: { from: "e2", to: "e4" } });
  await wait(300);

  b.emit("make-move", { roomId: ROOM, move: { from: "e7", to: "e5" } });
  await wait(300);

  console.log("Offer draw from A");
  a.emit("offer-draw", { roomId: ROOM });
  await wait(300);

  console.log("B accept draw");
  b.emit("accept-draw", { roomId: ROOM });
  await wait(500);

  console.log("Events log (last few):");
  console.log("A events:", events.a.slice(-10));
  console.log("B events:", events.b.slice(-10));

  // disconnect both
  a.disconnect();
  b.disconnect();
  console.log("Test finished.");
  process.exit(0);
}

run().catch((e) => {
  console.error("Test failed", e);
  process.exit(1);
});
