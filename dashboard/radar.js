'use strict';
/* Token Launch Radar: renders window.RADAR (zdata.js) as a sortable, filterable board with a
   detail panel per protocol. Row fields by index: 0 slug, 1 name, 2 category index, 3 TVL,
   4 change_7d, 5 listed_at, 6 years tokenless, 7 growth factor, 8 years factor, 9 implied value,
   10 watchlist flag, 11 chains (up to 3), 12 chain count, 13 farm-step indexes. */
var R = window.RADAR;
var cats = R.cats, stepTable = R.steps;
var all = R.rows.map(function (r, i) { return { r: r, rank: i + 1 }; });
var bySlug = {};
all.forEach(function (w) { bySlug[w.r[0]] = w; });

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function commas(n) {
  var s = String(Math.round(n)), out = '';
  for (var i = 0; i < s.length; i++) { if (i > 0 && (s.length - i) % 3 === 0) out += ','; out += s[i]; }
  return out;
}
function big(n) {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2).replace(/0$/, '') + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  return '$' + commas(n);
}
function full(n) { return '$' + commas(n); }
function pct(x) { return x === null ? '&mdash;' : '<span class="' + (x >= 0 ? 'pos' : 'neg') + '">' + (x > 0 ? '+' : '') + x.toFixed(1) + '%</span>'; }
function yrs(x) { return x === null ? '&mdash;' : x.toFixed(1); }
function mult(x) { return x.toFixed(2) + '&times;'; }
function catName(ci) { var n = cats[ci][0]; return n === null ? 'Uncategorised' : n; }

var state = { k: 'rank', dir: 1 };
var KEYF = {
  rank: function (w) { return w.rank; },
  name: function (w) { return w.r[1].toLowerCase(); },
  cat: function (w) { return catName(w.r[2]); },
  tvl: function (w) { return w.r[3]; },
  chg: function (w) { return w.r[4] === null ? -1e9 : w.r[4]; },
  years: function (w) { return w.r[6] === null ? -1 : w.r[6]; },
  mult: function (w) { return cats[w.r[2]][3]; },
  val: function (w) { return w.r[9]; }
};

function visible() {
  var q = $('q').value.trim().toLowerCase();
  var cat = $('fcat').value, chain = $('fchain').value;
  var minTvl = Number($('ftvl').value), wlOnly = $('fwl').checked;
  return all.filter(function (w) {
    var r = w.r;
    if (q && r[1].toLowerCase().indexOf(q) < 0 && r[0].indexOf(q) < 0) return false;
    if (cat !== '' && r[2] !== Number(cat)) return false;
    if (chain !== '' && r[11].indexOf(chain) < 0) return false;
    if (r[3] < minTvl) return false;
    if (wlOnly && r[10] !== 1) return false;
    return true;
  });
}

function render() {
  var list = visible();
  var f = KEYF[state.k];
  list.sort(function (a, b) {
    var x = f(a), y = f(b);
    var c = (typeof x === 'string') ? (x < y ? -1 : x > y ? 1 : 0) : x - y;
    if (c === 0) c = a.rank - b.rank;
    return c * state.dir;
  });
  var html = '';
  list.forEach(function (w) {
    var r = w.r;
    html += '<tr data-slug="' + esc(r[0]) + '"' + (openSlug === r[0] ? ' class="open"' : '') + '>' +
      '<td class="rk">' + w.rank + '</td>' +
      '<td class="nm">' + esc(r[1]) + (r[10] === 1 ? '<span class="badge">WATCHLIST</span>' : '') + '<span class="slug">' + esc(r[0]) + '</span></td>' +
      '<td class="cat">' + esc(catName(r[2])) + '</td>' +
      '<td class="num">' + big(r[3]) + '</td>' +
      '<td class="num">' + pct(r[4]) + '</td>' +
      '<td class="num">' + yrs(r[6]) + '</td>' +
      '<td class="num">' + mult(cats[r[2]][3]) + '</td>' +
      '<td class="num">' + big(r[9]) + '</td></tr>';
  });
  $('rows').innerHTML = html || '<tr><td colspan="8">No protocol matches the current filters.</td></tr>';
  $('count').textContent = list.length + ' of ' + all.length + ' protocols';
  var ths = document.querySelectorAll('th[data-k]');
  for (var i = 0; i < ths.length; i++) ths[i].classList.toggle('sorted', ths[i].getAttribute('data-k') === state.k);
}

var openSlug = null;
function openDetail(slug) {
  var w = bySlug[slug];
  if (!w) return;
  openSlug = slug;
  var r = w.r, c = cats[r[2]];
  var chains = r[11].join(', ') + (r[12] > r[11].length ? ' +' + (r[12] - r[11].length) + ' more' : '');
  var basis = c[1] > 0
    ? 'Peer basis: ' + c[1] + ' tokened ' + esc(catName(r[2])) + ' protocols carry a market cap; their median market-cap/TVL multiple is ' + mult(c[2]) + ' and the model applies ' + mult(c[3]) + ' after the 0.10&ndash;10&times; clamp.'
    : 'Peer basis: no tokened protocol in this category carries a market cap, so the model applies the snapshot-wide fallback multiple of ' + mult(R.stats.fallback_multiple) + '.';
  var steps = r[13].map(function (ix) { return '<li>' + esc(stepTable[ix]) + '</li>'; }).join('');
  $('detail').innerHTML =
    '<button class="x" id="xclose" aria-label="Close">&times;</button>' +
    '<h2>#' + w.rank + ' ' + esc(r[1]) + (r[10] === 1 ? '<span class="badge">WATCHLIST</span>' : '') + '</h2>' +
    '<p class="sub">' + esc(r[0]) + ' &middot; ' + esc(catName(r[2])) + ' &middot; ' + esc(chains) + '</p>' +
    '<div class="grid">' +
    '<div><span>TVL</span><b>' + full(r[3]) + '</b></div>' +
    '<div><span>TVL change, 7d</span><b>' + (r[4] === null ? 'not reported' : (r[4] > 0 ? '+' : '') + r[4].toFixed(1) + '%') + '</b></div>' +
    '<div><span>Listed since</span><b>' + (r[5] === null ? 'not recorded' : r[5]) + '</b></div>' +
    '<div><span>Years tokenless</span><b>' + (r[6] === null ? 'unknown' : r[6].toFixed(2)) + '</b></div>' +
    '<div><span>Market cap</span><b>records no token</b></div>' +
    '<div><span>Implied value</span><b>' + full(r[9]) + '</b></div>' +
    '</div>' +
    '<p class="formula">' + full(r[3]) + ' &times; ' + c[3].toFixed(3) + ' (multiple) &times; ' + r[7].toFixed(3) + ' (growth) &times; ' + r[8].toFixed(3) + ' (years) = ' + full(r[9]) + '</p>' +
    '<p class="basis">' + basis + '</p>' +
    '<h3>Farm plan</h3><ol>' + steps + '</ol>';
  $('detail').hidden = false;
  if (window.history && history.replaceState) history.replaceState(null, '', '#' + slug);
  render();
}
function closeDetail() {
  openSlug = null;
  $('detail').hidden = true;
  if (window.history && history.replaceState) history.replaceState(null, '', ' ');
  render();
}

function init() {
  $('stats').textContent = R.stats.tracked + ' pre-token protocols tracked · ' + R.stats.watchlist +
    ' on the watchlist · median peer multiple ' + R.stats.median_multiple.toFixed(2) + '× · snapshot ' + R.as_of;
  $('asof').textContent = R.as_of;
  $('peers').textContent = R.stats.peers + ' tokened protocols carry a usable market-cap/TVL multiple and form the peer basis';
  var fc = $('fcat');
  cats.forEach(function (c, i) {
    var o = document.createElement('option');
    o.value = String(i); o.textContent = catName(i);
    fc.appendChild(o);
  });
  var chainSet = {};
  all.forEach(function (w) { w.r[11].forEach(function (ch) { chainSet[ch] = 1; }); });
  var fch = $('fchain');
  Object.keys(chainSet).sort().forEach(function (ch) {
    var o = document.createElement('option');
    o.value = ch; o.textContent = ch;
    fch.appendChild(o);
  });
  ['q', 'fcat', 'fchain', 'ftvl', 'fwl'].forEach(function (id) {
    $(id).addEventListener('input', render);
    $(id).addEventListener('change', render);
  });
  document.querySelector('thead').addEventListener('click', function (ev) {
    var th = ev.target.closest('th[data-k]');
    if (!th) return;
    var k = th.getAttribute('data-k');
    if (state.k === k) state.dir = -state.dir;
    else { state.k = k; state.dir = (k === 'name' || k === 'cat') ? 1 : -1; }
    render();
  });
  $('rows').addEventListener('click', function (ev) {
    var tr = ev.target.closest('tr[data-slug]');
    if (tr) openDetail(tr.getAttribute('data-slug'));
  });
  $('detail').addEventListener('click', function (ev) {
    if (ev.target.id === 'xclose') closeDetail();
  });
  render();
  var h = window.location.hash.replace('#', '');
  if (h && bySlug[h]) openDetail(h);
}
init();
