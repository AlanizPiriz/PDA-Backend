require("dotenv").config();

const fs = require("fs");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const ADMIN_KEY = process.env.ADMIN_KEY;

if (!ADMIN_KEY) {
  throw new Error("Falta ADMIN_KEY en variables de entorno");
}

const { createClient } = require("@supabase/supabase-js");
const multer = require("multer");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const upload = multer({ storage: multer.memoryStorage() });

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

app.post("/login", async (req, res) => {
  const { user, password } = req.body;
  const storeId = user.toLowerCase();
  let stores = loadStores();

  if (!stores[storeId]) {
    stores[storeId] = { password };
    saveStores(stores);
    console.log("Nueva tienda creada:", storeId);
  }

  if (stores[storeId].password !== password) {
    await guardarLog(storeId, "login_fallido", `Usuario: ${user}`, "Password incorrecta");
    return res.json({ ok: false, message: "Password incorrecta" });
  }

  return res.json({ ok: true, storeId });
});


// ✅ crear servidor HTTP
const server = http.createServer(app);

// ✅ inicializar socket.io
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
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

app.post("/print", async (req, res) => {
  const { storeId, tickets } = req.body;

  if (!storeId || !tickets) {
    return res.json({ ok: false, message: "Faltan storeId o tickets" });
  }

  const sala = io.sockets.adapter.rooms.get(storeId);
  console.log(`Emitiendo a sala "${storeId}". Sockets en sala:`, sala ? [...sala] : "SALA VACÍA ⚠️");

  if (!sala || sala.size === 0) {
    await guardarLog(storeId, "print_error", null, "EXE no conectado - sala vacía");
    return res.json({ ok: false, message: "EXE no conectado" });
  }

  io.to(storeId).emit("print", { storeId, tickets });
  await guardarLog(storeId, "print_ok", `${tickets.length} bytes enviados`);
  console.log("Impresión enviada a", storeId);

  res.json({ ok: true });
});

// ---------- UPLOAD EXCEL ----------
app.post("/upload-excel", upload.single("excel"), async (req, res) => {
  const { storeId } = req.body;

  if (!storeId || !req.file) {
    return res.json({ ok: false, message: "Faltan storeId o archivo" });
  }

  const filePath = `${storeId}/precios.xlsx`;

  const { error } = await supabase.storage
    .from("excels")
    .upload(filePath, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: true
    });

  if (error) {
    console.error("Error subiendo a Supabase:", error.message);
    return res.json({ ok: false, message: error.message });
  }

  console.log(`Excel subido para tienda: ${storeId}`);
  io.to(storeId).emit("nuevoExcel", { storeId, fileName: req.file.originalname });
  await guardarLog(storeId, "excel_subido", req.file.originalname);
  res.json({ ok: true, fileName: req.file.originalname });
});


// ---------- DOWNLOAD EXCEL ----------
app.get("/excel/:tienda", async (req, res) => {
  const { tienda } = req.params;
  const filePath = `${tienda}/precios.xlsx`;

  const { data, error } = await supabase.storage
    .from("excels")
    .download(filePath);

  if (error) {
    console.error("Error descargando de Supabase:", error.message);
    return res.status(404).json({ ok: false, message: error.message });
  }

  const buffer = Buffer.from(await data.arrayBuffer());
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="precios.xlsx"`);
  res.send(buffer);
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

async function guardarLog(storeId, evento, detalle = null, error = null) {
  try {
    await supabase.from("logs").insert({
      store_id: storeId,
      evento,
      detalle,
      error
    });
  } catch (err) {
    console.error("Error guardando log:", err.message);
  }
}


// ---------- ADMIN LOGS ----------
app.get("/admin/logs", async (req, res) => {
  const key = req.headers["x-admin-key"];
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, message: "No autorizado" });
  }

  const storeId = req.query.storeId;
  let query = supabase.from("logs").select("*").order("created_at", { ascending: false }).limit(100);

  if (storeId) {
    query = query.eq("store_id", storeId);
  }

  const { data, error } = await query;

  if (error) {
    return res.json({ ok: false, message: error.message });
  }

  res.json({ ok: true, logs: data });
});