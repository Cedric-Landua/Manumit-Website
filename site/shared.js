// Shared site helpers (manumit.studio shell, vanilla JS). Load first:
// <script defer src="/shared.js"></script> → window.FE.
(function () {
  var API_BASE = 'https://split-task-api.landua-cedric.workers.dev';
  var CONTACT_EMAIL = 'freeerapps.dev@gmail.com';
  function sha256(str) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
      return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    });
  }
  function isValidEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
  // JSON fetch → { ok, data }; never throws (network failure → ok:false).
  // Sends the admin bearer token when present (ticket read/mutate are admin-only).
  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    try {
      var tok = sessionStorage.getItem('admin_token');
      if (tok) headers['Authorization'] = 'Bearer ' + tok;
    } catch (e) {}
    return fetch(API_BASE + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      return res.json().then(function (d) { return { ok: res.ok, data: d }; });
    }).catch(function () { return { ok: false, data: null }; });
  }
  // el(tag, attrs, html): element builder (class via attrs.class).
  function el(tag, attrs, html) {
    var node = document.createElement(tag);
    for (var k in attrs) {
      if (k === 'class') node.className = attrs[k];
      else node.setAttribute(k, attrs[k]);
    }
    if (html) node.innerHTML = html;
    return node;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  // setBusy(btn, busy, label): disable + swap label while awaiting a request.
  function setBusy(btn, busy, label, busyLabel) {
    btn.disabled = busy;
    btn.textContent = busy ? busyLabel : label;
  }
  function onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }
  window.FE = {
    API_BASE: API_BASE, CONTACT_EMAIL: CONTACT_EMAIL,
    MAIL_COMPOSE: 'https://mail.google.com/mail/?view=cm&fs=1&to=' + encodeURIComponent(CONTACT_EMAIL),
    sha256: sha256, isValidEmail: isValidEmail, api: api, el: el, esc: esc, setBusy: setBusy, onReady: onReady,
  };
})();
