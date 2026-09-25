// catalog-api: owns the products table.
// Public:   GET /health, GET /products, GET /products/:id, GET /work?ms=500
// Internal: POST /internal/products/:id/reserve (needs the x-internal-secret header)

import { randomUUID, timingSafeEqual } from "node:crypto";
import cors from "cors";
import express from "express";
import pg from "pg";

const PORT = process.env.PORT || 8080;
// One or more browser origins allowed to call this API, comma-separated:
// WEB_ORIGIN=https://main-web-myteam.light-cloud.io,http://localhost:5173
const WEB_ORIGINS = (process.env.WEB_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// The current secret, plus the previous one while a rotation is in progress.
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;
const INTERNAL_SECRET_PREVIOUS = process.env.INTERNAL_SECRET_PREVIOUS;

// Connections per instance. Every instance opens its own pool, so the total
// is DB_POOL_MAX x running instances; keep it under the database's limit.
const DB_POOL_MAX = Number(process.env.DB_POOL_MAX || 2);
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: DB_POOL_MAX });

// Identifies this running copy of the service in responses and logs.
const INSTANCE_ID = randomUUID().slice(0, 8);

const PRODUCTS = [
  ["Espresso beans, 1 kg", 2400, 40],
  ["Pour-over kettle", 5900, 12],
  ["Ceramic mug", 1500, 100],
  ["Paper filters, 100 pack", 600, 250],
];

async function setUpDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS products (
      id          SERIAL PRIMARY KEY,
      name        TEXT    NOT NULL,
      price_cents INTEGER NOT NULL,
      stock       INTEGER NOT NULL
    )
  `);
  const { rows } = await db.query("SELECT count(*)::int AS n FROM products");
  if (rows[0].n === 0) {
    for (const [name, price, stock] of PRODUCTS) {
      await db.query(
        "INSERT INTO products (name, price_cents, stock) VALUES ($1, $2, $3)",
        [name, price, stock]
      );
    }
  }
}

// One JSON object per line. "severity" is what the Logs tab's level filter
// reads (INFO, WARNING, ERROR); requestId ties lines from all services together.
function log(req, message, extra = {}, severity = "INFO") {
  console.log(JSON.stringify({ severity, service: "catalog-api", requestId: req.requestId, message, ...extra }));
}

const app = express();
app.use(express.json());
app.use(cors({ origin: WEB_ORIGINS }));

// Every request gets an ID. If another service sent one, keep it, so one
// request can be followed across all services in the logs.
app.use((req, res, next) => {
  req.requestId = req.get("x-request-id") || randomUUID();
  res.set("x-request-id", req.requestId);
  next();
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "catalog-api", instance: INSTANCE_ID });
});

// Deliberately expensive: keeps the CPU busy for ?ms= milliseconds (max 2000),
// like a report or an image resize would. Used to watch autoscaling.
app.get("/work", (req, res) => {
  const ms = Math.min(Math.max(Number(req.query.ms) || 100, 1), 2000);
  const until = Date.now() + ms;
  let spins = 0;
  while (Date.now() < until) spins++;
  res.json({ service: "catalog-api", instance: INSTANCE_ID, worked_ms: ms });
});

app.get("/products", async (req, res) => {
  const { rows } = await db.query(
    `SELECT *, CASE WHEN stock = 0 THEN 'sold out' WHEN stock < 10 THEN 'low' ELSE 'in stock' END AS stock_status
     FROM products ORDER BY id`
  );
  log(req, "listed products", { count: rows.length });
  res.json(rows);
});

app.get("/products/:id", async (req, res) => {
  const { rows } = await db.query("SELECT * FROM products WHERE id = $1", [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: "Product not found" });
  res.json(rows[0]);
});

// Compares in constant time, so response timing does not leak the secret.
function sameSecret(expected, given) {
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Only other services may call /internal routes.
function requireInternalSecret(req, res, next) {
  const given = req.get("x-internal-secret");
  if (sameSecret(INTERNAL_SECRET, given)) return next();
  if (sameSecret(INTERNAL_SECRET_PREVIOUS, given)) {
    // Still accepted during a rotation. When this stops appearing in the
    // logs, every caller has the new secret and the old one can be removed.
    log(req, "internal call used the previous secret");
    return next();
  }
  log(req, "rejected internal call");
  return res.status(401).json({ error: "Unauthorized" });
}

app.post("/internal/products/:id/reserve", requireInternalSecret, async (req, res) => {
  const quantity = Number(req.body.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ error: "quantity must be a positive whole number" });
  }
  const { rows } = await db.query(
    `UPDATE products SET stock = stock - $2
     WHERE id = $1 AND stock >= $2
     RETURNING *`,
    [req.params.id, quantity]
  );
  if (rows.length === 0) {
    // Nothing updated: either the product does not exist or stock is short.
    const exists = await db.query("SELECT 1 FROM products WHERE id = $1", [req.params.id]);
    if (exists.rows.length === 0) {
      log(req, "product not found", { productId: req.params.id }, "WARNING");
      return res.status(404).json({ error: "Product not found" });
    }
    log(req, "reserve failed", { productId: req.params.id, quantity }, "WARNING");
    return res.status(409).json({ error: "Not enough stock" });
  }
  log(req, "reserved stock", { productId: rows[0].id, quantity, stockLeft: rows[0].stock });
  res.json(rows[0]);
});

// Errors from any route: a database that refuses more connections is
// temporary (503, try again); anything else is a 500. Always JSON.
app.use((err, req, res, next) => {
  const busy = /too many connections|remaining connection slots/i.test(err.message);
  log(req, busy ? "database busy" : "unhandled error", { error: err.message }, "ERROR");
  res.status(busy ? 503 : 500).json({ error: busy ? "Database busy, please try again" : "Internal error" });
});

await setUpDatabase();
app.listen(PORT, () => {
  console.log(`catalog-api ${INSTANCE_ID} listening on port ${PORT}, db pool max ${DB_POOL_MAX}`);
});
