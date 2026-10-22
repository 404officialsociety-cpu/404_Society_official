// 404 Society — Cloudflare Worker
// Shopify products + collections • Google login • Cashfree payments

const enc = new TextEncoder();

class HttpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}

const J = (d, s = 200, h = {}) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...h,
    },
  });

const num = (v, d) =>
  v === undefined || v === null || v === "" ? d : Number(v);

const b64 = (u) => btoa(String.fromCharCode(...u));

const b64u = (s) =>
  s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const same = (a, b) => {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) {
    r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return r === 0;
};

async function hmac(secret, data) {
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", k, enc.encode(data))
  );
}

const cookie = (req, n) =>
  ((req.headers.get("cookie") || "")
    .split(/;\s*/)
    .map((c) => c.split("="))
    .find(([k]) => k === n) || [])[1];

const SV = (env) => env.SHOPIFY_API_VERSION || "2026-04";

/* ---------- Shipping ---------- */

export function shippingFor(subtotal, env = {}) {
  if (!(subtotal > 0)) return 0;
  return subtotal < num(env.SHIP_THRESHOLD, 2000)
    ? num(env.SHIP_BELOW, 0)
    : num(env.SHIP_ABOVE, 99);
}

/* ---------- Session helpers ---------- */

export async function signSession(p, secret) {
  const body = b64u(b64(enc.encode(JSON.stringify(p))));
  return body + "." + b64u(b64(await hmac(secret, body)));
}

export async function verifySession(tok, secret) {
  if (!tok || !secret) return null;
  const [b, s] = tok.split(".");
  if (!b || !s || !same(s, b64u(b64(await hmac(secret, b))))) {
    return null;
  }
  try {
    const bin = atob(b.replace(/-/g, "+").replace(/_/g, "/"));
    const p = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(bin, (c) => c.charCodeAt(0))
      )
    );
    return p.exp > Date.now() / 1000 ? p : null;
  } catch {
    return null;
  }
}

export async function verifyCashfreeSignature(raw, ts, sig, secret) {
  if (!raw || !ts || !sig || !secret) return false;
  return same(b64(await hmac(secret, ts + raw)), sig);
}

/* ---------- Shopify product normalization ---------- */

export function normalizeProducts(d) {
  return ((d && d.products && d.products.nodes) || [])
    .map((p) => {
      const variants = (p.variants?.nodes || []).map((v) => {
        const option = (v.selectedOptions || []).find((x) =>
          /size/i.test(x.name)
        );
        const size = option ? option.value : v.title;
        return {
          id: v.id,
          size: size === "Default Title" ? "One size" : size,
          price: Number(v.price.amount),
          compareAt: v.compareAtPrice
            ? Number(v.compareAtPrice.amount)
            : 0,
          available: !!v.availableForSale,
        };
      });

      const available = variants.filter((v) => v.available);
      const pricedVariants = available.length ? available : variants;

      return {
        id: p.id,
        handle: p.handle || "",
        title: p.title,
        description: p.description || "",
        category: p.productType || "Shop",
        image: p.featuredImage?.url || "",
        price: pricedVariants.length
          ? Math.min(...pricedVariants.map((v) => v.price))
          : 0,
        compareAt: Math.max(0, ...variants.map((v) => v.compareAt)),
        variants,
      };
    })
    .filter((p) => p.variants.length);
}

/* ---------- Checkout validation ---------- */

export function cleanItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 20) {
    return null;
  }
  const map = new Map();
  for (const item of items) {
    const qty = Number(item && item.qty);
    if (
      !item ||
      typeof item.variantId !== "string" ||
      !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(item.variantId) ||
      !Number.isInteger(qty) ||
      qty < 1 ||
      qty > 10
    ) {
      return null;
    }
    map.set(item.variantId, (map.get(item.variantId) || 0) + qty);
  }
  const result = [...map].map(([variantId, qty]) => ({ variantId, qty }));
  if (result.some((item) => item.qty > 10)) return null;
  return result;
}

export function validAddress(a) {
  if (!a || typeof a !== "object") return null;
  const t = (k) =>
    String(a[k] == null ? "" : a[k]).trim().slice(0, 120);
  const address = {
    name: t("name"),
    phone: t("phone"),
    address1: t("address1"),
    city: t("city"),
    state: t("state"),
    pincode: t("pincode"),
  };
  if (
    address.name.length < 2 ||
    address.address1.length < 5 ||
    address.city.length < 2 ||
    address.state.length < 2 ||
    !/^[6-9]\d{9}$/.test(address.phone) ||
    !/^\d{6}$/.test(address.pincode)
  ) {
    return null;
  }
  return address;
}

export function shopifyOrder(rec, id) {
  const a = rec.address;
  const [first, ...rest] = a.name.split(" ");
  return {
    order: {
      email: rec.email,
      currency: "INR",
      financial_status: "paid",
      send_receipt: true,
      tags: "404society, cashfree",
      note: "Cashfree order " + id,
      line_items: rec.lines.map((line) => ({
        variant_id: Number(line.variantId.split("/").pop()),
        quantity: line.qty,
      })),
      shipping_lines: [
        {
          title: "Standard shipping",
          code: "STD",
          price: rec.shipping.toFixed(2),
        },
      ],
      shipping_address: {
        first_name: first,
        last_name: rest.join(" ") || "-",
        address1: a.address1,
        city: a.city,
        province: a.state,
        zip: a.pincode,
        country: "IN",
        phone: a.phone,
      },
      transactions: [
        {
          kind: "sale",
          status: "success",
          gateway: "Cashfree",
          amount: rec.total.toFixed(2),
        },
      ],
    },
  };
}

/* ---------- Shopify Storefront API ---------- */

const Q_PRODUCTS = `{
  products(first: 50) {
    nodes {
      id
      title
      handle
      description
      productType
      featuredImage { url altText }
      variants(first: 30) {
        nodes {
          id
          title
          availableForSale
          price { amount }
          compareAtPrice { amount }
          selectedOptions { name value }
        }
      }
    }
  }
}`;

const Q_COLLECTIONS = `{
  collections(first: 50) {
    nodes {
      id
      title
      handle
      description
      image { url altText }
      products(first: 20) {
        nodes {
          id
          title
          handle
          productType
          availableForSale
          featuredImage { url altText }
          priceRange {
            minVariantPrice { amount currencyCode }
          }
        }
      }
    }
  }
}`;

const Q_VARIANTS = `query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on ProductVariant {
      id
      availableForSale
      price { amount }
      product { title }
    }
  }
}`;

async function storefront(env, query, variables = {}) {
  const token =
    env.SHOPIFY_STOREFRONT_PUBLIC_TOKEN || env.SHOPIFY_STOREFRONT_TOKEN;

  if (!env.SHOPIFY_DOMAIN || !token) {
    throw new Error("Missing SHOPIFY_DOMAIN or Storefront API token secret");
  }

  const response = await fetch(
    `https://${env.SHOPIFY_DOMAIN}/api/${SV(env)}/graphql.json`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Shopify-Storefront-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (!response.ok) {
    throw new Error("Shopify Storefront API HTTP " + response.status);
  }

  const result = await response.json();

  if (result.errors) {
    console.error(
      "Shopify Storefront GraphQL errors",
      JSON.stringify(result.errors)
    );
    throw new Error("Shopify Storefront GraphQL request failed");
  }

  return result.data;
}

async function getShopifyCollections(env) {
  const data = await storefront(env, Q_COLLECTIONS);
  return data?.collections?.nodes || [];
}

/* ---------- Server-side price validation ---------- */

async function priceItems(env, items) {
  const data = await storefront(env, Q_VARIANTS, {
    ids: items.map((item) => item.variantId),
  });

  const byId = Object.fromEntries(
    (data.nodes || []).filter(Boolean).map((node) => [node.id, node])
  );

  let subtotal = 0;
  const lines = [];

  for (const item of items) {
    const variant = byId[item.variantId];
    if (!variant || !variant.availableForSale) {
      throw new HttpError(409, "An item in your bag is unavailable");
    }
    const price = Number(variant.price.amount);
    subtotal += price * item.qty;
    lines.push({
      variantId: item.variantId,
      qty: item.qty,
      price,
      title: variant.product.title,
    });
  }

  return { lines, subtotal };
}

/* ---------- Cashfree ---------- */

const cfBase = (env) =>
  env.CASHFREE_ENV === "production"
    ? "https://api.cashfree.com/pg"
    : "https://sandbox.cashfree.com/pg";

const cfHeaders = (env) => ({
  "content-type": "application/json",
  "x-api-version": "2023-08-01",
  "x-client-id": env.CASHFREE_CLIENT_ID,
  "x-client-secret": env.CASHFREE_CLIENT_SECRET,
});

async function checkout(req, env, sess) {
  const body = await req.json().catch(() => null);
  const items = cleanItems(body && body.items);
  const address = validAddress(body && body.address);

  if (!items || !address) {
    throw new HttpError(400, "Invalid bag or delivery details");
  }

  const { lines, subtotal } = await priceItems(env, items);
  const shipping = shippingFor(subtotal, env);
  const total = +(subtotal + shipping).toFixed(2);

  const orderId =
    "404_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);

  const origin = new URL(req.url).origin;

  const response = await fetch(cfBase(env) + "/orders", {
    method: "POST",
    headers: cfHeaders(env),
    body: JSON.stringify({
      order_id: orderId,
      order_amount: total,
      order_currency: "INR",
      customer_details: {
        customer_id:
          "g_" +
          String(sess.sub).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40),
        customer_email: sess.email,
        customer_phone: address.phone,
        customer_name: address.name,
      },
      order_meta: {
        return_url: origin + "/?order_id={order_id}",
        notify_url: origin + "/api/cashfree/webhook",
      },
    }),
  });

  if (!response.ok) {
    console.error("Cashfree order creation failed", response.status);
    throw new HttpError(502, "Payment provider error");
  }

  const order = await response.json();

  await env.ORDERS.put(
    "order:" + orderId,
    JSON.stringify({
      lines,
      address,
      email: sess.email,
      subtotal,
      shipping,
      total,
      status: "pending",
    }),
    { expirationTtl: 2592000 }
  );

  return J({
    order_id: orderId,
    payment_session_id: order.payment_session_id,
    total,
    shipping,
  });
}

/* ---------- Shopify Admin order creation ---------- */

export async function fulfil(id, env) {
  const key = "order:" + id;
  const rec = JSON.parse((await env.ORDERS.get(key)) || "null");

  if (!rec || rec.status !== "pending") return "skipped";

  rec.status = "creating";
  await env.ORDERS.put(key, JSON.stringify(rec), { expirationTtl: 2592000 });

  const response = await fetch(
    `https://${env.SHOPIFY_DOMAIN}/admin/api/${SV(env)}/orders.json`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Shopify-Access-Token": env.SHOPIFY_ADMIN_TOKEN,
      },
      body: JSON.stringify(shopifyOrder(rec, id)),
    }
  );

  if (!response.ok) {
    console.error("Shopify Admin order creation failed", response.status);
    rec.status = "pending";
    await env.ORDERS.put(key, JSON.stringify(rec), { expirationTtl: 2592000 });
    return "failed";
  }

  rec.status = "created";
  await env.ORDERS.put(key, JSON.stringify(rec), { expirationTtl: 2592000 });
  return "created";
}

/* ---------- Cashfree webhook ---------- */

async function webhook(req, env) {
  const raw = await req.text();

  const valid = await verifyCashfreeSignature(
    raw,
    req.headers.get("x-webhook-timestamp"),
    req.headers.get("x-webhook-signature"),
    env.CASHFREE_CLIENT_SECRET
  );

  if (!valid) return J({ error: "bad signature" }, 401);

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return J({ error: "bad json" }, 400);
  }

  if (event.type === "PAYMENT_SUCCESS_WEBHOOK") {
    const id = event.data && event.data.order && event.data.order.order_id;
    if (id && (await fulfil(id, env)) === "failed") {
      return J({ error: "retry" }, 500);
    }
  }

  return J({ ok: true });
}

/* ---------- Order status ---------- */

async function orderStatus(url, env, sess) {
  const id = url.searchParams.get("order_id") || "";

  if (!/^404_[a-f0-9]{20}$/.test(id)) {
    throw new HttpError(400, "Bad order id");
  }

  const rec = JSON.parse((await env.ORDERS.get("order:" + id)) || "null");

  if (!rec || rec.email !== sess.email) {
    throw new HttpError(404, "Order not found");
  }

  const response = await fetch(cfBase(env) + "/orders/" + id, {
    headers: cfHeaders(env),
  });

  if (!response.ok) throw new HttpError(502, "Payment provider error");

  const order = await response.json();

  if (order.order_status === "PAID") {
    await fulfil(id, env);
  }

  return J({ status: order.order_status });
}

/* ---------- Google login ---------- */

async function googleLogin(req, env) {
  const body = await req.json().catch(() => null);
  const credential = body && body.credential;

  if (typeof credential !== "string" || credential.length > 4096) {
    throw new HttpError(400, "Bad credential");
  }

  const response = await fetch(
    "https://oauth2.googleapis.com/tokeninfo?id_token=" +
      encodeURIComponent(credential)
  );

  if (!response.ok) throw new HttpError(401, "Invalid Google token");

  const token = await response.json();

  if (
    !env.GOOGLE_CLIENT_ID ||
    token.aud !== env.GOOGLE_CLIENT_ID ||
    String(token.email_verified) !== "true" ||
    !/^(https:\/\/)?accounts\.google\.com$/.test(token.iss) ||
    !(+token.exp > Date.now() / 1000)
  ) {
    throw new HttpError(401, "Invalid Google token");
  }

  const session = {
    sub: token.sub,
    email: token.email,
    name: token.name || token.email,
    exp: Math.floor(Date.now() / 1000) + 604800,
  };

  const sessionToken = await signSession(session, env.SESSION_SECRET);

  return J({ name: session.name, email: session.email }, 200, {
    "set-cookie": `sid=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
  });
}

/* ---------- Router ---------- */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    const POST = req.method === "POST";
    const GET = req.method === "GET";

    if (!p.startsWith("/api/")) {
      return env.ASSETS.fetch(req);
    }

    try {
      if (p === "/api/cashfree/webhook" && POST) {
        return await webhook(req, env);
      }

      const origin = req.headers.get("origin");

      if (POST && origin && origin !== url.origin) {
        throw new HttpError(403, "Bad origin");
      }

      if (p === "/api/config" && GET) {
        return J({
          googleClientId: env.GOOGLE_CLIENT_ID || "",
          cashfreeMode:
            env.CASHFREE_ENV === "production" ? "production" : "sandbox",
          threshold: num(env.SHIP_THRESHOLD, 2000),
          shipBelow: num(env.SHIP_BELOW, 0),
          shipAbove: num(env.SHIP_ABOVE, 99),
        });
      }

      if (p === "/api/products" && GET) {
        const data = await storefront(env, Q_PRODUCTS);
        return J({ products: normalizeProducts(data) }, 200, {
          "cache-control": "public, max-age=60",
        });
      }

      if (p === "/api/collections" && GET) {
        const collections = await getShopifyCollections(env);
        return J({ collections }, 200, {
          "cache-control": "public, max-age=60",
        });
      }

      const sess = await verifySession(cookie(req, "sid"), env.SESSION_SECRET);

      if (p === "/api/me" && GET) {
        return sess
          ? J({ name: sess.name, email: sess.email })
          : J({ error: "signed out" }, 401);
      }

      if (p === "/api/auth/google" && POST) {
        return await googleLogin(req, env);
      }

      if (p === "/api/auth/logout" && POST) {
        return J({ ok: true }, 200, {
          "set-cookie":
            "sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
        });
      }

      if (!sess) throw new HttpError(401, "Please sign in with Google");

      if (p === "/api/checkout" && POST) {
        return await checkout(req, env, sess);
      }

      if (p === "/api/order-status" && GET) {
        return await orderStatus(url, env, sess);
      }

      throw new HttpError(404, "Not found");
    } catch (error) {
      if (error instanceof HttpError) {
        return J({ error: error.message }, error.status);
      }
      console.error(error);
      return J({ error: "Server error" }, 500);
    }
  },
};
