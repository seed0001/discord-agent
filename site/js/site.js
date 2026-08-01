/* Shared site behaviour: nav, scroll reveals, FAQ rendering, hero motion. */
(function () {
  'use strict';

  /* ---------- nav ---------- */

  var nav = document.querySelector('.nav');
  if (nav) {
    var onScroll = function () {
      nav.classList.toggle('is-stuck', window.scrollY > 8);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  var burger = document.querySelector('.nav__burger');
  var links = document.querySelector('.nav__links');
  if (burger && links) {
    burger.addEventListener('click', function () {
      var open = links.classList.toggle('is-open');
      burger.setAttribute('aria-expanded', String(open));
    });
    links.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') {
        links.classList.remove('is-open');
        burger.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* Mark the current page in the nav. */
  var here = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav__links a').forEach(function (a) {
    var href = a.getAttribute('href') || '';
    if (href === here || (here === 'index.html' && href === './')) {
      a.classList.add('is-active');
    }
  });

  /* ---------- scroll reveal ---------- */

  var reveals = document.querySelectorAll('.reveal');
  if (reveals.length && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var el = entry.target;
          var delay = parseInt(el.dataset.delay || '0', 10);
          setTimeout(function () {
            el.classList.add('is-in');
          }, delay);
          io.unobserve(el);
        });
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.08 }
    );
    reveals.forEach(function (el) {
      io.observe(el);
    });
  } else {
    reveals.forEach(function (el) {
      el.classList.add('is-in');
    });
  }

  /* ---------- hero: stagger the mock conversation ---------- */

  document.querySelectorAll('.mock .msg').forEach(function (msg, i) {
    msg.style.animationDelay = 0.35 + i * 0.45 + 's';
  });

  /* ---------- hero: fill the pressure gauge once it is on screen ---------- */

  var gauge = document.querySelector('.gauge');
  if (gauge) {
    var fill = function () {
      gauge.querySelectorAll('.gauge__fill').forEach(function (bar) {
        bar.style.width = bar.dataset.pct + '%';
      });
    };
    if ('IntersectionObserver' in window) {
      var gio = new IntersectionObserver(
        function (entries) {
          if (entries[0].isIntersecting) {
            setTimeout(fill, 1600);
            gio.disconnect();
          }
        },
        { threshold: 0.1 }
      );
      gio.observe(gauge);
    } else {
      fill();
    }
  }

  /* ---------- FAQ ---------- */

  var faqHost = document.querySelector('[data-faq]');
  if (faqHost && window.CATALOG) {
    faqHost.innerHTML = window.CATALOG.FAQ.map(function (item) {
      return (
        '<details><summary>' +
        item.q +
        '</summary><p>' +
        item.a +
        '</p></details>'
      );
    }).join('');
  }

  /* ---------- footer year ---------- */

  document.querySelectorAll('[data-year]').forEach(function (el) {
    el.textContent = new Date().getFullYear();
  });
})();
