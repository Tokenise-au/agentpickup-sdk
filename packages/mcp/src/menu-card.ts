// The menu card (MCP Apps): what get_shop shows in chat apps that draw cards. The shop's items with their photos,
// prices and labels (vegan, gluten-free, contains nuts, sold out), so the person sees what they're ordering before
// they ask for it. Self-contained like the pass card, except for the item photos, which load from the shop's own
// /img/<id> (the resource's CSP names the shop's origin). Ordering carries on in the chat.

export const MENU_META_KEY = "agentpickup/menu";

export interface MenuCardItem {
  id: string;
  name: string;
  /** "$4.50" */
  price: string;
  description?: string;
  category?: string;
  /** The shop's /img/<id>. */
  image?: string;
  dietary?: string[];
  allergens?: string[];
  calories?: number;
  soldOut?: boolean;
}

export interface MenuCard {
  v: 1;
  shop: string;
  /** Where to collect. */
  location?: string;
  /** null when the shop gave no hours. */
  openNow: boolean | null;
  opensNext?: string;
  items: MenuCardItem[];
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Menu</title>
<style>
:root{--bg:#0a0b0d;--panel:#14171b;--text:#eef0f3;--muted:#b7bdc6;--dim:#8b929c;--line:#262a30;--lime:#b5f23d;--red:#f87171}
html,body{margin:0;padding:0;background:transparent}
body{font-family:var(--font-sans,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif);padding:2px;-webkit-font-smoothing:antialiased}
.card{box-sizing:border-box;max-width:560px;margin:0 auto;background:var(--bg);color:var(--text);border-radius:18px;padding:16px 16px 12px}
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
h1{margin:0;font-size:20px;line-height:1.2;font-weight:750}
.where{color:var(--dim);font-size:13px;margin-top:2px}
.open{font-size:12px;font-weight:600;border-radius:999px;padding:4px 9px;border:1px solid var(--line);white-space:nowrap;color:var(--muted)}
.open.yes{color:var(--lime);border-color:var(--lime)}
.open.no{color:var(--red);border-color:var(--red)}
h2{margin:14px 0 6px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);font-weight:600}
.item{display:flex;gap:12px;padding:10px 0;border-top:1px solid var(--line)}
.item:first-of-type{border-top:0}
.ph{width:64px;height:64px;border-radius:12px;object-fit:cover;flex:none;background:var(--panel)}
.ph.none{display:flex;align-items:center;justify-content:center;color:var(--dim);font-weight:700;font-size:18px}
.body{flex:1;min-width:0}
.top{display:flex;justify-content:space-between;gap:10px}
.name{font-weight:650;font-size:15px}
.price{font-weight:650;font-size:15px;font-variant-numeric:tabular-nums;white-space:nowrap}
.desc{color:var(--muted);font-size:13px;margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.badges{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.b{font-size:11px;line-height:1;padding:4px 7px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.b.diet{color:var(--lime);border-color:rgba(181,242,61,.55)}
.b.out{color:var(--red);border-color:var(--red);font-weight:600}
.item.soldout .name,.item.soldout .price{color:var(--dim);text-decoration:line-through}
.item.soldout .ph{opacity:.4}
.more{color:var(--dim);font-size:13px;margin:10px 0 0}
.note{color:var(--dim);font-size:12px;margin:10px 0 0;border-top:1px solid var(--line);padding-top:10px}
</style>
</head>
<body>
<div id="root"></div>
<script>
(function () {
  var VERSION = "__VERSION__";
  var SHOW = 30;
  var root = document.getElementById("root");
  var state = null, nextId = 1, pending = {}, lastHeight = -1;
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
    if (m.method === "ui/notifications/host-context-changed") { applyContext(m.params || {}); return; }
    if (m.method === "ui/resource-teardown" && m.id != null) return send({ jsonrpc: "2.0", id: m.id, result: {} });
    if (m.method === "ping" && m.id != null) return send({ jsonrpc: "2.0", id: m.id, result: {} });
    if (m.id != null && m.method && m.method.indexOf("ui/notifications/") !== 0) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
  });
  function applyContext(ctx) {
    var vars = ctx.styles && ctx.styles.variables;
    if (vars && typeof vars["--font-sans"] === "string") document.documentElement.style.setProperty("--font-sans", vars["--font-sans"]);
  }
  function onResult(result) {
    var data = (result && result.structuredContent && result.structuredContent.menu) || (result && result._meta && result._meta["agentpickup/menu"]);
    if (data && data.items) state = data;
    render();
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function safeImg(u) { return typeof u === "string" && /^https:\/\//.test(u) ? u : ""; }
  function item(i) {
    var img = safeImg(i.image);
    var letter = esc((i.name || "?").charAt(0));
    var ph = img ? '<img class="ph" src="' + esc(img) + '" alt="" loading="lazy" data-letter="' + letter + '">' : '<span class="ph none">' + letter + "</span>";
    var badges = [];
    if (i.soldOut) badges.push('<span class="b out">Sold out</span>');
    (i.dietary || []).forEach(function (d) { badges.push('<span class="b diet">' + esc(d) + "</span>"); });
    if (i.allergens && i.allergens.length) badges.push('<span class="b">Contains ' + esc(i.allergens.join(", ")) + "</span>");
    if (typeof i.calories === "number") badges.push('<span class="b">' + esc(i.calories) + " kcal</span>");
    return '<div class="item' + (i.soldOut ? " soldout" : "") + '">' + ph + '<div class="body"><div class="top"><span class="name">' + esc(i.name) +
      '</span><span class="price">' + esc(i.price) + "</span></div>" + (i.description ? '<div class="desc">' + esc(i.description) + "</div>" : "") +
      (badges.length ? '<div class="badges">' + badges.join("") + "</div>" : "") + "</div></div>";
  }
  function render() {
    if (!state) { root.innerHTML = ""; return reportSize(); }
    var items = state.items.slice(0, SHOW);
    var groups = [], byName = {};
    items.forEach(function (i) { var k = i.category || ""; if (!(k in byName)) { byName[k] = []; groups.push(k); } byName[k].push(i); });
    var open = state.openNow === true ? '<span class="open yes">Open now</span>' : state.openNow === false ? '<span class="open no">Closed' + (state.opensNext ? ", opens " + esc(state.opensNext) : "") + "</span>" : "";
    root.innerHTML =
      '<div class="card"><div class="head"><div><h1>' + esc(state.shop) + "</h1>" + (state.location ? '<div class="where">Collect at ' + esc(state.location) + "</div>" : "") + "</div>" + open + "</div>" +
      groups.map(function (g) { return (groups.length > 1 && g ? "<h2>" + esc(g) + "</h2>" : "") + byName[g].map(item).join(""); }).join("") +
      (state.items.length > SHOW ? '<p class="more">And ' + (state.items.length - SHOW) + " more on the menu.</p>" : "") +
      '<p class="note">Ask for what you want and your assistant orders it. You pay, then collect with a QR.</p></div>';
    // A photo that won't load (another host, or gone) becomes the item's letter.
    Array.prototype.forEach.call(root.querySelectorAll("img.ph"), function (im) {
      im.addEventListener("error", function () {
        var span = document.createElement("span");
        span.className = "ph none";
        span.textContent = im.getAttribute("data-letter") || "?";
        im.replaceWith(span);
        reportSize();
      });
      im.addEventListener("load", reportSize);
    });
    reportSize();
  }
  function reportSize() {
    var height = Math.ceil(document.body.getBoundingClientRect().height);
    if (height !== lastHeight) { lastHeight = height; notify("ui/notifications/size-changed", { height: height }); }
  }
  if (window.ResizeObserver) new ResizeObserver(reportSize).observe(document.body);
  request("ui/initialize", { appInfo: { name: "agentpickup-menu", version: VERSION }, appCapabilities: {}, protocolVersion: "2026-01-26" })
    .then(function (r) {
      applyContext((r && r.hostContext) || {});
      notify("ui/notifications/initialized", {});
      render();
    }, function () { render(); });
})();
</script>
</body>
</html>`;

export function menuCardHtml(version: string): string {
  return PAGE.replace("__VERSION__", version);
}
