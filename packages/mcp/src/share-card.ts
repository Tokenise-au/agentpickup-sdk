// The share card (MCP Apps): what share_agentpickup shows when someone asks how to get friends using agentPickup.
// The counter sticker as a card: a QR to the add page that a friend scans off the screen, the link to copy, and
// buttons that open the add page's share mode (the phone's share sheet, and the printable sticker). Self-contained,
// like the pass card: no scripts, fonts or images from anywhere else, and the same small MCP Apps bridge.

export const SHARE_META_KEY = "agentpickup/share";

export interface ShareCard {
  v: 1;
  /** The add page, maybe for one café (?shop=). */
  url: string;
  /** The add page's share mode: the share sheet and the sticker. */
  sharePageUrl: string;
  /** The QR as SVG, ink on transparent, for the white tile. */
  qrSvg: string;
  /** A café to name, when the link is for one. */
  shopName?: string;
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Share agentPickup</title>
<style>
:root{--bg:#0a0b0d;--text:#eef0f3;--muted:#b7bdc6;--dim:#8b929c;--line:#2a2f36;--lime:#b5f23d;--ink:#0a0b0d}
html,body{margin:0;padding:0;background:transparent}
body{font-family:var(--font-sans,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif);padding:2px;-webkit-font-smoothing:antialiased}
.card{box-sizing:border-box;max-width:420px;margin:0 auto;background:var(--bg);color:var(--text);border-radius:18px;padding:20px 20px 16px}
.top{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px}
.top svg{width:22px;height:22px;border-radius:5px}
.top .dim{color:var(--dim)}
h1{margin:14px 0 0;font-size:34px;line-height:.95;font-weight:850;letter-spacing:-.02em;text-transform:uppercase}
h1 em{font-style:normal;color:var(--lime)}
.sub{margin:8px 0 0;color:var(--muted);font-size:15px}
.row{display:flex;gap:16px;align-items:flex-end;margin-top:16px}
.tile{background:#fff;border-radius:14px;padding:12px;width:156px;height:156px;flex:none;box-sizing:border-box}
.tile svg{display:block;width:100%;height:100%}
ol{list-style:none;margin:0;padding:0;counter-reset:n;color:var(--muted);font-size:15px}
li{counter-increment:n;margin:0 0 8px;display:flex;align-items:center;gap:8px}
li::before{content:counter(n);width:22px;height:22px;border-radius:50%;border:1.5px solid var(--line);display:inline-flex;align-items:center;justify-content:center;font:600 12px ui-monospace,Menlo,monospace;color:var(--lime);flex:none}
.link{margin-top:14px;display:flex;gap:8px;align-items:center}
.link code{flex:1;min-width:0;overflow-wrap:anywhere;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text);background:#16191d;border:1px solid var(--line);border-radius:10px;padding:9px 10px;user-select:all;-webkit-user-select:all}
button{font-weight:600;font-size:14px;font-family:inherit;border-radius:10px;padding:10px 14px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--text);white-space:nowrap}
button.lime{background:var(--lime);color:var(--ink);border-color:var(--lime)}
.actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.actions button{flex:1}
.note{margin:10px 0 0;font-size:12px;color:var(--dim)}
@media (max-width:360px){.row{flex-direction:column;align-items:flex-start}}
</style>
</head>
<body>
<div id="root"></div>
<script>
(function () {
  var VERSION = "__VERSION__";
  var root = document.getElementById("root");
  var state = null, canOpen = false, nextId = 1, pending = {}, lastHeight = -1;
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
  function openLink(url) {
    if (!url) return;
    if (canOpen) request("ui/open-link", { url: url }).catch(function () { window.open(url, "_blank", "noopener"); });
    else window.open(url, "_blank", "noopener");
  }
  function onResult(result) {
    var data = result && result._meta && result._meta["agentpickup/share"];
    if (data && data.url) state = data;
    render();
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function safeSvg(svg) { return typeof svg === "string" && /^<svg[\s>]/.test(svg) && !/<script|<foreignObject|\son[a-z]+=/i.test(svg) ? svg : ""; }
  function copy(text, button) {
    var done = function () { button.textContent = "Copied"; setTimeout(function () { button.textContent = "Copy"; }, 1600); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(done, function () { select(); });
    } catch (e) {}
    select();
  }
  function select() {
    var code = document.getElementById("url");
    if (!code || !window.getSelection) return;
    var range = document.createRange();
    range.selectNodeContents(code);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  function render() {
    if (!state) { root.innerHTML = ""; return reportSize(); }
    var svg = safeSvg(state.qrSvg);
    var shown = state.url.replace(/^https?:\/\//, "");
    root.innerHTML =
      '<div class="card">' +
      '<div class="top"><svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" fill="#16191d"/><rect x="7" y="7" width="7" height="7" rx="1.5" fill="#fff"/><rect x="18" y="7" width="7" height="7" rx="1.5" fill="#fff"/><rect x="7" y="18" width="7" height="7" rx="1.5" fill="#fff"/><path d="M18.5 21.5l2.5 2.5 4.5-5" fill="none" stroke="#b5f23d" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span><span class="dim">agent</span>Pickup</span></div>' +
      "<h1>" + (state.shopName ? "Order from " + esc(state.shopName) + "<br>with your <em>AI</em>" : "Order ahead<br>from your <em>AI</em>") + "</h1>" +
      '<p class="sub">Claude, ChatGPT or Grok</p>' +
      '<div class="row">' + (svg ? '<div class="tile">' + svg.replace("<svg", '<svg role="img" aria-label="QR code to add agentPickup"') + "</div>" : "") +
      "<ol><li>Scan</li><li>Add agentPickup</li><li>Ask for your usual</li></ol></div>" +
      '<div class="link"><code id="url">' + esc(shown) + '</code><button type="button" id="copy">Copy</button></div>' +
      '<div class="actions"><button class="lime" type="button" id="share">Share</button><button type="button" id="sticker">Get the sticker</button></div>' +
      '<p class="note">A friend scans the QR off your screen, or you send them the link.</p>' +
      "</div>";
    document.getElementById("copy").addEventListener("click", function (e) { copy(state.url, e.currentTarget); });
    document.getElementById("share").addEventListener("click", function () { openLink(state.sharePageUrl); });
    document.getElementById("sticker").addEventListener("click", function () { openLink(state.sharePageUrl + (state.sharePageUrl.indexOf("?") >= 0 ? "&" : "?") + "sticker=1"); });
    reportSize();
  }
  function reportSize() {
    var height = Math.ceil(document.body.getBoundingClientRect().height);
    if (height !== lastHeight) { lastHeight = height; notify("ui/notifications/size-changed", { height: height }); }
  }
  if (window.ResizeObserver) new ResizeObserver(reportSize).observe(document.body);
  request("ui/initialize", { appInfo: { name: "agentpickup-share", version: VERSION }, appCapabilities: {}, protocolVersion: "2026-01-26" })
    .then(function (r) {
      canOpen = Boolean(r && r.hostCapabilities && r.hostCapabilities.openLinks);
      applyContext((r && r.hostContext) || {});
      notify("ui/notifications/initialized", {});
      render();
    }, function () { render(); });
})();
</script>
</body>
</html>`;

export function shareCardHtml(version: string): string {
  return PAGE.replace("__VERSION__", version);
}
