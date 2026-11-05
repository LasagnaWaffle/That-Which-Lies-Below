(() => {
  const cfg = window.TERMINAL_CONFIG || {};
  const STORAGE_KEY = "twlb-terminal";
  const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  // Commands only run when the input matches the key exactly (case, spaces and all).
  const COMMANDS = {
    "/reset": {
      description: "Clears the terminal, including all story text and your past messages.",
      run: resetTerminal,
    },
  };

  const screen = document.getElementById("screen");
  const output = document.getElementById("output");
  const form = document.getElementById("input-form");
  const input = document.getElementById("input");
  const drawer = document.getElementById("commands");
  const drawerToggle = document.getElementById("commands-toggle");
  const commandsList = document.getElementById("commands-list");

  let session = loadSession();
  let waiting = false;
  let spinner = null;
  // Bumped on /reset so in-flight replies and typing from the old session are dropped.
  let generation = 0;

  function newSessionId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function freshSession() {
    return { sessionId: newSessionId(), history: [], storyState: null };
  }

  function loadSession() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && saved.sessionId && Array.isArray(saved.history)) return saved;
    } catch {}
    return freshSession();
  }

  function saveSession() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch {}
  }

  // ---------- Output ----------

  function isNearBottom() {
    return output.scrollHeight - output.scrollTop - output.clientHeight < 40;
  }

  function scrollToBottom() {
    output.scrollTop = output.scrollHeight;
  }

  function appendLine(role, text) {
    const line = document.createElement("div");
    line.className = `line ${role}`;
    line.textContent = text;
    output.appendChild(line);
    scrollToBottom();
    return line;
  }

  function addMessage(role, text) {
    session.history.push({ role, text });
    saveSession();
    return appendLine(role, text);
  }

  function typeLine(text, gen) {
    const line = appendLine("ai", "");
    const cps = Number(cfg.TYPE_CHARS_PER_SECOND) || 0;
    if (cps <= 0) {
      line.textContent = text;
      scrollToBottom();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const start = performance.now();
      const step = (now) => {
        if (gen !== generation) return resolve();
        const stick = isNearBottom();
        const count = Math.min(text.length, Math.floor(((now - start) / 1000) * cps));
        line.textContent = text.slice(0, count);
        if (stick) scrollToBottom();
        if (count < text.length) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  function startSpinner() {
    stopSpinner();
    const line = appendLine("spinner", SPINNER_FRAMES[0]);
    let frame = 0;
    const timer = setInterval(() => {
      frame = (frame + 1) % SPINNER_FRAMES.length;
      line.textContent = SPINNER_FRAMES[frame];
    }, 80);
    spinner = { line, timer };
  }

  function stopSpinner() {
    if (!spinner) return;
    clearInterval(spinner.timer);
    spinner.line.remove();
    spinner = null;
  }

  function setWaiting(value) {
    waiting = value;
    screen.classList.toggle("waiting", value);
  }

  // ---------- n8n ----------

  function extractReply(raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return raw;
    }
    if (Array.isArray(data)) data = data[0];
    if (typeof data === "string") return data;
    if (data && typeof data === "object") {
      for (const key of ["output", "text", "response", "reply", "message"]) {
        if (typeof data[key] === "string") return data[key];
      }
    }
    return raw;
  }

  function splitState(text) {
    const startMarker = cfg.STATE_START;
    const endMarker = cfg.STATE_END;
    const start = startMarker ? text.indexOf(startMarker) : -1;
    if (start === -1) return { visible: text.trim(), hidden: null };

    const afterStart = start + startMarker.length;
    const end = endMarker ? text.indexOf(endMarker, afterStart) : -1;
    const hidden = text.slice(afterStart, end === -1 ? undefined : end).trim();
    const after = end === -1 ? "" : text.slice(end + endMarker.length);
    return { visible: (text.slice(0, start) + after).trim(), hidden };
  }

  async function requestStory(message) {
    const gen = generation;
    setWaiting(true);
    startSpinner();

    let reply;
    try {
      if (!cfg.WEBHOOK_URL) throw new Error("No n8n webhook URL is set in config.js.");
      const res = await fetch(cfg.WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: session.sessionId,
          chatInput: message,
          storyState: session.storyState,
        }),
      });
      if (!res.ok) throw new Error(`n8n responded with status ${res.status}.`);
      reply = extractReply(await res.text());
    } catch (err) {
      if (gen !== generation) return;
      stopSpinner();
      setWaiting(false);
      appendLine("system", `[connection error] ${err.message}`);
      return;
    }

    if (gen !== generation) return;
    stopSpinner();

    const { visible, hidden } = splitState(reply);
    if (hidden) session.storyState = hidden;
    session.history.push({ role: "ai", text: visible });
    saveSession();

    await typeLine(visible, gen);
    if (gen === generation) setWaiting(false);
  }

  // ---------- Commands ----------

  function resetTerminal() {
    generation++;
    stopSpinner();
    setWaiting(false);
    output.textContent = "";
    session = freshSession();
    saveSession();
    boot();
  }

  function renderCommands() {
    for (const [name, { description }] of Object.entries(COMMANDS)) {
      const item = document.createElement("li");
      const nameEl = document.createElement("span");
      nameEl.className = "command-name";
      nameEl.textContent = name;
      const descEl = document.createElement("span");
      descEl.className = "command-desc";
      descEl.textContent = description;
      item.append(nameEl, descEl);
      commandsList.appendChild(item);
    }
  }

  function setDrawer(open) {
    drawer.classList.toggle("open", open);
    drawerToggle.setAttribute("aria-expanded", String(open));
    drawerToggle.setAttribute("aria-label", open ? "Hide commands" : "Show commands");
    drawerToggle.innerHTML = open ? "&#9654;" : "&#9664;";
  }

  // ---------- Wiring ----------

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value;

    if (Object.prototype.hasOwnProperty.call(COMMANDS, text)) {
      input.value = "";
      COMMANDS[text].run();
      return;
    }

    if (waiting || text.trim() === "") return;
    input.value = "";
    addMessage("user", text);
    requestStory(text);
  });

  screen.addEventListener("click", () => {
    if (!window.getSelection().toString()) input.focus();
  });

  drawerToggle.addEventListener("click", () => {
    setDrawer(!drawer.classList.contains("open"));
  });

  function boot() {
    if (cfg.START_MESSAGE) requestStory(cfg.START_MESSAGE);
  }

  renderCommands();
  for (const { role, text } of session.history) appendLine(role, text);
  if (session.history.length === 0) boot();
  input.focus();
})();
