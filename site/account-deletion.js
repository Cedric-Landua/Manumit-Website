// Credential-verified Manumit account deletion for the public site.
(function () {
  var formVerify = document.getElementById('delete-verify-form');
  if (!formVerify) return;

  var formConfirm = document.getElementById('delete-confirm-form');
  var message = document.getElementById('delete-message');
  var verifyButton = document.getElementById('verify-button');
  var deleteButton = document.getElementById('delete-button');
  var usernameInput = document.getElementById('delete-username');
  var passwordInput = document.getElementById('delete-password');
  var verifiedUsername = document.getElementById('verified-username');
  var success = document.getElementById('delete-success');
  var passwordHash = '';
  var accountName = '';

  function showMessage(text, isError) {
    message.textContent = text;
    message.className = 'help-form-message ' + (isError ? 'error' : 'success');
    message.hidden = false;
  }

  function clearMessage() {
    message.textContent = '';
    message.hidden = true;
    message.className = 'help-form-message';
  }

  function setBusy(button, busy, idleLabel, busyLabel) {
    button.disabled = busy;
    button.textContent = busy ? busyLabel : idleLabel;
  }

  async function post(path, body) {
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 20000);
    try {
      var response = await fetch(window.FE.API_BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: controller.signal,
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        var error = new Error(data.error || 'The request could not be completed. Please try again.');
        error.status = response.status;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  function requestError(error, operation) {
    if (error && error.status === 401) return 'Invalid username or password. Check your credentials and try again.';
    if (error && error.status === 429) return 'Too many attempts. Please wait a moment before trying again.';
    if (error && error.name === 'AbortError') return 'The request timed out. Check your connection and try again.';
    if (error instanceof TypeError) return 'Could not connect to Manumit. Check your connection and try again.';
    return error && error.message ? error.message : operation + ' failed. Please try again.';
  }

  formVerify.addEventListener('submit', async function (event) {
    event.preventDefault();
    clearMessage();
    setBusy(verifyButton, true, 'Verify identity', 'Verifying…');

    accountName = usernameInput.value.trim();
    try {
      passwordHash = await window.FE.sha256(passwordInput.value);
      var result = await post('/api/login', { username: accountName, password_hash: passwordHash });
      if (!result || result.success !== true) throw new Error('Identity verification did not complete. Please try again.');
      passwordInput.value = '';
      verifiedUsername.textContent = result.username || accountName;
      formVerify.hidden = true;
      formConfirm.hidden = false;
      deleteButton.focus();
      showMessage('Identity verified. Select the button below to permanently delete your account and cloud data.', false);
    } catch (error) {
      passwordHash = '';
      showMessage(requestError(error, 'Identity verification'), true);
    } finally {
      setBusy(verifyButton, false, 'Verify identity', 'Verifying…');
    }
  });

  formConfirm.addEventListener('submit', async function (event) {
    event.preventDefault();
    clearMessage();
    setBusy(deleteButton, true, 'Delete account and cloud data', 'Deleting…');
    try {
      var result = await post('/api/delete-account', { username: accountName, password_hash: passwordHash });
      if (!result || result.success !== true) throw new Error('The account deletion was not confirmed by the service. Please contact support before retrying.');
      passwordHash = '';
      accountName = '';
      formConfirm.hidden = true;
      document.querySelector('.account-delete-warning').hidden = true;
      success.hidden = false;
      showMessage('Your account has been permanently deleted.', false);
    } catch (error) {
      showMessage(requestError(error, 'Account deletion'), true);
    } finally {
      if (success.hidden) {
        setBusy(deleteButton, false, 'Delete account and cloud data', 'Deleting…');
      }
    }
  });
})();
