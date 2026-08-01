/* The bot builder.

   Six steps, one state object, one render pass. Everything the user picks
   feeds the same computation: which tier their modules require, what that
   costs, and which Discord permissions the invite link needs to ask for. */
(function () {
  'use strict';

  var C = window.CATALOG;
  if (!C) return;

  var STEPS = ['Identity', 'Personality', 'Capabilities', 'Voice', 'Plan', 'Deploy'];
  var STORE_KEY = 'max-build-v1';

  var ACCENTS = [
    { id: 'blurple', from: '#5865f2', to: '#8b5cf6' },
    { id: 'tide', from: '#14b8a6', to: '#0ea5e9' },
    { id: 'ember', from: '#f59e0b', to: '#ef4444' },
    { id: 'bloom', from: '#f43f5e', to: '#a855f7' },
    { id: 'moss', from: '#22c55e', to: '#14b8a6' },
    { id: 'slate', from: '#64748b', to: '#1e293b' },
  ];

  var PRESETS = [
    {
      id: 'vibe',
      name: 'Vibe engineer',
      hint: 'Mellow, funny, technically sharp. The default.',
      prompt:
        "You're a laid-back vibe-coder who happens to run this server — moderator, " +
        'DJ of the conversation, and resident engineer. You talk like a person, not a ' +
        'helpdesk: short sentences, dry humour, no corporate padding. You are genuinely ' +
        'good at the technical stuff and you say so plainly when you know something, and ' +
        'just as plainly when you do not. You never open with "Great question!". You do ' +
        'not moralise, and you do not pile on. If someone is stuck, you get to the answer ' +
        'first and the context second.',
    },
    {
      id: 'straight',
      name: 'Straight shooter',
      hint: 'Terse and factual. No jokes, no filler.',
      prompt:
        'You are the server\'s operator. You answer in as few words as the question ' +
        'allows. No preamble, no summary of what was just asked, no sign-off. If an ' +
        'answer needs three sentences, use three. If it needs one word, use one word. ' +
        'You state uncertainty as a fact rather than hedging around it. You do not use ' +
        'emoji unless someone else does first.',
    },
    {
      id: 'host',
      name: 'Community host',
      hint: 'Warm and social. Pulls quiet people in.',
      prompt:
        'You are the host of this community. You are warm, curious, and genuinely ' +
        'interested in the people here — you remember what they are working on and ask ' +
        'about it. You welcome newcomers by name and connect them to whoever is already ' +
        'talking about the thing they care about. You keep the energy up without being ' +
        'exhausting, and you notice when someone has gone quiet. You are still the ' +
        'moderator, and you are firm when you need to be.',
    },
    {
      id: 'custom',
      name: 'Custom',
      hint: 'Write it yourself, from a blank page.',
      prompt: '',
    },
  ];

  var VOICES = [
    { id: 'ember', name: 'Ember', hint: 'Warm, mid-range, unhurried. Good default.' },
    { id: 'quartz', name: 'Quartz', hint: 'Bright and quick. Cuts through a busy channel.' },
    { id: 'basalt', name: 'Basalt', hint: 'Low and dry. Reads as calm under pressure.' },
    { id: 'clone', name: 'Your own clone', hint: 'Bring a fish.audio voice reference. $40 one-time.' },
  ];

  /* Discord permission bits the invite link asks for, per module. */
  var PERM = {
    VIEW_CHANNEL: 1n << 10n,
    SEND_MESSAGES: 1n << 11n,
    MANAGE_MESSAGES: 1n << 13n,
    EMBED_LINKS: 1n << 14n,
    ATTACH_FILES: 1n << 15n,
    READ_HISTORY: 1n << 16n,
    KICK: 1n << 1n,
    BAN: 1n << 2n,
    MANAGE_CHANNELS: 1n << 4n,
    MANAGE_ROLES: 1n << 28n,
    MODERATE_MEMBERS: 1n << 40n,
    CONNECT: 1n << 20n,
    SPEAK: 1n << 21n,
  };

  var MODULE_PERMS = {
    'mod-commands': ['KICK', 'BAN', 'MODERATE_MEMBERS', 'MANAGE_MESSAGES'],
    'roles-channels': ['MANAGE_CHANNELS', 'MANAGE_ROLES'],
    automod: ['MANAGE_MESSAGES'],
    welcome: ['MANAGE_ROLES'],
    'nl-admin': ['MANAGE_CHANNELS', 'MANAGE_ROLES', 'MANAGE_MESSAGES'],
    'voice-join': ['CONNECT', 'SPEAK'],
    transcription: ['CONNECT'],
    tts: ['CONNECT', 'SPEAK'],
  };

  /* ---------- catalog helpers ---------- */

  var ALL_CAPS = [];
  C.GROUPS.forEach(function (g) {
    g.caps.forEach(function (c) {
      ALL_CAPS.push(Object.assign({ group: g.id }, c));
    });
  });

  function capById(id) {
    return ALL_CAPS.filter(function (c) { return c.id === id; })[0];
  }

  var DEFAULT_MODULES = ALL_CAPS.filter(function (c) {
    return c.builder && c.tier === 'hobby';
  }).map(function (c) { return c.id; });

  /* ---------- state ---------- */

  var state = {
    step: 0,
    name: 'Max',
    tagline: 'Moderator, engineer, and the one who remembers.',
    accent: 'blurple',
    preset: 'vibe',
    persona: PRESETS[0].prompt,
    modules: DEFAULT_MODULES.slice(),
    wake: ['hey max', 'max, you around?'],
    voice: 'ember',
    window: 25,
    tier: 'hobby',
    annual: false,
  };

  try {
    var saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved && typeof saved === 'object') Object.assign(state, saved, { step: 0 });
  } catch (e) { /* a corrupt draft is not worth failing over */ }

  /* A tier can also be preselected from a pricing-page link. */
  var wanted = new URLSearchParams(location.search).get('tier');
  if (wanted && C.TIER_INDEX[wanted] !== undefined) state.tier = wanted;

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  /* ---------- derived ---------- */

  function requiredIndex() {
    return state.modules.reduce(function (max, id) {
      var cap = capById(id);
      return cap ? Math.max(max, C.TIER_INDEX[cap.tier]) : max;
    }, 0);
  }

  function activeIndex() {
    return Math.max(requiredIndex(), C.TIER_INDEX[state.tier] || 0);
  }

  function activeTier() {
    return C.TIERS[activeIndex()];
  }

  function monthly(tier) {
    if (!tier.price) return 0;
    return state.annual ? Math.round((tier.price * 10) / 12) : tier.price;
  }

  function accent() {
    return ACCENTS.filter(function (a) { return a.id === state.accent; })[0] || ACCENTS[0];
  }

  function hasVoice() {
    return state.modules.some(function (id) {
      var cap = capById(id);
      return cap && cap.group === 'voice';
    });
  }

  function permissionBits() {
    var bits =
      PERM.VIEW_CHANNEL |
      PERM.SEND_MESSAGES |
      PERM.EMBED_LINKS |
      PERM.ATTACH_FILES |
      PERM.READ_HISTORY;
    state.modules.forEach(function (id) {
      (MODULE_PERMS[id] || []).forEach(function (key) { bits |= PERM[key]; });
    });
    return bits;
  }

  /* A stable pretend snowflake, so the same bot name yields the same link. */
  function clientId() {
    var h = 2166136261;
    var seed = state.name + '|' + state.accent;
    for (var i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    var digits = String(h) + String((h * 7919) >>> 0);
    return (digits + '100000000000000000').slice(0, 18);
  }

  function inviteURL() {
    return (
      'https://discord.com/oauth2/authorize?client_id=' +
      clientId() +
      '&permissions=' +
      permissionBits().toString() +
      '&scope=bot%20applications.commands'
    );
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }

  /* ---------- DOM ---------- */

  var $ = function (sel) { return document.querySelector(sel); };
  var panes = Array.prototype.slice.call(document.querySelectorAll('.pane'));

  var TICK_SM =
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8.5l3.5 3.5 7.5-8"/></svg>';
  var TICK =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8.5l3.5 3.5 7.5-8"/></svg>';

  /* ---------- static renders (built once) ---------- */

  $('[data-swatches]').innerHTML = ACCENTS.map(function (a) {
    return (
      '<button class="swatch" data-accent="' + a.id + '" aria-label="' + a.id + '" ' +
      'style="background:linear-gradient(135deg,' + a.from + ',' + a.to + ')"></button>'
    );
  }).join('');

  $('[data-presets]').innerHTML = PRESETS.map(function (p) {
    return (
      '<button class="opt" data-preset="' + p.id + '">' +
      '<b>' + p.name + '</b><span>' + p.hint + '</span></button>'
    );
  }).join('');

  $('[data-voices]').innerHTML = VOICES.map(function (v) {
    return (
      '<button class="opt" data-voice="' + v.id + '">' +
      '<b>' + v.name + '</b><span>' + v.hint + '</span></button>'
    );
  }).join('');

  $('[data-progress]').innerHTML = STEPS.map(function (label, i) {
    return (
      '<div class="progress__step" data-goto="' + i + '">' +
      '<span class="progress__num">' + (i + 1) + '</span>' +
      '<span class="progress__label">' + label + '</span>' +
      '</div>' +
      (i < STEPS.length - 1 ? '<span class="progress__bar"></span>' : '')
    );
  }).join('');

  /* Modules: builder capabilities become toggles, the rest are listed as
     automatically included so the group still reads as complete. */
  $('[data-modules]').innerHTML = C.GROUPS.map(function (g) {
    var toggles = g.caps.filter(function (c) { return c.builder; });
    var included = g.caps.filter(function (c) { return !c.builder; });
    if (!toggles.length && !included.length) return '';

    return (
      '<div class="modgroup">' +
      '<div class="modgroup__head"><span class="ico">' + g.icon + '</span>' +
      '<h3>' + g.name + '</h3>' +
      '<span class="req">' + g.summary + '</span></div>' +
      '<div class="mods">' +
      toggles.map(function (c) {
        return (
          '<div class="mod" data-module="' + c.id + '" role="checkbox" tabindex="0">' +
          '<span class="mod__box">' + TICK_SM + '</span>' +
          '<span class="mod__text">' +
          '<span class="mod__name">' + c.name +
          '<span class="lock" data-lock="' + c.id + '">' + c.tier + '</span></span>' +
          '<span class="mod__detail">' + c.detail + '</span>' +
          '</span></div>'
        );
      }).join('') +
      '</div>' +
      (included.length
        ? '<div class="rail__mods" style="margin-top:10px">' +
          included.map(function (c) {
            return '<span class="chip chip--muted" title="' + esc(c.detail) + '">' +
              c.name + ' · included from ' + c.tier + '</span>';
          }).join('') +
          '</div>'
        : '') +
      '</div>'
    );
  }).join('');

  /* ---------- live render ---------- */

  function render() {
    var tier = activeTier();
    var reqIdx = requiredIndex();
    var a = accent();
    var grad = 'linear-gradient(135deg,' + a.from + ',' + a.to + ')';

    /* panes + progress */
    panes.forEach(function (p, i) { p.classList.toggle('is-on', i === state.step); });
    document.querySelectorAll('.progress__step').forEach(function (s, i) {
      s.classList.toggle('is-on', i === state.step);
      s.classList.toggle('is-done', i < state.step);
    });

    /* step 1 */
    $('#botname').value = state.name;
    $('#tagline').value = state.tagline;
    document.querySelectorAll('[data-accent]').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.accent === state.accent);
    });

    /* step 2 */
    document.querySelectorAll('[data-preset]').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.preset === state.preset);
    });
    if ($('#persona').value !== state.persona) $('#persona').value = state.persona;

    /* step 3 */
    document.querySelectorAll('[data-module]').forEach(function (el) {
      var id = el.dataset.module;
      var cap = capById(id);
      var on = state.modules.indexOf(id) !== -1;
      el.classList.toggle('is-on', on);
      el.setAttribute('aria-checked', String(on));

      var lock = el.querySelector('[data-lock]');
      var need = C.TIER_INDEX[cap.tier];
      if (need <= reqIdx) {
        lock.className = 'lock lock--in';
        lock.textContent = need === 0 ? 'all tiers' : 'in ' + C.TIERS[need].name;
      } else {
        lock.className = 'lock';
        lock.textContent = 'needs ' + C.TIERS[need].name;
      }
    });

    /* step 4 */
    var voiceOn = hasVoice();
    $('[data-voice-on]').style.display = voiceOn ? '' : 'none';
    $('[data-voice-off]').innerHTML = voiceOn
      ? ''
      : '<div class="notice">' +
        '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="flex-shrink:0;margin-top:2px"><path d="M12 3v10M12 13a3.5 3.5 0 003.5-3.5v-3a3.5 3.5 0 10-7 0v3A3.5 3.5 0 0012 13zM5 11a7 7 0 0014 0M12 18v3"/></svg>' +
        '<span>No voice modules are switched on, so there is nothing to configure here. ' +
        '<b>Voice</b> starts at $' + C.TIERS[C.TIER_INDEX.voice].price + ' / month. ' +
        '<button class="btn btn--sm btn--ghost" data-add-voice style="margin-left:8px">Turn voice on</button></span></div>';

    $('[data-phrases]').innerHTML = state.wake.map(function (p, i) {
      return (
        '<span class="phrase">' + esc(p) +
        '<button data-drop-phrase="' + i + '" aria-label="Remove">×</button></span>'
      );
    }).join('');

    document.querySelectorAll('[data-voice]').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.voice === state.voice);
    });
    $('#window').value = state.window;
    $('[data-window-val]').textContent =
      state.window === 0 ? 'off' : state.window + ' seconds';

    /* step 5 */
    $('[data-plan]').innerHTML = C.TIERS.map(function (t, i) {
      var locked = i < reqIdx;
      var missing = state.modules.filter(function (id) {
        return C.TIER_INDEX[capById(id).tier] > i;
      }).length;
      var isOn = i === activeIndex();

      return (
        '<article class="tier' + (isOn ? ' tier--popular' : '') + '" ' +
        'data-pick-tier="' + t.id + '" style="cursor:' + (locked ? 'not-allowed' : 'pointer') +
        ';opacity:' + (locked ? '.45' : '1') + '">' +
        (isOn ? '<span class="tier__flag">Your tier</span>' : '') +
        '<div class="tier__name">' + t.name + '</div>' +
        '<div class="tier__tagline">' + t.tagline + '</div>' +
        '<div class="tier__price"><span class="cur">$</span>' +
        '<span class="amt">' + monthly(t) + '</span>' +
        (t.price ? '<span class="per">/ mo</span>' : '') + '</div>' +
        '<div class="tier__note">' +
        (locked
          ? missing + ' of your modules need more'
          : state.annual && t.price
          ? 'billed $' + t.price * 10 + ' / year'
          : t.priceNote) +
        '</div>' +
        '<ul class="tier__limits">' +
        ['servers', 'messages', 'voice', 'models'].map(function (k) {
          return '<li>' + TICK + '<span>' + t.limits[k] + '</span></li>';
        }).join('') +
        '</ul>' +
        '<span class="btn ' + (isOn ? 'btn--primary' : 'btn--ghost') + ' btn--block">' +
        (locked ? 'Not enough' : isOn ? 'Selected' : 'Select ' + t.name) +
        '</span></article>'
      );
    }).join('');

    /* step 6 */
    $('[data-deploy-title]').textContent = state.name + ' is ready.';
    $('[data-invite]').value = inviteURL();
    $('[data-summary]').innerHTML = summaryHTML(tier, grad);

    /* rail */
    var rail = $('[data-rail-avatar]');
    rail.style.background = grad;
    rail.textContent = (state.name.trim()[0] || 'M').toUpperCase();
    $('[data-rail-name]').textContent = state.name || 'Untitled bot';
    $('[data-rail-tagline]').textContent = state.tagline || '—';
    $('[data-rail-tier]').textContent = tier.name;
    $('[data-rail-count]').textContent = state.modules.length;
    $('[data-rail-servers]').textContent = tier.limits.servers;
    $('[data-rail-messages]').textContent = tier.limits.messages;
    $('[data-rail-voice]').textContent = tier.limits.voice;
    $('[data-rail-price]').textContent =
      '$' + monthly(tier) + (state.annual && tier.price ? '*' : '');

    $('[data-rail-chips]').innerHTML = state.modules.length
      ? state.modules
          .map(function (id) {
            var cap = capById(id);
            return cap ? '<span class="chip">' + cap.name + '</span>' : '';
          })
          .join('')
      : '<span class="chip chip--muted">No modules — he will just sit there</span>';

    save();
  }

  function summaryHTML(tier, grad) {
    var voiceOn = hasVoice();
    var byGroup = C.GROUPS.map(function (g) {
      var mine = state.modules.filter(function (id) {
        var cap = capById(id);
        return cap && cap.group === g.id;
      });
      if (!mine.length) return '';
      return (
        '<div class="v"><b>' + g.icon + ' ' + g.name + '</b> — ' +
        mine.map(function (id) { return capById(id).name; }).join(', ') +
        '</div>'
      );
    }).join('');

    return (
      '<div class="summary__card"><h4>Identity</h4>' +
      '<div class="v" style="display:flex;align-items:center;gap:10px">' +
      '<span style="width:30px;height:30px;border-radius:10px;background:' + grad +
      ';display:grid;place-items:center;font-weight:700;color:#fff">' +
      esc((state.name.trim()[0] || 'M').toUpperCase()) + '</span>' +
      esc(state.name) + '</div>' +
      '<div class="v" style="color:var(--muted);font-size:.83rem">' + esc(state.tagline) + '</div>' +
      '</div>' +

      '<div class="summary__card"><h4>Subscription</h4>' +
      '<div class="v"><b>' + tier.name + '</b> — $' + monthly(tier) + ' / month' +
      (state.annual ? ', billed annually' : '') + '</div>' +
      '<div class="v" style="color:var(--muted);font-size:.83rem">' +
      tier.limits.servers + ' · ' + tier.limits.messages + ' · ' + tier.limits.voice +
      '</div></div>' +

      '<div class="summary__card" style="grid-column:1/-1"><h4>Modules · ' +
      state.modules.length + '</h4>' + (byGroup || '<div class="v">None selected.</div>') +
      '</div>' +

      '<div class="summary__card"><h4>Voice</h4>' +
      (voiceOn
        ? /* Bracketed, the way the dashboard stores them — so a phrase can
             itself contain a comma without splitting in two. */
          '<div class="v">Wake: <code style="background:rgba(255,255,255,.07);padding:1px 5px;border-radius:4px;font-size:.86em">' +
          (state.wake.length
            ? esc(state.wake.map(function (p) { return '[' + p + ']'; }).join(' '))
            : 'none set') +
          '</code></div>' +
          '<div class="v" style="color:var(--muted);font-size:.83rem">Voice ' +
          VOICES.filter(function (v) { return v.id === state.voice; })[0].name +
          ' · follow-up ' + (state.window === 0 ? 'off' : state.window + 's') + '</div>'
        : '<div class="v" style="color:var(--muted)">Not enabled.</div>') +
      '</div>' +

      '<div class="summary__card"><h4>Invite scope</h4>' +
      '<div class="v" style="color:var(--muted);font-size:.83rem">' +
      'Permissions bitfield <code style="background:rgba(255,255,255,.07);padding:1px 5px;border-radius:4px">' +
      permissionBits().toString() + '</code>, derived from your modules — ' +
      'no Administrator, nothing you did not switch on.</div></div>'
    );
  }

  /* ---------- events ---------- */

  function go(step) {
    state.step = Math.max(0, Math.min(STEPS.length - 1, step));
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  document.addEventListener('click', function (e) {
    var t = e.target;

    var next = t.closest('[data-next]');
    if (next) return go(state.step + 1);

    var prev = t.closest('[data-prev]');
    if (prev) return go(state.step - 1);

    var jump = t.closest('[data-goto]');
    if (jump) return go(parseInt(jump.dataset.goto, 10));

    var sw = t.closest('[data-accent]');
    if (sw) { state.accent = sw.dataset.accent; return render(); }

    var pre = t.closest('[data-preset]');
    if (pre) {
      state.preset = pre.dataset.preset;
      var found = PRESETS.filter(function (p) { return p.id === state.preset; })[0];
      state.persona = found.prompt;
      return render();
    }

    var mod = t.closest('[data-module]');
    if (mod) {
      var id = mod.dataset.module;
      var at = state.modules.indexOf(id);
      if (at === -1) state.modules.push(id);
      else state.modules.splice(at, 1);
      /* Dropping modules can free you to pick a cheaper tier; never strand
         the selection above what is now required. */
      if (C.TIER_INDEX[state.tier] > requiredIndex() && at !== -1) {
        state.tier = C.TIERS[requiredIndex()].id;
      }
      return render();
    }

    var vo = t.closest('[data-voice]');
    if (vo) { state.voice = vo.dataset.voice; return render(); }

    var addVoice = t.closest('[data-add-voice]');
    if (addVoice) {
      ['voice-join', 'transcription', 'wake', 'followup', 'tts'].forEach(function (m) {
        if (state.modules.indexOf(m) === -1) state.modules.push(m);
      });
      return render();
    }

    var drop = t.closest('[data-drop-phrase]');
    if (drop) {
      state.wake.splice(parseInt(drop.dataset.dropPhrase, 10), 1);
      return render();
    }

    var pick = t.closest('[data-pick-tier]');
    if (pick) {
      var wantIdx = C.TIER_INDEX[pick.dataset.pickTier];
      if (wantIdx < requiredIndex()) return;
      state.tier = pick.dataset.pickTier;
      return render();
    }

    var cycle = t.closest('[data-billing-b] button[data-cycle]');
    if (cycle) {
      state.annual = cycle.dataset.cycle === 'annual';
      document.querySelectorAll('[data-billing-b] button').forEach(function (b) {
        b.classList.toggle('is-on', b === cycle);
      });
      return render();
    }

    var copy = t.closest('[data-copy]');
    if (copy) {
      var field = $('[data-invite]');
      field.select();
      var done = function () {
        copy.textContent = 'Copied';
        setTimeout(function () { copy.textContent = 'Copy invite link'; }, 1800);
      };
      if (navigator.clipboard) {
        navigator.clipboard.writeText(field.value).then(done, done);
      } else {
        try { document.execCommand('copy'); } catch (err) {}
        done();
      }
      return;
    }

    var reset = t.closest('[data-reset]');
    if (reset) {
      try { localStorage.removeItem(STORE_KEY); } catch (err) {}
      location.href = 'build.html';
    }
  });

  /* Keyboard support for the module rows, which are divs playing checkbox. */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var mod = e.target.closest && e.target.closest('[data-module]');
    if (!mod) return;
    e.preventDefault();
    mod.click();
  });

  $('#botname').addEventListener('input', function (e) {
    state.name = e.target.value;
    render();
  });
  $('#tagline').addEventListener('input', function (e) {
    state.tagline = e.target.value;
    render();
  });
  $('#persona').addEventListener('input', function (e) {
    state.persona = e.target.value;
    var match = PRESETS.filter(function (p) { return p.prompt === state.persona; })[0];
    state.preset = match ? match.id : 'custom';
    render();
  });
  $('#window').addEventListener('input', function (e) {
    state.window = parseInt(e.target.value, 10);
    $('[data-window-val]').textContent =
      state.window === 0 ? 'off' : state.window + ' seconds';
  });
  $('#window').addEventListener('change', render);

  $('#wake').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var val = e.target.value.trim().toLowerCase().replace(/\s+/g, ' ');
    if (val && state.wake.indexOf(val) === -1) state.wake.push(val);
    e.target.value = '';
    render();
  });

  render();
})();
