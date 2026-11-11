// The pickup pass as an MCP Apps card (ui:// resource, text/html;profile=mcp-app): chat apps that show cards (Claude,
// ChatGPT) draw it beside the tool result. While the order is unpaid it shows what's in it and a Pay button; once
// paid, the QR, pickup code and collect-by time; and it keeps itself up to date (order_status with the order's
// claim) until it's collected. At "ready" the QR's tile turns brand lime. One self-contained page: no scripts,
// fonts or images from anywhere else.
//
// The card reads its data from the tool result's structuredContent.card. Hosts pass structuredContent to the card
// (Claude drops _meta), so everything the card draws goes there, with the QR as a compact bit grid rather than an
// image. _meta carries the same for hosts that read it, and the text JSON is a last resort.
//
// The bridge is the MCP Apps postMessage protocol (JSON-RPC 2.0 with the host, protocol 2026-01-26), written out
// here rather than bundling the 300 KB SDK: ui/initialize, ui/notifications/initialized, tool-result,
// host-context-changed, resource-teardown, tools/call, ui/open-link and ui/notifications/size-changed.

export const CARD_MIME_TYPE = "text/html;profile=mcp-app";

/** The _meta key that mirrors structuredContent.card, for hosts that pass _meta. */
export const CARD_META_KEY = "agentpickup/pass";

/** A QR as a bit grid: size × size modules, row by row, packed 8 to a byte (first module in the top bit), base64. */
export interface QrBits {
  size: number;
  bits: string;
}

/** What the card draws. Every field but orderId is optional: later results fill in or update what's there. */
export interface PassCard {
  v: 1;
  orderId: string;
  shopUrl?: string;
  shopName?: string;
  /** The shop's logo, from its own /img/ address (the card's CSP names the shop's origin). */
  logo?: string;
  /** The shop's colour, for the letter tile when it has no logo. */
  brandColor?: string;
  /** Where to collect: the shop's address, or its counter's name. */
  where?: string;
  /** Lets the card call order_status itself while the order moves along. */
  claim?: string;
  status?: string;
  /** A paid order staff have started. */
  accepted?: boolean;
  rail?: string;
  /** "2× Flat white, 1× Croissant" */
  items?: string;
  /** The order's lines with their prices, photos and chosen options, for the card's receipt while it's unpaid. */
  lines?: { qty: number; name: string; price?: string; image?: string; options?: string }[];
  /** Present where the shop takes dietary notes: the customer's note, or null when they added none. */
  dietary?: { note: string | null };
  total?: string;
  collectBy?: number | null;
  collectedAt?: number | null;
  checkoutUrl?: string;
  passUrl?: string;
  pickupCode?: string | null;
  /** The pass's QR, once it's paid. */
  qr?: QrBits;
  /** When the customer will collect (Unix ms); absent is as soon as possible. */
  pickupAt?: number;
  /** The add page's share mode, for "Invite a friend". */
  inviteUrl?: string;
}

/**
 * Draws a QR bit grid as an SVG path, one run of dark modules per segment. Plain JavaScript source, so the cards
 * run exactly this text; the server and tests use the same function below.
 */
export const QR_PATH_JS = `function (qr, decode) {
  var raw = (decode || function (b) { return atob(b); })(qr.bits);
  var size = qr.size;
  function dark(i) { return (raw.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1; }
  var d = "";
  for (var y = 0; y < size; y++) {
    var x = 0;
    while (x < size) {
      if (!dark(y * size + x)) { x++; continue; }
      var start = x;
      while (x < size && dark(y * size + x)) x++;
      d += "M" + start + " " + y + "h" + (x - start) + "v1h-" + (x - start) + "z";
    }
  }
  return d;
}`;

export const qrPathFromBits = new Function(`return ${QR_PATH_JS}`)() as (qr: QrBits, decode?: (b64: string) => string) => string;

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pickup pass</title>
<style>
:root{--bg:#ffffff;--surface:#f4f4f1;--text:#16161a;--muted:#66666d;--faint:#9a9aa0;--line:rgba(10,11,13,.1);--ok:#23843b;--okbg:#e8f5ea;--warn:#8a5a00;--warnbg:#fdf2dc;--lime:#b5f23d;--ink:#0a0b0d;color-scheme:light}
:root[data-theme=dark]{--bg:#1d1d20;--surface:#28282c;--text:#f2f2f4;--muted:#a3a3ab;--faint:#74747c;--line:rgba(255,255,255,.12);--ok:#8fd47f;--okbg:#1f3322;--warn:#f2c46b;--warnbg:#3a2f17;color-scheme:dark}
@media (prefers-color-scheme:dark){:root:not([data-theme]){--bg:#1d1d20;--surface:#28282c;--text:#f2f2f4;--muted:#a3a3ab;--faint:#74747c;--line:rgba(255,255,255,.12);--ok:#8fd47f;--okbg:#1f3322;--warn:#f2c46b;--warnbg:#3a2f17;color-scheme:dark}}
html,body{margin:0;padding:0;background:transparent}
body{font-family:var(--font-sans,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif);color:var(--text);-webkit-font-smoothing:antialiased;padding:2px}
.card{box-sizing:border-box;max-width:380px;margin:0 auto;background:var(--bg);border:1px solid var(--line);border-radius:18px;padding:16px 18px 14px}
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.who{display:flex;gap:10px;align-items:center;min-width:0}
.logo{width:40px;height:40px;border-radius:10px;object-fit:cover;flex:none;background:var(--surface);border:1px solid var(--line);box-sizing:border-box}
.logo.none{display:flex;align-items:center;justify-content:center;font-weight:700;font-size:17px;color:#fff;border:0}
.shop{font-weight:650;font-size:16px;margin:0;letter-spacing:-.01em}
.sub{font-size:13px;color:var(--muted);margin:2px 0 0}
.pill{font-size:12px;line-height:1;padding:6px 10px;border-radius:999px;white-space:nowrap;background:var(--surface);color:var(--muted)}
.pill.awaiting_payment{background:var(--warnbg);color:var(--warn)}
.pill.paid,.pill.collected{background:var(--okbg);color:var(--ok)}
.pill.ready{background:var(--lime);color:var(--ink);font-weight:650}
.lines{margin:14px 0 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:8px 0;font-size:14px}
.line{display:flex;justify-content:space-between;gap:12px;padding:3px 0}
.line.item{align-items:center;gap:10px;padding:5px 0}
.line.item .what{flex:1;min-width:0;display:flex;align-items:center;gap:10px}
.thumb{width:36px;height:36px;border-radius:8px;object-fit:cover;flex:none;background:var(--surface)}
.thumb.none{display:flex;align-items:center;justify-content:center;color:var(--faint);font-weight:700;font-size:14px}
.opts{display:block;font-size:12px;color:var(--muted);margin-top:1px}
.diet{font-size:13px;margin:10px 0 0;padding:8px 12px;border-radius:12px;background:var(--surface);line-height:1.4}
.diet b{font-weight:650}
.diet.none{color:var(--muted)}
.line span:first-child{min-width:0;overflow-wrap:anywhere}
.line.total{font-weight:650}
.wrap{position:relative;border-radius:14px;margin-top:14px}
.tile{position:relative;overflow:hidden;background:#ffffff;border-radius:14px;padding:16px;display:flex;justify-content:center;align-items:center;border:1px solid var(--line);min-height:120px}
.tile svg{position:relative;display:block;width:100%;max-width:210px;height:auto}
.pour{position:absolute;left:0;right:0;bottom:0;height:0;background:var(--lime);transition:height 1s cubic-bezier(.5,0,.2,1)}
.wrap.ready .pour{height:100%}
.wrap.ready .tile{border-color:var(--lime)}
.wrap.ready::after{content:"";position:absolute;inset:0;border:2px solid var(--lime);border-radius:14px;animation:ring 1.8s ease-out infinite;pointer-events:none}
@keyframes ring{from{transform:scale(1);opacity:.9}to{transform:scale(1.08);opacity:0}}
.tile.plain{background:var(--surface)}
.done{font-size:15px;color:var(--text);text-align:center}
.done b{display:block;font-size:30px;line-height:1.2;color:var(--ok)}
.facts{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;margin:10px 0 0}
.fact{background:var(--surface);border-radius:12px;padding:8px 12px}
.fact span{display:block;font-size:12px;color:var(--muted)}
.fact b{display:block;font-size:19px;font-weight:650;overflow-wrap:anywhere}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:2px}
.steps{display:flex;gap:6px;margin-top:14px}
.step{flex:1;display:flex;align-items:center;gap:6px;font-size:12px;color:var(--faint)}
.step i{width:9px;height:9px;border-radius:50%;border:1.5px solid currentColor;box-sizing:border-box;flex:none}
.step.past{color:var(--ok)}.step.past i{background:currentColor}
.step.now{color:var(--text)}.step.now i{background:transparent;border:2px solid var(--lime)}
.msg{font-size:13px;color:var(--muted);margin:10px 0 0;line-height:1.45}
.test{font-size:12px;color:var(--muted);margin:6px 0 0}
button{font:inherit;cursor:pointer}
.pay{display:block;width:100%;margin:14px 0 0;padding:13px 14px;border-radius:12px;border:0;background:var(--lime);color:var(--ink);font-size:15px;font-weight:650}
.note{font-size:12px;color:var(--muted);margin:8px 0 0;text-align:center;line-height:1.4}
.link{background:none;border:none;padding:0;color:var(--muted);text-decoration:underline;font-size:13px}
.actions{margin-top:10px}
.foot{font-size:11px;color:var(--faint);margin-top:14px;display:flex;justify-content:space-between;align-items:center;gap:8px}
.brand{display:inline-flex;align-items:center;gap:6px}
.brand svg{width:16px;height:16px;display:block}
.card.pending{border-color:rgba(181,242,61,.5);animation:glow 2.6s ease-in-out infinite}
@keyframes glow{0%,100%{border-color:rgba(181,242,61,.4);box-shadow:inset 0 0 0 1px rgba(181,242,61,.12),inset 0 0 16px 0 rgba(181,242,61,.05)}50%{border-color:rgba(181,242,61,.95);box-shadow:inset 0 0 0 1px rgba(181,242,61,.4),inset 0 0 26px 0 rgba(181,242,61,.14)}}
.foot .link{font-size:12px;color:var(--muted)}
@media (prefers-reduced-motion:reduce){.pour{transition:none}.wrap.ready::after{animation:none;opacity:1}.card.pending{animation:none;border-color:rgba(181,242,61,.8);box-shadow:inset 0 0 0 1px rgba(181,242,61,.3),inset 0 0 20px 0 rgba(181,242,61,.1)}}
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
  var qrPathFromBits = __QR_PATH__;

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
    if (vars && typeof vars["--font-sans"] === "string") document.documentElement.style.setProperty("--font-sans", vars["--font-sans"]);
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
    var sc = result.structuredContent && result.structuredContent.card;
    if (sc && sc.orderId) return sc;
    var meta = result._meta && result._meta["agentpickup/pass"];
    if (meta && meta.orderId) return meta;
    // Neither came through: the JSON after the tool's summary line still has the basics.
    try {
      var text = result.content && result.content[0] && result.content[0].text;
      var data = JSON.parse(text.slice(text.indexOf("\n\n") + 2));
      var id = data.orderId || data.id || (data.order && data.order.id);
      if (!id) return null;
      return { orderId: id, status: data.status || (data.checkoutUrl || data.payUrl ? "awaiting_payment" : undefined), passUrl: data.passUrl, pickupCode: data.pickupCode, checkoutUrl: data.checkoutUrl, total: data.total, claim: data.claim, shopUrl: data.shop };
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
  // A shop that has left, or an order that's gone, won't come back: stop asking. Anything else is tried again,
  // up to five times in a row.
  var failures = 0;
  function failed(r) {
    var text = (r && r.content && r.content[0] && r.content[0].text) || "";
    if (/no such venue|not found|isn.t an agentpickup shop|no longer/i.test(text) || ++failures >= 5) stop();
    else schedule();
  }
  function poll() {
    var args = { order_id: state.orderId, claim: state.claim };
    if (state.shopUrl) args.shop_url = state.shopUrl;
    request("tools/call", { name: "order_status", arguments: args }).then(function (r) {
      if (r && !r.isError) { failures = 0; onResult(r); } else failed(r);
    }, failed);
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
  function qrSvg(qr) {
    if (!qr || typeof qr.bits !== "string" || !(qr.size > 0 && qr.size < 200)) return "";
    try {
      return '<svg viewBox="0 0 ' + qr.size + " " + qr.size + '" shape-rendering="crispEdges" role="img" aria-label="Pickup QR code"><path fill="#0a0b0d" d="' + qrPathFromBits(qr) + '"/></svg>';
    } catch (e) { return ""; }
  }
  function message(s) {
    var live = canCall && s.claim;
    switch (s.status) {
      case "awaiting_payment": return s.checkoutUrl ? "" : "Waiting for the payment. " + (live ? "This card becomes your pickup pass once it's paid." : "");
      case "paid": return (s.accepted ? "Paid. The shop is making it. " : "Paid. The shop has your order. ") + (live ? "This turns green when it's ready. " : "") + "The pass is in your email too.";
      case "ready": return "Ready at the counter. Show the QR or say the code.";
      case "collected": return "Enjoy. The receipt is in your email.";
      case "expired": return "This order expired before anyone collected it.";
      case "cancelled": return "This order was cancelled. Anything paid goes back the way it was paid.";
      default: return "";
    }
  }
  // Pay (or Paid), Preparing, Ready, Collected: the steps it has reached are filled, and the next one is a hollow
  // lime ring, so a paid order never reads as ready.
  function steps(s) {
    var status = s.status || "awaiting_payment";
    var reached = { awaiting_payment: 0, paid: s.accepted ? 2 : 1, ready: 3, collected: 4 }[status];
    if (reached === undefined) return "";
    return '<div class="steps">' + [status === "awaiting_payment" ? "Pay" : "Paid", "Preparing", "Ready", "Collected"].map(function (name, i) {
      var cls = i < reached ? " past" : i === reached ? " now" : "";
      return '<span class="step' + cls + '"><i></i>' + name + "</span>";
    }).join("") + "</div>";
  }
  var MARK = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#0a0b0d"/><rect x="7" y="7" width="7" height="7" rx="1.5" fill="#fff"/><rect x="18" y="7" width="7" height="7" rx="1.5" fill="#fff"/><rect x="7" y="18" width="7" height="7" rx="1.5" fill="#fff"/><path d="M18.5 21.5l2.5 2.5 4.5-5" fill="none" stroke="#b5f23d" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function safeImg(u) { return typeof u === "string" && /^https:\/\//.test(u) ? u : ""; }
  function safeColor(c) { return typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c) ? c : "#0a0b0d"; }
  // A photo that fails to load turns back into its letter tile (see render).
  function logo(s) {
    var letter = esc((s.shopName || "?").charAt(0).toUpperCase());
    var tile = '<span class="logo none" style="background:' + safeColor(s.brandColor) + '">' + letter + "</span>";
    var src = safeImg(s.logo);
    return src ? '<img class="logo" src="' + esc(src) + '" alt="" data-tile="' + esc(tile) + '">' : tile;
  }
  function thumb(l) {
    var tile = '<span class="thumb none">' + esc((l.name || "?").charAt(0).toUpperCase()) + "</span>";
    var src = safeImg(l.image);
    return src ? '<img class="thumb" src="' + esc(src) + '" alt="" data-tile="' + esc(tile) + '">' : tile;
  }
  function diet(s) {
    if (!s.dietary) return "";
    return s.dietary.note
      ? '<p class="diet"><b>Dietary notes:</b> ' + esc(s.dietary.note) + "</p>"
      : '<p class="diet none"><b>Dietary notes:</b> none added</p>';
  }
  function view(s) {
    var status = s.status || "awaiting_payment";
    var unpaid = status === "awaiting_payment";
    var live = status === "paid" || status === "ready";
    var h = '<div class="card' + (unpaid && s.checkoutUrl ? " pending" : "") + '"><div class="head"><div class="who">' + logo(s) + "<div>";
    h += '<p class="shop">' + esc(s.shopName || "Your pickup order") + "</p>";
    var sub = unpaid ? (s.where ? "Pickup at " + s.where : "") : (s.items ? s.items + (s.total ? " · " + s.total : "") : "");
    if (sub) h += '<p class="sub">' + esc(sub) + "</p>";
    h += '</div></div><span class="pill ' + esc(status) + '">' + esc(LABELS[status] || status) + "</span></div>";

    if (unpaid) {
      var lines = s.lines && s.lines.length ? s.lines : null;
      if (lines || s.total) {
        h += '<div class="lines">';
        if (lines) lines.forEach(function (l) {
          h += '<div class="line item"><span class="what">' + thumb(l) + "<span>" + esc(l.qty + "× " + l.name) +
            (l.options ? '<span class="opts">' + esc(l.options) + "</span>" : "") + "</span></span><span>" + esc(l.price || "") + "</span></div>";
        });
        else if (s.items) h += '<div class="line"><span>' + esc(s.items) + "</span><span></span></div>";
        if (s.total) h += '<div class="line total"><span>Total</span><span>' + esc(s.total) + "</span></div>";
        if (s.pickupAt) h += '<div class="line"><span>Pickup at</span><span>' + esc(time(s.pickupAt)) + "</span></div>";
        h += "</div>";
      }
    }
    if (unpaid) h += diet(s);
    var svg = qrSvg(s.qr);
    if (live && svg) {
      h += '<div class="wrap' + (status === "ready" && poured ? " ready" : "") + '" id="wrap"><div class="tile"><div class="pour"></div>' + svg + "</div></div>";
    } else if (status === "collected") {
      h += '<div class="wrap"><div class="tile plain"><div class="done"><b>&#10003;</b>' + esc(s.collectedAt ? "Collected at " + time(s.collectedAt) : "Collected") + "</div></div></div>";
    }
    if (live && (s.pickupCode || s.collectBy)) {
      h += '<div class="facts">';
      if (s.pickupCode) h += '<div class="fact"><span>Pickup code</span><b class="code">' + esc(s.pickupCode) + "</b></div>";
      if (s.pickupAt) h += '<div class="fact"><span>Pickup at</span><b>' + esc(time(s.pickupAt)) + "</b></div>";
      else if (s.collectBy) h += '<div class="fact"><span>Collect by</span><b>' + esc(time(s.collectBy)) + "</b></div>";
      h += "</div>";
    }
    if (live) h += diet(s);
    h += steps(s);
    var msg = message(s);
    if (msg) h += '<p class="msg">' + esc(msg) + "</p>";
    if (unpaid && s.checkoutUrl) {
      h += '<button class="pay" data-open="checkoutUrl">Pay' + (s.total ? " " + esc(s.total) : "") + "</button>";
      h += '<p class="note">Card, Apple Pay or Google Pay on the shop\'s secure checkout. This card becomes your pickup pass.</p>';
    }
    if (s.rail === "test") h += '<p class="test">Test order: no money moved.</p>';
    if (live && s.passUrl) h += '<div class="actions"><button class="link" data-open="passUrl">Open the pass</button></div>';
    h += '<div class="foot">' + (s.inviteUrl ? '<button class="link" data-open="inviteUrl">Invite a friend</button>' : "<span></span>") + '<span class="brand">' + MARK + "agentPickup</span></div></div>";
    return h;
  }
  function render() {
    var html = state ? view(state) : "";
    if (html !== lastHtml) {
      root.innerHTML = html;
      lastHtml = html;
      var buttons = root.querySelectorAll("[data-open]");
      for (var i = 0; i < buttons.length; i++) buttons[i].addEventListener("click", function (e) { openLink(state[e.currentTarget.getAttribute("data-open")]); });
      var imgs = root.querySelectorAll("img[data-tile]");
      for (var j = 0; j < imgs.length; j++) {
        imgs[j].addEventListener("error", function (e) { e.currentTarget.outerHTML = e.currentTarget.getAttribute("data-tile"); reportSize(); });
        imgs[j].addEventListener("load", reportSize);
      }
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
  return PAGE.replace("__VERSION__", version).replace("__QR_PATH__", QR_PATH_JS);
}
