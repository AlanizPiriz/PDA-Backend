const fs = require("fs");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const STORES_FILE = "./stores.json";

function loadStores() {
  if (!fs.existsSync(STORES_FILE)) return {};
  return JSON.parse(fs.readFileSync(STORES_FILE));
}

function saveStores(data) {
  fs.writeFileSync(STORES_FILE, JSON.stringify(data, null, 2));
}

const app = express();
app.use(cors());
app.use(express.json());

// ---------- LOGIN ----------
app.post("/login", (req, res) => {
  const { user, password } = req.body;
  let stores = loadStores();

  if (!stores[user]) {
    stores[user] = { password };
    saveStores(stores);
    console.log("Nueva tienda creada:", user);
  }

  if (stores[user].password !== password) {
    return res.json({ ok: false, message: "Password incorrecta" });
  }

  return res.json({ ok: true, storeId: user });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"]
});

// ---------- SOCKETS ----------
io.on("connection", (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);

  // ✅ UN SOLO handler de register
  socket.on("register", (data) => {
    const storeId = data.storeId;
    socket.join(storeId);
    console.log(`Socket ${socket.id} registrado en sala: "${storeId}"`);
    // Útil para debuggear: ver todas las salas activas
    console.log("Salas activas:", [...io.sockets.adapter.rooms.keys()]);
  });

  socket.on("disconnect", () => {
    console.log(`Cliente desconectado: ${socket.id}`);
  });
});

// ---------- PRINT ----------
app.post("/print", (req, res) => {
  const { storeId, tickets } = req.body;

  if (!storeId || !tickets) {
    return res.json({ ok: false, message: "Faltan storeId o tickets" });
  }

  // ✅ Ver a qué sala se va a emitir antes de emitir
  const sala = io.sockets.adapter.rooms.get(storeId);
  console.log(`Emitiendo a sala "${storeId}". Sockets en sala:`, sala ? [...sala] : "SALA VACÍA ⚠️");

  io.to(storeId).emit("print", { storeId, tickets });
  console.log("Impresión enviada a", storeId);

  res.json({ ok: true });
});

// ---------- TEST MANUAL (GET para probar desde el browser) ----------
app.get("/test-print/:storeId", (req, res) => {
  const { storeId } = req.params;
  const sala = io.sockets.adapter.rooms.get(storeId);
  console.log(`[TEST] Sala "${storeId}":`, sala ? [...sala] : "VACÍA ⚠️");

  io.to(storeId).emit("print", { tickets: "🔥 TEST IMPRESION 🔥" });
  res.json({ ok: true, sala: sala ? [...sala] : [] });
});


app.get("/", (req, res) => {
  res.send("Backend funcionando");
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});