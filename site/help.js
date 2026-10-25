// SITE-ONLY: /help ticket form (site/help.js → /help/ only).
// Separate from in-app SupportScreen.jsx; both POST to /api/tickets.
(function () {
  var FE = window.FE;
  function init() {
    var form = document.getElementById('help-ticket-form');
    if (!form) return;
    var submitBtn = form.querySelector('.help-form-submit');
    var messageBox = document.getElementById('help-form-message');
    var typeSel = document.getElementById('help-type');
    var emailRow = document.getElementById('help-email-row');
    var emailInput = document.getElementById('help-email');
    var emailRequired = false;

    function showMessage(text, kind) {
      if (!text) { messageBox.style.display = 'none'; return; }
      messageBox.textContent = text;
      messageBox.className = 'help-form-message ' + kind;
      messageBox.style.display = 'block';
    }
    function setEmailState(state) { // 'valid' | 'invalid' | ''
      emailInput.classList.remove('is-invalid', 'is-valid');
      if (state) emailInput.classList.add(state === 'valid' ? 'is-valid' : 'is-invalid');
    }
    function updateEmailVisibility() {
      emailRequired = typeSel.value === 'support' || typeSel.value === 'other';
      emailRow.style.display = emailRequired ? '' : 'none';
      if (!emailRequired) { setEmailState(''); emailInput.value = ''; }
    }
    typeSel.addEventListener('change', updateEmailVisibility);
    emailInput.addEventListener('focus', function () { setEmailState(''); });
    emailInput.addEventListener('blur', function () {
      if (!emailRequired) return;
      var val = emailInput.value.trim();
      setEmailState(!val ? '' : (FE.isValidEmail(val) ? 'valid' : 'invalid'));
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var type = typeSel.value;
      var username = document.getElementById('help-name').value.trim() || null;
      var email = null;
      var msg = document.getElementById('help-message').value.trim();

      if (type === 'support' || type === 'other') {
        email = emailInput.value.trim();
        if (!email) { showMessage('Please provide a contact email so we can reply.', 'error'); return; }
        if (!FE.isValidEmail(email)) {
          setEmailState('invalid');
          showMessage('Please enter a valid email address.', 'error');
          return;
        }
        setEmailState('valid');
      }
      if (!msg) { showMessage('Please describe your issue.', 'error'); return; }

      FE.setBusy(submitBtn, true, 'Send', 'Sending...');
      showMessage('', '');
      var payload = { username: username, type: type, message: msg };
      if (email) payload.email = email;

      FE.api('/api/tickets', { method: 'POST', body: payload }).then(function (result) {
        if (result.ok) {
          document.getElementById('help-ticket-container').innerHTML =
            '<div class="help-success-page">' +
              '<div class="help-success-icon">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>' +
              '</div>' +
              '<h3>Ticket sent!</h3>' +
              '<p>Thanks for reaching out.</p>' +
              '<a class="btn primary" href="/">Back to Home</a>' +
            '</div>';
        } else {
          FE.setBusy(submitBtn, false, 'Send');
          showMessage((result.data && result.data.error) || 'Failed to send. Please try again.', 'error');
        }
      });
    });

    updateEmailVisibility();
  }
  FE.onReady(init);
})();
