/**
 * db.js — SQLite Persistence Layer
 * ──────────────────────────────────
 * Stores all agent activity: scans, decisions, executed actions, errors.
 * The frontend reads from this DB via the Next.js /api/agent-log endpoint.
 *
 * Schema:
 *   scans     — every position scan result (HF, band, scenarios)
 *   actions   — every executed on-chain action (tx hash, HF before/after)
 *   errors    — pipeline errors for debugging
 *   telegram  — user wallet → telegram chat_id mapping
 *
 * Uses better-sqlite3 (synchronous, zero-config, fast for this scale).
 */

"use strict";

const path    = require("path");
const fs      = require("fs");
const Database = require("better-sqlite3");
const { log, error: logError } = require("./logger");

// ─────────────────────────────────────────────────────────────────────────────
// DB setup
// ─────────────────────────────────────────────────────────────────────────────

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "../data/agent.db");

let _db = null;

function getDb() {
  if (!_db) throw new Error("DB not initialised — call db.init() first");
  return _db;
}

// ─────────────────────────────────────────────────────────────────────────────
// Initialise (create tables if they don't exist)
// ─────────────────────────────────────────────────────────────────────────────

async function init() {
  // Ensure data directory exists
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _db = new Database(DB_PATH);

  // Enable WAL mode for better concurrent read performance
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");

  // Create tables
  _db.exec(`
    CREATE TABLE IF NOT EXISTS scans (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user            TEXT    NOT NULL,
      cycle_id        TEXT    NOT NULL,
      health_factor   REAL    NOT NULL,
      band            TEXT    NOT NULL,
      projected_hf_5  REAL,
      projected_hf_10 REAL,
      projected_hf_20 REAL,
      volatility_bp   INTEGER,
      decision        TEXT,
      scanned_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS actions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user          TEXT    NOT NULL,
      cycle_id      TEXT,
      action_type   TEXT    NOT NULL,
      token         TEXT,
      amount        TEXT,
      tx_hash       TEXT,
      hf_before     REAL,
      hf_after      REAL,
      explanation   TEXT,
      success       INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      executed_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS errors (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user       TEXT,
      cycle_id   TEXT,
      error      TEXT NOT NULL,
      logged_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS telegram (
      user_address TEXT PRIMARY KEY,
      chat_id      TEXT NOT NULL,
      registered_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    -- Indexes for common query patterns
    CREATE INDEX IF NOT EXISTS idx_scans_user      ON scans(user);
    CREATE INDEX IF NOT EXISTS idx_scans_user_time ON scans(user, scanned_at DESC);
    CREATE INDEX IF NOT EXISTS idx_actions_user    ON actions(user);
    CREATE INDEX IF NOT EXISTS idx_actions_tx      ON actions(tx_hash);
  `);

  log(`Database ready: ${DB_PATH}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scans
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record the result of a position scan.
 * @param {object} scan
 * @param {string} scan.user
 * @param {string} scan.cycleId
 * @param {number} scan.healthFactor
 * @param {string} scan.band
 * @param {number} [scan.projectedHF5]
 * @param {number} [scan.projectedHF10]
 * @param {number} [scan.projectedHF20]
 * @param {number} [scan.volatilityBP]
 * @param {string} [scan.decision]
 */
function recordScan(scan) {
  try {
    const stmt = getDb().prepare(`
      INSERT INTO scans
        (user, cycle_id, health_factor, band, projected_hf_5, projected_hf_10,
         projected_hf_20, volatility_bp, decision)
      VALUES
        (@user, @cycleId, @healthFactor, @band, @projectedHF5, @projectedHF10,
         @projectedHF20, @volatilityBP, @decision)
    `);
    stmt.run({
      user:          scan.user.toLowerCase(),
      cycleId:       scan.cycleId?.toString(),
      healthFactor:  scan.healthFactor,
      band:          scan.band,
      projectedHF5:  scan.projectedHF5  ?? null,
      projectedHF10: scan.projectedHF10 ?? null,
      projectedHF20: scan.projectedHF20 ?? null,
      volatilityBP:  scan.volatilityBP  ?? null,
      decision:      scan.decision      ?? null,
    });
  } catch (err) {
    logError(`db.recordScan: ${err.message}`);
  }
}

/**
 * Fetch recent scans for a user (for the frontend activity chart).
 * @param {string} user  Wallet address
 * @param {number} limit Max rows to return
 */
function getRecentScans(user, limit = 100) {
  return getDb()
    .prepare(`
      SELECT * FROM scans
      WHERE user = ?
      ORDER BY scanned_at DESC
      LIMIT ?
    `)
    .all(user.toLowerCase(), limit);
}

/**
 * Fetch the HF history for a user (for the frontend chart).
 * Returns [{ scanned_at, health_factor, band }]
 */
function getHFHistory(user, hours = 24) {
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  return getDb()
    .prepare(`
      SELECT scanned_at, health_factor, band
      FROM scans
      WHERE user = ? AND scanned_at >= ?
      ORDER BY scanned_at ASC
    `)
    .all(user.toLowerCase(), since);
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record an executed (or attempted) agent action.
 */
function recordAction(action) {
  try {
    const stmt = getDb().prepare(`
      INSERT INTO actions
        (user, cycle_id, action_type, token, amount, tx_hash,
         hf_before, hf_after, explanation, success, error_message)
      VALUES
        (@user, @cycleId, @actionType, @token, @amount, @txHash,
         @hfBefore, @hfAfter, @explanation, @success, @errorMessage)
    `);
    stmt.run({
      user:         action.user.toLowerCase(),
      cycleId:      action.cycleId?.toString() ?? null,
      actionType:   action.actionType,
      token:        action.token  ?? null,
      amount:       action.amount ?? null,
      txHash:       action.txHash ?? null,
      hfBefore:     action.hfBefore ?? null,
      hfAfter:      action.hfAfter  ?? null,
      explanation:  action.explanation ?? null,
      success:      action.success ? 1 : 0,
      errorMessage: action.errorMessage ?? null,
    });
  } catch (err) {
    logError(`db.recordAction: ${err.message}`);
  }
}

/**
 * Fetch the agent activity log for a user (frontend Agent Activity feed).
 * Returns actions newest-first.
 */
function getActionHistory(user, limit = 50) {
  return getDb()
    .prepare(`
      SELECT * FROM actions
      WHERE user = ?
      ORDER BY executed_at DESC
      LIMIT ?
    `)
    .all(user.toLowerCase(), limit);
}

/**
 * Fetch all actions across all users (for admin/analytics view).
 */
function getAllActions(limit = 200) {
  return getDb()
    .prepare(`
      SELECT * FROM actions
      ORDER BY executed_at DESC
      LIMIT ?
    `)
    .all(limit);
}

/**
 * Get lifetime stats for a user.
 */
function getUserStats(user) {
  return getDb()
    .prepare(`
      SELECT
        COUNT(*) as total_actions,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful_actions,
        MIN(hf_before) as lowest_hf_seen,
        MAX(hf_after)  as best_hf_achieved
      FROM actions
      WHERE user = ?
    `)
    .get(user.toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

function recordError(errObj) {
  try {
    getDb()
      .prepare(`
        INSERT INTO errors (user, cycle_id, error)
        VALUES (?, ?, ?)
      `)
      .run(
        errObj.user?.toLowerCase() ?? null,
        errObj.cycleId?.toString() ?? null,
        errObj.error
      );
  } catch (err) {
    logError(`db.recordError: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram user mapping
// ─────────────────────────────────────────────────────────────────────────────

function setTelegramChatId(userAddress, chatId) {
  getDb()
    .prepare(`
      INSERT INTO telegram (user_address, chat_id)
      VALUES (?, ?)
      ON CONFLICT(user_address) DO UPDATE SET chat_id = excluded.chat_id
    `)
    .run(userAddress.toLowerCase(), chatId);
}

function getTelegramChatId(userAddress) {
  const row = getDb()
    .prepare(`SELECT chat_id FROM telegram WHERE user_address = ?`)
    .get(userAddress.toLowerCase());
  return row?.chat_id ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Maintenance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prune old scan records to keep the DB small.
 * Keeps the last 7 days of scans.
 */
function pruneOldScans(daysToKeep = 7) {
  const cutoff = Math.floor(Date.now() / 1000) - daysToKeep * 86400;
  const result = getDb()
    .prepare(`DELETE FROM scans WHERE scanned_at < ?`)
    .run(cutoff);
  log(`db.pruneOldScans: removed ${result.changes} old scan records`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  init,
  // Scans
  recordScan,
  getRecentScans,
  getHFHistory,
  // Actions
  recordAction,
  getActionHistory,
  getAllActions,
  getUserStats,
  // Errors
  recordError,
  // Telegram
  setTelegramChatId,
  getTelegramChatId,
  // Maintenance
  pruneOldScans,
};
