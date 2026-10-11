// 404 Society — Cloudflare Worker
// Shopify (products + orders) • Google login • Cashfree payments
// Secrets (set in Cloudflare dashboard): SHOPIFY_STOREFRONT_TOKEN, SHOPIFY_ADMIN_TOKEN,
// CASHFREE_CLIENT_ID, CASHFREE_CLIENT_SECRET, SESSION_SECRET
// Vars (wrangler.jsonc): SHOPIFY_DOMAIN, GOOGLE_CLIENT_ID, CASHFREE_ENV, SHIP_THRESHOLD, SHIP_BELOW, SHIP_ABOVE

const enc = new TextEncoder();
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const J = (d, s = 200, h = {}) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...h } });
const num = (v, d) => (v === undefined || v === null || v === "" ? d : Number(v));
const b64 = (u) => btoa(String.fromCharCode(...u));
const b64u = (s) => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const same = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
async function hmac(secret, data) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}
const cookie = (req, n) => ((req.headers.get("cookie") || "").split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === n) || [])[1];
const SV = (env) => env.SHOPIFY_API_VERSION || "2026-04";

/* ---------- pure helpers (unit tested) ---------- */
export function shippingFor(subtotal, env = {}) {
  if (!(subtotal > 0)) return 0;
  return subtotal < num(env.SHIP_THRESHOLD, 2000) ? num(env.SHIP_BELOW, 0) : num(env.SHIP_ABOVE, 99);
}
export async function signSession(p, secret) {
  const body = b64u(b64(enc.encode(JSON.stringify(p))));
  return body + "." + b64u(b64(await hmac(secret, body)));
}
export async function verifySession(tok, secret) {
  if (!tok || !secret) return null;
  const [b, s] = tok.split(".");
  if (!b || !s || !same(s, b64u(b64(await hmac(secret, b))))) return null;
  try {
    const bin = atob(b.replace(/-/g, "+").replace(/_/g, "/"));
    const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    return p.exp > Date.now() / 1000 ? p : null;
  } catch { return null; }
}
export async function verifyCashfreeSignature(raw, ts, sig, secret) {
  if (!raw || !ts || !sig || !secret) return false;
  return same(b64(await hmac(secret, ts + raw)), sig);
}
export function normalizeProducts(d) {
  return ((d && d.products && d.products.nodes) || []).map((p) => {
    const vs = p.variants.nodes.map((v) => {
      const o = v.selectedOptions.find((x) => /size/i.test(x.name));
      const size = o ? o.value : v.title;
      return { id: v.id, size: size === "Default Title" ? "One size" : size, price: +v.price.amount, compareAt: v.compareAtPrice ? +v.compareAtPrice.amount : 0, available: !!v.availableForSale };
    });
    const avail = vs.filter((v) => v.available);
    return {
      id: p.id, title: p.title, category: p.productType || "Shop",
      image: (p.featuredImage && p.featuredImage.url) || "",
      price: Math.min(...(avail.length ? avail : vs).map((v) => v.price)),
      compareAt: Math.max(0, ...vs.map((v) => v.compareAt)), variants: vs,
    };
  }).filter((p) => p.variants.length);
}
export function cleanItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 20) return null;
  const m = new Map();
  for (const i of items) {
    const q = Number(i && i.qty);
    if (!i || typeof i.variantId !== "string" || !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(i.variantId) || !Number.isInteger(q) || q < 1 || q > 10) return null;
    m.set(i.variantId, (m.get(i.variantId) || 0) + q);
  }
  return [...m].map(([variantId, qty]) => ({ variantId, qty }));
}
export function validAddress(a) {
  if (!a || typeof a !== "object") return null;
  const t = (k) => String(a[k] == null ? "" : a[k]).trim().slice(0, 120);
  const o = { name: t("name"), phone: t("phone"), address1: t("address1"), city: t("city"), state: t("state"), pincode: t("pincode") };
  if (o.name.length < 2 || o.address1.length < 5 || o.city.length < 2 || o.state.length < 2 || !/^[6-9]\d{9}$/.test(o.phone) || !/^\d{6}$/.test(o.pincode)) return null;
  return o;
}
export function shopifyOrder(rec, id) {
  const a = rec.address, [first, ...rest] = a.name.split(" ");
  return { order: {
    email: rec.email, currency: "INR", financial_status: "paid", send_receipt: true,
    tags: "404society, cashfree", note: "Cashfree order " + id,
    line_items: rec.lines.map((l) => ({ variant_id: Number(l.variantId.split("/").pop()), quantity: l.qty })),
    shipping_lines: [{ title: "Standard shipping", code: "STD", price: rec.shipping.toFixed(2) }],
    shipping_address: { first_name: first, last_name: rest.join(" ") || "-", address1: a.address1, city: a.city, province: a.state, zip: a.pincode, country: "IN", phone: a.phone },
    transactions: [{ kind: "sale", status: "success", gateway: "Cashfree", amount: rec.total.toFixed(2) }],
  } };
}

/* ---------- Shopify ---------- */
const Q_PRODUCTS = `{products(first:50){nodes{id title productType featuredImage{url} variants(first:30){nodes{id title availableForSale price{amount} compareAtPrice{amount} selectedOptions{name value}}}}}}`;
const Q_VARIANTS = `query($ids:[ID!]!){nodes(ids:$ids){... on ProductVariant{id availableForSale price{amount} product{title}}}}`;
async function storefront(env, query, variables) {
  const r = await fetch(`https://${env.SHOPIFY_DOMAIN}/api/${SV(env)}/graphql.json`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Shopify-Storefront-Access-Token": env.SHOPIFY_STOREFRONT_TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error("shopify " + r.status);
  const j = await r.json();
  if (j.errors) throw new Error("shopify graphql");
  return j.data;
}
async function priceItems(env, items) {
  const d = await storefront(env, Q_VARIANTS, { ids: items.map((i) => i.variantId) });
  const byId = Object.fromEntries((d.nodes || []).filter(Boolean).map((n) => [n.id, n]));
  let subtotal = 0; const lines = [];
  for (const i of items) {
    const n = byId[i.variantId];
    if (!n || !n.availableForSale) throw new HttpError(409, "An item in your bag is unavailable");
    const price = +n.price.amount; // price always comes from Shopify, never from the browser
    subtotal += price * i.qty;
    lines.push({ variantId: i.variantId, qty: i.qty, price, title: n.product.title });
  }
  return { lines, subtotal };
}

/* ---------- Cashfree ---------- */
const cfBase = (env) => (env.CASHFREE_ENV === "production" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg");
const cfHeaders = (env) => ({ "content-type": "application/json", "x-api-version": "2023-08-01", "x-client-id": env.CASHFREE_CLIENT_ID, "x-client-secret": env.CASHFREE_CLIENT_SECRET });

async function checkout(req, env, sess) {
  const b = await req.json().catch(() => null);
  const items = cleanItems(b && b.items), addr = validAddress(b && b.address);
  if (!items || !addr) throw new HttpError(400, "Invalid bag or delivery details");
  const { lines, subtotal } = await priceItems(env, items);
  const shipping = shippingFor(subtotal, env);
  const total = +(subtotal + shipping).toFixed(2);
  const orderId = "404_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  const origin = new URL(req.url).origin;
  const r = await fetch(cfBase(env) + "/orders", {
    method: "POST", headers: cfHeaders(env),
    body: JSON.stringify({
      order_id: orderId, order_amount: total, order_currency: "INR",
      customer_details: { customer_id: "g_" + String(sess.sub).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40), customer_email: sess.email, customer_phone: addr.phone, customer_name: addr.name },
      order_meta: { return_url: origin + "/?order_id={order_id}", notify_url: origin + "/api/cashfree/webhook" },
    }),
  });
  if (!r.ok) throw new HttpError(502, "Payment provider error");
  const o = await r.json();
  await env.ORDERS.put("order:" + orderId, JSON.stringify({ lines, address: addr, email: sess.email, subtotal, shipping, total, status: "pending" }), { expirationTtl: 2592000 });
  return J({ order_id: orderId, payment_session_id: o.payment_session_id, total, shipping });
}

// Creates the paid order in Shopify exactly once. Returns "created" | "skipped" | "failed".
export async function fulfil(id, env) {
  const key = "order:" + id;
  const rec = JSON.parse((await env.ORDERS.get(key)) || "null");
  if (!rec || rec.status !== "pending") return "skipped";
  rec.status = "creating";
  await env.ORDERS.put(key, JSON.stringify(rec), { expirationTtl: 2592000 });
  const r = await fetch(`https://${env.SHOPIFY_DOMAIN}/admin/api/${SV(env)}/orders.json`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Shopify-Access-Token": env.SHOPIFY_ADMIN_TOKEN },
    body: JSON.stringify(shopifyOrder(rec, id)),
  });
  rec.status = r.ok ? "created" : "pending";
  await env.ORDERS.put(key, JSON.stringify(rec), { expirationTtl: 2592000 });
  return r.ok ? "created" : "failed";
}

async function webhook(req, env) {
  const raw = await req.text();
  if (!(await verifyCashfreeSignature(raw, req.headers.get("x-webhook-timestamp"), req.headers.get("x-webhook-signature"), env.CASHFREE_CLIENT_SECRET))) return J({ error: "bad signature" }, 401);
  let e; try { e = JSON.parse(raw); } catch { return J({ error: "bad json" }, 400); }
  if (e.type === "PAYMENT_SUCCESS_WEBHOOK") {
    const id = e.data && e.data.order && e.data.order.order_id;
    if (id && (await fulfil(id, env)) === "failed") return J({ error: "retry" }, 500); // Cashfree will retry
  }
  return J({ ok: true });
}

async function orderStatus(url, env, sess) {
  const id = url.searchParams.get("order_id") || "";
  if (!/^404_[a-f0-9]{20}$/.test(id)) throw new HttpError(400, "Bad order id");
  const rec = JSON.parse((await env.ORDERS.get("order:" + id)) || "null");
  if (!rec || rec.email !== sess.email) throw new HttpError(404, "Order not found");
  const r = await fetch(cfBase(env) + "/orders/" + id, { headers: cfHeaders(env) });
  if (!r.ok) throw new HttpError(502, "Payment provider error");
  const o = await r.json();
  if (o.order_status === "PAID") await fulfil(id, env); // covers a delayed webhook
  return J({ status: o.order_status });
}

/* ---------- Google login ---------- */
async function googleLogin(req, env) {
  const b = await req.json().catch(() => null);
  const c = b && b.credential;
  if (typeof c !== "string" || c.length > 4096) throw new HttpError(400, "Bad credential");
  const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(c));
  if (!r.ok) throw new HttpError(401, "Invalid Google token");
  const t = await r.json();
  if (!env.GOOGLE_CLIENT_ID || t.aud !== env.GOOGLE_CLIENT_ID || String(t.email_verified) !== "true" || !/^(https:\/\/)?accounts\.google\.com$/.test(t.iss) || !(+t.exp > Date.now() / 1000)) throw new HttpError(401, "Invalid Google token");
  const sess = { sub: t.sub, email: t.email, name: t.name || t.email, exp: Math.floor(Date.now() / 1000) + 604800 };
  const tok = await signSession(sess, env.SESSION_SECRET);
  return J({ name: sess.name, email: sess.email }, 200, { "set-cookie": `sid=${tok}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800` });
}

/* ---------- router ---------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname, POST = req.method === "POST", GET = req.method === "GET";
    if (!p.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      if (p === "/api/cashfree/webhook" && POST) return await webhook(req, env);
      const origin = req.headers.get("origin");
      if (POST && origin && origin !== url.origin) throw new HttpError(403, "Bad origin");
      if (p === "/api/config" && GET) return J({ googleClientId: env.GOOGLE_CLIENT_ID || "", cashfreeMode: env.CASHFREE_ENV === "production" ? "production" : "sandbox", threshold: num(env.SHIP_THRESHOLD, 2000), shipBelow: num(env.SHIP_BELOW, 0), shipAbove: num(env.SHIP_ABOVE, 99) });
      if (p === "/api/products" && GET) return J({ products: normalizeProducts(await storefront(env, Q_PRODUCTS, {})) }, 200, { "cache-control": "public, max-age=60" });
      const sess = await verifySession(cookie(req, "sid"), env.SESSION_SECRET);
      if (p === "/api/me" && GET) return sess ? J({ name: sess.name, email: sess.email }) : J({ error: "signed out" }, 401);
      if (p === "/api/auth/google" && POST) return await googleLogin(req, env);
      if (p === "/api/auth/logout" && POST) return J({ ok: true }, 200, { "set-cookie": "sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
      if (!sess) throw new HttpError(401, "Please sign in with Google");
      if (p === "/api/checkout" && POST) return await checkout(req, env, sess);
      if (p === "/api/order-status" && GET) return await orderStatus(url, env, sess);
      throw new HttpError(404, "Not found");
    } catch (e) {
      if (e instanceof HttpError) return J({ error: e.message }, e.status);
      console.error(e);
      return J({ error: "Server error" }, 500);
    }
  },
};
