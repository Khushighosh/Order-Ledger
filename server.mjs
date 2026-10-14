// server.mjs - Order Ledger: a tiny local web app. No npm packages needed.
// Run:  node server.mjs   then open http://localhost:3000
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { extractOrder, DEFAULT_MODEL } from "./extract.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const DB_FILE = path.join(__dirname, "orders.json");
const UNITS = ["kg", "pcs", "litre", "box"];
const STATUSES = ["confirmed", "tentative", "cancelled"];

// ---------- storage (a plain JSON file, easy to inspect and back up) ----------
function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveDb(rows) {
  fs.writeFileSync(DB_FILE, JSON.stringify(rows, null, 2));
}

// ---------- validation: never trust what the model or the browser sends ----------
const num = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

function clean(o = {}) {
  const phone = str(o.phone)?.replace(/\D/g, "").slice(-10) || null;
  return {
    customer: str(o.customer),
    phone,
    items: Array.isArray(o.items)
      ? o.items.map((i) => ({
          name: str(i?.name) ?? "item",
          qty: num(i?.qty),
          unit: UNITS.includes(i?.unit) ? i.unit : null,
          notes: str(i?.notes),
        }))
      : [],
    delivery_date: /^\d{4}-\d{2}-\d{2}$/.test(o.delivery_date ?? "") ? o.delivery_date : null,
    delivery_time: str(o.delivery_time),
    amount: num(o.amount),
    paid: num(o.paid) ?? 0,
    status: STATUSES.includes(o.status) ? o.status : "confirmed",
    delivered: Boolean(o.delivered),
    needs_review: Boolean(o.needs_review),
    source_chat: str(o.source_chat),
  };
}

// ---------- helpers ----------
function send(res, status, body, type = "application/json; charset=utf-8", extra = {}) {
  res.writeHead(status, { "Content-Type": type, ...extra });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

function readJson(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("Request too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  const head = ["date", "time", "customer", "phone", "items", "total", "paid", "balance", "status", "delivered"];
  const lines = rows.map((o) => {
    const items = o.items.map((i) => `${i.qty ?? "?"} ${i.unit ?? ""} ${i.name}`.replace(/\s+/g, " ").trim()).join("; ");
    const balance = o.amount == null ? "" : Math.max(0, o.amount - (o.paid || 0));
    return [o.delivery_date, o.delivery_time, o.customer, o.phone, items, o.amount, o.paid, balance, o.status, o.delivered ? "yes" : "no"]
      .map(csvCell)
      .join(",");
  });
  return "\uFEFF" + [head.join(","), ...lines].join("\r\n");
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    const idMatch = url.pathname.match(/^\/api\/orders\/([\w-]+)$/);

    if (route === "GET /" || route === "GET /index.html") {
      return send(res, 200, fs.readFileSync(path.join(__dirname, "index.html")), "text/html; charset=utf-8");
    }

    if (route === "GET /api/health") {
      let ollama = false;
      let modelReady = false;
      try {
        const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
        ollama = r.ok;
        if (r.ok) {
          const tags = await r.json();
          modelReady = (tags.models ?? []).some((m) => m.name === DEFAULT_MODEL || m.model === DEFAULT_MODEL);
        }
      } catch {}
      return send(res, 200, { ollama, modelReady, model: DEFAULT_MODEL });
    }

    if (route === "POST /api/parse") {
      const { chat } = await readJson(req);
      if (typeof chat !== "string" || !chat.trim()) return send(res, 400, { error: "Paste a chat first." });
      try {
        const parsed = await extractOrder(chat);
        return send(res, 200, clean(parsed));
      } catch (err) {
        const unreachable = /fetch failed|ECONNREFUSED/i.test(`${err.message} ${err.cause?.code ?? ""}`);
        const msg = unreachable
          ? "Could not reach the local model. Is Ollama running?"
          : `The model could not read that chat: ${err.message}`;
        return send(res, 502, { error: msg });
      }
    }

    if (route === "GET /api/orders") return send(res, 200, loadDb());

    if (route === "POST /api/orders") {
      const body = await readJson(req);
      const row = { id: randomUUID(), created_at: new Date().toISOString(), ...clean(body) };
      const rows = loadDb();
      rows.push(row);
      saveDb(rows);
      return send(res, 201, row);
    }

    if (idMatch && req.method === "PUT") {
      const rows = loadDb();
      const i = rows.findIndex((r) => r.id === idMatch[1]);
      if (i < 0) return send(res, 404, { error: "Order not found" });
      const body = await readJson(req);
      rows[i] = { ...clean({ ...rows[i], ...body }), id: rows[i].id, created_at: rows[i].created_at };
      saveDb(rows);
      return send(res, 200, rows[i]);
    }

    if (idMatch && req.method === "DELETE") {
      const rows = loadDb();
      const left = rows.filter((r) => r.id !== idMatch[1]);
      if (left.length === rows.length) return send(res, 404, { error: "Order not found" });
      saveDb(left);
      return send(res, 200, { ok: true });
    }

    if (route === "GET /api/export.csv") {
      return send(res, 200, toCsv(loadDb()), "text/csv; charset=utf-8", {
        "Content-Disposition": 'attachment; filename="orders.csv"',
      });
    }

    send(res, 404, { error: "Not found" });
  } catch (err) {
    send(res, err.status ?? 500, { error: err.message ?? "Server error" });
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") console.error(`Port ${PORT} is already in use. Close the other copy of this app, or run: set PORT=3001 && node server.mjs`);
  else console.error(err);
  process.exit(1);
});

// 127.0.0.1 = only this computer can open the app. Nothing is exposed to the network.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Order Ledger is running at http://localhost:${PORT}`);
  console.log(`Model: ${DEFAULT_MODEL} via ${OLLAMA_URL}`);
});
