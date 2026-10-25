// SITE-ONLY: /help admin login modal + /admin dashboard.
// Separate from in-app SupportScreen.jsx; both hit /api/tickets.
(function () {
  var FE = window.FE;
  var TOKEN_KEY = 'admin_token';
  var USER_KEY = 'admin_user';
  var allTickets = [];
  var activeFilter = 'all';

  function fmtTime(iso) {
    try {
      var d = new Date(iso);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
        ' at ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return iso; }
  }

  function buildLoginModal() {
    var overlay = document.createElement('div');
    overlay.className = 'admin-modal-overlay';
    overlay.id = 'admin-login-overlay';
    overlay.innerHTML =
      '<div class="admin-modal">' +
        '<h3>Administrative Login</h3>' +
        '<p class="admin-modal-sub">Sign in to access the dashboard.</p>' +
        '<div class="admin-modal-error" id="admin-login-error"></div>' +
        '<div class="admin-modal-field">' +
          '<label for="admin-input-user">Username</label>' +
          '<input type="text" id="admin-input-user" autocomplete="username" />' +
        '</div>' +
        '<div class="admin-modal-field">' +
          '<label for="admin-input-pass">Password</label>' +
          '<input type="password" id="admin-input-pass" autocomplete="current-password" />' +
        '</div>' +
        '<button type="button" class="help-form-submit admin-modal-submit" id="admin-login-submit">Sign In</button>' +
      '</div>';
    document.body.appendChild(overlay);
    // Inline styles (not just .is-open) so a stale cached site.css can't leak
    // the modal onto the page below the footer.
    overlay.style.display = 'none';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.zIndex = '300';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.background = 'rgba(0, 0, 0, 0.45)';
    var userInput = document.getElementById('admin-input-user');
    var passInput = document.getElementById('admin-input-pass');
    var submitBtn = document.getElementById('admin-login-submit');
    var errorBox = document.getElementById('admin-login-error');
    function open() {
      // Inline display (not just .is-open) — see note where styles are set.
      overlay.style.display = 'flex';
      overlay.classList.add('is-open');
      setTimeout(function () { userInput.focus(); }, 100);
    }
    function close() {
      overlay.classList.remove('is-open');
      overlay.style.display = 'none';
      userInput.value = ''; passInput.value = ''; errorBox.textContent = '';
    }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay.classList.contains('is-open')) close(); });
    function doLogin() {
      var username = userInput.value.trim();
      var password = passInput.value;
      if (!username || !password) { errorBox.textContent = 'Please enter both username and password.'; return; }
      FE.setBusy(submitBtn, true, 'Sign In', 'Signing in...');
      errorBox.textContent = '';
      FE.sha256(password).then(function (hash) {
        return FE.api('/api/admin/login', { method: 'POST', body: { username: username, password_hash: hash } });
      }).then(function (r) {
        FE.setBusy(submitBtn, false, 'Sign In');
        if (r.ok && r.data.success) {
          sessionStorage.setItem(TOKEN_KEY, r.data.token);
          sessionStorage.setItem(USER_KEY, r.data.username);
          close(); window.location.href = '/admin/';
        } else { errorBox.textContent = (r.data && r.data.error) || 'Invalid credentials.'; }
      });
    }
    submitBtn.addEventListener('click', doLogin);
    passInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    return { open: open };
  }

  function renderStats() {
    var total = allTickets.length;
    var open = allTickets.filter(function (t) { return t.status === 'open'; }).length;
    document.getElementById('admin-stats').innerHTML =
      '<div class="admin-stat"><div class="value">' + total + '</div><div class="label">Total</div></div>' +
      '<div class="admin-stat"><div class="value">' + open + '</div><div class="label">Open</div></div>' +
      '<div class="admin-stat"><div class="value">' + (total - open) + '</div><div class="label">Resolved</div></div>';
  }

  var TYPE_LABELS = { support: 'Support', bug: 'Bug', other: 'Other' };
  function renderTickets() {
    var el = document.getElementById('admin-tickets');
    var filtered = activeFilter === 'all' ? allTickets
      : allTickets.filter(function (t) { return t.status === activeFilter; });
    if (!filtered.length) { el.innerHTML = '<div class="admin-empty">No tickets to show.</div>'; return; }
    el.innerHTML = filtered.map(function (t) {
      var contact = [t.username ? '@' + FE.esc(t.username) : null, t.email ? FE.esc(t.email) : null].filter(Boolean).join(' &middot; ') || 'Guest';
      var toggleBtn = t.status === 'open'
        ? '<button class="admin-ticket-btn" data-action="resolve" data-id="' + t.id + '">Mark resolved</button>'
        : '<button class="admin-ticket-btn" data-action="reopen" data-id="' + t.id + '">Reopen</button>';
      return '<div class="admin-ticket">' +
        '<div class="admin-ticket-header"><span class="admin-ticket-id">#' + (t.id || '') + '</span>' +
        '<div class="admin-ticket-meta">' +
        '<span class="admin-ticket-badge ' + (t.status === 'resolved' ? 'resolved' : 'open') + '">' + t.status + '</span>' +
        '<span class="admin-ticket-type">' + (TYPE_LABELS[t.type] || 'Other') + '</span>' +
        '<span class="admin-ticket-time">' + fmtTime(t.created_at) + '</span>' +
        '</div></div>' +
        '<div class="admin-ticket-message">' + FE.esc(t.message) + '</div>' +
        '<div class="admin-ticket-footer"><span class="admin-ticket-contact">' + contact + '</span>' +
        '<div class="admin-ticket-actions">' + toggleBtn +
        '<button class="admin-ticket-btn danger" data-action="delete" data-id="' + t.id + '">Delete</button>' +
        '</div></div></div>';
    }).join('');
  }

  function loadTickets() {
    var ticketsEl = document.getElementById('admin-tickets');
    var loadingEl = document.getElementById('admin-loading');
    loadingEl.style.display = ''; ticketsEl.innerHTML = '';
    FE.api('/api/tickets').then(function (r) {
      loadingEl.style.display = 'none';
      if (!r.ok) { ticketsEl.innerHTML = '<div class="admin-empty">Failed to load tickets. Please refresh.</div>'; return; }
      allTickets = r.data.tickets || [];
      renderStats(); renderTickets();
    });
  }

  function mutateTicket(path, method, body) {
    FE.api(path, { method: method, body: body }).then(function (r) { if (r.ok) loadTickets(); });
  }

  function initDashboard() {
    if (!document.getElementById('admin-dashboard')) return;
    if (!sessionStorage.getItem(TOKEN_KEY)) { window.location.href = '/help/'; return; }
    var tabsEl = document.getElementById('admin-tabs');
    var ticketsEl = document.getElementById('admin-tickets');
    document.getElementById('admin-logout-btn').addEventListener('click', function () {
      sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(USER_KEY);
      window.location.href = '/help/';
    });
    tabsEl.addEventListener('click', function (e) {
      var btn = e.target.closest('.admin-tab'); if (!btn) return;
      tabsEl.querySelectorAll('.admin-tab').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active'); activeFilter = btn.getAttribute('data-filter'); renderTickets();
    });
    ticketsEl.addEventListener('click', function (e) {
      var btn = e.target.closest('.admin-ticket-btn'); if (!btn) return;
      var id = btn.getAttribute('data-id'); var action = btn.getAttribute('data-action');
      if (action === 'resolve') mutateTicket('/api/tickets/status', 'POST', { id: id, status: 'resolved' });
      else if (action === 'reopen') mutateTicket('/api/tickets/status', 'POST', { id: id, status: 'open' });
      else if (action === 'delete') mutateTicket('/api/tickets', 'DELETE', { id: id });
    });
    var firstTab = tabsEl.querySelector('.admin-tab');
    if (firstTab) firstTab.classList.add('active');
    loadTickets();
  }

  function init() {
    var loginBtn = document.getElementById('admin-login-btn');
    if (loginBtn) { var modal = buildLoginModal(); loginBtn.addEventListener('click', modal.open); }
    initDashboard();
  }
  FE.onReady(init);
})();
