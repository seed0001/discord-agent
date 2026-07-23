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

function showLogin() {
  $("#app").classList.add("hidden");
  $("#login-screen").classList.remove("hidden");
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
  const renderers = {
    overview: renderOverview,
    members: renderMembers,
    server: renderServer,
    mod: renderMod,
    settings: renderSettings,
  };
  content().innerHTML = `<div class="card"><p class="muted">Loading…</p></div>`;
  renderers[state.tab]().catch((e) => console.error(e));
}

/* ---------- overview ---------- */

async function renderOverview() {
  const [g, me] = await Promise.all([api(`/guilds/${state.guildId}`), api("/me")]);
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
      <div class="muted">${me.guild_count} server(s) · ${me.latency_ms}ms</div></div>
      <span class="badge ok">online</span>
    </div>`;
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

async function renderSettings() {
  const [settings, channels, roles, me] = await Promise.all([
    api(`/guilds/${state.guildId}/settings`),
    api(`/guilds/${state.guildId}/channels`),
    api(`/guilds/${state.guildId}/roles`),
    api("/me"),
  ]);
  const textChannels = channels.filter((c) => c.type === "text");
  const channelOptions = (selected) =>
    `<option value="">— none —</option>` + textChannels.map((c) =>
      `<option value="${c.id}" ${String(selected) === c.id ? "selected" : ""}>#${esc(c.name)}</option>`).join("");
  const roleOptions = (selected) =>
    `<option value="">— none —</option>` + roles.filter((r) => !r.managed).map((r) =>
      `<option value="${r.id}" ${String(selected) === r.id ? "selected" : ""}>${esc(r.name)}</option>`).join("");

  content().innerHTML = `
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

    <div class="section-title">AI (OpenRouter)</div>
    <div class="card">
      <label class="toggle"><input type="checkbox" id="s-ai_enabled"
        ${settings.ai_enabled ? "checked" : ""}> Enable AI replies</label>
      <label class="field"><span class="lbl">Model</span>
        <input id="s-ai_model" value="${esc(settings.ai_model)}" placeholder="anthropic/claude-3.5-haiku"></label>
      <label class="field"><span class="lbl">System prompt</span>
        <textarea id="s-ai_system_prompt">${esc(settings.ai_system_prompt)}</textarea></label>
      <label class="field"><span class="lbl">Always-on AI channels (replies to every message)</span>
        <select id="s-ai_channels" multiple size="5">${textChannels.map((c) =>
          `<option value="${c.id}" ${(settings.ai_channels || []).map(String).includes(c.id) ? "selected" : ""}>#${esc(c.name)}</option>`).join("")}</select>
        <span class="muted">The bot always replies when @mentioned, in any channel.</span></label>
    </div>

    <div class="section-title">Logging</div>
    <div class="card">
      <label class="field"><span class="lbl">Mod log channel</span>
        <select id="s-log_channel">${channelOptions(settings.log_channel)}</select></label>
    </div>

    <button class="btn primary full" id="save-settings">Save server settings</button>

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
    </div>`;

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
      ai_enabled: $("#s-ai_enabled").checked,
      ai_model: $("#s-ai_model").value.trim(),
      ai_system_prompt: $("#s-ai_system_prompt").value,
      ai_channels: [...$("#s-ai_channels").selectedOptions].map((o) => o.value),
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
