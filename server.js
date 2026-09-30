import { createServer } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = resolve(ROOT, process.env.DATA_DIR || "data");
const KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "";

const DELIVERY_CHARGE = 80;
const COD_LIMIT = 2000;
const PINCODES = new Set(["560078", "560076", "560069", "560041", "560011", "560070", "560062", "560068", "560085"]);

const CATALOG = {
  "sankranti-sweet-box": { price:699, festival:"pongal" },
  "pongal-festival-pack": { price:1099, festival:"pongal" },
  "hyd-biryani": { price:399, festival:"ramzan", sizes:[1,2,5], options:{ spice:{Mild:0,Medium:0,Spicy:0}, sides:{"With Raita & Brinjal":0,"Biryani only":0}, type:{Chicken:0,Veg:0,Jain:0} } },
  "royal-biryani-combo": { price:1599, festival:"ramzan" },
  "meeta-khana": { price:1100, festival:"ramzan" },
  "eid-feast-box": { price:3499, festival:"ramzan" },
  "holi-snack-box": { price:3200, festival:"holi" },
  "gujiya-pack": { price:1200, festival:"holi" },
  "kolukattai-box": { price:699, festival:"vinayaka" },
  "ganesh-prasadam": { price:999, festival:"vinayaka" },
  "onam-sadhya-box": { price:599, festival:"onam" },
  "onam-feast-combo": { price:2100, festival:"onam" },
  "sundal-combo": { price:249, festival:"navaratri" },
  "dussehra-catering": { price:7999, festival:"navaratri" },
  "diwali-sweet-box": { price:899, festival:"diwali" },
  "diwali-savory-box": { price:1100, festival:"diwali" },
  "diwali-hamper": { price:2100, festival:"diwali" },
  "diwali-corporate-box": { price:1100, festival:"diwali" }
};

const COUPONS = {
  DIWALI15: { pct:15, festival:"diwali", expires:"2026-10-15" },
  EARLYBIRD10: { pct:10, festival:"diwali", expires:"2026-10-20" }
};

mkdirSync(DATA_DIR, { recursive:true });
const db = new DatabaseSync(join(DATA_DIR, "orders.sqlite"));
db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    order_json TEXT NOT NULL,
    total_rupees INTEGER NOT NULL,
    amount_due_rupees INTEGER NOT NULL,
    amount_paid_rupees INTEGER NOT NULL DEFAULT 0,
    razorpay_order_id TEXT UNIQUE,
    razorpay_payment_id TEXT UNIQUE
  );
  CREATE INDEX IF NOT EXISTS idx_orders_razorpay_order ON orders(razorpay_order_id);
`);

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type":"application/json; charset=utf-8", "cache-control":"no-store" });
  res.end(body);
}

function readBody(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("Request is too large"), { status:413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(raw) {
  try { return JSON.parse(raw.toString("utf8")); }
  catch { throw Object.assign(new Error("Invalid JSON"), { status:400 }); }
}

function cleanText(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function calculateOrder(input) {
  if (!input || !Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 50) {
    throw Object.assign(new Error("Your cart is empty or invalid"), { status:400 });
  }
  const name = cleanText(input.name, 100);
  const phone = cleanText(input.phone, 20).replace(/\D/g, "");
  const method = input.method === "pickup" ? "pickup" : input.method === "delivery" ? "delivery" : "";
  const payMode = ["cod", "half", "full"].includes(input.payMode) ? input.payMode : "";
  const pin = cleanText(input.pin, 6);
  const addr = cleanText(input.addr, 500);
  if (name.length < 2) throw Object.assign(new Error("Customer name is required"), { status:400 });
  if (!/^\d{10}$/.test(phone)) throw Object.assign(new Error("A valid 10-digit phone number is required"), { status:400 });
  if (!method || !payMode) throw Object.assign(new Error("Delivery or payment method is invalid"), { status:400 });
  if (method === "delivery" && (!PINCODES.has(pin) || addr.length < 10)) {
    throw Object.assign(new Error("A serviceable delivery address is required"), { status:400 });
  }
  if (method === "delivery" && payMode !== "full") {
    throw Object.assign(new Error("Home delivery requires full advance payment"), { status:400 });
  }
  const date = cleanText(input.date, 10);
  const slot = cleanText(input.slot, 80);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || slot.length < 3) {
    throw Object.assign(new Error("A valid order date and time slot are required"), { status:400 });
  }

  let subtotal = 0;
  const festivals = new Set();
  const lines = input.lines.map(raw => {
    const product = CATALOG[cleanText(raw.pid, 80)];
    const qty = Number(raw.qty);
    if (!product || !Number.isInteger(qty) || qty < 1 || qty > 100) {
      throw Object.assign(new Error("A cart item is invalid"), { status:400 });
    }
    const size = Number.isInteger(Number(raw.size)) ? Number(raw.size) : 0;
    const multiplier = product.sizes ? product.sizes[size] : 1;
    if (!multiplier) throw Object.assign(new Error("A product size is invalid"), { status:400 });
    const opts = {};
    let optionDelta = 0;
    for (const [group, allowed] of Object.entries(product.options || {})) {
      const selected = cleanText(raw.opts?.[group], 100);
      if (!(selected in allowed)) throw Object.assign(new Error("A product option is invalid"), { status:400 });
      opts[group] = selected;
      optionDelta += allowed[selected];
    }
    const unitPrice = Math.round(product.price * multiplier + optionDelta);
    subtotal += unitPrice * qty;
    festivals.add(product.festival);
    return { pid:raw.pid, size, opts, qty, unitPrice };
  });

  const couponCode = cleanText(input.coupon, 30).toUpperCase();
  const coupon = couponCode ? COUPONS[couponCode] : null;
  let discount = 0;
  if (coupon && new Date().toISOString().slice(0, 10) <= coupon.expires && festivals.has(coupon.festival)) {
    discount = Math.round(subtotal * coupon.pct / 100);
  }
  const delivery = method === "delivery" ? DELIVERY_CHARGE : 0;
  const total = subtotal + delivery - discount;
  if (payMode === "cod" && total > COD_LIMIT) {
    throw Object.assign(new Error(`Cash on delivery is only available up to ₹${COD_LIMIT}`), { status:400 });
  }
  const amountDue = payMode === "cod" ? 0 : payMode === "half" ? Math.round(total / 2) : total;
  return {
    name, phone, method, payMode, pin, addr:method === "pickup" ? "JP Nagar Branch, Bengaluru" : addr,
    date, slot, coupon:discount ? couponCode : null,
    lines, bill:{ sub:subtotal, del:delivery, disc:discount, pct:discount ? coupon.pct : 0 }, total, amountDue
  };
}

function newOrderId() {
  return `SSS${Date.now().toString(36).toUpperCase()}${randomBytes(2).toString("hex").toUpperCase()}`;
}

function saveOrder(order, status, razorpayOrderId = null) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO orders
    (id, created_at, updated_at, status, customer_name, customer_phone, order_json,
     total_rupees, amount_due_rupees, amount_paid_rupees, razorpay_order_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
    .run(order.id, now, now, status, order.name, order.phone, JSON.stringify(order), order.total, order.amountDue, razorpayOrderId);
}

function publicOrder(order, paid, status) {
  return {
    id:order.id, placed:order.placed, lines:order.lines.map(({ pid, size, opts, qty }) => ({ pid, size, opts, qty })),
    date:order.date, slot:order.slot, method:order.method, addr:order.addr, name:order.name, phone:order.phone,
    total:order.total, paid, payMode:order.payMode, bill:order.bill, stage:0, coupon:order.coupon, paymentStatus:status
  };
}

async function razorpay(path, options = {}) {
  if (!KEY_ID || !KEY_SECRET) throw Object.assign(new Error("Razorpay is not configured on the server"), { status:503 });
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    ...options,
    headers:{
      authorization:`Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64")}`,
      "content-type":"application/json",
      ...(options.headers || {})
    }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = result?.error?.description || "Razorpay request failed";
    throw Object.assign(new Error(message), { status:502 });
  }
  return result;
}

function secureEqual(actual, expected) {
  const a = Buffer.from(String(actual || ""));
  const b = Buffer.from(String(expected || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

async function createOrder(req, res) {
  const input = parseJson(await readBody(req));
  const order = calculateOrder(input);
  order.id = newOrderId();
  order.placed = new Date().toISOString().slice(0, 10);

  if (order.payMode === "cod") {
    saveOrder(order, "cod_confirmed");
    return json(res, 201, { requiresPayment:false, order:publicOrder(order, 0, "cod_confirmed") });
  }

  const gatewayOrder = await razorpay("/orders", {
    method:"POST",
    body:JSON.stringify({
      amount:order.amountDue * 100,
      currency:"INR",
      receipt:order.id,
      notes:{ internal_order_id:order.id, customer_phone:order.phone }
    })
  });
  saveOrder(order, "payment_pending", gatewayOrder.id);
  json(res, 201, {
    requiresPayment:true,
    keyId:KEY_ID,
    razorpayOrderId:gatewayOrder.id,
    amount:gatewayOrder.amount,
    currency:"INR",
    businessName:"SSS Catering",
    description:`Order ${order.id}`,
    customer:{ name:order.name, contact:`+91${order.phone}` },
    internalOrderId:order.id
  });
}

async function verifyPayment(req, res) {
  const body = parseJson(await readBody(req));
  const internalId = cleanText(body.internalOrderId, 80);
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(internalId);
  if (!row) return json(res, 404, { error:"Order not found" });
  if (row.razorpay_order_id !== body.razorpayOrderId) return json(res, 400, { error:"Payment does not match this order" });
  const expected = createHmac("sha256", KEY_SECRET)
    .update(`${row.razorpay_order_id}|${cleanText(body.razorpayPaymentId, 100)}`)
    .digest("hex");
  if (!secureEqual(body.razorpaySignature, expected)) return json(res, 400, { error:"Payment verification failed" });

  let payment = await razorpay(`/payments/${encodeURIComponent(body.razorpayPaymentId)}`);
  if (payment.order_id !== row.razorpay_order_id || payment.amount !== row.amount_due_rupees * 100) {
    return json(res, 400, { error:"Payment amount or order does not match" });
  }
  if (payment.status === "authorized") {
    payment = await razorpay(`/payments/${encodeURIComponent(payment.id)}/capture`, {
      method:"POST", body:JSON.stringify({ amount:payment.amount, currency:"INR" })
    });
  }
  if (payment.status !== "captured") return json(res, 409, { error:"Payment is still processing. Please check again shortly." });

  db.prepare(`UPDATE orders SET status='paid', amount_paid_rupees=?, razorpay_payment_id=?, updated_at=? WHERE id=?`)
    .run(row.amount_due_rupees, payment.id, new Date().toISOString(), internalId);
  const order = JSON.parse(row.order_json);
  json(res, 200, { order:publicOrder(order, row.amount_due_rupees, "paid") });
}

async function webhook(req, res) {
  const raw = await readBody(req, 512 * 1024);
  if (!WEBHOOK_SECRET) return json(res, 503, { error:"Webhook is not configured" });
  const expected = createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  if (!secureEqual(req.headers["x-razorpay-signature"], expected)) return json(res, 401, { error:"Invalid webhook signature" });
  const event = parseJson(raw);
  const payment = event?.payload?.payment?.entity;
  if (event.event === "payment.captured" && payment?.order_id) {
    db.prepare(`UPDATE orders SET status='paid', amount_paid_rupees=amount_due_rupees,
      razorpay_payment_id=COALESCE(razorpay_payment_id, ?), updated_at=? WHERE razorpay_order_id=?`)
      .run(payment.id, new Date().toISOString(), payment.order_id);
  } else if (event.event === "payment.failed" && payment?.order_id) {
    db.prepare(`UPDATE orders SET status='payment_failed', updated_at=? WHERE razorpay_order_id=? AND status!='paid'`)
      .run(new Date().toISOString(), payment.order_id);
  } else if (event.event === "refund.processed" && payment?.id) {
    db.prepare(`UPDATE orders SET status='refunded', updated_at=? WHERE razorpay_payment_id=?`)
      .run(new Date().toISOString(), payment.id);
  }
  json(res, 200, { received:true });
}

const MIME = {
  ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8",
  ".json":"application/json; charset=utf-8", ".webmanifest":"application/manifest+json", ".png":"image/png", ".jpg":"image/jpeg"
};

function staticFile(req, res) {
  const url = new URL(req.url, "http://localhost");
  const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const safe = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  const path = join(ROOT, safe);
  if (!path.startsWith(ROOT) || !existsSync(path) || path.includes(`${DATA_DIR}`)) {
    res.writeHead(404); return res.end("Not found");
  }
  res.writeHead(200, {
    "content-type":MIME[extname(path).toLowerCase()] || "application/octet-stream",
    "x-content-type-options":"nosniff",
    "referrer-policy":"strict-origin-when-cross-origin"
  });
  res.end(readFileSync(path));
}

export const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    if (req.method === "POST" && path === "/api/orders") return await createOrder(req, res);
    if (req.method === "POST" && path === "/api/payments/verify") return await verifyPayment(req, res);
    if (req.method === "POST" && path === "/api/webhooks/razorpay") return await webhook(req, res);
    if (req.method === "GET" || req.method === "HEAD") return staticFile(req, res);
    json(res, 404, { error:"Not found" });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, error.status || 500, { error:error.status ? error.message : "Unexpected server error" });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`SSS Catering listening on http://localhost:${PORT}`));
}

export { calculateOrder, secureEqual };
