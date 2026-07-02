const fs = require("fs/promises");
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 20;
const LOBBY_CODE_LENGTH = 6;
const RECONNECT_GRACE_MS = 20000;
const CODE_CHARACTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let questionPairs = [];

const lobbies = new Map();
const socketSessions = new Map();

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, lobbies: lobbies.size });
});

function createPlayer({ clientId, name, socketId, joinedAt }) {
  return {
    id: clientId,
    clientId,
    name,
    socketId,
    joinedAt,
    connected: true,
    disconnectTimer: null,
  };
}

function normalizeName(name) {
  return String(name || "").trim().replace(/\s+/g, " ").slice(0, 24);
}

function normalizeCode(code) {
  return String(code || "").trim().toUpperCase().slice(0, LOBBY_CODE_LENGTH);
}

function generateLobbyCode() {
  let code = "";

  do {
    code = Array.from({ length: LOBBY_CODE_LENGTH }, () => {
      const index = Math.floor(Math.random() * CODE_CHARACTERS.length);
      return CODE_CHARACTERS[index];
    }).join("");
  } while (lobbies.has(code));

  return code;
}

function getLobbyPlayers(lobby) {
  return Array.from(lobby.players.values()).sort((a, b) => a.joinedAt - b.joinedAt);
}

function getConnectedPlayers(lobby) {
  return getLobbyPlayers(lobby).filter((player) => player.connected && player.socketId);
}

function clearDisconnectTimer(player) {
  if (player.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
  }
}

function getPublicPlayer(player, lobby) {
  return {
    id: player.id,
    name: player.name,
    connected: player.connected,
    isHost: lobby.hostId === player.id,
  };
}

function pickNextHost(lobby) {
  const oldestConnected = getConnectedPlayers(lobby)[0];
  if (oldestConnected) {
    return oldestConnected.id;
  }

  const oldestAny = getLobbyPlayers(lobby)[0];
  return oldestAny ? oldestAny.id : null;
}

function removeLobbyIfEmpty(lobbyCode) {
  const lobby = lobbies.get(lobbyCode);
  if (!lobby) {
    return;
  }

  if (lobby.players.size === 0) {
    lobbies.delete(lobbyCode);
  }
}

function getQuestionForPlayer(lobby, playerId) {
  if (!lobby.currentRound) {
    return null;
  }

  const pair = questionPairs[lobby.currentRound.questionIndex];
  if (!pair) {
    return null;
  }

  return lobby.currentRound.impostorId === playerId ? pair.impostor : pair.normal;
}

function buildLobbyState(lobby, playerId) {
  const playerQuestionVisible = Boolean(
    lobby.currentRound && lobby.currentRound.revealedPlayerIds.has(playerId)
  );

  return {
    code: lobby.code,
    players: getLobbyPlayers(lobby).map((player) => getPublicPlayer(player, lobby)),
    hostId: lobby.hostId,
    gameStarted: Boolean(lobby.currentRound),
    roundNumber: lobby.currentRound ? lobby.currentRound.roundNumber : 0,
    hasRevealed: playerQuestionVisible,
    question: playerQuestionVisible ? getQuestionForPlayer(lobby, playerId) : null,
    canReveal: Boolean(lobby.currentRound) && !playerQuestionVisible,
  };
}

function emitLobbyState(lobby) {
  getLobbyPlayers(lobby).forEach((player) => {
    if (!player.connected || !player.socketId) {
      return;
    }

    io.to(player.socketId).emit("lobbyState", buildLobbyState(lobby, player.id));
  });
}

function emitToastToLobby(lobby, message) {
  io.to(lobby.code).emit("systemMessage", { message });
}

function removePlayerFromLobby(lobbyCode, playerId, options = {}) {
  const lobby = lobbies.get(lobbyCode);
  if (!lobby) {
    return;
  }

  const player = lobby.players.get(playerId);
  if (!player) {
    return;
  }

  clearDisconnectTimer(player);

  if (player.socketId) {
    const socket = io.sockets.sockets.get(player.socketId);
    if (socket) {
      socket.leave(lobby.code);
    }
    socketSessions.delete(player.socketId);
  }

  lobby.players.delete(playerId);

  if (lobby.currentRound) {
    lobby.currentRound.revealedPlayerIds.delete(playerId);

    if (lobby.currentRound.impostorId === playerId) {
      const remainingPlayers = getLobbyPlayers(lobby);
      if (remainingPlayers.length > 0) {
        const nextImpostor =
          remainingPlayers[Math.floor(Math.random() * remainingPlayers.length)];
        lobby.currentRound.impostorId = nextImpostor.id;
      } else {
        lobby.currentRound = null;
      }
    }
  }

  if (lobby.hostId === playerId) {
    lobby.hostId = pickNextHost(lobby);
    if (lobby.hostId) {
      const nextHost = lobby.players.get(lobby.hostId);
      if (nextHost) {
        emitToastToLobby(lobby, `${nextHost.name} is now the host.`);
      }
    }
  }

  if (!options.silent) {
    io.to(lobby.code).emit("playerLeft", {
      playerId,
      name: player.name,
    });
  }

  removeLobbyIfEmpty(lobbyCode);

  if (lobbies.has(lobbyCode)) {
    emitLobbyState(lobby);
  }
}

function scheduleDisconnectCleanup(lobby, player) {
  clearDisconnectTimer(player);

  player.disconnectTimer = setTimeout(() => {
    removePlayerFromLobby(lobby.code, player.id);
  }, RECONNECT_GRACE_MS);
}

function findPlayerByName(lobby, name) {
  const target = name.toLowerCase();
  return getLobbyPlayers(lobby).find((player) => player.name.toLowerCase() === target);
}

function getRandomUnusedQuestionIndex(lobby) {
  if (questionPairs.length === 0) {
    return -1;
  }

  if (lobby.usedQuestionIndexes.size >= questionPairs.length) {
    lobby.usedQuestionIndexes.clear();
  }

  const availableIndexes = [];

  for (let index = 0; index < questionPairs.length; index += 1) {
    if (!lobby.usedQuestionIndexes.has(index)) {
      availableIndexes.push(index);
    }
  }

  const chosenIndex = availableIndexes[Math.floor(Math.random() * availableIndexes.length)];
  lobby.usedQuestionIndexes.add(chosenIndex);
  return chosenIndex;
}

function startRound(lobby) {
  const players = getLobbyPlayers(lobby);
  if (players.length < 2) {
    return { ok: false, message: "At least 2 players are required to start." };
  }

  const questionIndex = getRandomUnusedQuestionIndex(lobby);
  if (questionIndex < 0) {
    return { ok: false, message: "No question pairs are available." };
  }

  const impostor = players[Math.floor(Math.random() * players.length)];

  lobby.currentRound = {
    roundNumber: lobby.currentRound ? lobby.currentRound.roundNumber + 1 : 1,
    questionIndex,
    impostorId: impostor.id,
    revealedPlayerIds: new Set(),
  };

  return { ok: true };
}

function restartLobby(lobby) {
  lobby.currentRound = null;
  lobby.usedQuestionIndexes.clear();
}

function createLobbyForPlayer(socket, name, clientId) {
  const code = generateLobbyCode();
  const joinedAt = Date.now();
  const player = createPlayer({
    clientId,
    name,
    socketId: socket.id,
    joinedAt,
  });

  const lobby = {
    code,
    createdAt: joinedAt,
    hostId: player.id,
    players: new Map([[player.id, player]]),
    usedQuestionIndexes: new Set(),
    currentRound: null,
  };

  lobbies.set(code, lobby);
  socketSessions.set(socket.id, { lobbyCode: code, playerId: player.id });
  socket.join(code);

  return lobby;
}

function joinOrReconnectLobby(socket, name, code, clientId) {
  const lobby = lobbies.get(code);
  if (!lobby) {
    return { ok: false, message: "Lobby not found." };
  }

  const existingByClient = lobby.players.get(clientId);
  if (existingByClient) {
    const nameMatches = existingByClient.name.toLowerCase() === name.toLowerCase();
    if (!nameMatches) {
      return {
        ok: false,
        message: "This session is already linked to a different player name in the lobby.",
      };
    }

    clearDisconnectTimer(existingByClient);
    existingByClient.socketId = socket.id;
    existingByClient.connected = true;
    socketSessions.set(socket.id, { lobbyCode: code, playerId: existingByClient.id });
    socket.join(code);
    return { ok: true, lobby, player: existingByClient, reconnected: true };
  }

  if (lobby.players.size >= MAX_PLAYERS) {
    return { ok: false, message: "This lobby is full." };
  }

  const duplicateNamePlayer = findPlayerByName(lobby, name);
  if (duplicateNamePlayer) {
    return { ok: false, message: "That player name is already taken in this lobby." };
  }

  const player = createPlayer({
    clientId,
    name,
    socketId: socket.id,
    joinedAt: Date.now(),
  });

  lobby.players.set(player.id, player);
  socketSessions.set(socket.id, { lobbyCode: code, playerId: player.id });
  socket.join(code);

  return { ok: true, lobby, player, reconnected: false };
}

function ensureHost(lobby, playerId) {
  return lobby.hostId === playerId;
}

async function loadQuestionPairs() {
  const filePath = path.join(__dirname, "questions.json");
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed) || parsed.length < 100) {
    throw new Error("questions.json must contain at least 100 question pairs.");
  }

  parsed.forEach((pair, index) => {
    if (!pair || typeof pair.normal !== "string" || typeof pair.impostor !== "string") {
      throw new Error(`Question pair at index ${index} is invalid.`);
    }
  });

  questionPairs = parsed;
}

function getAckCallback(possibleCallback) {
  return typeof possibleCallback === "function" ? possibleCallback : () => {};
}

io.on("connection", (socket) => {
  socket.on("createLobby", async (payload, callback = () => {}) => {
    try {
      const name = normalizeName(payload?.playerName);
      const clientId = String(payload?.clientId || "").trim();

      if (!name) {
        callback({ ok: false, message: "Enter a player name." });
        return;
      }

      if (!clientId) {
        callback({ ok: false, message: "Missing client session." });
        return;
      }

      const existingSession = socketSessions.get(socket.id);
      if (existingSession) {
        removePlayerFromLobby(existingSession.lobbyCode, existingSession.playerId, {
          silent: true,
        });
      }

      const lobby = createLobbyForPlayer(socket, name, clientId);
      callback({ ok: true, code: lobby.code });
      emitLobbyState(lobby);
      io.to(lobby.code).emit("playerJoined", { playerId: clientId, name });
    } catch (error) {
      callback({ ok: false, message: "Unable to create lobby right now." });
    }
  });

  socket.on("joinLobby", async (payload, callback = () => {}) => {
    try {
      const name = normalizeName(payload?.playerName);
      const code = normalizeCode(payload?.lobbyCode);
      const clientId = String(payload?.clientId || "").trim();

      if (!name || !code) {
        callback({ ok: false, message: "Enter your name and lobby code." });
        return;
      }

      if (!clientId) {
        callback({ ok: false, message: "Missing client session." });
        return;
      }

      const existingSession = socketSessions.get(socket.id);
      if (existingSession) {
        removePlayerFromLobby(existingSession.lobbyCode, existingSession.playerId, {
          silent: true,
        });
      }

      const result = joinOrReconnectLobby(socket, name, code, clientId);

      if (!result.ok) {
        callback(result);
        return;
      }

      callback({ ok: true, code });
      emitLobbyState(result.lobby);

      if (result.reconnected) {
        emitToastToLobby(result.lobby, `${result.player.name} reconnected.`);
      } else {
        io.to(result.lobby.code).emit("playerJoined", {
          playerId: result.player.id,
          name: result.player.name,
        });
      }
    } catch (error) {
      callback({ ok: false, message: "Unable to join lobby right now." });
    }
  });

  socket.on("startGame", (_payload, possibleCallback) => {
    const callback = getAckCallback(possibleCallback);
    const session = socketSessions.get(socket.id);
    if (!session) {
      callback({ ok: false, message: "You are not in a lobby." });
      return;
    }

    const lobby = lobbies.get(session.lobbyCode);
    if (!lobby) {
      callback({ ok: false, message: "Lobby not found." });
      return;
    }

    if (!ensureHost(lobby, session.playerId)) {
      callback({ ok: false, message: "Only the host can start the game." });
      return;
    }

    const result = startRound(lobby);
    if (!result.ok) {
      callback(result);
      return;
    }

    callback({ ok: true });
    io.to(lobby.code).emit("startGame", { roundNumber: lobby.currentRound.roundNumber });
    emitLobbyState(lobby);
  });

  socket.on("revealQuestion", (_payload, possibleCallback) => {
    const callback = getAckCallback(possibleCallback);
    const session = socketSessions.get(socket.id);
    if (!session) {
      callback({ ok: false, message: "You are not in a lobby." });
      return;
    }

    const lobby = lobbies.get(session.lobbyCode);
    if (!lobby || !lobby.currentRound) {
      callback({ ok: false, message: "The game has not started yet." });
      return;
    }

    if (lobby.currentRound.revealedPlayerIds.has(session.playerId)) {
      callback({ ok: true, question: getQuestionForPlayer(lobby, session.playerId) });
      return;
    }

    lobby.currentRound.revealedPlayerIds.add(session.playerId);
    const question = getQuestionForPlayer(lobby, session.playerId);

    io.to(socket.id).emit("questionRevealed", { question });
    emitLobbyState(lobby);
    callback({ ok: true, question });
  });

  socket.on("nextRound", (_payload, possibleCallback) => {
    const callback = getAckCallback(possibleCallback);
    const session = socketSessions.get(socket.id);
    if (!session) {
      callback({ ok: false, message: "You are not in a lobby." });
      return;
    }

    const lobby = lobbies.get(session.lobbyCode);
    if (!lobby) {
      callback({ ok: false, message: "Lobby not found." });
      return;
    }

    if (!ensureHost(lobby, session.playerId)) {
      callback({ ok: false, message: "Only the host can start the next round." });
      return;
    }

    const result = startRound(lobby);
    if (!result.ok) {
      callback(result);
      return;
    }

    callback({ ok: true });
    io.to(lobby.code).emit("nextRound", { roundNumber: lobby.currentRound.roundNumber });
    emitLobbyState(lobby);
  });

  socket.on("restartGame", (_payload, possibleCallback) => {
    const callback = getAckCallback(possibleCallback);
    const session = socketSessions.get(socket.id);
    if (!session) {
      callback({ ok: false, message: "You are not in a lobby." });
      return;
    }

    const lobby = lobbies.get(session.lobbyCode);
    if (!lobby) {
      callback({ ok: false, message: "Lobby not found." });
      return;
    }

    if (!ensureHost(lobby, session.playerId)) {
      callback({ ok: false, message: "Only the host can restart the game." });
      return;
    }

    restartLobby(lobby);
    callback({ ok: true });
    io.to(lobby.code).emit("restartGame");
    emitLobbyState(lobby);
  });

  socket.on("leaveLobby", (_payload, possibleCallback) => {
    const callback = getAckCallback(possibleCallback);
    const session = socketSessions.get(socket.id);
    if (!session) {
      callback({ ok: false, message: "You are not in a lobby." });
      return;
    }

    removePlayerFromLobby(session.lobbyCode, session.playerId);
    callback({ ok: true });
  });

  socket.on("disconnect", () => {
    const session = socketSessions.get(socket.id);
    socketSessions.delete(socket.id);

    if (!session) {
      return;
    }

    const lobby = lobbies.get(session.lobbyCode);
    if (!lobby) {
      return;
    }

    const player = lobby.players.get(session.playerId);
    if (!player) {
      return;
    }

    player.connected = false;
    player.socketId = null;

    if (lobby.hostId === player.id) {
      lobby.hostId = pickNextHost(lobby);
      if (lobby.hostId && lobby.hostId !== player.id) {
        const nextHost = lobby.players.get(lobby.hostId);
        if (nextHost) {
          emitToastToLobby(lobby, `${nextHost.name} is now the host.`);
        }
      }
    }

    scheduleDisconnectCleanup(lobby, player);
    emitLobbyState(lobby);
  });
});

async function startServer() {
  await loadQuestionPairs();

  server.listen(PORT, () => {
    console.log(`Question Impostor is running on http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
