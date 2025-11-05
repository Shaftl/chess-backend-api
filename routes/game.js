const express = require("express");
const Game = require("../models/Game");
const router = express.Router();

router.get("/", async (req, res) => {
  const list = await Game.find().sort({ createdAt: -1 }).limit(20);
  res.json(list);
});

router.get("/:roomId", async (req, res) => {
  const g = await Game.findOne({ roomId: req.params.roomId });
  if (!g) return res.status(404).json({ error: "Not found" });
  res.json(g);
});

module.exports = router;
