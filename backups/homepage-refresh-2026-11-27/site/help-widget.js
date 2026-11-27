// SITE-ONLY: floating "Need help?" FAB + panel (every site page).
// Separate from in-app SupportScreen.jsx. Gmail compose used (not mailto:)
// so devices without a mail handler still reach us.
(function () {
  var FE = window.FE;
  var ICONS = {
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22,6 12,13 2,6" /></svg>',
    ticket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z" /><path d="M13 5v2M13 17v2M13 11v2" /></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>',
    help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>',
  };

  function card(href, icon, title, sub, blank) {
    var attrs = { class: 'help-card', href: href };
    if (blank) { attrs.target = '_blank'; attrs.rel = 'noopener'; }
    return FE.el('a', attrs,
      '<div class="help-card-icon">' + ICONS[icon] + '</div>' +
      '<div class="help-card-text"><strong>' + title + '</strong><span>' + sub + '</span></div>');
  }

  function buildWidget() {
    var fab = FE.el('button', { type: 'button', class: 'help-fab', 'aria-expanded': 'false', 'aria-controls': 'help-panel' },
      '<span class="help-fab-icon-open">' + ICONS.help + '</span>' +
      '<span class="help-fab-icon-close">' + ICONS.close + '</span>' +
      '<span>Need help?</span>');
    var panel = FE.el('div', { id: 'help-panel', class: 'help-panel', role: 'dialog', 'aria-label': 'Help center' });
    var body = FE.el('div', { class: 'help-panel-body' });

    function setOpen(open) {
      panel.classList.toggle('is-open', open);
      fab.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        body.innerHTML = '';
        body.appendChild(card(FE.MAIL_COMPOSE, 'mail', 'Email Me', FE.CONTACT_EMAIL, true));
        body.appendChild(card('/help/', 'ticket', 'Submit a Ticket', 'Report a bug or request support on the help page.'));
        body.appendChild(card('/policies/', 'shield', 'Policies', 'Privacy Policy and EULA for Free-er Apps.'));
      }
    }
    fab.addEventListener('click', function () { setOpen(!panel.classList.contains('is-open')); });
    document.addEventListener('click', function (e) {
      if (panel.classList.contains('is-open') && !panel.contains(e.target) && !fab.contains(e.target)) setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panel.classList.contains('is-open')) setOpen(false);
    });

    var header = FE.el('div', { class: 'help-panel-header' });
    header.appendChild(FE.el('h2', {}, 'Need help?'));
    header.appendChild(FE.el('p', {}, 'Find answers, contact us, or submit a ticket. Anything you need.'));
    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(fab);
    document.body.appendChild(panel);
  }
  FE.onReady(buildWidget);
})();
