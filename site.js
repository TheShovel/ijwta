/* Khuwari website helpers: docs search (the hub searches every category
 * through the shared index and links to the subpages). */
(function () {
  'use strict';

  // Home page: inject the feature figures into their containers, then reveal
  // each feature row as it scrolls into view.
  var shots = document.querySelectorAll('.feat-shot');
  if (shots.length) {
    var figs = window.HOME_FIGS || {};
    shots.forEach(function (shot) {
      var key = shot.getAttribute('data-fig');
      if (figs[key]) shot.innerHTML = figs[key];
    });
  }
  var rows = Array.prototype.slice.call(document.querySelectorAll('.feat-row'));
  if (rows.length) {
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) entry.target.classList.add('in');
        });
      }, { threshold: 0.45 });
      rows.forEach(function (r) { io.observe(r); });
    } else {
      rows.forEach(function (r) { r.classList.add('in'); });
    }
  }

  // Docs hub search: filter the shared index (docs-data.js) and render results
  // as cards that link into the category subpages.
  var input = document.getElementById('docSearch');
  if (!input) return;

  var index = window.KHUWARI_DOCS || [];
  var results = document.getElementById('searchResults');
  var grid = document.getElementById('catGrid');
  var count = document.getElementById('searchCount');
  var empty = document.getElementById('searchEmpty');

  function render(q) {
    var hits = [];
    if (q) {
      index.forEach(function (item) {
        var hay = (item.title + ' ' + item.text + ' ' + item.cat).toLowerCase();
        if (hay.indexOf(q) !== -1) hits.push(item);
      });
    }

    if (!q) {
      // Nothing typed: show the category grid, hide the results.
      results.classList.add('hidden');
      if (grid) grid.classList.remove('hidden');
      if (empty) empty.classList.add('hidden');
      if (count) count.textContent = '';
      return;
    }

    if (grid) grid.classList.add('hidden');
    if (empty) empty.classList.toggle('hidden', hits.length !== 0);
    if (count) count.textContent = q ? (hits.length + ' of ' + index.length + ' topics') : '';

    results.classList.toggle('hidden', hits.length === 0);
    results.innerHTML = hits.map(function (item) {
      return '<a class="search-hit" href="' + item.url + '#' + item.id + '">' +
        '<span class="search-hit-cat">' + item.cat + '</span>' +
        '<span class="search-hit-title">' + item.title + '</span>' +
        '<span class="search-hit-text">' + item.text + '</span>' +
        '</a>';
    }).join('');
  }

  input.addEventListener('input', function () { render(input.value.trim().toLowerCase()); });

  // "/" focuses the search from anywhere, Escape clears it
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== input) {
      e.preventDefault();
      input.focus();
      input.select();
    } else if (e.key === 'Escape' && document.activeElement === input) {
      input.value = '';
      render('');
      input.blur();
    }
  });
})();
