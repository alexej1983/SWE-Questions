// SWE-Questions admin — single-page app.
//
// Configure once, then deploy as a static site (e.g. GitHub Pages).
// See README.md for the OAuth App + Cloudflare Worker setup.

const CONFIG = {
  owner: "alexej1983",
  repo: "SWE-Questions",
  branch: "main",
  manifestPath: "manifest.json",
  // GitHub OAuth App client ID (public — safe to ship in the bundle).
  clientId: "REPLACE_WITH_YOUR_GITHUB_OAUTH_CLIENT_ID",
  // Cloudflare Worker (or other proxy) that forwards the two OAuth endpoints with CORS.
  oauthProxy: "https://REPLACE_WITH_YOUR_WORKER.workers.dev",
  // Scope needed to commit. `public_repo` is enough for a public repo; use `repo` for private.
  scope: "public_repo",
};

const TOKEN_KEY = "swe_admin_token";

// ---------- Tiny DOM helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "html") node.innerHTML = v;
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
};
const show = (node) => node.classList.remove("hidden");
const hide = (node) => node.classList.add("hidden");
const toast = (msg, kind = "info") => {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast ${kind}`;
  show(t);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => hide(t), 3500);
};

// ---------- App state ----------
const state = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  user: null,
  manifest: null, // { version, topics: { key: version } }
  manifestSha: null,
  topics: {}, // key -> { questions, sha, dirty, originalJson }
  currentTopic: null,
  editingQuestionId: null,
};

// ---------- GitHub API ----------
const gh = {
  async req(path, opts = {}) {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers || {}),
    };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    if (opts.body && typeof opts.body !== "string") {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(`https://api.github.com${path}`, { ...opts, headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub ${res.status}: ${text}`);
    }
    return res.status === 204 ? null : res.json();
  },
  me() {
    return this.req("/user");
  },
  getContents(path) {
    return this.req(
      `/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${encodeURIComponent(path)}?ref=${CONFIG.branch}`,
    );
  },
  putContents(path, { message, content, sha }) {
    return this.req(`/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${encodeURIComponent(path)}`, {
      method: "PUT",
      body: { message, content, sha, branch: CONFIG.branch },
    });
  },
};

// base64 helpers that handle UTF-8 (Swedish characters!) correctly.
const b64encode = (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str)));
const b64decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

// ---------- OAuth device flow (via proxy) ----------
const oauth = {
  async startDeviceFlow() {
    const res = await fetch(`${CONFIG.oauthProxy}/login/device/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: CONFIG.clientId, scope: CONFIG.scope }),
    });
    if (!res.ok) throw new Error(`device code: ${res.status}`);
    return res.json(); // { device_code, user_code, verification_uri, expires_in, interval }
  },
  async pollForToken({ device_code, interval }, onTick) {
    const pollMs = Math.max(5, interval || 5) * 1000;
    // GitHub may extend the interval via slow_down; respect it.
    let currentInterval = pollMs;
    while (true) {
      await new Promise((r) => setTimeout(r, currentInterval));
      const res = await fetch(`${CONFIG.oauthProxy}/login/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: CONFIG.clientId,
          device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
      const data = await res.json();
      if (data.access_token) return data.access_token;
      if (data.error === "authorization_pending") {
        onTick && onTick("Waiting for you to authorize…");
        continue;
      }
      if (data.error === "slow_down") {
        currentInterval += 5000;
        continue;
      }
      if (data.error === "expired_token") throw new Error("Code expired. Try signing in again.");
      if (data.error === "access_denied") throw new Error("Authorization denied.");
      throw new Error(data.error_description || data.error || "OAuth failed");
    }
  },
};

// ---------- Data loading ----------
async function loadManifest() {
  const file = await gh.getContents(CONFIG.manifestPath);
  state.manifest = JSON.parse(b64decode(file.content));
  state.manifestSha = file.sha;
}

async function loadTopic(key) {
  if (state.topics[key]) return state.topics[key];
  const path = `${key}.json`;
  const file = await gh.getContents(path);
  const json = b64decode(file.content);
  const questions = JSON.parse(json);
  state.topics[key] = {
    questions,
    sha: file.sha,
    dirty: false,
    originalJson: json,
  };
  return state.topics[key];
}

function markDirty(key) {
  const t = state.topics[key];
  if (!t) return;
  const currentJson = serializeQuestions(t.questions);
  t.dirty = currentJson !== t.originalJson;
  renderDirtyState();
  renderTopicList();
}

function serializeQuestions(questions) {
  // Match the repo's existing formatting: 2-space indent, trailing newline.
  return JSON.stringify(questions, null, 2) + "\n";
}

function dirtyTopics() {
  return Object.entries(state.topics)
    .filter(([, t]) => t.dirty)
    .map(([key]) => key);
}

// ---------- Render: topbar / auth ----------
function renderAuth() {
  $("#repo-label").textContent = `${CONFIG.owner}/${CONFIG.repo}`;
  const status = $("#auth-status");
  const signin = $("#signin-btn");
  const signout = $("#signout-btn");
  if (state.user) {
    status.textContent = `signed in as @${state.user.login}`;
    status.classList.remove("muted");
    hide(signin);
    show(signout);
    show($("#app"));
  } else {
    status.textContent = "not signed in";
    status.classList.add("muted");
    show(signin);
    hide(signout);
    hide($("#app"));
  }
}

// ---------- Render: sidebar ----------
function renderTopicList() {
  const list = $("#topic-list");
  list.innerHTML = "";
  if (!state.manifest) return;
  $("#manifest-version").textContent = `v${state.manifest.version}`;
  const entries = Object.entries(state.manifest.topics).sort(([a], [b]) => a.localeCompare(b));
  for (const [key, version] of entries) {
    const isActive = key === state.currentTopic;
    const isDirty = state.topics[key]?.dirty;
    const li = el(
      "li",
      {
        class: `topic-item${isActive ? " active" : ""}${isDirty ? " dirty" : ""}`,
        onclick: () => selectTopic(key),
      },
      [
        el("span", { class: "topic-name" }, key),
        el("span", { class: "topic-version" }, `v${version}`),
      ],
    );
    list.appendChild(li);
  }
}

// ---------- Render: question list ----------
function renderQuestions() {
  const container = $("#questions");
  container.innerHTML = "";
  const key = state.currentTopic;
  if (!key) {
    hide(container);
    show($("#empty-state"));
    $("#topic-title").textContent = "Select a topic";
    $("#topic-meta").textContent = "";
    $("#add-question-btn").disabled = true;
    return;
  }
  hide($("#empty-state"));
  show(container);
  const t = state.topics[key];
  $("#topic-title").textContent = key;
  $("#topic-meta").textContent =
    `${t.questions.length} question${t.questions.length === 1 ? "" : "s"} · v${state.manifest.topics[key]}`;
  $("#add-question-btn").disabled = false;

  t.questions.forEach((q, idx) => {
    const card = el("article", { class: "qcard", dataset: { id: String(q.id) } }, [
      el("header", { class: "qcard-header" }, [
        el("span", { class: "qcard-num" }, `#${q.id}`),
        el("span", { class: `pill diff-${q.difficulty}` }, q.difficulty || "—"),
        el("div", { class: "qcard-actions" }, [
          el("button", { class: "btn ghost small", onclick: () => openQuestionModal(q.id) }, "Edit"),
          el(
            "button",
            { class: "btn danger small", onclick: () => deleteQuestion(q.id) },
            "Delete",
          ),
        ]),
      ]),
      el("p", { class: "qcard-q" }, q.question),
      el(
        "ol",
        { class: "qcard-opts" },
        q.options.map((opt, i) =>
          el("li", { class: i === q.correctIndex ? "correct" : "" }, opt),
        ),
      ),
      el("p", { class: "qcard-exp muted" }, q.explanation),
    ]);
    container.appendChild(card);
  });
}

function renderDirtyState() {
  const dirty = dirtyTopics();
  $("#publish-btn").disabled = dirty.length === 0;
  const banner = $("#dirty-banner");
  if (dirty.length) {
    banner.querySelector("span").textContent =
      `Unpublished changes in: ${dirty.join(", ")}`;
    show(banner);
  } else {
    hide(banner);
  }
}

// ---------- Actions ----------
async function selectTopic(key) {
  state.currentTopic = key;
  try {
    await loadTopic(key);
    renderTopicList();
    renderQuestions();
  } catch (e) {
    toast(`Failed to load ${key}: ${e.message}`, "error");
  }
}

function nextQuestionId(questions) {
  return questions.reduce((max, q) => Math.max(max, q.id || 0), 0) + 1;
}

function openQuestionModal(id) {
  const t = state.topics[state.currentTopic];
  if (!t) return;
  state.editingQuestionId = id;
  const q =
    id == null
      ? { question: "", options: ["", "", "", ""], correctIndex: 0, explanation: "", difficulty: "easy" }
      : t.questions.find((q) => q.id === id);
  if (!q) return;
  const form = $("#question-form");
  form.question.value = q.question;
  form.option0.value = q.options[0] || "";
  form.option1.value = q.options[1] || "";
  form.option2.value = q.options[2] || "";
  form.option3.value = q.options[3] || "";
  form.correctIndex.value = String(q.correctIndex);
  form.difficulty.value = q.difficulty || "easy";
  form.explanation.value = q.explanation || "";
  $("#question-modal-title").textContent = id == null ? "Add question" : `Edit question #${id}`;
  show($("#question-modal"));
}

function closeQuestionModal() {
  hide($("#question-modal"));
  state.editingQuestionId = null;
}

function saveQuestionFromForm(form) {
  const t = state.topics[state.currentTopic];
  if (!t) return;
  const payload = {
    question: form.question.value.trim(),
    options: [
      form.option0.value.trim(),
      form.option1.value.trim(),
      form.option2.value.trim(),
      form.option3.value.trim(),
    ],
    correctIndex: Number(form.correctIndex.value),
    explanation: form.explanation.value.trim(),
    difficulty: form.difficulty.value,
  };
  if (state.editingQuestionId == null) {
    const id = nextQuestionId(t.questions);
    t.questions.push({ id, ...payload });
  } else {
    const idx = t.questions.findIndex((q) => q.id === state.editingQuestionId);
    if (idx !== -1) t.questions[idx] = { id: state.editingQuestionId, ...payload };
  }
  markDirty(state.currentTopic);
  renderQuestions();
  closeQuestionModal();
}

function deleteQuestion(id) {
  const t = state.topics[state.currentTopic];
  if (!t) return;
  if (!confirm(`Delete question #${id}?`)) return;
  t.questions = t.questions.filter((q) => q.id !== id);
  markDirty(state.currentTopic);
  renderQuestions();
}

function discardChanges() {
  const dirty = dirtyTopics();
  if (!dirty.length) return;
  if (!confirm(`Discard unpublished changes in ${dirty.join(", ")}?`)) return;
  for (const key of dirty) {
    delete state.topics[key];
  }
  if (state.currentTopic && !state.topics[state.currentTopic]) {
    selectTopic(state.currentTopic);
  } else {
    renderTopicList();
    renderQuestions();
  }
  renderDirtyState();
}

// ---------- Publish ----------
function openPublishModal() {
  const dirty = dirtyTopics();
  if (!dirty.length) return;
  $("#publish-repo").textContent = `${CONFIG.owner}/${CONFIG.repo}@${CONFIG.branch}`;
  const summary = $("#publish-summary");
  summary.innerHTML = "";
  for (const key of dirty) {
    const oldV = Number(state.manifest.topics[key]) || 0;
    summary.appendChild(
      el("li", {}, `${key}.json + manifest (${key}: v${oldV} → v${oldV + 1})`),
    );
  }
  const totalV = Number(state.manifest.version) || 0;
  summary.appendChild(el("li", {}, `manifest version: v${totalV} → v${totalV + 1}`));
  $("#publish-message").value = `Update ${dirty.join(", ")}`;
  $("#publish-status").textContent = "";
  show($("#publish-modal"));
}

async function publish() {
  const dirty = dirtyTopics();
  if (!dirty.length) return;
  const msg = $("#publish-message").value.trim() || `Update ${dirty.join(", ")}`;
  const statusEl = $("#publish-status");
  const confirmBtn = $("#publish-confirm-btn");
  confirmBtn.disabled = true;

  try {
    // 1) Push each dirty topic file.
    for (const key of dirty) {
      statusEl.textContent = `Committing ${key}.json…`;
      const t = state.topics[key];
      const content = serializeQuestions(t.questions);
      const res = await gh.putContents(`${key}.json`, {
        message: `${msg} (${key})`,
        content: b64encode(content),
        sha: t.sha,
      });
      t.sha = res.content.sha;
      t.originalJson = content;
      t.dirty = false;
    }

    // 2) Bump versions and push manifest.
    statusEl.textContent = "Updating manifest…";
    const m = state.manifest;
    m.version = String((Number(m.version) || 0) + 1);
    for (const key of dirty) {
      m.topics[key] = String((Number(m.topics[key]) || 0) + 1);
    }
    const manifestContent = JSON.stringify(m, null, 2) + "\n";
    const mRes = await gh.putContents(CONFIG.manifestPath, {
      message: `${msg} (manifest v${m.version})`,
      content: b64encode(manifestContent),
      sha: state.manifestSha,
    });
    state.manifestSha = mRes.content.sha;

    statusEl.textContent = "Done.";
    toast("Published.", "success");
    hide($("#publish-modal"));
    renderTopicList();
    renderQuestions();
    renderDirtyState();
  } catch (e) {
    statusEl.textContent = `Failed: ${e.message}`;
    toast(`Publish failed: ${e.message}`, "error");
  } finally {
    confirmBtn.disabled = false;
  }
}

// ---------- New topic ----------
function openTopicModal() {
  $("#topic-form").reset();
  $("#topic-filename-preview").textContent = "name.json";
  show($("#topic-modal"));
}

async function createTopic(key) {
  if (state.manifest.topics[key] != null) {
    throw new Error(`Topic "${key}" already exists.`);
  }
  // Create the file with [] and bump manifest.
  const content = "[]\n";
  const fileRes = await gh.putContents(`${key}.json`, {
    message: `Create topic ${key}`,
    content: b64encode(content),
  });
  state.topics[key] = {
    questions: [],
    sha: fileRes.content.sha,
    dirty: false,
    originalJson: content,
  };
  const m = state.manifest;
  m.version = String((Number(m.version) || 0) + 1);
  m.topics[key] = "1";
  const manifestContent = JSON.stringify(m, null, 2) + "\n";
  const mRes = await gh.putContents(CONFIG.manifestPath, {
    message: `Add topic ${key} to manifest`,
    content: b64encode(manifestContent),
    sha: state.manifestSha,
  });
  state.manifestSha = mRes.content.sha;
}

// ---------- Sign in / out ----------
async function signIn() {
  if (CONFIG.clientId.startsWith("REPLACE_") || CONFIG.oauthProxy.includes("REPLACE_")) {
    toast("Configure clientId and oauthProxy in app.js first. See README.", "error");
    return;
  }
  try {
    const code = await oauth.startDeviceFlow();
    $("#device-code").textContent = code.user_code;
    $("#device-url").href = code.verification_uri;
    $("#device-url").textContent = code.verification_uri;
    $("#device-status").textContent = "Waiting for you to authorize…";
    show($("#device-modal"));
    const token = await oauth.pollForToken(code, (msg) => {
      $("#device-status").textContent = msg;
    });
    localStorage.setItem(TOKEN_KEY, token);
    state.token = token;
    hide($("#device-modal"));
    await afterSignIn();
  } catch (e) {
    $("#device-status").textContent = e.message;
    toast(`Sign-in failed: ${e.message}`, "error");
  }
}

function signOut() {
  localStorage.removeItem(TOKEN_KEY);
  state.token = null;
  state.user = null;
  state.manifest = null;
  state.manifestSha = null;
  state.topics = {};
  state.currentTopic = null;
  renderAuth();
}

async function afterSignIn() {
  try {
    state.user = await gh.me();
    renderAuth();
    await loadManifest();
    renderTopicList();
    renderQuestions();
    renderDirtyState();
  } catch (e) {
    toast(`Failed to load repo: ${e.message}`, "error");
    if (String(e.message).startsWith("GitHub 401")) signOut();
  }
}

// ---------- Wire up ----------
function init() {
  renderAuth();

  $("#signin-btn").addEventListener("click", signIn);
  $("#signout-btn").addEventListener("click", signOut);

  $("#device-cancel-btn").addEventListener("click", () => hide($("#device-modal")));
  $("#copy-code-btn").addEventListener("click", () => {
    navigator.clipboard.writeText($("#device-code").textContent);
    toast("Code copied.");
  });

  $("#add-question-btn").addEventListener("click", () => openQuestionModal(null));
  $("#question-cancel-btn").addEventListener("click", closeQuestionModal);
  $("#question-form").addEventListener("submit", (e) => {
    e.preventDefault();
    saveQuestionFromForm(e.target);
  });

  $("#publish-btn").addEventListener("click", openPublishModal);
  $("#publish-cancel-btn").addEventListener("click", () => hide($("#publish-modal")));
  $("#publish-confirm-btn").addEventListener("click", publish);
  $("#discard-btn").addEventListener("click", discardChanges);

  $("#add-topic-btn").addEventListener("click", openTopicModal);
  $("#topic-cancel-btn").addEventListener("click", () => hide($("#topic-modal")));
  $("#topic-form").addEventListener("input", (e) => {
    if (e.target.name === "key") {
      $("#topic-filename-preview").textContent = `${e.target.value || "name"}.json`;
    }
  });
  $("#topic-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = e.target.key.value.trim();
    try {
      await createTopic(key);
      hide($("#topic-modal"));
      renderTopicList();
      selectTopic(key);
      toast(`Topic ${key} created.`, "success");
    } catch (err) {
      toast(err.message, "error");
    }
  });

  // Close modal when clicking its backdrop.
  $$(".modal").forEach((modal) => {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) hide(modal);
    });
  });

  if (state.token) afterSignIn();
}

init();
