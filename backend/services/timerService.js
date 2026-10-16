/**
 * TimerService
 *
 * Two related-but-distinct pieces of in-memory, per-server-process state
 * live here (same pattern the original shared-countdown timer used):
 *
 *   1. Game clocks — per-player remaining time with Fischer increment,
 *      supporting standard Bullet/Blitz/Rapid presets (feat: clock
 *      increment / time control support).
 *   2. Reconnect grace timers — a 60s countdown started when a player's
 *      socket disconnects, auto-forfeiting the match if they don't
 *      reconnect in time (feat: Socket.io reconnect strategy).
 */

// ---------------------------------------------------------------------------
// Time control presets
// ---------------------------------------------------------------------------

// base = starting seconds per player, increment = Fischer bonus seconds added
// to the mover's clock after each move they make.
const TIME_CONTROLS = {
	bullet: { label: "Bullet (1+0)", baseSeconds: 60, incrementSeconds: 0 },
	bullet2: { label: "Bullet (2+1)", baseSeconds: 120, incrementSeconds: 1 },
	blitz: { label: "Blitz (3+2)", baseSeconds: 180, incrementSeconds: 2 },
	blitz5: { label: "Blitz (5+0)", baseSeconds: 300, incrementSeconds: 0 },
	rapid: { label: "Rapid (10+0)", baseSeconds: 600, incrementSeconds: 0 },
	rapid15: { label: "Rapid (15+10)", baseSeconds: 900, incrementSeconds: 10 },
};

const DEFAULT_PRESET = "rapid";
const RECONNECT_GRACE_SECONDS = 60;

// Heartbeat configuration for detecting dead mobile connections
const HEARTBEAT_INTERVAL_MS = 15 * 1000; // Send ping every 15 seconds
const HEARTBEAT_TIMEOUT_MS = 10 * 1000; // Wait 10 seconds for pong response
const HEARTBEAT_MAX_MISSES = 2; // Disconnect after 2 consecutive missed pongs

function resolveTimeControl({ preset, baseSeconds, incrementSeconds } = {}) {
	if (preset && TIME_CONTROLS[preset]) {
		return { preset, ...TIME_CONTROLS[preset] };
	}
	if (Number.isFinite(baseSeconds) && baseSeconds > 0) {
		return {
			preset: "custom",
			label: "Custom",
			baseSeconds,
			incrementSeconds: Number.isFinite(incrementSeconds) && incrementSeconds >= 0 ? incrementSeconds : 0,
		};
	}
	return { preset: DEFAULT_PRESET, ...TIME_CONTROLS[DEFAULT_PRESET] };
}

class TimerService {
	constructor() {
		this.io = null;

		// gameCode -> { whiteMs, blackMs, incrementMs, turn, deadline, timeout }
		this.clocks = new Map();

		// legacy shared countdown (kept for callers that only pass a flat
		// duration and don't care about per-player clocks / increments)
		this.timers = new Map();

		// `${gameCode}:${color}` -> { timeout, expiresAt }
		this.player_disconnect_timers = new Map();
		this.reconnectTimers = this.player_disconnect_timers;

		// Heartbeat management: `${gameCode}:${socketId}` -> {
		//   color, interval, pendingPing, missCount, lastHeartbeatAt
		// }
		this.heartbeats = new Map();
	}

	init(io) {
		this.io = io;
	}

	// -------------------------------------------------------------------
	// Per-player clocks (Fischer increment / time controls)
	// -------------------------------------------------------------------

	/**
	 * Start (or restart) a per-player clock for a game.
	 * @param {string} gameCode
	 * @param {object} options - { preset, baseSeconds, incrementSeconds, turn }
	 */
	startClock(gameCode, options = {}) {
		this.clearClock(gameCode);

		const tc = resolveTimeControl(options);
		const baseMs = tc.baseSeconds * 1000;
		const incrementMs = tc.incrementSeconds * 1000;
		const turn = options.turn === "black" ? "black" : "white";

		const state = {
			whiteMs: baseMs,
			blackMs: baseMs,
			incrementMs,
			preset: tc.preset,
			turn,
			deadline: Date.now() + baseMs,
			timeout: null,
		};

		this.clocks.set(gameCode, state);
		this._scheduleFlagFall(gameCode);
		return this.getClockState(gameCode);
	}

	/**
	 * Call after a move is applied: stops the mover's clock (adding the
	 * increment), and starts the opponent's clock ticking.
	 * @param {string} gameCode
	 * @param {"white"|"black"} moverColor - the color that just moved
	 */
	applyMove(gameCode, moverColor) {
		const state = this.clocks.get(gameCode);
		if (!state) return null;

		const elapsed = Date.now() - (state.deadline - this._remainingMsFor(state, moverColor));
		const key = moverColor === "white" ? "whiteMs" : "blackMs";

		state[key] = Math.max(0, state[key] - elapsed) + state.incrementMs;
		state.turn = moverColor === "white" ? "black" : "white";
		state.deadline = Date.now() + this._remainingMsFor(state, state.turn);

		this._scheduleFlagFall(gameCode);
		return this.getClockState(gameCode);
	}

	_remainingMsFor(state, color) {
		return color === "white" ? state.whiteMs : state.blackMs;
	}

	/** Snapshot of remaining time for both players, accounting for the live tick. */
	getClockState(gameCode) {
		const state = this.clocks.get(gameCode);
		if (!state) return null;

		const now = Date.now();
		const activeRemaining = Math.max(0, state.deadline - now);
		const whiteMs = state.turn === "white" ? activeRemaining : state.whiteMs;
		const blackMs = state.turn === "black" ? activeRemaining : state.blackMs;

		return {
			whiteMs,
			blackMs,
			turn: state.turn,
			preset: state.preset,
			incrementMs: state.incrementMs,
		};
	}

	/**
	 * Get precise remaining clocks for both players, accounting for elapsed time
	 * since the current turn started. This is used for reconnection state rehydration
	 * to ensure zero clock discrepancy when a player rejoins.
	 *
	 * @param {string} gameCode
	 * @returns {object|null} { whiteMs, blackMs, turn } with millisecond precision,
	 *                         or null if no clock is running for this game
	 */
	getPreciseClocks(gameCode) {
		const state = this.clocks.get(gameCode);
		if (!state) return null;

		const now = Date.now();
		const activeRemaining = Math.max(0, state.deadline - now);
		const whiteMs = state.turn === "white" ? activeRemaining : state.whiteMs;
		const blackMs = state.turn === "black" ? activeRemaining : state.blackMs;

		return {
			whiteMs,
			blackMs,
			turn: state.turn,
			incrementMs: state.incrementMs,
			preset: state.preset,
		};
	}

	_scheduleFlagFall(gameCode) {
		const state = this.clocks.get(gameCode);
		if (!state) return;

		const remaining = this._remainingMsFor(state, state.turn);
		state.deadline = Date.now() + remaining;

		state.timeout = setTimeout(async () => {
			const loser = state.turn;
			this.clearClock(gameCode);
			try {
				const gameModel = require("../models/gameModel");
				const game = await gameModel.endByFlag(gameCode, loser);
				await require("../models/userModel").invalidateProfilesForGame(game);
				if (this.io && game) {
					this.io.to(gameCode).emit("game-update", game);
					this.io.to(gameCode).emit("flag-fall", { gameCode, loser, winner: game.winner });
				}
			} catch (err) {
				console.error(`[TimerService] endByFlag failed for ${gameCode}:`, err.message);
			}
		}, remaining);
	}

	clearClock(gameCode) {
		const state = this.clocks.get(gameCode);
		if (state) {
			if (state.timeout) clearTimeout(state.timeout);
			this.clocks.delete(gameCode);
		}
	}

	getTimeControls() {
		return TIME_CONTROLS;
	}

	// -------------------------------------------------------------------
	// Legacy shared countdown (kept for backwards compatibility)
	// -------------------------------------------------------------------

	/**
	 * @deprecated Prefer startClock() for per-player clocks. Retained so
	 * any existing callers relying on the flat shared countdown keep working.
	 */
	startTimer(gameCode, totalSeconds) {
		this.clearTimer(gameCode);

		let secondsLeft = Math.max(0, totalSeconds);

		const interval = setInterval(async () => {
			secondsLeft = Math.max(0, secondsLeft - 1);

			if (secondsLeft <= 0) {
				this.clearTimer(gameCode);
				try {
					const gameModel = require("../models/gameModel");
					const game = await gameModel.endByTime(gameCode);
					await require("../models/userModel").invalidateProfilesForGame(game);
					if (this.io && game) {
						this.io.to(gameCode).emit("game-update", game);
					}
				} catch (err) {
					console.error(`[TimerService] endByTime failed for ${gameCode}:`, err.message);
				}
			}
		}, 1000);

		this.timers.set(gameCode, { interval });
	}

	clearTimer(gameCode) {
		const entry = this.timers.get(gameCode);
		if (entry) {
			clearInterval(entry.interval);
			this.timers.delete(gameCode);
		}
	}

	// -------------------------------------------------------------------
	// Reconnect grace period / presence
	// -------------------------------------------------------------------

	/**
	 * Start a 60s grace countdown after a player's socket disconnects.
	 * If cancelReconnectGrace() isn't called for the same game+color before
	 * it fires, the match is auto-forfeited for that color.
	 * @param {string} gameCode
	 * @param {"white"|"black"} color
	 * @param {number} graceSeconds
	 */
	startReconnectGrace(gameCode, color, graceSeconds = RECONNECT_GRACE_SECONDS) {
		const key = `${gameCode}:${color}`;
		this.cancelReconnectGrace(gameCode, color);

		const timeout = setTimeout(async () => {
			this.player_disconnect_timers.delete(key);
			try {
				const gameModel = require("../models/gameModel");
				const game = await gameModel.forfeitByDisconnect(gameCode, color);
				await require("../models/userModel").invalidateProfilesForGame(game);
				this.clearClock(gameCode);
				if (this.io && game) {
					this.io.to(gameCode).emit("game-update", game);
					this.io.to(gameCode).emit("presence-update", {
						gameCode,
						color,
						status: "offline",
						forfeited: true,
					});
					this.io.to(gameCode).emit("game_over", {
						gameCode,
						winner: game.winner === game.player_white_address ? "white" : "black",
						reason: "abandonment",
					});
				}
			} catch (err) {
				console.error(`[TimerService] auto-forfeit failed for ${gameCode}/${color}:`, err.message);
			}
		}, graceSeconds * 1000);

		this.player_disconnect_timers.set(key, { timeout, expiresAt: Date.now() + graceSeconds * 1000 });
	}

	cancelReconnectGrace(gameCode, color) {
		const key = `${gameCode}:${color}`;
		const entry = this.player_disconnect_timers.get(key);
		if (entry) {
			clearTimeout(entry.timeout);
			this.player_disconnect_timers.delete(key);
			return true;
		}
		return false;
	}

	isPendingForfeit(gameCode, color) {
		return this.player_disconnect_timers.has(`${gameCode}:${color}`);
	}

	// -------------------------------------------------------------------
	// Application-level heartbeat monitoring (detect dead mobile connections)
	// -------------------------------------------------------------------

	/**
	 * Start active heartbeat monitoring for a connected player socket.
	 * Emits ping_heartbeat every 15 seconds; expects pong_heartbeat response.
	 * After 2 consecutive missed pongs, the socket should be forcibly disconnected.
	 *
	 * @param {object} socket - Socket.io socket instance
	 * @param {string} gameCode
	 * @param {"white"|"black"} playerColor
	 */
	startHeartbeat(socket, gameCode, playerColor) {
		const key = `${gameCode}:${socket.id}`;
		this.stopHeartbeat(socket, gameCode); // Clear any existing heartbeat

		const state = {
			color: playerColor,
			gameCode,
			missCount: 0,
			lastHeartbeatAt: Date.now(),
			pendingPing: null,
			interval: null,
		};

		// Emit ping every HEARTBEAT_INTERVAL_MS (15s)
		state.interval = setInterval(() => {
			if (!this.heartbeats.has(key)) return; // Heart stopped

			const clientTimestamp = Date.now();
			state.pendingPing = clientTimestamp;

			// Emit challenge to client; expect pong_heartbeat response within HEARTBEAT_TIMEOUT_MS
			if (this.io && socket && socket.emit) {
				socket.emit("ping_heartbeat", { timestamp: clientTimestamp });
			}

			// Schedule timeout: if no pong response within 10s, increment miss count
			const timeoutHandle = setTimeout(() => {
				const current = this.heartbeats.get(key);
				if (!current) return; // Heartbeat was cancelled

				// Increment consecutive miss counter
				current.missCount++;

				if (current.missCount >= HEARTBEAT_MAX_MISSES) {
					// 2 consecutive misses = treat as dead connection; force disconnect
					this.stopHeartbeat(socket, gameCode);
					if (socket && socket.disconnect) {
						socket.disconnect(true); // true = close transport
					}
				}
			}, HEARTBEAT_TIMEOUT_MS);

			// Store timeout so we can cancel it if pong arrives
			state.pendingTimeout = timeoutHandle;
		}, HEARTBEAT_INTERVAL_MS);

		this.heartbeats.set(key, state);
	}

	/**
	 * Record a successful pong_heartbeat response from the client.
	 * Resets the miss counter and clears any pending timeout.
	 *
	 * @param {object} socket
	 * @param {string} gameCode
	 * @param {object} data - { timestamp } from client pong
	 */
	recordHeartbeatAck(socket, gameCode, data = {}) {
		const key = `${gameCode}:${socket.id}`;
		const state = this.heartbeats.get(key);
		if (!state) return;

		// Clear any pending timeout from the last ping
		if (state.pendingTimeout) {
			clearTimeout(state.pendingTimeout);
			state.pendingTimeout = null;
		}

		// Reset miss counter on successful pong
		state.missCount = 0;
		state.lastHeartbeatAt = Date.now();
		state.pendingPing = null;
	}

	/**
	 * Stop heartbeat monitoring for a player socket.
	 * Called when a player leaves/disconnects.
	 *
	 * @param {object} socket
	 * @param {string} gameCode
	 */
	stopHeartbeat(socket, gameCode) {
		const key = `${gameCode}:${socket.id}`;
		const state = this.heartbeats.get(key);
		if (!state) return;

		if (state.interval) {
			clearInterval(state.interval);
		}
		if (state.pendingTimeout) {
			clearTimeout(state.pendingTimeout);
		}

		this.heartbeats.delete(key);
	}

	/**
	 * Utility: Get heartbeat state for a socket (for testing).
	 * @param {object} socket
	 * @param {string} gameCode
	 * @returns {object|null}
	 */
	getHeartbeatState(socket, gameCode) {
		const key = `${gameCode}:${socket.id}`;
		return this.heartbeats.get(key) || null;
	}
}

module.exports = new TimerService();
module.exports.TIME_CONTROLS = TIME_CONTROLS;
module.exports.RECONNECT_GRACE_SECONDS = RECONNECT_GRACE_SECONDS;
module.exports.HEARTBEAT_INTERVAL_MS = HEARTBEAT_INTERVAL_MS;
module.exports.HEARTBEAT_TIMEOUT_MS = HEARTBEAT_TIMEOUT_MS;
module.exports.HEARTBEAT_MAX_MISSES = HEARTBEAT_MAX_MISSES;
