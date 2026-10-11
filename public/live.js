/* 404 Society — live mode. Loads after the demo script and takes over when the Worker API answers.
   If /api is unavailable (e.g. opened as a plain file) the demo catalogue keeps working. */
(async () => {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
  const api = async (p, o) => { const r = await fetch(p, o); let d = {}; try { d = await r.json(); } catch (e) { if (r.ok) throw new Error("Not JSON"); } if (!r.ok) throw new Error(d.error || "Request failed"); return d; };
  const post = (p, b) => api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) });
  const load = (src, ok) => new Promise((res, rej) => { if (ok()) return res(); const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });

  // Clear message instead of silently showing demo products
  const warn = (msg) => {
    const b = document.createElement("div");
    b.style.cssText = "background:#ff3d2e;color:#fff;padding:10px 5vw;font-size:13px;text-align:center";
    b.textContent = "Demo mode — " + msg;
    document.body.prepend(b);
    checkout = () => toast("Store not connected yet");
  };
  let C, L, step = "/api/config";
  try { C = await api(step); step = "/api/products"; L = (await api(step)).products; }
  catch (e) { return warn(step === "/api/config" ? "the Worker API is not reachable (deploy src/worker.js with wrangler.jsonc)" : "Shopify did not respond: " + e.message + " (check SHOPIFY_DOMAIN and SHOPIFY_STOREFRONT_TOKEN)"); }
  if (!L || !L.length) return warn("Shopify returned no products (set products to Active and available to your Storefront API token)");

  const vm = {}, sel = {};
  L.forEach((p) => { p.variants.forEach((v) => (vm[v.id] = { p, v })); if (p.variants.length === 1 && p.variants[0].available) sel[p.id] = p.variants[0].id; });
  const cats = ["All", ...new Set(L.map((p) => p.category))];
  const sub = () => Object.keys(bag).reduce((a, k) => a + vm[k].v.price * bag[k], 0);
  const fee = (s) => (!s ? 0 : s < C.threshold ? C.shipBelow : C.shipAbove);

  window.setCat = (i) => { cat = cats[i]; chips(); grid(); };
  window.lpick = (pid, vid) => { sel[pid] = vid; grid(); };
  window.ladd = (pid) => { const v = sel[pid]; if (!v) return toast("Please select a size"); bag[v] = (bag[v] || 0) + 1; draw(); toast("Added to bag"); };

  chips = () => { $("f").innerHTML = cats.map((c, i) => `<button class="chip ${c == cat ? "on" : ""}" onclick="setCat(${i})">${esc(c)}</button>`).join(""); };
  grid = () => {
    $("g").innerHTML = L.map((p) => (cat == "All" || p.category == cat) ? `<div class="p"><div class="img">${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.title)}" loading="lazy" style="width:100%;height:100%;object-fit:cover">` : "👕"}</div><h3>${esc(p.title)}</h3><small>${esc(p.category)}</small><div class="pr">${R(p.price)}${p.compareAt > p.price ? `<s>${R(p.compareAt)}</s>` : ""}</div><div class="sz">${p.variants.map((v) => `<button ${v.available ? "" : 'disabled style="opacity:.35"'} class="${sel[p.id] == v.id ? "on" : ""}" onclick="lpick('${p.id}','${v.id}')">${esc(v.size)}</button>`).join("")}</div><button class="btn ab" onclick="ladd('${p.id}')">Add to bag</button></div>` : "").join("");
  };
  totals = () => { const s = sub(), f = fee(s); return [s, f, s + f]; };
  draw = () => {
    const k = Object.keys(bag);
    $("n").textContent = k.reduce((a, i) => a + bag[i], 0);
    $("items").innerHTML = k.length ? k.map((id) => { const { p, v } = vm[id]; return `<div class="row"><div class="e" style="overflow:hidden">${p.image ? `<img src="${esc(p.image)}" alt="" style="width:100%;height:100%;object-fit:cover">` : "👕"}</div><div>${esc(p.title)}<br><small style="color:var(--mut)">Size: ${esc(v.size)}</small><br><b>${R(v.price)}</b></div><div class="q" style="flex:none"><button onclick="chg('${id}',-1)">−</button> ${bag[id]} <button onclick="chg('${id}',1)">+</button></div></div>`; }).join("") : '<p style="color:var(--mut)">Your bag is empty.</p>';
    const [t, s, g] = totals(); $("s1").textContent = R(t); $("s2").textContent = s ? R(s) : "FREE"; $("s3").textContent = R(g);
  };

  /* ---- Google login ---- */
  const setUser = (u) => { user = u; $("u").textContent = u ? "Hi, " + u.name.split(" ")[0] + " ✓" : "Sign in"; };
  try { setUser(await api("/api/me")); } catch (e) {}
  login = async () => {
    if (user) { await post("/api/auth/logout"); setUser(null); return toast("Signed out"); }
    const m = $("m"); $("ov").classList.add("on"); m.classList.add("on");
    m.innerHTML = '<h3 style="margin:0">Sign in to continue</h3><p style="color:var(--mut);font-size:14px">Google account required to shop at 404 Society.</p><div id="gb" style="display:flex;justify-content:center;margin-top:16px"></div>';
    if (!C.googleClientId) return m.insertAdjacentHTML("beforeend", '<p style="color:var(--ac);font-size:13px">Google login is not configured yet.</p>');
    await load("https://accounts.google.com/gsi/client", () => window.google && google.accounts);
    google.accounts.id.initialize({ client_id: C.googleClientId, callback: async (r) => { try { setUser(await post("/api/auth/google", { credential: r.credential })); closeM(); $("ov").classList.remove("on"); toast("Signed in"); } catch (e) { toast(e.message); } } });
    google.accounts.id.renderButton($("gb"), { theme: "outline", size: "large", text: "continue_with" });
  };

  /* ---- Checkout: delivery details -> Cashfree ---- */
  const F = [["name", "Full name"], ["phone", "Mobile (10 digits)"], ["address1", "Address"], ["city", "City"], ["state", "State"], ["pincode", "PIN code"]];
  const shut = () => { $("ck").classList.remove("on"); $("ov").classList.remove("on"); };
  window.shutCk = shut;
  checkout = () => {
    if (!Object.keys(bag).length) return toast("Bag is empty");
    if (!user) { cart(0); return login(); }
    cart(0);
    let m = $("ck"); if (!m) { m = document.createElement("div"); m.id = "ck"; m.className = "modal"; m.style.textAlign = "left"; document.body.appendChild(m); }
    const [, sh, tot] = totals();
    m.innerHTML = `<h3 style="margin:0 0 10px">Delivery details</h3>${F.map(([k, l]) => `<input id="ck_${k}" placeholder="${l}" style="width:100%;margin:4px 0;padding:11px;border:1px solid var(--ln);background:var(--bg);color:var(--fg);font:inherit">`).join("")}<p style="font-size:13px;color:var(--mut)">Shipping: ${sh ? R(sh) : "FREE"}</p><button class="btn" id="ck_go" style="width:100%">Pay ${R(tot)} with Cashfree</button><button class="ghost" style="width:100%;margin-top:8px" onclick="shutCk()">Cancel</button>`;
    m.classList.add("on"); $("ov").classList.add("on");
    $("ck_go").onclick = async () => {
      const a = {}; F.forEach(([k]) => (a[k] = $("ck_" + k).value.trim()));
      $("ck_go").disabled = true;
      try {
        const o = await post("/api/checkout", { items: Object.keys(bag).map((id) => ({ variantId: id, qty: bag[id] })), address: a });
        await load("https://sdk.cashfree.com/js/v3/cashfree.js", () => window.Cashfree);
        Cashfree({ mode: C.cashfreeMode }).checkout({ paymentSessionId: o.payment_session_id, redirectTarget: "_self" });
      } catch (e) { toast(e.message); $("ck_go").disabled = false; }
    };
  };

  /* ---- Return from Cashfree ---- */
  const oid = new URLSearchParams(location.search).get("order_id");
  if (oid) {
    history.replaceState(null, "", location.pathname); toast("Confirming payment…");
    let tries = 0;
    const poll = async () => {
      try {
        const s = await api("/api/order-status?order_id=" + encodeURIComponent(oid));
        if (s.status === "PAID") { Object.keys(bag).forEach((k) => delete bag[k]); draw(); return toast("Payment successful — order placed 🎉"); }
        if (s.status === "ACTIVE" && ++tries < 6) return setTimeout(poll, 3000);
        toast("Payment " + String(s.status).toLowerCase());
      } catch (e) { toast(e.message); }
    };
    poll();
  }

  cat = "All"; chips(); grid(); draw();
})();
