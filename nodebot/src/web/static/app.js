/* Discord Agent dashboard */
"use strict";

const state = {
  guilds: [],
  guildId: null,
  tab: "overview",
  memberSearch: "",
  memberOffset: 0,
  roles: [],
  channels: [],
};

const $ = (sel) => document.querySelector(sel);
const content = () => $("#content");

/* What the bot is called right now: the per-server override if one is set,
   otherwise the Discord application's own name. Never hardcode it — the bot
   gets renamed and every hardcoded label goes stale silently. */
const botLabel = (settings) =>
  (settings && settings.bot_name_effective) || (state.me && state.me.name) || "the bot";

/* ---------- API ---------- */

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error("Not logged in");
  }
  if (!res.ok) {
    let detail = "Request failed";
    try { detail = (await res.json()).detail || detail; } catch {}
    toast(detail, true);
    throw new Error(detail);
  }
  return res.json();
}

/* ---------- helpers ---------- */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Phrase lists display as [one] [per] [bracket]. Parsing the way back is the
// server's job (src/phrases.js) — this direction is trivial and needs no
// second implementation.
function brackets(list) {
  return (Array.isArray(list) ? list : []).map((p) => `[${p}]`).join(" ");
}

function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error-toast", isError);
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), 3000);
}

function timeAgo(ts) {
  if (!ts) return "?";
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function openModal(html) {
  $("#modal").innerHTML = html;
  $("#modal-backdrop").classList.remove("hidden");
}
function closeModal() {
  $("#modal-backdrop").classList.add("hidden");
}
$("#modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "modal-backdrop") closeModal();
});

function confirmAction(text, onYes) {
  openModal(`
    <h2>Are you sure?</h2>
    <p class="muted">${esc(text)}</p>
    <div class="btn-row">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn danger" id="confirm-yes">Confirm</button>
    </div>`);
  $("#confirm-yes").onclick = async () => { closeModal(); await onYes(); };
}

/* ---------- login ---------- */

async function showLogin() {
  $("#app").classList.add("hidden");
  $("#login-screen").classList.remove("hidden");
  // Offer the Discord button only when the server actually has OAuth
  // configured — otherwise it would just bounce people to a 503.
  try {
    const cfg = await api("/auth/config");
    $("#login-discord").classList.toggle("hidden", !cfg.discord);
    $("#login-discord-note").classList.toggle("hidden", !cfg.discord);
    $("#login-password-label").textContent = cfg.discord
      ? "or use the owner password" : "Enter the dashboard password";
  } catch { /* leave password-only */ }

  // Surface why a Discord sign-in bounced (no access, expired state, ...).
  const err = new URLSearchParams(location.search).get("login_error");
  if (err) {
    const el = $("#login-error");
    el.textContent = err;
    el.classList.remove("hidden");
    history.replaceState({}, "", location.pathname);
  }
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").classList.add("hidden");
  try {
    await api("/login", { method: "POST", body: { password: $("#login-password").value } });
    $("#login-password").value = "";
    init();
  } catch {
    $("#login-error").classList.remove("hidden");
  }
});

$("#logout-btn").addEventListener("click", async () => {
  await api("/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

/* ---------- boot ---------- */

async function init() {
  let me;
  try {
    me = await api("/me");
  } catch { return; }
  $("#login-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  if (!me.ready) {
    content().innerHTML = `<div class="card"><h2>Bot is starting…</h2>
      <p class="muted">Refresh in a few seconds.</p></div>`;
    setTimeout(init, 3000);
    return;
  }
  state.me = me;
  state.level = me.level || "none";
  // Hide what this level can't use. The server enforces it regardless — this
  // is so people aren't shown buttons that would only ever return 403.
  const rank = { none: 0, moderator: 1, admin: 2, creator: 3 };
  const can = (needed) => (rank[state.level] || 0) >= rank[needed];
  document.querySelectorAll("#tabbar button").forEach((btn) => {
    const needed = { settings: "admin", logs: "creator" }[btn.dataset.tab] || "moderator";
    btn.classList.toggle("hidden", !can(needed));
  });
  if (!can({ settings: "admin", logs: "creator" }[state.tab] || "moderator")) {
    state.tab = "overview";
    document.querySelectorAll("#tabbar button").forEach((b) =>
      b.classList.toggle("active", b.dataset.tab === "overview"));
  }
  $("#level-badge") && ($("#level-badge").textContent = state.level);

  state.guilds = await api("/guilds");
  const sel = $("#guild-select");
  sel.innerHTML = state.guilds
    .map((g) => `<option value="${g.id}">${esc(g.name)}</option>`)
    .join("");
  if (!state.guilds.length) {
    content().innerHTML = `<div class="card"><h2>No servers</h2>
      <p class="muted">Invite the bot to a server first, then refresh.</p></div>`;
    return;
  }
  if (!state.guildId || !state.guilds.find((g) => g.id === state.guildId)) {
    state.guildId = state.guilds[0].id;
  }
  sel.value = state.guildId;
  render();
}

$("#guild-select").addEventListener("change", (e) => {
  state.guildId = e.target.value;
  render();
});

document.querySelectorAll("#tabbar button").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.tab = btn.dataset.tab;
    document.querySelectorAll("#tabbar button").forEach((b) =>
      b.classList.toggle("active", b === btn));
    render();
  });
});

function render() {
  clearInterval(state.voiceTimer); // stop console polling when leaving the tab
  clearInterval(state.logsTimer);
  const renderers = {
    overview: renderOverview,
    members: renderMembers,
    server: renderServer,
    voice: renderVoice,
    mod: renderMod,
    logs: renderLogs,
    settings: renderSettings,
  };
  content().innerHTML = `<div class="card"><p class="muted">Loading…</p></div>`;
  renderers[state.tab]().catch((e) => console.error(e));
}

/* ---------- voice cues ---------- */

/* Each cue is stored as {mode:"tone"|"off"|"soundboard", soundId}. One <select>
   covers all three: the fixed options are the two modes, and every soundboard
   sound in the server is an additional option below them. */
function cueValue(settings, event) {
  const cue = settings[`voice_cue_${event}`];
  if (!cue || cue.mode === "off") return "off";
  if (cue.mode === "soundboard" && cue.soundId) return `sound:${cue.soundId}`;
  return "tone";
}

function cueField(event, label, settings, sounds) {
  const current = cueValue(settings, event);
  const option = (value, text) =>
    `<option value="${esc(value)}" ${current === value ? "selected" : ""}>${esc(text)}</option>`;
  return `<label class="field"><span class="lbl">${esc(label)}</span>
    <select id="s-cue-${esc(event)}">
      ${option("tone", "Tone")}
      ${option("off", "Nothing")}
      ${(sounds || []).map((snd) =>
        option(`sound:${snd.id}`,
          `Soundboard: ${snd.emoji ? `${snd.emoji} ` : ""}${snd.name}${snd.available ? "" : " (unavailable)"}`)).join("")}
    </select></label>`;
}

function readCue(event) {
  const value = $(`#s-cue-${event}`).value;
  if (value === "off") return { mode: "off" };
  if (value.startsWith("sound:")) return { mode: "soundboard", soundId: value.slice(6) };
  return { mode: "tone" };
}

/* ---------- overview ---------- */

async function renderOverview() {
  const [g, me, settings] = await Promise.all([
    api(`/guilds/${state.guildId}`), api("/me"), api(`/guilds/${state.guildId}/settings`),
  ]);
  content().innerHTML = `
    <div class="card" style="display:flex;align-items:center;gap:12px">
      ${g.icon ? `<img class="avatar" src="${g.icon}" style="width:48px;height:48px;border-radius:12px">` : ""}
      <div><div style="font-size:17px;font-weight:700">${esc(g.name)}</div>
      <div class="muted">Owner: ${esc(g.owner ?? "?")}</div></div>
    </div>
    <div class="stat-grid">
      <div class="stat"><div class="value">${g.member_count}</div><div class="label">Members</div></div>
      <div class="stat"><div class="value">${g.humans}</div><div class="label">Humans</div></div>
      <div class="stat"><div class="value">${g.bots}</div><div class="label">Bots</div></div>
      <div class="stat"><div class="value">${g.channels}</div><div class="label">Channels</div></div>
      <div class="stat"><div class="value">${g.roles}</div><div class="label">Roles</div></div>
      <div class="stat"><div class="value">${g.boost_level}</div><div class="label">Boost level</div></div>
    </div>
    <div class="section-title">Bot</div>
    <div class="card" style="display:flex;align-items:center;gap:12px">
      <img class="avatar" src="${me.avatar}" style="width:40px;height:40px;border-radius:50%">
      <div class="grow"><div style="font-weight:600">${esc(me.name)}</div>
      <div class="muted">${me.guild_count} server(s) · ${me.latency_ms}ms · build ${esc(me.build || "?")}</div></div>
      <span class="badge ok">online</span>
    </div>
    <div class="card" style="margin-top:10px;display:flex;align-items:center;gap:12px">
      <span style="font-size:20px">&#x1F310;</span>
      <div class="grow"><div style="font-weight:600">Showcase site</div>
      <div class="muted">The public marketing page, pricing tiers and bot builder.</div></div>
      <a class="btn ghost" href="/site/" target="_blank" rel="noopener">Open</a>
    </div>
    ${g.quiet_mode ? `
    <div class="card" style="margin-top:10px;border:1px solid var(--danger)">
      <div style="font-weight:700">🔇 Muted (podcast mode)</div>
      <div class="muted">Not in voice, not listening, not replying, not interjecting.</div>
    </div>` : ""}
    <div class="btn-row" style="margin-top:10px">
      <button class="btn ${g.quiet_mode ? "primary" : ""}" id="quiet-btn">
        ${g.quiet_mode ? `🔊 Unmute ${esc(botLabel(settings))}` : `🔇 Mute ${esc(botLabel(settings))} (podcast mode)`}
      </button>
      <button class="btn danger" id="restart-bot-btn">Restart bot</button>
    </div>

    <div class="section-title">AI persona</div>
    <div class="card">
      <label class="field">
        <span class="lbl-row">
          <span class="lbl">Character persona — personality &amp; voice</span>
          <button class="btn ghost sm enhance-btn" data-target="persona-character" data-kind="character">&#x2728; Enhance with AI</button>
        </span>
        <textarea id="persona-character" rows="6">${esc(settings.ai_system_prompt)}</textarea>
      </label>
      <label class="field">
        <span class="lbl-row">
          <span class="lbl">Capability persona — what ${esc(botLabel(settings))} knows it can do</span>
          <button class="btn ghost sm enhance-btn" data-target="persona-capability" data-kind="capability">&#x2728; Enhance with AI</button>
        </span>
        <textarea id="persona-capability" rows="6">${esc(settings.ai_capability_prompt)}</textarea>
      </label>
      <button class="btn primary full" id="save-persona">Save persona</button>
    </div>`;

  document.querySelectorAll(".enhance-btn").forEach((btn) => {
    btn.onclick = async () => {
      const textarea = $(`#${btn.dataset.target}`);
      const text = textarea.value.trim();
      if (!text) return toast("Nothing to enhance", true);
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = "Enhancing…";
      try {
        const res = await api(`/guilds/${state.guildId}/ai/enhance`, {
          method: "POST", body: { kind: btn.dataset.kind, text },
        });
        textarea.value = res.text;
        toast("Enhanced — review, then save");
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    };
  });

  $("#save-persona").onclick = async () => {
    await api(`/guilds/${state.guildId}/settings`, {
      method: "PUT",
      body: {
        ai_system_prompt: $("#persona-character").value,
        ai_capability_prompt: $("#persona-capability").value,
      },
    });
    toast("Persona saved");
  };

  $("#quiet-btn").onclick = async () => {
    const r = await api(`/guilds/${state.guildId}/quiet`, {
      method: "POST", body: { on: !g.quiet_mode } });
    toast(r.quiet_mode ? `${botLabel(settings)} is muted — out of voice and silent everywhere.`
                       : `${botLabel(settings)} is back.`);
    render();
  };
  $("#restart-bot-btn").onclick = () =>
    confirmAction("Restart the whole bot? It'll be back in ~30 seconds.", async () => {
      await api("/bot/restart", { method: "POST" });
      toast("Restarting — give it ~30s, then refresh.");
    });
}

/* ---------- members ---------- */

async function renderMembers() {
  content().innerHTML = `
    <div class="inline-form">
      <input id="member-search" placeholder="Search members…" value="${esc(state.memberSearch)}">
    </div>
    <div id="member-list" class="list"></div>
    <div class="btn-row">
      <button class="btn sm hidden" id="member-prev">&larr; Prev</button>
      <button class="btn sm hidden" id="member-next">Next &rarr;</button>
    </div>`;
  const input = $("#member-search");
  input.addEventListener("input", () => {
    clearTimeout(input._t);
    input._t = setTimeout(() => {
      state.memberSearch = input.value;
      state.memberOffset = 0;
      loadMembers();
    }, 300);
  });
  await loadMembers();
}

async function loadMembers() {
  const q = new URLSearchParams({
    search: state.memberSearch, offset: state.memberOffset, limit: 50,
  });
  const data = await api(`/guilds/${state.guildId}/members?${q}`);
  const list = $("#member-list");
  if (!list) return;
  list.innerHTML = data.members.map((m) => `
    <div class="row" data-id="${m.id}">
      <img class="avatar" src="${m.avatar}">
      <div class="grow">
        <div class="title">${esc(m.display_name)}
          ${m.bot ? '<span class="badge">bot</span>' : ""}
          ${m.timed_out ? '<span class="badge warn">timed out</span>' : ""}</div>
        <div class="sub">@${esc(m.name)}</div>
      </div>
      <div class="right">${timeAgo(m.joined_at)}</div>
    </div>`).join("") || `<div class="card muted">No members found</div>`;
  list.querySelectorAll(".row").forEach((row) => {
    row.addEventListener("click", () => {
      const m = data.members.find((x) => x.id === row.dataset.id);
      memberSheet(m);
    });
  });
  const prev = $("#member-prev"), next = $("#member-next");
  prev.classList.toggle("hidden", state.memberOffset === 0);
  next.classList.toggle("hidden", state.memberOffset + 50 >= data.total);
  prev.onclick = () => { state.memberOffset = Math.max(0, state.memberOffset - 50); loadMembers(); };
  next.onclick = () => { state.memberOffset += 50; loadMembers(); };
}

function memberSheet(m) {
  openModal(`
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
      <img src="${m.avatar}" style="width:52px;height:52px;border-radius:50%">
      <div><div style="font-size:17px;font-weight:700">${esc(m.display_name)}</div>
      <div class="muted">@${esc(m.name)} · ${m.id}</div></div>
    </div>
    <label class="field"><span class="lbl">Reason (for actions below)</span>
      <input id="action-reason" placeholder="Optional reason"></label>
    <div class="btn-row">
      <button class="btn warn" data-act="warn">Warn</button>
      <button class="btn" data-act="timeout">Timeout</button>
      ${m.timed_out ? '<button class="btn" data-act="untimeout">Untimeout</button>' : ""}
      <button class="btn danger" data-act="kick">Kick</button>
      <button class="btn danger" data-act="ban">Ban</button>
    </div>
    <div class="btn-row">
      <button class="btn full" id="manage-roles-btn">Manage roles</button>
    </div>`);
  document.querySelectorAll("#modal [data-act]").forEach((btn) => {
    btn.onclick = () => {
      const action = btn.dataset.act;
      const reason = $("#action-reason").value || null;
      const run = async (minutes = null) => {
        await api(`/guilds/${state.guildId}/members/${m.id}/action`, {
          method: "POST", body: { action, reason, minutes },
        });
        toast(`${action} → ${m.display_name}`);
        closeModal();
        loadMembers();
      };
      if (action === "timeout") {
        const mins = parseInt(prompt("Timeout minutes:", "10"), 10);
        if (!mins) return;
        run(mins);
      } else if (action === "kick" || action === "ban") {
        confirmAction(`${action} ${m.display_name}?`, () => run());
      } else {
        run();
      }
    };
  });
  $("#manage-roles-btn").onclick = () => roleSheet(m);
}

async function roleSheet(m) {
  const roles = await api(`/guilds/${state.guildId}/roles`);
  const assignable = roles.filter((r) => !r.managed);
  openModal(`
    <h2>Roles — ${esc(m.display_name)}</h2>
    <div class="list">${assignable.map((r) => `
      <label class="toggle">
        <input type="checkbox" data-role="${r.id}" ${m.roles.includes(r.id) ? "checked" : ""}>
        <span class="color-dot" style="background:${r.color || "#5c5f66"}"></span>
        ${esc(r.name)}
      </label>`).join("")}</div>
    <div class="btn-row"><button class="btn primary full" id="save-roles">Save</button></div>`);
  $("#save-roles").onclick = async () => {
    const add = [], remove = [];
    document.querySelectorAll("#modal [data-role]").forEach((cb) => {
      const had = m.roles.includes(cb.dataset.role);
      if (cb.checked && !had) add.push(cb.dataset.role);
      if (!cb.checked && had) remove.push(cb.dataset.role);
    });
    await api(`/guilds/${state.guildId}/members/${m.id}/roles`, {
      method: "POST", body: { add, remove },
    });
    toast("Roles updated");
    closeModal();
    loadMembers();
  };
}

/* ---------- server (channels & roles) ---------- */

async function renderServer() {
  const [channels, roles] = await Promise.all([
    api(`/guilds/${state.guildId}/channels`),
    api(`/guilds/${state.guildId}/roles`),
  ]);
  state.channels = channels;
  state.roles = roles;
  const textChannels = channels.filter((c) => c.type === "text");
  content().innerHTML = `
    <div class="section-title">Send a message as the bot</div>
    <div class="card">
      <label class="field"><span class="lbl">Channel</span>
        <select id="send-channel">${textChannels.map((c) =>
          `<option value="${c.id}">#${esc(c.name)}</option>`).join("")}</select></label>
      <label class="field"><span class="lbl">Message</span>
        <textarea id="send-content" placeholder="Type a message…"></textarea></label>
      <button class="btn primary full" id="send-btn">Send</button>
    </div>

    <div class="section-title">Channels (${channels.length})</div>
    <div class="inline-form">
      <input id="new-channel-name" placeholder="new-channel">
      <select id="new-channel-type" style="max-width:110px">
        <option value="text">Text</option><option value="voice">Voice</option>
        <option value="category">Category</option>
        <option value="forum">Forum</option>
      </select>
      <button class="btn primary sm" id="create-channel-btn">Add</button>
    </div>
    <div class="list">${channels.map((c) => `
      <div class="row" style="cursor:default">
        <div class="grow">
          <div class="title">${c.type === "text" ? "#" : ""}${esc(c.name)}</div>
          <div class="sub">${esc(c.type)}${c.category ? " · " + esc(c.category) : ""}</div>
        </div>
        <button class="btn ghost sm" data-del-channel="${c.id}" data-name="${esc(c.name)}">&#x1F5D1;</button>
      </div>`).join("")}</div>

    <div class="section-title">Roles (${roles.length})</div>
    <div class="inline-form">
      <input id="new-role-name" placeholder="New role">
      <input id="new-role-color" type="color" value="#5865f2" style="max-width:56px;padding:4px">
      <button class="btn primary sm" id="create-role-btn">Add</button>
    </div>
    <div class="list">${roles.map((r) => `
      <div class="row" style="cursor:default">
        <span class="color-dot" style="background:${r.color || "#5c5f66"}"></span>
        <div class="grow">
          <div class="title">${esc(r.name)} ${r.managed ? '<span class="badge">managed</span>' : ""}</div>
          <div class="sub">${r.members} member(s)</div>
        </div>
        ${r.managed ? "" : `<button class="btn ghost sm" data-del-role="${r.id}" data-name="${esc(r.name)}">&#x1F5D1;</button>`}
      </div>`).join("")}</div>`;

  $("#send-btn").onclick = async () => {
    const channelId = $("#send-channel").value;
    const text = $("#send-content").value.trim();
    if (!text) return toast("Message is empty", true);
    await api(`/guilds/${state.guildId}/channels/${channelId}/messages`, {
      method: "POST", body: { content: text },
    });
    $("#send-content").value = "";
    toast("Message sent");
  };
  $("#create-channel-btn").onclick = async () => {
    const name = $("#new-channel-name").value.trim();
    if (!name) return;
    await api(`/guilds/${state.guildId}/channels`, {
      method: "POST", body: { name, type: $("#new-channel-type").value },
    });
    toast("Channel created");
    renderServer();
  };
  $("#create-role-btn").onclick = async () => {
    const name = $("#new-role-name").value.trim();
    if (!name) return;
    await api(`/guilds/${state.guildId}/roles`, {
      method: "POST", body: { name, color: $("#new-role-color").value },
    });
    toast("Role created");
    renderServer();
  };
  document.querySelectorAll("[data-del-channel]").forEach((btn) => {
    btn.onclick = () => confirmAction(`Delete channel "${btn.dataset.name}"? This cannot be undone.`,
      async () => {
        await api(`/guilds/${state.guildId}/channels/${btn.dataset.delChannel}`, { method: "DELETE" });
        toast("Channel deleted");
        renderServer();
      });
  });
  document.querySelectorAll("[data-del-role]").forEach((btn) => {
    btn.onclick = () => confirmAction(`Delete role "${btn.dataset.name}"?`,
      async () => {
        await api(`/guilds/${state.guildId}/roles/${btn.dataset.delRole}`, { method: "DELETE" });
        toast("Role deleted");
        renderServer();
      });
  });
}

/* ---------- voice console ---------- */

async function renderVoice() {
  content().innerHTML = `
    <div class="section-title" style="display:flex;align-items:center;gap:8px">
      Voice console <span id="voice-live" class="badge hidden"></span>
    </div>
    <div class="inline-form">
      <select id="voice-channel"></select>
      <label class="muted" style="display:flex;align-items:center;gap:6px;font-size:13px">
        <input type="checkbox" id="voice-follow" checked> follow
      </label>
      <button class="btn primary sm" id="voice-start-btn">Start</button>
      <button class="btn sm" id="voice-stop-btn">Stop</button>
    </div>
    <div id="voice-console" class="console"><div class="muted" style="padding:8px">Loading…</div></div>`;
  $("#voice-channel").addEventListener("change", (e) => {
    state.voiceChannel = e.target.value;
    refreshVoice(true).catch(() => {});
  });
  $("#voice-start-btn").onclick = async () => {
    const r = await api(`/guilds/${state.guildId}/voice/start`, { method: "POST" });
    toast(r.joined ? `Listening in #${r.joined}` : (r.detail || "Voice monitoring on"));
    refreshVoice(true).catch(() => {});
  };
  $("#voice-stop-btn").onclick = async () => {
    await api(`/guilds/${state.guildId}/voice/stop`, { method: "POST" });
    toast("Voice monitoring stopped");
    refreshVoice(true).catch(() => {});
  };
  await refreshVoice(true);
  state.voiceTimer = setInterval(() => refreshVoice(false).catch(() => {}), 3000);
}

function consoleLine(l) {
  const t = new Date(l.ts * 1000).toLocaleTimeString([], { hour12: false });
  if (l.system) return `<div class="console-line system"><span class="t">${t}</span> ${esc(l.text)}</div>`;
  const cls = l.bot ? "console-line bot" : l.flagged ? "console-line flagged" : "console-line";
  return `<div class="${cls}"><span class="t">${t}</span> <span class="who">${esc(l.name)}:</span> ${esc(l.text)}${l.flagged ? ' <span class="badge danger">flagged</span>' : ""}</div>`;
}

async function refreshVoice(force) {
  const box = $("#voice-console");
  if (!box) return; // tab changed mid-flight
  const data = await api(`/guilds/${state.guildId}/transcripts`);

  const live = $("#voice-live");
  live.classList.remove("hidden");
  if (!data.enabled) {
    live.textContent = "transcription off";
    live.className = "badge";
  } else if (data.listening) {
    live.textContent = "listening";
    live.className = "badge ok";
  } else if (data.voice_enabled === false) {
    live.textContent = "stopped";
    live.className = "badge danger";
  } else {
    live.textContent = "idle";
    live.className = "badge";
  }

  const select = $("#voice-channel");
  const options = data.channels
    .map((c) => `<option value="${c.id}">${esc("#" + c.name)}${c.live ? " · live" : ""}</option>`)
    .join("");
  if (select.innerHTML !== options) {
    select.innerHTML = options;
  }
  if (!data.channels.length) {
    box.innerHTML = `<div class="muted" style="padding:8px">No transcripts yet — lines appear here in real time as people talk in voice.</div>`;
    return;
  }
  if (!data.channels.some((c) => c.id === state.voiceChannel)) {
    state.voiceChannel = (data.channels.find((c) => c.live) || data.channels[0]).id;
  }
  select.value = state.voiceChannel;

  const chan = data.channels.find((c) => c.id === state.voiceChannel);
  const html = chan.lines.map(consoleLine).join("");
  if (box._html !== html) {
    const follow = $("#voice-follow").checked;
    box.innerHTML = html;
    box._html = html;
    if (force || follow) box.scrollTop = box.scrollHeight;
  }
}

/* ---------- logs ---------- */

async function renderLogs() {
  content().innerHTML = `
    <div class="section-title">Live logs</div>
    <div class="inline-form">
      <select id="logs-level" style="max-width:120px">
        <option value="">All levels</option>
        <option value="INFO">Info+</option>
        <option value="WARNING">Warnings+</option>
        <option value="ERROR">Errors</option>
      </select>
      <input id="logs-filter" placeholder="Filter (e.g. listener, voice, memory)…">
      <label class="muted" style="display:flex;align-items:center;gap:6px;font-size:13px">
        <input type="checkbox" id="logs-follow" checked> follow
      </label>
    </div>
    <div id="logs-console" class="console"><div class="muted" style="padding:8px">Loading…</div></div>`;
  $("#logs-level").addEventListener("change", () => refreshLogs(true).catch(() => {}));
  $("#logs-filter").addEventListener("input", () => refreshLogs(true).catch(() => {}));
  await refreshLogs(true);
  state.logsTimer = setInterval(() => refreshLogs(false).catch(() => {}), 3000);
}

const LEVEL_RANK = { DEBUG: 0, INFO: 1, WARNING: 2, ERROR: 3, CRITICAL: 4 };

function logLine(e) {
  const t = new Date(e.ts * 1000).toLocaleTimeString([], { hour12: false });
  const lvl = e.level === "WARNING" ? "log-warn"
    : (e.level === "ERROR" || e.level === "CRITICAL") ? "log-err" : "";
  return `<div class="console-line ${lvl}"><span class="t">${t}</span> ` +
    `<span class="who">${esc(e.logger)}</span> ${esc(e.message)}</div>`;
}

async function refreshLogs(force) {
  const box = $("#logs-console");
  if (!box) return;
  const data = await api(`/logs`);
  const minRank = LEVEL_RANK[$("#logs-level").value] ?? 0;
  const needle = $("#logs-filter").value.toLowerCase();
  let entries = data.entries.filter((e) => (LEVEL_RANK[e.level] ?? 1) >= minRank);
  if (needle) {
    entries = entries.filter((e) =>
      e.logger.toLowerCase().includes(needle) || e.message.toLowerCase().includes(needle));
  }
  const html = entries.length
    ? entries.map(logLine).join("")
    : `<div class="muted" style="padding:8px">No matching log lines yet.</div>`;
  if (box._html !== html) {
    box.innerHTML = html;
    box._html = html;
    if (force || $("#logs-follow").checked) box.scrollTop = box.scrollHeight;
  }
}

/* ---------- moderation ---------- */

async function renderMod() {
  const [warnings, logs] = await Promise.all([
    api(`/guilds/${state.guildId}/warnings`),
    api(`/guilds/${state.guildId}/logs?limit=100`),
  ]);
  content().innerHTML = `
    <div class="section-title">Warnings (${warnings.length})</div>
    <div class="list">${warnings.map((w) => `
      <div class="row" style="cursor:default">
        <div class="grow">
          <div class="title">${esc(w.user_name)}</div>
          <div class="sub">${esc(w.reason || "No reason")} · by ${esc(w.moderator_name)} · ${timeAgo(w.created_at)}</div>
        </div>
        <button class="btn ghost sm" data-del-warning="${w.id}">&#x1F5D1;</button>
      </div>`).join("") || '<div class="card muted">No warnings</div>'}</div>

    <div class="section-title">Moderation log</div>
    <div class="list">${logs.map((l) => `
      <div class="row" style="cursor:default">
        <span class="badge ${["ban", "kick", "automod"].includes(l.action) ? "danger" :
          ["warn", "timeout"].includes(l.action) ? "warn" : ""}">${esc(l.action)}</span>
        <div class="grow">
          <div class="title">${esc(l.target || "—")}</div>
          <div class="sub">${esc(l.reason || "")} · by ${esc(l.actor)} · ${timeAgo(l.created_at)}</div>
        </div>
      </div>`).join("") || '<div class="card muted">No log entries</div>'}</div>`;
  document.querySelectorAll("[data-del-warning]").forEach((btn) => {
    btn.onclick = async () => {
      await api(`/guilds/${state.guildId}/warnings/${btn.dataset.delWarning}`, { method: "DELETE" });
      toast("Warning removed");
      renderMod();
    };
  });
}

/* ---------- settings ---------- */

const SETTINGS_TAB_KEY = "settingsTab";

function showSettingsPanel(id) {
  sessionStorage.setItem(SETTINGS_TAB_KEY, id);
  document.querySelectorAll(".settings-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === id);
  });
  document.querySelectorAll("[data-settings-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.settingsTab === id);
  });
}

async function renderSettings() {
  const [settings, channels, roles, me, sounds] = await Promise.all([
    api(`/guilds/${state.guildId}/settings`),
    api(`/guilds/${state.guildId}/channels`),
    api(`/guilds/${state.guildId}/roles`),
    api("/me"),
    // Never fatal: a guild with no soundboard, or a bot without the
    // permission to read it, still gets a working settings page.
    api(`/guilds/${state.guildId}/soundboard`).catch(() => []),
  ]);
  const textChannels = channels.filter((c) => c.type === "text");
  const voiceChannelList = channels.filter((c) => c.type === "voice");
  // Bot/integration-managed roles can't be handed out to people, so they're
  // no use as a dashboard-access group.
  const allRoles = roles.filter((r) => !r.managed);
  const channelOptions = (selected) =>
    `<option value="">— none —</option>` + textChannels.map((c) =>
      `<option value="${c.id}" ${String(selected) === c.id ? "selected" : ""}>#${esc(c.name)}</option>`).join("");
  const roleOptions = (selected) =>
    `<option value="">— none —</option>` + roles.filter((r) => !r.managed).map((r) =>
      `<option value="${r.id}" ${String(selected) === r.id ? "selected" : ""}>${esc(r.name)}</option>`).join("");

  const settingsTabs = [
    { id: "identity", label: "Identity" },
    { id: "welcome", label: "Welcome" },
    { id: "automod", label: "Automod" },
    { id: "access", label: "Dashboard access" },
    { id: "ai", label: "AI" },
    { id: "media", label: "Images & video" },
    { id: "voice-detect", label: "Voice detection" },
    { id: "voice-cues", label: "Voice cues" },
    { id: "voice-phrases", label: "Wake & stop words" },
    { id: "speech", label: "Speech (TTS)" },
    { id: "proactive", label: "Proactive" },
    { id: "deescalation", label: "De-escalation" },
    { id: "memory", label: "Memory" },
    { id: "logging", label: "Logging" },
    { id: "presence", label: "Presence" },
  ];
  const activeTab = sessionStorage.getItem(SETTINGS_TAB_KEY) || "identity";

  const fishKeyBadge = settings.fish_api_configured
    ? '<span class="badge ok">Fish API key on server</span>'
    : '<span class="badge warn">No Fish API key — Edge TTS only</span>';

  content().innerHTML = `
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="Settings sections">
        ${settingsTabs.map((t) =>
          `<button type="button" data-settings-tab="${t.id}" class="${t.id === activeTab ? "active" : ""}">${esc(t.label)}</button>`).join("")}
      </nav>
      <div class="settings-main">
        <section class="settings-panel ${activeTab === "identity" ? "active" : ""}" data-panel="identity">
          <div class="section-title">Identity</div>
          <div class="card">
            <label class="field"><span class="lbl">Bot name</span>
              <input id="s-bot_name" value="${esc(settings.bot_name || "")}"
                placeholder="${esc(me.name)} (from Discord)"></label>
            <span class="muted">Leave blank to use the Discord application name.
              Fill in only to call it something different in this server.
              ${settings.bot_name_source === "override"
                ? `Currently <strong>${esc(settings.bot_name_effective)}</strong> — clear to use ${esc(me.name)}.`
                : `Currently <strong>${esc(settings.bot_name_effective)}</strong>, from Discord.`}</span>
          </div>
        </section>

        <section class="settings-panel ${activeTab === "welcome" ? "active" : ""}" data-panel="welcome">
          <div class="section-title">Welcome &amp; autorole</div>
          <div class="card">
            <label class="field"><span class="lbl">Welcome channel</span>
              <select id="s-welcome_channel">${channelOptions(settings.welcome_channel)}</select></label>
            <label class="field"><span class="lbl">Welcome message ({user}, {server}, {membercount})</span>
              <textarea id="s-welcome_message">${esc(settings.welcome_message)}</textarea></label>
            <label class="field"><span class="lbl">Goodbye message</span>
              <textarea id="s-goodbye_message">${esc(settings.goodbye_message)}</textarea></label>
            <label class="field"><span class="lbl">Autorole (given to new members)</span>
              <select id="s-autorole">${roleOptions(settings.autorole)}</select></label>
          </div>
        </section>

        <section class="settings-panel ${activeTab === "automod" ? "active" : ""}" data-panel="automod">
          <div class="section-title">Auto-moderation</div>
          <div class="card">
            <label class="toggle"><input type="checkbox" id="s-automod_enabled"
              ${settings.automod_enabled ? "checked" : ""}> Enable automod</label>
            <label class="toggle"><input type="checkbox" id="s-block_invites"
              ${settings.block_invites ? "checked" : ""}> Block Discord invite links</label>
            <label class="field"><span class="lbl">Banned words (comma-separated)</span>
              <input id="s-banned_words" value="${esc((settings.banned_words || []).join(", "))}"></label>
            <label class="field"><span class="lbl">Max mentions per message (0 = off)</span>
              <input id="s-max_mentions" type="number" min="0" value="${settings.max_mentions || 0}"></label>
          </div>
          <div class="section-title">Cross-channel spam ban</div>
          <div class="card">
            <label class="toggle"><input type="checkbox" id="s-antispam_enabled"
              ${settings.antispam_enabled ? "checked" : ""}> Auto-ban members blasting the same
              message across channels (recent messages are deleted server-wide on the ban)</label>
            <label class="field"><span class="lbl">Channels within the window to trigger a ban</span>
              <input id="s-antispam_channel_threshold" type="number" min="2"
                value="${settings.antispam_channel_threshold || 4}"></label>
            <label class="field"><span class="lbl">Window (seconds)</span>
              <input id="s-antispam_window_seconds" type="number" min="1"
                value="${settings.antispam_window_seconds || 20}"></label>
            <label class="field"><span class="lbl">Message history to delete on ban (seconds, max 604800)</span>
              <input id="s-antispam_delete_seconds" type="number" min="0" max="604800"
                value="${settings.antispam_delete_seconds || 3600}"></label>
          </div>
        </section>

        <section class="settings-panel ${activeTab === "access" ? "active" : ""}" data-panel="access">
          <div class="section-title">Dashboard access</div>
          <div class="card">
            <label class="field"><span class="lbl">Roles with admin access</span>
              <select id="s-dashboard_admin_roles" multiple size="5">${allRoles.map((r) =>
                `<option value="${r.id}" ${(settings.dashboard_admin_roles || []).map(String).includes(r.id) ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select></label>
            <label class="field"><span class="lbl">Roles with moderator access</span>
              <select id="s-dashboard_mod_roles" multiple size="5">${allRoles.map((r) =>
                `<option value="${r.id}" ${(settings.dashboard_mod_roles || []).map(String).includes(r.id) ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select></label>
            <span class="muted">Admins manage AI, voice, and automod; moderators handle members.
              Empty lists fall back to Discord permissions. OWNER_ID is always full access.</span>
          </div>
        </section>

        <section class="settings-panel ${activeTab === "ai" ? "active" : ""}" data-panel="ai">
          <div class="section-title">AI (OpenRouter)</div>
          <div class="card">
            <label class="toggle"><input type="checkbox" id="s-ai_enabled"
              ${settings.ai_enabled ? "checked" : ""}> Enable AI replies</label>
            <label class="field"><span class="lbl">Model (${esc(botLabel(settings))}'s voice)</span>
              <input id="s-ai_model" value="${esc(settings.ai_model)}" placeholder="openrouter/free"></label>
            <label class="field"><span class="lbl">Utility model (background work)</span>
              <input id="s-ai_utility_model" value="${esc(settings.ai_utility_model)}" placeholder="openrouter/free"></label>
            <p class="muted" style="margin-bottom:12px">Character &amp; capability persona are on the Overview tab.</p>
            <label class="field"><span class="lbl">Always-on AI channels</span>
              <select id="s-ai_channels" multiple size="5">${textChannels.map((c) =>
                `<option value="${c.id}" ${(settings.ai_channels || []).map(String).includes(c.id) ? "selected" : ""}>#${esc(c.name)}</option>`).join("")}</select>
              <span class="muted">The bot always replies when @mentioned, in any channel.</span></label>
          </div>
        </section>

        <section class="settings-panel ${activeTab === "media" ? "active" : ""}" data-panel="media">
          <div class="section-title">Images &amp; video</div>
          <div class="card">
            <label class="toggle"><input type="checkbox" id="s-media_enabled"
              ${settings.media_enabled ? "checked" : ""}> Let the bot generate images and video</label>
            <label class="field"><span class="lbl">Who can ask for one</span>
              <select id="s-media_access">
                <option value="owner" ${settings.media_access !== "everyone" ? "selected" : ""}>Owner only</option>
                <option value="everyone" ${settings.media_access === "everyone" ? "selected" : ""}>Everyone in this server</option>
              </select></label>
            <label class="field"><span class="lbl">Image model</span>
              <input id="s-media_image_model" value="${esc(settings.media_image_model || "")}"
                placeholder="google/gemini-2.5-flash-image"></label>
            <label class="field"><span class="lbl">Vision model — reads pictures people post</span>
              <input id="s-media_vision_model" value="${esc(settings.media_vision_model || "")}"
                placeholder="${esc(settings.ai_model || "")}">
              <span class="muted">Only used on messages that actually have an image attached,
                and it answers that whole turn. Leave blank to use the chat model above.
                Worth setting when that model can't read images.</span></label>
            <label class="field"><span class="lbl">Videos per hour, server-wide (0 = no cap)</span>
              <input id="s-media_video_hourly_cap" type="number" min="0" value="${settings.media_video_hourly_cap ?? 5}"></label>
            <span class="muted">Every image and every video is billed against this instance's
              OpenRouter credit — leave the image model blank to follow whatever this instance is
              configured to use. A video is a script plus several illustrations plus narration
              plus assembly, all in one request, so it costs meaningfully more and takes a few
              minutes; the hourly cap is the safety net. Opening either to
              <strong>everyone</strong> hands the whole server a button that spends real money.</span>
          </div>

          <div class="section-title">Music</div>
          <div class="card">
            <label class="field"><span class="lbl">Roles that can make music</span>
              <select id="s-music_roles" multiple size="5">${allRoles.map((r) =>
                `<option value="${r.id}" ${(settings.music_roles || []).map(String).includes(r.id) ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select>
              <span class="muted">Generate tracks with Lyria and keep a personal 10-song library.</span></label>
            <label class="field"><span class="lbl">Roles that can also curate the server library</span>
              <select id="s-music_curator_roles" multiple size="5">${allRoles.map((r) =>
                `<option value="${r.id}" ${(settings.music_curator_roles || []).map(String).includes(r.id) ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select>
              <span class="muted">Everything above, plus adding and removing songs in the one shared
                server library (30 songs).</span></label>
            <span class="muted">Server admins and the server owner always have both. Leave both
              lists empty and music stays admin-only — the safe default, since every generation
              spends real credits whether or not the track is kept. ${esc(botLabel(settings))} can
              also grant a role from chat ("let the DJ role make music"), and members turn their
              own library sharing on or off by asking.</span>
          </div>
        </section>

        <section class="settings-panel ${activeTab === "voice-detect" ? "active" : ""}" data-panel="voice-detect">
          <div class="section-title">Allowed voice channels</div>
          <div class="card">
            <label class="field"><span class="lbl">Channels the bot may join</span>
              <select id="s-voice_channel_allowlist" multiple size="5">${voiceChannelList.map((c) =>
                `<option value="${c.id}" ${(settings.voice_channel_allowlist || []).map(String).includes(c.id) ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
              <span class="muted">${voiceChannelList.length ? "" : "<em>No voice channels found in this server.</em> "}
              Leave empty to allow any voice channel. Select one or more to narrow the bot down to
              just those — it won't auto-join or accept <code>/voicejoin</code> into anything else.</span></label>
          </div>
          <div class="section-title">Voice detection</div>
          <div class="card">
            <label class="field"><span class="lbl">Detection mode</span>
              <select id="s-voice_detection_mode">
                <option value="smart" ${settings.voice_detection_mode !== "wake_words" ? "selected" : ""}>Smart detection (recommended)</option>
                <option value="wake_words" ${settings.voice_detection_mode === "wake_words" ? "selected" : ""}>Exact wake words only</option>
              </select></label>
            <span class="muted">Smart detection runs a cheap classifier over what was said
              to spot ${esc(botLabel(settings))}'s name even when the transcriber mangles it
              ("hey aim ee"), then lets the main model read the conversation and work out
              whether it was being <em>spoken to</em> or just <em>spoken about</em> — so
              "I asked ${esc(botLabel(settings))} earlier" doesn't make it butt in. The
              wake words below still trigger instantly in either mode. The classifier uses
              the utility model, the same cheap one memory and de-escalation use.</span>
          </div>
          <div class="section-title">Follow-up listening</div>
          <div class="card">
            <label class="toggle"><input type="checkbox" id="s-voice_followup_enabled"
              ${settings.voice_followup_enabled ? "checked" : ""}> Keep listening without the wake word
              after ${esc(botLabel(settings))} finishes speaking</label>
            <label class="field"><span class="lbl">Follow-up window (seconds)</span>
              <input id="s-voice_followup_window_sec" type="number" min="0" max="120"
                value="${settings.voice_followup_window_sec ?? 5}"></label>
            <span class="muted">How long after ${esc(botLabel(settings))} stops talking anyone can keep
              the conversation going without saying the wake word again. Each real answer re-arms it.
              Set to 0 to require the wake word every time.</span>
          </div>
        </section>

        <section class="settings-panel ${activeTab === "voice-cues" ? "active" : ""}" data-panel="voice-cues">
          <div class="section-title">Voice cues</div>
          <div class="card">
            ${cueField("thinking", "Heard its name, deciding", settings, sounds)}
            ${cueField("engaging", "About to answer", settings, sounds)}
            ${cueField("declined", "Decided it wasn't being addressed", settings, sounds)}
            ${cueField("stopped_listening", "Follow-up window closed", settings, sounds)}
            <span class="muted">Short tones or soundboard sounds for what it's doing, including
              when the follow-up window (Voice tab) closes and it goes back to needing the wake word.
              ${sounds.length ? "" : "<em>No soundboard sounds found in this server.</em>"}</span>
          </div>
        </section>

        <section class="settings-panel ${activeTab === "voice-phrases" ? "active" : ""}" data-panel="voice-phrases">
          <div class="section-title">Wake &amp; stop words</div>
          <div class="card">
            <label class="field"><span class="lbl">Wake words</span>
              <input id="s-voice_wake_words" value="${esc(brackets(settings.voice_wake_words))}"
                placeholder="[hey {ai}] [{ai}, you around?]"></label>
            <label class="field"><span class="lbl">Cancel words (abort a pending reply)</span>
              <input id="s-voice_cancel_words" value="${esc(brackets(settings.voice_cancel_words))}"
                placeholder="[never mind] [forget it] [cancel that]"></label>
            <label class="field"><span class="lbl">Stop speaking (cut off, stay in conversation)</span>
              <input id="s-voice_stop_speaking_words" value="${esc(brackets(settings.voice_stop_speaking_words))}"
                placeholder="[{ai} stop speaking] [{ai} be quiet]"></label>
            <label class="field"><span class="lbl">Stop listening (end the conversation)</span>
              <input id="s-voice_stop_listening_words" value="${esc(brackets(settings.voice_stop_listening_words))}"
                placeholder="[{ai} stop listening] [{ai} we are done]"></label>
            <label class="field"><span class="lbl">Leave voice (disconnect and stay out)</span>
              <input id="s-voice_leave_words" value="${esc(brackets(settings.voice_leave_words))}"
                placeholder="[{ai} go to sleep] [{ai} leave the call]"></label>
            <span class="muted">Put each phrase in its own [brackets]. Use <code>{ai}</code> as a
              placeholder for the bot's name so wake words follow renames.
              Say a wake word to pull the bot into the conversation; a cancel word right
              after calls it off before he answers. <strong>Leave voice</strong> is stronger than
              stop&nbsp;listening — the bot disconnects and won't auto-rejoin until someone asks it
              back ("join us in voice") or you hit start above.</span>
          </div>
        </section>

        <section class="settings-panel ${activeTab === "speech" ? "active" : ""}" data-panel="speech">
          <div class="section-title">Speech (TTS)</div>
          <div class="card">
            <p style="margin-bottom:12px">${fishKeyBadge}</p>
            <label class="toggle"><input type="checkbox" id="s-tts_strip_markdown"
              ${settings.tts_strip_markdown !== false ? "checked" : ""}> Do not say markdown</label>
            <span class="muted" style="display:block;margin-bottom:14px">Strip <code>*</code>, <code>\`</code>,
              <code>#</code>, and other formatting from spoken replies so TTS reads the words, not the markup.</span>
            <span class="muted" style="display:block;margin-bottom:14px">Fish Audio is tried first when the server
              has <code>FISH_API_KEY</code> in Railway; Edge TTS is the free fallback. Leave a field blank here
              to use the deployment default. Changes apply on the next spoken reply — no redeploy.</span>
            <label class="field"><span class="lbl">Fish voice ID (reference_id)</span>
              <input id="s-fish_voice_id" value="${esc(settings.fish_voice_id || "")}"
                placeholder="${esc(settings.fish_voice_id_effective || "from fish.audio voice URL")}"></label>
            <span class="muted">Copy from a voice page on fish.audio — the hex id in the URL after <code>/m/</code>.
              ${settings.fish_voice_id_source === "override"
                ? `Using <strong>${esc(settings.fish_voice_id_effective || "(none)")}</strong> for this server.`
                : settings.fish_voice_id_effective
                  ? `Deployment default: <strong>${esc(settings.fish_voice_id_effective)}</strong>.`
                  : "No voice id set — Fish uses its platform default."}</span>
            <label class="field" style="margin-top:14px"><span class="lbl">Fish model</span>
              <input id="s-fish_tts_model" value="${esc(settings.fish_tts_model || "")}"
                placeholder="${esc(settings.fish_tts_model_effective || "s2.1-pro-free")}"></label>
            <span class="muted">e.g. <code>s2.1-pro-free</code>, <code>s2.1-pro</code>, <code>s1</code>.
              ${settings.fish_tts_model_source === "override"
                ? `This server: <strong>${esc(settings.fish_tts_model_effective)}</strong>.`
                : `Deployment default: <strong>${esc(settings.fish_tts_model_effective)}</strong>.`}</span>
            <label class="field" style="margin-top:14px"><span class="lbl">Edge TTS voice (fallback)</span>
              <input id="s-edge_tts_voice" value="${esc(settings.edge_tts_voice || "")}"
                placeholder="${esc(settings.edge_tts_voice_effective || "en-US-JennyNeural")}"></label>
            <span class="muted">Microsoft neural voice when Fish is off or fails — e.g.
              <code>en-US-JennyNeural</code>, <code>en-US-GuyNeural</code>.
              ${settings.edge_tts_voice_source === "override"
                ? `This server: <strong>${esc(settings.edge_tts_voice_effective)}</strong>.`
                : `Deployment default: <strong>${esc(settings.edge_tts_voice_effective)}</strong>.`}</span>
          </div>
        </section>

        <section class="settings-panel ${activeTab === "proactive" ? "active" : ""}" data-panel="proactive">
          <div class="section-title">Proactive speech</div>
          <div class="card">
            <label class="toggle"><input type="checkbox" id="s-pressure_enabled"
              ${settings.pressure_enabled ? "checked" : ""}> Speak up unprompted when pressure builds</label>
          </div>
        </section>

        <section class="settings-panel ${activeTab === "deescalation" ? "active" : ""}" data-panel="deescalation">
          <div class="section-title">De-escalation</div>
          <div class="card">
            <label class="toggle"><input type="checkbox" id="s-deesc_enabled"
              ${settings.deesc_enabled ? "checked" : ""}> Step in on real conflicts</label>
            <label class="toggle"><input type="checkbox" id="s-deesc_harsh_language"
              ${settings.deesc_harsh_language ? "checked" : ""}> Gently check in on sustained harsh language</label>
          </div>
        </section>

        <section class="settings-panel ${activeTab === "memory" ? "active" : ""}" data-panel="memory">
          <div class="section-title">Memory</div>
          <div class="card">
            <div class="btn-row">
              <button class="btn" id="memory-view-btn">View memory</button>
              <button class="btn danger" id="memory-wipe-btn">Wipe memory</button>
            </div>
            <span class="muted">Persistent working + durable memory from text and voice.</span>
          </div>
        </section>

        <section class="settings-panel ${activeTab === "logging" ? "active" : ""}" data-panel="logging">
          <div class="section-title">Logging</div>
          <div class="card">
            <label class="field"><span class="lbl">Mod log channel</span>
              <select id="s-log_channel">${channelOptions(settings.log_channel)}</select></label>
          </div>
        </section>

        <section class="settings-panel ${activeTab === "presence" ? "active" : ""}" data-panel="presence">
          <div class="section-title">Bot presence (global)</div>
          <div class="card">
            <label class="field"><span class="lbl">Status</span>
              <select id="p-status">${["online", "idle", "dnd", "invisible"].map((s) =>
                `<option ${me.presence.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
            <label class="field"><span class="lbl">Activity</span>
              <select id="p-type">${["playing", "watching", "listening", "competing"].map((s) =>
                `<option ${me.presence.activity_type === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
            <label class="field"><span class="lbl">Activity text (empty = none)</span>
              <input id="p-text" value="${esc(me.presence.text)}"></label>
            <button class="btn full" id="save-presence">Update presence</button>
          </div>
        </section>

        <button class="btn primary full settings-save" id="save-settings">Save server settings</button>
      </div>
    </div>`;

  document.querySelectorAll("[data-settings-tab]").forEach((btn) => {
    btn.onclick = () => showSettingsPanel(btn.dataset.settingsTab);
  });

  $("#memory-view-btn").onclick = async () => {
    const m = await api(`/guilds/${state.guildId}/memory`);
    openModal(`
      <h2>${esc(botLabel(settings))}'s memory</h2>
      <div class="section-title">Durable (v${m.durable_version})</div>
      <pre style="white-space:pre-wrap;font-size:12.5px;max-height:30vh;overflow-y:auto">${esc(m.durable || "(empty)")}</pre>
      <div class="section-title">Working (v${m.working_version})</div>
      <pre style="white-space:pre-wrap;font-size:12.5px;max-height:30vh;overflow-y:auto">${esc(m.working || "(empty)")}</pre>
      <div class="btn-row"><button class="btn" onclick="closeModal()">Close</button></div>`);
  };
  $("#memory-wipe-btn").onclick = () =>
    confirmAction(`Erase everything ${botLabel(settings)} remembers about this server (working + durable)?`,
      async () => {
        await api(`/guilds/${state.guildId}/memory`, { method: "DELETE" });
        toast("Memory wiped");
      });

  $("#save-settings").onclick = async () => {
    const body = {
      welcome_channel: $("#s-welcome_channel").value || null,
      welcome_message: $("#s-welcome_message").value,
      goodbye_message: $("#s-goodbye_message").value,
      autorole: $("#s-autorole").value || null,
      automod_enabled: $("#s-automod_enabled").checked,
      block_invites: $("#s-block_invites").checked,
      banned_words: $("#s-banned_words").value.split(",").map((w) => w.trim()).filter(Boolean),
      max_mentions: parseInt($("#s-max_mentions").value, 10) || 0,
      antispam_enabled: $("#s-antispam_enabled").checked,
      antispam_channel_threshold: parseInt($("#s-antispam_channel_threshold").value, 10) || 4,
      antispam_window_seconds: parseInt($("#s-antispam_window_seconds").value, 10) || 20,
      antispam_delete_seconds: parseInt($("#s-antispam_delete_seconds").value, 10) || 0,
      ai_enabled: $("#s-ai_enabled").checked,
      ai_model: $("#s-ai_model").value.trim(),
      ai_utility_model: $("#s-ai_utility_model").value.trim(),
      media_enabled: $("#s-media_enabled").checked,
      media_access: $("#s-media_access").value,
      media_image_model: $("#s-media_image_model").value.trim(),
      media_vision_model: $("#s-media_vision_model").value.trim(),
      media_video_hourly_cap: parseInt($("#s-media_video_hourly_cap").value, 10) || 0,
      music_roles: [...$("#s-music_roles").selectedOptions].map((o) => o.value),
      music_curator_roles: [...$("#s-music_curator_roles").selectedOptions].map((o) => o.value),
      pressure_enabled: $("#s-pressure_enabled").checked,
      deesc_enabled: $("#s-deesc_enabled").checked,
      deesc_harsh_language: $("#s-deesc_harsh_language").checked,
      ai_channels: [...$("#s-ai_channels").selectedOptions].map((o) => o.value),
      voice_channel_allowlist: [...$("#s-voice_channel_allowlist").selectedOptions].map((o) => o.value),
      dashboard_admin_roles: [...$("#s-dashboard_admin_roles").selectedOptions].map((o) => o.value),
      dashboard_mod_roles: [...$("#s-dashboard_mod_roles").selectedOptions].map((o) => o.value),
      // Sent as the raw field text; the server parses the brackets (and still
      // accepts the old comma form, so nothing breaks mid-edit).
      voice_wake_words: $("#s-voice_wake_words").value,
      voice_cancel_words: $("#s-voice_cancel_words").value,
      voice_stop_speaking_words: $("#s-voice_stop_speaking_words").value,
      voice_stop_listening_words: $("#s-voice_stop_listening_words").value,
      voice_leave_words: $("#s-voice_leave_words").value,
      // Blank is meaningful: the server turns it back into null, i.e.
      // "follow the Discord application name".
      bot_name: $("#s-bot_name").value.trim(),
      fish_voice_id: $("#s-fish_voice_id").value.trim(),
      fish_tts_model: $("#s-fish_tts_model").value.trim(),
      edge_tts_voice: $("#s-edge_tts_voice").value.trim(),
      tts_strip_markdown: $("#s-tts_strip_markdown").checked,
      voice_detection_mode: $("#s-voice_detection_mode").value,
      voice_followup_enabled: $("#s-voice_followup_enabled").checked,
      voice_followup_window_sec: Math.max(0, parseInt($("#s-voice_followup_window_sec").value, 10) || 0),
      voice_cue_thinking: readCue("thinking"),
      voice_cue_engaging: readCue("engaging"),
      voice_cue_declined: readCue("declined"),
      voice_cue_stopped_listening: readCue("stopped_listening"),
      log_channel: $("#s-log_channel").value || null,
    };
    await api(`/guilds/${state.guildId}/settings`, { method: "PUT", body });
    toast("Settings saved");
  };

  $("#save-presence").onclick = async () => {
    await api("/presence", {
      method: "POST",
      body: {
        status: $("#p-status").value,
        activity_type: $("#p-type").value,
        text: $("#p-text").value.trim(),
      },
    });
    toast("Presence updated");
  };
}

/* expose for inline handlers */
window.closeModal = closeModal;

init();
