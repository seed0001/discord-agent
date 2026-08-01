/* Renders everything driven by the catalog: tier cards, the billing toggle,
   the full capability matrix, and add-ons. Shared by index.html and
   pricing.html — whichever hooks are present on the page get filled. */
(function () {
  'use strict';

  var C = window.CATALOG;
  if (!C) return;

  var TICK =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8.5l3.5 3.5 7.5-8"/></svg>';
  var DASH =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 8h8"/></svg>';

  var annual = false;

  /* Annual billing bills 10 months for 12 — two months free. */
  function monthly(tier) {
    if (!tier.price) return 0;
    return annual ? Math.round((tier.price * 10) / 12) : tier.price;
  }

  function tierCard(tier) {
    var price = monthly(tier);
    var note = tier.price
      ? annual
        ? 'billed $' + tier.price * 10 + ' / year, per server'
        : tier.priceNote
      : tier.priceNote;

    var limits = ['servers', 'messages', 'voice', 'models']
      .map(function (k) {
        return '<li>' + TICK + '<span>' + tier.limits[k] + '</span></li>';
      })
      .join('');

    return (
      '<article class="tier' +
      (tier.popular ? ' tier--popular' : '') +
      '">' +
      (tier.popular ? '<span class="tier__flag">Most chosen</span>' : '') +
      '<div class="tier__name">' + tier.name + '</div>' +
      '<div class="tier__tagline">' + tier.tagline + '</div>' +
      '<div class="tier__price">' +
      '<span class="cur">$</span><span class="amt">' + price + '</span>' +
      (tier.price ? '<span class="per">/ mo</span>' : '') +
      '</div>' +
      '<div class="tier__note">' + note + '</div>' +
      '<p class="tier__blurb">' + tier.blurb + '</p>' +
      '<ul class="tier__limits">' + limits + '</ul>' +
      '<a class="btn ' +
      (tier.popular ? 'btn--primary' : 'btn--ghost') +
      ' btn--block" href="build.html?tier=' + tier.id + '">' +
      tier.cta +
      '</a>' +
      '</article>'
    );
  }

  function renderTiers() {
    var hosts = document.querySelectorAll('[data-tiers], [data-tiers-preview]');
    if (!hosts.length) return;
    var html = C.TIERS.map(tierCard).join('');
    hosts.forEach(function (host) {
      host.innerHTML = html;
    });
  }

  /* ---------- billing toggle ---------- */

  var toggle = document.querySelector('[data-billing]');
  if (toggle) {
    toggle.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-cycle]');
      if (!btn) return;
      annual = btn.dataset.cycle === 'annual';
      toggle.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('is-on', b === btn);
      });
      renderTiers();
    });
  }

  /* ---------- capability matrix ---------- */

  function matrixRows() {
    var rows = '';

    /* Plan limits first — the numbers people compare before features. */
    var limitRows = [
      ['Servers included', 'servers'],
      ['AI replies', 'messages'],
      ['Voice hours', 'voice'],
      ['Models', 'models'],
    ];
    rows +=
      '<tr class="group"><td colspan="' + (C.TIERS.length + 1) + '">Plan limits</td></tr>';
    limitRows.forEach(function (pair) {
      rows +=
        '<tr><td>' +
        pair[0] +
        '</td>' +
        C.TIERS.map(function (t) {
          return '<td><span class="cell-txt">' + t.limits[pair[1]] + '</span></td>';
        }).join('') +
        '</tr>';
    });

    C.GROUPS.forEach(function (group) {
      rows +=
        '<tr class="group"><td colspan="' +
        (C.TIERS.length + 1) +
        '">' +
        group.icon +
        '&nbsp;&nbsp;' +
        group.name +
        '</td></tr>';

      group.caps.forEach(function (cap) {
        var min = C.TIER_INDEX[cap.tier];
        rows +=
          '<tr><td>' +
          cap.name +
          '<small>' +
          cap.detail +
          '</small></td>' +
          C.TIERS.map(function (t, i) {
            return (
              '<td>' +
              (i >= min
                ? '<span class="yes">' + TICK + '</span>'
                : '<span class="no">' + DASH + '</span>') +
              '</td>'
            );
          }).join('') +
          '</tr>';
      });
    });

    return rows;
  }

  var matrixHost = document.querySelector('[data-matrix]');
  if (matrixHost) {
    matrixHost.innerHTML =
      '<thead><tr><th>Capability</th>' +
      C.TIERS.map(function (t) {
        return (
          '<th' +
          (t.popular ? ' class="is-popular"' : '') +
          '>' +
          t.name +
          '<small>' +
          (t.price ? '$' + t.price + ' / mo' : 'Free') +
          '</small></th>'
        );
      }).join('') +
      '</tr></thead><tbody>' +
      matrixRows() +
      '</tbody>';
  }

  /* ---------- add-ons ---------- */

  var addonHost = document.querySelector('[data-addons]');
  if (addonHost) {
    addonHost.innerHTML = C.ADDONS.map(function (a) {
      return (
        '<div class="addon">' +
        '<div class="addon__price">' + a.price + '</div>' +
        '<div class="addon__unit">' + a.unit + '</div>' +
        '<h4>' + a.name + '</h4>' +
        '<p>' + a.detail + '</p>' +
        '</div>'
      );
    }).join('');
  }

  renderTiers();
})();
