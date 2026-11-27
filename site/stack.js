// Homepage "Every layer, in the open" drawer: collapsed on load, one visible
// label, aria-expanded kept in sync with the panel's hidden state.
(function () {
  function init() {
    var btn = document.getElementById('mm-stack-toggle');
    var panel = document.getElementById('mm-stack-body');
    if (!btn || !panel) return;
    var label = btn.querySelector('.mm-stack-label');
    btn.addEventListener('click', function () {
      var open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      panel.hidden = !open;
      if (label) label.textContent = open ? 'Hide the stack' : 'Show the stack';
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
