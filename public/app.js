const STORAGE_KEYS = {
  clientId: "question-impostor-client-id",
  session: "question-impostor-session",
};

const socket = io();

const state = {
  clientId: getOrCreateClientId(),
  currentView: "home",
  currentPanel: "create",
  playerName: "",
  lobbyCode: "",
  lobbyState: null,
  autoJoinInFlight: false,
};

const elements = {
  homeScreen: document.getElementById("homeScreen"),
  lobbyScreen: document.getElementById("lobbyScreen"),
  showCreateBtn: document.getElementById("showCreateBtn"),
  showJoinBtn: document.getElementById("showJoinBtn"),
  createForm: document.getElementById("createForm"),
  joinForm: document.getElementById("joinForm"),
  createNameInput: document.getElementById("createNameInput"),
  joinNameInput: document.getElementById("joinNameInput"),
  joinCodeInput: document.getElementById("joinCodeInput"),
  lobbyTitle: document.getElementById("lobbyTitle"),
  lobbyCodeText: document.getElementById("lobbyCodeText"),
  playerCountText: document.getElementById("playerCountText"),
  playersList: document.getElementById("playersList"),
  hostControls: document.getElementById("hostControls"),
  startGameBtn: document.getElementById("startGameBtn"),
  nextRoundBtn: document.getElementById("nextRoundBtn"),
  restartGameBtn: document.getElementById("restartGameBtn"),
  roundTitle: document.getElementById("roundTitle"),
  questionBox: document.getElementById("questionBox"),
  questionStatus: document.getElementById("questionStatus"),
  questionText: document.getElementById("questionText"),
  revealQuestionBtn: document.getElementById("revealQuestionBtn"),
  connectionStatus: document.getElementById("connectionStatus"),
  toastStack: document.getElementById("toastStack"),
  copyCodeBtn: document.getElementById("copyCodeBtn"),
  leaveLobbyBtn: document.getElementById("leaveLobbyBtn"),
};

function getOrCreateClientId() {
  let clientId = sessionStorage.getItem(STORAGE_KEYS.clientId);

  if (!clientId) {
    clientId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    sessionStorage.setItem(STORAGE_KEYS.clientId, clientId);
  }

  return clientId;
}

function getSavedSession() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEYS.session);
    return raw ? JSON.parse(raw) : null;
  } catch (_error) {
    return null;
  }
}

function saveSession(playerName, lobbyCode) {
  sessionStorage.setItem(
    STORAGE_KEYS.session,
    JSON.stringify({
      playerName,
      lobbyCode,
    })
  );
}

function clearSavedSession() {
  sessionStorage.removeItem(STORAGE_KEYS.session);
}

function normalizeName(name) {
  return String(name || "").trim().replace(/\s+/g, " ").slice(0, 24);
}

function normalizeCode(code) {
  return String(code || "").trim().toUpperCase().slice(0, 6);
}

function switchPanel(panel) {
  state.currentPanel = panel;
  elements.createForm.classList.toggle("hidden", panel !== "create");
  elements.joinForm.classList.toggle("hidden", panel !== "join");
  elements.createForm.classList.toggle("active", panel === "create");
  elements.joinForm.classList.toggle("active", panel === "join");
}

function switchScreen(view) {
  state.currentView = view;
  elements.homeScreen.classList.toggle("active", view === "home");
  elements.lobbyScreen.classList.toggle("active", view === "lobby");
}

function setButtonsDisabled(disabled) {
  [
    elements.showCreateBtn,
    elements.showJoinBtn,
    elements.startGameBtn,
    elements.nextRoundBtn,
    elements.restartGameBtn,
    elements.revealQuestionBtn,
    elements.copyCodeBtn,
    elements.leaveLobbyBtn,
  ].forEach((button) => {
    button.disabled = disabled;
  });
}

function showToast(message, variant = "default") {
  const toast = document.createElement("div");
  toast.className = `toast ${variant}`.trim();
  toast.textContent = message;
  elements.toastStack.appendChild(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 3200);
}

function setConnectionStatus(label, tone = "neutral") {
  elements.connectionStatus.textContent = label;

  if (tone === "success") {
    elements.connectionStatus.style.color = "var(--success)";
  } else if (tone === "warning") {
    elements.connectionStatus.style.color = "var(--warning)";
  } else {
    elements.connectionStatus.style.color = "var(--muted)";
  }
}

function getMeIsHost() {
  return state.lobbyState && state.lobbyState.hostId === state.clientId;
}

function renderPlayers(players) {
  elements.playersList.innerHTML = "";

  players.forEach((player) => {
    const item = document.createElement("div");
    item.className = "player-item";

    const meta = document.createElement("div");
    meta.className = "player-meta";

    const avatar = document.createElement("div");
    avatar.className = "player-avatar";
    avatar.textContent = player.name.slice(0, 1).toUpperCase();

    const nameWrap = document.createElement("div");
    nameWrap.className = "player-name-wrap";

    const nameText = document.createElement("div");
    nameText.className = "player-name";
    nameText.textContent = player.name;

    const stateText = document.createElement("div");
    stateText.className = "player-state";
    stateText.textContent = player.connected ? "Connected" : "Reconnecting...";

    nameWrap.appendChild(nameText);
    nameWrap.appendChild(stateText);
    meta.appendChild(avatar);
    meta.appendChild(nameWrap);

    const badges = document.createElement("div");
    badges.className = "badge-row";

    if (player.isHost) {
      const hostBadge = document.createElement("span");
      hostBadge.className = "host-badge";
      hostBadge.textContent = "Host";
      badges.appendChild(hostBadge);
    }

    if (player.id === state.clientId) {
      const youBadge = document.createElement("span");
      youBadge.className = "you-badge";
      youBadge.textContent = "You";
      badges.appendChild(youBadge);
    }

    if (!player.connected) {
      const offlineBadge = document.createElement("span");
      offlineBadge.className = "offline-badge";
      offlineBadge.textContent = "Offline";
      badges.appendChild(offlineBadge);
    }

    item.appendChild(meta);
    item.appendChild(badges);
    elements.playersList.appendChild(item);
  });
}

function renderQuestionPanel() {
  const lobbyState = state.lobbyState;
  if (!lobbyState || !lobbyState.gameStarted) {
    elements.roundTitle.textContent = "Waiting to start";
    elements.questionStatus.textContent = "Question hidden";
    elements.questionText.textContent =
      "Start the game to get your prompt, then reveal it whenever you want.";
    elements.questionBox.classList.add("hidden-state");
    elements.revealQuestionBtn.disabled = true;
    return;
  }

  elements.roundTitle.textContent = `Round ${lobbyState.roundNumber}`;

  if (lobbyState.hasRevealed && lobbyState.question) {
    elements.questionStatus.textContent = "Question revealed";
    elements.questionText.textContent = lobbyState.question;
    elements.questionBox.classList.remove("hidden-state");
    elements.revealQuestionBtn.disabled = true;
    return;
  }

  elements.questionStatus.textContent = "Question hidden";
  elements.questionText.textContent =
    "Your question is ready. Reveal it only when you want to see your private prompt.";
  elements.questionBox.classList.add("hidden-state");
  elements.revealQuestionBtn.disabled = !lobbyState.canReveal;
}

function renderHostControls() {
  const isHost = getMeIsHost();
  const gameStarted = Boolean(state.lobbyState && state.lobbyState.gameStarted);

  elements.hostControls.classList.toggle("hidden", !isHost);
  elements.startGameBtn.style.display = isHost && !gameStarted ? "" : "none";
  elements.nextRoundBtn.style.display = isHost && gameStarted ? "" : "none";
  elements.restartGameBtn.style.display = isHost ? "" : "none";
}

function renderLobby() {
  const lobbyState = state.lobbyState;
  if (!lobbyState) {
    return;
  }

  switchScreen("lobby");
  elements.lobbyTitle.textContent = `Lobby ${lobbyState.code}`;
  elements.lobbyCodeText.textContent = lobbyState.code;
  elements.playerCountText.textContent = `${lobbyState.players.length} / 20`;
  renderPlayers(lobbyState.players);
  renderHostControls();
  renderQuestionPanel();
}

function resetLocalLobby() {
  state.lobbyState = null;
  state.playerName = "";
  state.lobbyCode = "";
}

function applyJoinedLobby(playerName, lobbyCode) {
  state.playerName = playerName;
  state.lobbyCode = lobbyCode;
  saveSession(playerName, lobbyCode);
  switchScreen("lobby");
}

function emitWithAck(eventName, payload) {
  return new Promise((resolve) => {
    socket.emit(eventName, payload, (response) => {
      resolve(response || { ok: false, message: "No response from server." });
    });
  });
}

async function submitCreateLobby(event) {
  event.preventDefault();
  const playerName = normalizeName(elements.createNameInput.value);

  if (!playerName) {
    showToast("Enter a player name first.", "error");
    return;
  }

  const response = await emitWithAck("createLobby", {
    playerName,
    clientId: state.clientId,
  });

  if (!response.ok) {
    showToast(response.message || "Unable to create lobby.", "error");
    return;
  }

  applyJoinedLobby(playerName, response.code);
  showToast(`Lobby ${response.code} created.`, "success");
}

async function submitJoinLobby(event) {
  event.preventDefault();
  const playerName = normalizeName(elements.joinNameInput.value);
  const lobbyCode = normalizeCode(elements.joinCodeInput.value);

  if (!playerName || !lobbyCode) {
    showToast("Enter your name and a lobby code.", "error");
    return;
  }

  const response = await emitWithAck("joinLobby", {
    playerName,
    lobbyCode,
    clientId: state.clientId,
  });

  if (!response.ok) {
    showToast(response.message || "Unable to join lobby.", "error");
    return;
  }

  applyJoinedLobby(playerName, lobbyCode);
  showToast(`Joined lobby ${lobbyCode}.`, "success");
}

async function resumeLobbyIfNeeded() {
  if (state.autoJoinInFlight || state.lobbyState) {
    return;
  }

  const savedSession = getSavedSession();
  if (!savedSession || !savedSession.playerName || !savedSession.lobbyCode) {
    return;
  }

  state.autoJoinInFlight = true;

  const response = await emitWithAck("joinLobby", {
    playerName: savedSession.playerName,
    lobbyCode: savedSession.lobbyCode,
    clientId: state.clientId,
  });

  state.autoJoinInFlight = false;

  if (!response.ok) {
    clearSavedSession();
    switchScreen("home");
    setConnectionStatus("Connected", "success");
    if (response.message) {
      showToast(response.message, "error");
    }
    return;
  }

  state.playerName = savedSession.playerName;
  state.lobbyCode = savedSession.lobbyCode;
  switchScreen("lobby");
  showToast(`Rejoined lobby ${savedSession.lobbyCode}.`, "success");
}

async function handleRevealQuestion() {
  const response = await emitWithAck("revealQuestion");

  if (!response.ok) {
    showToast(response.message || "Unable to reveal your question.", "error");
    return;
  }

  showToast("Your question is revealed only on your device.", "success");
}

async function handleStartGame() {
  const response = await emitWithAck("startGame");

  if (!response.ok) {
    showToast(response.message || "Unable to start the game.", "error");
    return;
  }

  showToast("Game started.", "success");
}

async function handleNextRound() {
  const response = await emitWithAck("nextRound");

  if (!response.ok) {
    showToast(response.message || "Unable to start the next round.", "error");
    return;
  }

  showToast("Next round started.", "success");
}

async function handleRestartGame() {
  const response = await emitWithAck("restartGame");

  if (!response.ok) {
    showToast(response.message || "Unable to restart the game.", "error");
    return;
  }

  showToast("Game reset. All question pairs are available again.", "success");
}

async function handleCopyCode() {
  if (!state.lobbyState) {
    return;
  }

  try {
    await navigator.clipboard.writeText(state.lobbyState.code);
    showToast("Lobby code copied.", "success");
  } catch (_error) {
    showToast("Unable to copy the code.", "error");
  }
}

async function handleLeaveLobby() {
  if (!state.lobbyState) {
    clearSavedSession();
    resetLocalLobby();
    switchScreen("home");
    return;
  }

  const response = await emitWithAck("leaveLobby");

  clearSavedSession();
  resetLocalLobby();
  switchScreen("home");
  elements.playersList.innerHTML = "";
  elements.joinCodeInput.value = "";

  if (!response.ok) {
    showToast("You left locally. The server will clean up your session shortly.", "error");
    return;
  }

  showToast("You left the lobby.", "success");
}

function hydrateFormValues() {
  const savedSession = getSavedSession();
  if (!savedSession) {
    return;
  }

  elements.createNameInput.value = savedSession.playerName || "";
  elements.joinNameInput.value = savedSession.playerName || "";
  elements.joinCodeInput.value = savedSession.lobbyCode || "";
}

elements.showCreateBtn.addEventListener("click", () => switchPanel("create"));
elements.showJoinBtn.addEventListener("click", () => switchPanel("join"));
elements.createForm.addEventListener("submit", submitCreateLobby);
elements.joinForm.addEventListener("submit", submitJoinLobby);
elements.revealQuestionBtn.addEventListener("click", handleRevealQuestion);
elements.startGameBtn.addEventListener("click", handleStartGame);
elements.nextRoundBtn.addEventListener("click", handleNextRound);
elements.restartGameBtn.addEventListener("click", handleRestartGame);
elements.copyCodeBtn.addEventListener("click", handleCopyCode);
elements.leaveLobbyBtn.addEventListener("click", handleLeaveLobby);
elements.joinCodeInput.addEventListener("input", (event) => {
  event.target.value = normalizeCode(event.target.value);
});

socket.on("connect", async () => {
  setConnectionStatus("Connected", "success");
  setButtonsDisabled(false);
  await resumeLobbyIfNeeded();
});

socket.on("disconnect", () => {
  setConnectionStatus("Reconnecting...", "warning");
  setButtonsDisabled(true);
});

socket.on("lobbyState", (lobbyState) => {
  state.lobbyState = lobbyState;
  state.lobbyCode = lobbyState.code;
  renderLobby();
  setConnectionStatus("Connected", "success");
});

socket.on("playerJoined", ({ name }) => {
  if (name) {
    showToast(`${name} joined the lobby.`, "success");
  }
});

socket.on("playerLeft", ({ name }) => {
  if (name) {
    showToast(`${name} left the lobby.`, "error");
  }
});

socket.on("startGame", ({ roundNumber }) => {
  showToast(`Round ${roundNumber} is ready.`, "success");
});

socket.on("nextRound", ({ roundNumber }) => {
  showToast(`Round ${roundNumber} is live.`, "success");
});

socket.on("restartGame", () => {
  showToast("The host restarted the game.", "success");
});

socket.on("questionRevealed", () => {
  renderQuestionPanel();
});

socket.on("systemMessage", ({ message }) => {
  if (message) {
    showToast(message);
  }
});

socket.on("errorMessage", ({ message }) => {
  if (message) {
    showToast(message, "error");
  }
});

hydrateFormValues();
switchPanel("create");
switchScreen("home");
setConnectionStatus("Connecting...");
