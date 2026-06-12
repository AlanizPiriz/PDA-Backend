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
app.use(cors({
  origin: [
    "http://127.0.0.1:3001",
    "http://localhost:3001",
    "http://127.0.0.1:5500",
    "http://localhost:5500",
    "https://alanizpiriz.github.io"
  ],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "x-admin-key"]
}));

app.use(express.json());


function verificarAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];

  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({
      ok: false,
      error: "No autorizado"
    });
  }

  next();
}


app.post("/admin/login", (req, res) => {
  const { key } = req.body;

  if (key !== ADMIN_KEY) {
    return res.status(401).json({
      ok: false,
      error: "Clave incorrecta"
    });
  }

  res.json({
    ok: true,
    token: ADMIN_KEY
  });
});

app.get("/admin/test", verificarAdmin, (req, res) => {
  res.json({
    ok: true,
    message: "Admin autorizado"
  });
});





app.get("/admin/test-log", (req, res) => {

  emitirAdminLog({
    fecha: new Date().toLocaleTimeString(),
    usuario: "TEST",
    accion: "debug",
    estado: "ok",
    mensaje: "Log admin funcionando 🔥"
  });

  res.json({
    ok: true
  });
});







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

const tiendasEstado = {};

// ✅ inicializar socket.io
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
});

// ---------- SOCKETS ----------
io.on("connection", (socket) => {
    console.log(`Cliente conectado: ${socket.id}`);

    // ✅ UN SOLO handler de register
    socket.on("register", (data) => {

      const storeId =
        data.storeId;

      socket.join(storeId);

      // guardar tienda conectada
      socket.on("register", (data) => {
  const storeId = data.storeId;

  socket.join(storeId);
  socket.storeId = storeId;

  // ✅ Guardar clientType — si no viene, es el EXE
  socket.data.clientType = data.clientType || "printer";

  tiendasEstado[storeId] = {
    online: true,
    lastSeen: Date.now()
  };

  io.to("admin-room").emit("store-status", tiendasEstado);

  console.log(`Socket ${socket.id} registrado en sala: "${storeId}" | tipo: ${socket.data.clientType}`);
  console.log("Salas activas:", [...io.sockets.adapter.rooms.keys()]);
});

  socket.on("disconnect", () => {

    console.log(
      `Cliente desconectado: ${socket.id}`
    );
  
    // si era una tienda registrada
    if (socket.storeId) {
    
      tiendasEstado[
        socket.storeId
      ] = {
        online: false,
        lastSeen:
          Date.now()
      };
    
      // avisar al admin
      io.to("admin-room").emit(
        "store-status",
        tiendasEstado
      );
    }
  });

  socket.on("print-confirmed", ({ storeId }) => {
    io.to(storeId).emit("print-confirmed");

    console.log(
      `Impresión confirmada para ${storeId}`
    );
  });

  socket.on("join-admin", () => {
  socket.join("admin-room");
  console.log("🟢 Admin conectado");
  });
});

function emitirAdminLog(log) {
  io.to("admin-room").emit("admin-log", log);
}

app.post("/print", async (req, res) => {
  const { storeId, tickets } = req.body;

  if (!storeId || !tickets) {
    return res.status(400).json({
      ok: false,
      message: "Faltan storeId o tickets"
    });
  }

  const sala =
    io.sockets.adapter.rooms.get(storeId);

  console.log(
    `Emitiendo a sala "${storeId}". Sockets en sala:`,
    sala ? [...sala] : "SALA VACÍA ⚠️"
  );

  const sockets =
    await io.in(storeId).fetchSockets();

  const printers = sockets.filter(
    socket =>
      socket.data.clientType === "printer"
  );

  console.log(
    `Impresoras encontradas: ${printers.length}`
  );

  if (printers.length === 0) {
    emitirAdminLog({
      fecha: new Date().toLocaleTimeString(),
      usuario: storeId,
      accion: "print",
      estado: "error",
      mensaje:
        "EXE no conectado - impresora no encontrada"
    });

    await guardarLog(
      storeId,
      "print_error",
      null,
      "EXE no conectado"
    );

    return res.status(503).json({
      ok: false,
      message: "EXE no conectado"
    });
  }

  printers.forEach(socket => {
    socket.volatile.emit("print", {
      storeId,
      tickets
    });
  });

  emitirAdminLog({
    fecha: new Date().toLocaleTimeString(),
    usuario: storeId,
    accion: "print",
    estado: "ok",
    mensaje: `${tickets.length} bytes enviados`
  });

  await guardarLog(
    storeId,
    "print_ok",
    `${tickets.length} bytes enviados`
  );

  console.log(
    "Impresión enviada a",
    storeId
  );

  return res.status(200).json({
    ok: true
  });
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


// ---------- EXCEL INFO ----------
app.get("/excel-info/:tienda", async (req, res) => {
  const { tienda } = req.params;
  const filePath = `${tienda}/precios.xlsx`;

  const { data, error } = await supabase.storage
    .from("excels")
    .list(tienda, { search: "precios.xlsx" });

  if (error || !data || data.length === 0) {
    return res.json({ ok: false });
  }

  res.json({ ok: true, updatedAt: data[0].updated_at });
});


