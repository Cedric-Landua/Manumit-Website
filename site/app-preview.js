(function () {
  var buttons = document.querySelectorAll('.mm-preview-view');
  var panels = document.querySelectorAll('.mm-preview-panel');
  var label = document.getElementById('mm-preview-view-label');
  if (!buttons.length || !panels.length || !label) return;

  var viewLabels = { day: 'Day view', week: 'Week view', month: 'Month view' };
  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      var view = button.getAttribute('data-preview-view');
      buttons.forEach(function (item) {
        var active = item === button;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      panels.forEach(function (panel) {
        panel.hidden = panel.getAttribute('data-preview-panel') !== view;
      });
      label.textContent = viewLabels[view];
    });
  });
})();
