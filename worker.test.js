import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker, { shippingFor, signSession, verifySession, verifyCashfreeSignature, normalizeProducts, cleanItems, validAddress, shopifyOrder } from "../src/worker.js";

const VID = "gid://shopify/ProductVariant/111";
const ADDR = { name: "Asha Rao", phone: "9876543210", address1: "12 MG Road", city: "Pune", state: "Maharashtra", pincode: "411001" };
const kv = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v) }; };
const mkEnv = (o = {}) => ({ SHOPIFY_DOMAIN: "shop.test", SHOPIFY_STOREFRONT_TOKEN: "sf", SHOPIFY_ADMIN_TOKEN: "adm", CASHFREE_CLIENT_ID: "cid", CASHFREE_CLIENT_SECRET: "csecret", SESSION_SECRET: "sess-secret", GOOGLE_CLIENT_ID: "gid-client", CASHFREE_ENV: "sandbox", ORDERS: kv(), ASSETS: { fetch: async () => new Response("<html>static</html>") }, ...o });
const call = (env, path, init = {}) => worker.fetch(new Request("https://404.test" + path, init), env);
const authed = async (env) => ({ cookie: "sid=" + (await signSession({ sub: "u1", email: "a@b.com", name: "Asha", exp: Math.floor(Date.now() / 1000) + 600 }, env.SESSION_SECRET)) });
const post = (body, headers = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const stubFetch = (h) => { const calls = []; globalThis.fetch = async (u, i = {}) => { calls.push({ url: String(u), init: i }); return h(String(u), i); }; return calls; };
const jr = (d, s = 200) => new Response(JSON.stringify(d), { status: s });
const variantNode = (price) => ({ data: { nodes: [{ id: VID, availableForSale: true, price: { amount: String(price) }, product: { title: "Tee" } }] } });

test("shipping: ₹0 below ₹2000, ₹99 from ₹2000, ₹0 for empty bag", () => {
  assert.equal(shippingFor(1999, {}), 0);
  assert.equal(shippingFor(2000, {}), 99);
  assert.equal(shippingFor(0, {}), 0);
  assert.equal(shippingFor(2500, { SHIP_ABOVE: "0" }), 0);
});

test("session: sign, verify, tamper, expiry", async () => {
  const ok = await signSession({ email: "a@b.com", exp: Math.floor(Date.now() / 1000) + 60 }, "k");
  assert.equal((await verifySession(ok, "k")).email, "a@b.com");
  assert.equal(await verifySession(ok, "other"), null);
  assert.equal(await verifySession(ok.slice(0, -2) + "xx", "k"), null);
  assert.equal(await verifySession(await signSession({ exp: 1 }, "k"), "k"), null);
  assert.equal(await verifySession(undefined, "k"), null);
});

test("cashfree signature check", async () => {
  const raw = '{"type":"PAYMENT_SUCCESS_WEBHOOK"}', ts = "1700000000000";
  const sig = createHmac("sha256", "s").update(ts + raw).digest("base64");
  assert.equal(await verifyCashfreeSignature(raw, ts, sig, "s"), true);
  assert.equal(await verifyCashfreeSignature(raw + " ", ts, sig, "s"), false);
  assert.equal(await verifyCashfreeSignature(raw, ts, "", "s"), false);
});

test("normalizeProducts maps Shopify data (sizes, prices, one-size)", () => {
  const out = normalizeProducts({ products: { nodes: [
    { id: "p1", title: "Tee", productType: "Men", featuredImage: { url: "https://cdn/x.jpg" }, variants: { nodes: [
      { id: "v1", title: "S", availableForSale: true, price: { amount: "999.0" }, compareAtPrice: { amount: "1299.0" }, selectedOptions: [{ name: "Size", value: "S" }] },
      { id: "v2", title: "M", availableForSale: false, price: { amount: "899.0" }, compareAtPrice: null, selectedOptions: [{ name: "Size", value: "M" }] }] } },
    { id: "p2", title: "Cap", productType: "", featuredImage: null, variants: { nodes: [
      { id: "v3", title: "Default Title", availableForSale: true, price: { amount: "699.0" }, compareAtPrice: null, selectedOptions: [{ name: "Title", value: "Default Title" }] }] } }] } });
  assert.equal(out[0].price, 999); assert.equal(out[0].compareAt, 1299); assert.equal(out[0].variants[1].available, false);
  assert.equal(out[1].variants[0].size, "One size"); assert.equal(out[1].category, "Shop");
});

test("input validation", () => {
  assert.deepEqual(cleanItems([{ variantId: VID, qty: 1 }, { variantId: VID, qty: 2 }]), [{ variantId: VID, qty: 3 }]);
  assert.equal(cleanItems([]), null);
  assert.equal(cleanItems([{ variantId: "bad", qty: 1 }]), null);
  assert.equal(cleanItems([{ variantId: VID, qty: 99 }]), null);
  assert.ok(validAddress(ADDR));
  assert.equal(validAddress({ ...ADDR, phone: "123" }), null);
  assert.equal(validAddress({ ...ADDR, pincode: "12" }), null);
});

test("GET /api/products returns live Shopify products", async () => {
  const calls = stubFetch(() => jr({ data: { products: { nodes: [{ id: "p1", title: "Tee", productType: "Men", featuredImage: null, variants: { nodes: [{ id: VID, title: "M", availableForSale: true, price: { amount: "1299.0" }, compareAtPrice: null, selectedOptions: [{ name: "Size", value: "M" }] }] } }] } } }));
  const r = await call(mkEnv(), "/api/products");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).products[0].variants[0].id, VID);
  assert.ok(calls[0].url.startsWith("https://shop.test/api/"));
  assert.equal(calls[0].init.headers["X-Shopify-Storefront-Access-Token"], "sf");
});

test("static files pass through to assets", async () => {
  assert.equal(await (await call(mkEnv(), "/")).text(), "<html>static</html>");
});

test("checkout needs a signed-in user", async () => {
  assert.equal((await call(mkEnv(), "/api/checkout", post({ items: [{ variantId: VID, qty: 1 }], address: ADDR }))).status, 401);
});

test("checkout: ₹1299 order has ₹0 shipping and uses Shopify price, not browser price", async () => {
  const env = mkEnv();
  const calls = stubFetch((u) => u.includes("graphql") ? jr(variantNode(1299)) : jr({ payment_session_id: "sess_123" }));
  const r = await call(env, "/api/checkout", post({ items: [{ variantId: VID, qty: 1, price: 1 }], address: ADDR }, await authed(env)));
  const d = await r.json();
  assert.equal(r.status, 200); assert.equal(d.total, 1299); assert.equal(d.shipping, 0); assert.equal(d.payment_session_id, "sess_123");
  const cf = calls.find((c) => c.url.includes("sandbox.cashfree.com/pg/orders"));
  const body = JSON.parse(cf.init.body);
  assert.equal(body.order_amount, 1299); assert.equal(body.customer_details.customer_phone, "9876543210");
  assert.equal(cf.init.headers["x-client-secret"], "csecret");
  assert.equal(JSON.parse(env.ORDERS.m.get("order:" + d.order_id)).status, "pending");
});

test("checkout: ₹2500 order adds ₹99 shipping", async () => {
  const env = mkEnv();
  stubFetch((u) => u.includes("graphql") ? jr(variantNode(2500)) : jr({ payment_session_id: "s" }));
  const d = await (await call(env, "/api/checkout", post({ items: [{ variantId: VID, qty: 1 }], address: ADDR }, await authed(env)))).json();
  assert.equal(d.shipping, 99); assert.equal(d.total, 2599);
});

test("checkout rejects bad address and unavailable items", async () => {
  const env = mkEnv(), h = await authed(env);
  assert.equal((await call(env, "/api/checkout", post({ items: [{ variantId: VID, qty: 1 }], address: { ...ADDR, phone: "1" } }, h))).status, 400);
  stubFetch(() => jr({ data: { nodes: [{ id: VID, availableForSale: false, price: { amount: "10" }, product: { title: "x" } }] } }));
  assert.equal((await call(env, "/api/checkout", post({ items: [{ variantId: VID, qty: 1 }], address: ADDR }, h))).status, 409);
});

test("webhook: rejects bad signature; creates Shopify order once", async () => {
  const env = mkEnv(), id = "404_" + "a".repeat(20);
  env.ORDERS.m.set("order:" + id, JSON.stringify({ lines: [{ variantId: VID, qty: 2, price: 1299 }], address: ADDR, email: "a@b.com", subtotal: 2598, shipping: 99, total: 2697, status: "pending" }));
  const raw = JSON.stringify({ type: "PAYMENT_SUCCESS_WEBHOOK", data: { order: { order_id: id } } }), ts = String(Date.now());
  const hdr = (sig) => ({ method: "POST", body: raw, headers: { "x-webhook-timestamp": ts, "x-webhook-signature": sig } });
  const calls = stubFetch(() => jr({ order: { id: 1 } }, 201));
  assert.equal((await call(env, "/api/cashfree/webhook", hdr("bad"))).status, 401);
  assert.equal(calls.length, 0);
  const good = createHmac("sha256", "csecret").update(ts + raw).digest("base64");
  assert.equal((await call(env, "/api/cashfree/webhook", hdr(good))).status, 200);
  assert.equal((await call(env, "/api/cashfree/webhook", hdr(good))).status, 200); // retry must not duplicate
  const shop = calls.filter((c) => c.url.includes("/admin/api/") && c.url.endsWith("/orders.json"));
  assert.equal(shop.length, 1);
  const o = JSON.parse(shop[0].init.body).order;
  assert.equal(o.financial_status, "paid"); assert.equal(o.line_items[0].variant_id, 111); assert.equal(o.line_items[0].quantity, 2);
  assert.equal(shop[0].init.headers["X-Shopify-Access-Token"], "adm");
  assert.equal(JSON.parse(env.ORDERS.m.get("order:" + id)).status, "created");
});

test("webhook returns 500 when Shopify fails so Cashfree retries, then succeeds", async () => {
  const env = mkEnv(), id = "404_" + "b".repeat(20);
  env.ORDERS.m.set("order:" + id, JSON.stringify({ lines: [{ variantId: VID, qty: 1 }], address: ADDR, email: "a@b.com", subtotal: 1, shipping: 0, total: 1, status: "pending" }));
  const raw = JSON.stringify({ type: "PAYMENT_SUCCESS_WEBHOOK", data: { order: { order_id: id } } }), ts = "1";
  const sig = createHmac("sha256", "csecret").update(ts + raw).digest("base64");
  const req = () => ({ method: "POST", body: raw, headers: { "x-webhook-timestamp": ts, "x-webhook-signature": sig } });
  stubFetch(() => jr({}, 500));
  assert.equal((await call(env, "/api/cashfree/webhook", req())).status, 500);
  stubFetch(() => jr({}, 201));
  assert.equal((await call(env, "/api/cashfree/webhook", req())).status, 200);
});

test("google login: accepts valid token, rejects wrong audience", async () => {
  const env = mkEnv(), future = String(Math.floor(Date.now() / 1000) + 600);
  const tok = (aud) => jr({ aud, iss: "https://accounts.google.com", email_verified: "true", exp: future, sub: "99", email: "a@b.com", name: "Asha" });
  stubFetch(() => tok("gid-client"));
  const ok = await call(env, "/api/auth/google", post({ credential: "tok" }));
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("set-cookie"), /sid=.*HttpOnly.*Secure/);
  stubFetch(() => tok("someone-else"));
  assert.equal((await call(env, "/api/auth/google", post({ credential: "tok" }))).status, 401);
});

test("cross-site POST is blocked", async () => {
  const r = await call(mkEnv(), "/api/auth/logout", { method: "POST", headers: { origin: "https://evil.test" } });
  assert.equal(r.status, 403);
});

test("shopifyOrder builds a paid order with address", () => {
  const o = shopifyOrder({ lines: [{ variantId: VID, qty: 1 }], address: ADDR, email: "a@b.com", shipping: 0, total: 1299 }, "404_x").order;
  assert.equal(o.shipping_address.first_name, "Asha"); assert.equal(o.shipping_address.last_name, "Rao"); assert.equal(o.transactions[0].amount, "1299.00");
});
