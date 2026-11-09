// The pickup pass as an MCP Apps card (ui:// resource, text/html;profile=mcp-app): chat apps that show cards (Claude,
// ChatGPT) draw it beside the tool result. It shows the order, a Pay button while it's unpaid, then the QR and pickup
// code, and keeps itself up to date (order_status with the order's claim) until it's collected. At "ready" the QR's
// tile turns brand lime. One self-contained page: no scripts, fonts or images from anywhere else.
//
// The bridge is the MCP Apps postMessage protocol (JSON-RPC 2.0 with the host, protocol 2026-01-26), written out
// here rather than bundling the 300 KB SDK: ui/initialize, ui/notifications/initialized, tool-result,
// host-context-changed, resource-teardown, tools/call, ui/open-link and ui/notifications/size-changed.

export const CARD_MIME_TYPE = "text/html;profile=mcp-app";

/** Where tools hand their card data: the card reads it, the model doesn't need it. */
export const CARD_META_KEY = "agentpickup/pass";

/** What the card draws. Every field but orderId is optional: later results fill in or update what's there. */
export interface PassCard {
  v: 1;
  orderId: string;
  shopUrl?: string;
  shopName?: string;
  /** Lets the card call order_status itself while the order moves along. */
  claim?: string;
  status?: string;
  rail?: string;
  items?: string;
  total?: string;
  collectBy?: number | null;
  collectedAt?: number | null;
  checkoutUrl?: string;
  passUrl?: string;
  pickupCode?: string | null;
  /** The QR as SVG, ink on transparent, so the tile behind it sets the colour. */
  qrSvg?: string;
  /** The add page's share mode, for "Invite a friend". */
  inviteUrl?: string;
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pickup pass</title>
<style>
:root{--bg:#ffffff;--surface:#f4f4f1;--text:#16161a;--muted:#66666d;--line:rgba(10,11,13,.12);--ok:#2e7d32;--lime:#b5f23d;--ink:#0a0b0d;color-scheme:light}
:root[data-theme=dark]{--bg:#1d1d20;--surface:#2a2a2e;--text:#f2f2f4;--muted:#a3a3ab;--line:rgba(255,255,255,.14);--ok:#8fd47f;color-scheme:dark}
@media (prefers-color-scheme:dark){:root:not([data-theme]){--bg:#1d1d20;--surface:#2a2a2e;--text:#f2f2f4;--muted:#a3a3ab;--line:rgba(255,255,255,.14);--ok:#8fd47f;color-scheme:dark}}
html,body{margin:0;padding:0;background:transparent}
body{font-family:var(--font-sans,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif);color:var(--text);-webkit-font-smoothing:antialiased;padding:2px}
.card{box-sizing:border-box;max-width:380px;margin:0 auto;background:var(--bg);border:1px solid var(--line);border-radius:16px;padding:16px 18px}
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px}
.shop{font-weight:600;font-size:15px;margin:0}
.items{font-size:13px;color:var(--muted);margin:2px 0 0}
.badge{font-size:12px;line-height:1;padding:6px 10px;border-radius:999px;background:var(--surface);white-space:nowrap}
.badge.ready{background:var(--lime);color:var(--ink);font-weight:600}
.wrap{position:relative;border-radius:12px}
.tile{position:relative;overflow:hidden;background:#ffffff;border-radius:12px;padding:14px;display:flex;justify-content:center;align-items:center;border:1px solid var(--line);min-height:120px}
.tile svg{position:relative;display:block;width:100%;max-width:220px;height:auto}
.pour{position:absolute;left:0;right:0;bottom:0;height:0;background:var(--lime);transition:height 1s cubic-bezier(.5,0,.2,1)}
.wrap.ready .pour{height:100%}
.wrap.ready .tile{border-color:var(--lime)}
.wrap.ready::after{content:"";position:absolute;inset:0;border:2px solid var(--lime);border-radius:12px;animation:ring 1.8s ease-out infinite;pointer-events:none}
@keyframes ring{from{transform:scale(1);opacity:.9}to{transform:scale(1.08);opacity:0}}
.tile.plain{background:var(--surface)}
.done{font-size:15px;color:var(--text);text-align:center}
.done b{display:block;font-size:34px;line-height:1.2}
.facts{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;margin:12px 0 0}
.fact{background:var(--surface);border-radius:10px;padding:8px 12px}
.fact span{display:block;font-size:12px;color:var(--muted)}
.fact b{display:block;font-size:20px;font-weight:600;overflow-wrap:anywhere}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:2px}
.steps{display:flex;justify-content:space-between;border-top:1px solid var(--line);padding-top:10px;margin-top:12px}
.step{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
.dot{width:10px;height:10px;border-radius:50%;border:1.5px solid currentColor;box-sizing:border-box}
.step.past{color:var(--ok)}.step.past .dot{background:currentColor}
.step.now{color:var(--text);font-weight:600}.step.now .dot{background:var(--ok);border-color:var(--ok)}
.msg{font-size:13px;color:var(--muted);margin:10px 0 0;line-height:1.45}
.test{font-size:12px;color:var(--muted);margin:6px 0 0}
.row{display:flex;gap:12px;align-items:center;margin-top:12px;flex-wrap:wrap}
button{font:inherit;font-size:14px;border-radius:10px;padding:10px 14px;cursor:pointer;border:1px solid var(--line);background:var(--surface);color:var(--text)}
button.pay{background:var(--lime);color:var(--ink);border-color:var(--lime);font-weight:600}
button.link{background:none;border:none;padding:0;color:var(--muted);text-decoration:underline;font-size:13px}
.foot{font-size:11px;color:var(--muted);margin-top:12px;display:flex;justify-content:space-between;align-items:center;gap:8px}
.foot button.link{font-size:12px}
@media (prefers-reduced-motion:reduce){.pour{transition:none}.wrap.ready::after{animation:none;opacity:1}}
</style>
</head>
<body>
<div id="root"></div>
<script>
(function () {
  var VERSION = "__VERSION__";
  var LABELS = { awaiting_payment: "Waiting for payment", paid: "Paid", ready: "Ready", collected: "Collected", expired: "Expired", cancelled: "Cancelled" };
  var FINAL = { collected: 1, expired: 1, cancelled: 1 };
  var root = document.getElementById("root");
  var state = null, canCall = false, canOpen = false, locale, timeZone;
  var nextId = 1, pending = {}, timer = null, started = Date.now(), lastHtml = "", poured = false, lastHeight = -1, stopped = false;

  // ---------- the bridge ----------
  var host = window.parent;
  function send(msg) { try { host.postMessage(msg, "*"); } catch (e) {} }
  function request(method, params) {
    var id = nextId++;
    send({ jsonrpc: "2.0", id: id, method: method, params: params });
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      setTimeout(function () { if (pending[id]) { delete pending[id]; reject(new Error("timed out")); } }, 30000);
    });
  }
  function notify(method, params) { send({ jsonrpc: "2.0", method: method, params: params }); }
  window.addEventListener("message", function (e) {
    if (host !== window && e.source !== host) return;
    var m = e.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id != null && !m.method) {
      var p = pending[m.id];
      if (p) { delete pending[m.id]; if (m.error) p.reject(m.error); else p.resolve(m.result); }
      return;
    }
    if (m.method === "ui/notifications/tool-result") return onResult(m.params);
    if (m.method === "ui/notifications/host-context-changed") { applyContext(m.params || {}); return render(); }
    if (m.method === "ui/resource-teardown") { stop(); if (m.id != null) send({ jsonrpc: "2.0", id: m.id, result: {} }); return; }
    if (m.method === "ping" && m.id != null) return send({ jsonrpc: "2.0", id: m.id, result: {} });
    if (m.id != null && m.method && m.method.indexOf("ui/notifications/") !== 0) {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
    }
  });
  function applyContext(ctx) {
    if (ctx.theme === "light" || ctx.theme === "dark") document.documentElement.setAttribute("data-theme", ctx.theme);
    var vars = ctx.styles && ctx.styles.variables;
    if (vars) for (var k in vars) if (k.indexOf("--") === 0 && typeof vars[k] === "string") document.documentElement.style.setProperty(k, vars[k]);
    if (ctx.locale) locale = ctx.locale;
    if (ctx.timeZone) timeZone = ctx.timeZone;
  }
  function openLink(url) {
    if (!url) return;
    if (canOpen) request("ui/open-link", { url: url }).catch(function () { window.open(url, "_blank", "noopener"); });
    else window.open(url, "_blank", "noopener");
  }

  // ---------- results ----------
  function cardOf(result) {
    if (!result) return null;
    var meta = result._meta && result._meta["agentpickup/pass"];
    if (meta && meta.orderId) return meta;
    // A host that drops _meta: the JSON after the tool's summary line still has the basics.
    try {
      var text = result.content && result.content[0] && result.content[0].text;
      var data = JSON.parse(text.slice(text.indexOf("\n\n") + 2));
      var id = data.orderId || data.id || (data.order && data.order.id);
      if (!id) return null;
      return { orderId: id, status: data.status, passUrl: data.passUrl, pickupCode: data.pickupCode, checkoutUrl: data.checkoutUrl, total: data.total, claim: data.claim, shopUrl: data.shop };
    } catch (e) { return null; }
  }
  function onResult(result) {
    var card = cardOf(result);
    if (card) {
      if (state && state.orderId !== card.orderId) state = null;
      var next = state ? Object.assign({}, state) : {};
      for (var k in card) if (card[k] !== undefined && card[k] !== null && card[k] !== "") next[k] = card[k];
      if (card.status && card.status !== "awaiting_payment") delete next.checkoutUrl;
      state = next;
    }
    render();
    schedule();
  }

  // ---------- keeping up to date ----------
  function stop() { stopped = true; clearTimeout(timer); }
  function schedule() {
    clearTimeout(timer);
    if (stopped || !state || !state.claim || !canCall || FINAL[state.status]) return;
    if (Date.now() - started > 4 * 3600 * 1000) return;
    var wait = document.hidden ? 60000 : state.status === "awaiting_payment" ? 5000 : 15000;
    timer = setTimeout(poll, wait);
  }
  function poll() {
    var args = { order_id: state.orderId, claim: state.claim };
    if (state.shopUrl) args.shop_url = state.shopUrl;
    request("tools/call", { name: "order_status", arguments: args }).then(function (r) {
      if (r && !r.isError) onResult(r); else schedule();
    }, schedule);
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden && state) { clearTimeout(timer); poll(); } });

  // ---------- drawing ----------
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function time(ms) {
    var d = new Date(ms), o = { hour: "numeric", minute: "2-digit" };
    if (timeZone) o.timeZone = timeZone;
    try {
      var s = d.toLocaleTimeString(locale, o);
      if (Math.abs(ms - Date.now()) > 18 * 3600 * 1000) {
        var od = { weekday: "short" };
        if (timeZone) od.timeZone = timeZone;
        s = d.toLocaleDateString(locale, od) + " " + s;
      }
      return s;
    } catch (e) { return d.toLocaleTimeString(); }
  }
  function safeSvg(svg) { return typeof svg === "string" && /^<svg[\s>]/.test(svg) && !/<script|<foreignObject|\son[a-z]+=/i.test(svg) ? svg : ""; }
  function message(s) {
    var live = canCall && s.claim;
    switch (s.status) {
      case "awaiting_payment":
        return s.checkoutUrl
          ? "Pay on the checkout page. " + (live ? "This card turns into your pickup pass once it's paid." : "Then ask for the pickup pass.")
          : "Waiting for the payment. " + (live ? "This card turns into your pickup pass once it's paid." : "");
      case "paid": return "Paid. " + (live ? "This turns green when it's ready. " : "") + "The pass is in your email too.";
      case "ready": return "Ready at the counter. Show the QR or say the code.";
      case "collected": return s.collectedAt ? "Collected at " + time(s.collectedAt) + ". Enjoy." : "Collected. Enjoy.";
      case "expired": return "This order expired before anyone collected it.";
      case "cancelled": return "This order was cancelled.";
      default: return "";
    }
  }
  function view(s) {
    var status = s.status || "awaiting_payment";
    var label = LABELS[status] || status;
    var live = status === "paid" || status === "ready";
    var h = '<div class="card">';
    h += '<div class="head"><div><p class="shop">' + esc(s.shopName || "Your pickup order") + "</p>";
    if (s.items) h += '<p class="items">' + esc(s.items) + (s.total ? " · " + esc(s.total) : "") + "</p>";
    h += '</div><span class="badge' + (status === "ready" ? " ready" : "") + '">' + esc(label) + "</span></div>";
    var svg = safeSvg(s.qrSvg);
    if (live && svg) {
      h += '<div class="wrap' + (status === "ready" && poured ? " ready" : "") + '" id="wrap"><div class="tile"><div class="pour"></div>' +
        svg.replace("<svg", '<svg role="img" aria-label="Pickup QR code"') + "</div></div>";
    } else if (status === "collected") {
      h += '<div class="wrap"><div class="tile plain"><div class="done"><b>&#10003;</b>Collected</div></div></div>';
    }
    if (live && (s.pickupCode || s.collectBy)) {
      h += '<div class="facts">';
      if (s.pickupCode) h += '<div class="fact"><span>Pickup code</span><b class="code">' + esc(s.pickupCode) + "</b></div>";
      if (s.collectBy) h += '<div class="fact"><span>Collect by</span><b>' + esc(time(s.collectBy)) + "</b></div>";
      h += "</div>";
    }
    if (live || status === "collected") {
      var at = { paid: 0, ready: 1, collected: 2 }[status];
      h += '<div class="steps">' + ["Paid", "Ready", "Collected"].map(function (name, i) {
        return '<span class="step' + (i < at ? " past" : i === at ? " now" : "") + '"><span class="dot"></span>' + name + "</span>";
      }).join("") + "</div>";
    }
    var msg = message(s);
    if (msg) h += '<p class="msg">' + esc(msg) + "</p>";
    if (s.rail === "test") h += '<p class="test">Test order: no money moved.</p>';
    var actions = "";
    if (status === "awaiting_payment" && s.checkoutUrl) actions += '<button class="pay" data-open="checkoutUrl">Pay' + (s.total ? " " + esc(s.total) : "") + " by card</button>";
    if (live && s.passUrl) actions += '<button class="link" data-open="passUrl">Open the pass</button>';
    if (actions) h += '<div class="row">' + actions + "</div>";
    h += '<div class="foot">' + (s.inviteUrl ? '<button class="link" data-open="inviteUrl">Invite a friend</button>' : "<span></span>") + "<span>agentPickup</span></div></div>";
    return h;
  }
  function render() {
    var html = state ? view(state) : "";
    if (html !== lastHtml) {
      root.innerHTML = html;
      lastHtml = html;
      var buttons = root.querySelectorAll("[data-open]");
      for (var i = 0; i < buttons.length; i++) buttons[i].addEventListener("click", function (e) { openLink(state[e.currentTarget.getAttribute("data-open")]); });
    }
    // The lime pours in once, the first time the card sees the order ready.
    var wrap = document.getElementById("wrap");
    if (wrap && state && state.status === "ready" && !poured) {
      void wrap.offsetWidth;
      wrap.classList.add("ready");
      poured = true;
      lastHtml = view(state);
    }
    reportSize();
  }
  function reportSize() {
    var height = Math.ceil(document.body.getBoundingClientRect().height);
    if (height !== lastHeight) { lastHeight = height; notify("ui/notifications/size-changed", { height: height }); }
  }
  if (window.ResizeObserver) new ResizeObserver(reportSize).observe(document.body);

  // ---------- start ----------
  request("ui/initialize", { appInfo: { name: "agentpickup-pass", version: VERSION }, appCapabilities: {}, protocolVersion: "2026-01-26" })
    .then(function (r) {
      var caps = (r && r.hostCapabilities) || {};
      canCall = Boolean(caps.serverTools);
      canOpen = Boolean(caps.openLinks);
      applyContext((r && r.hostContext) || {});
      notify("ui/notifications/initialized", {});
      render();
      schedule();
    }, function () { render(); });
})();
</script>
</body>
</html>`;

/** The card's page. Its version goes in the handshake, so a host's logs say which card it ran. */
export function passCardHtml(version: string): string {
  return PAGE.replace("__VERSION__", version);
}
