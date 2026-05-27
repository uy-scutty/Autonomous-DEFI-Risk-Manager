/**
 * logger.js — Structured console logger
 * Adds timestamps and log levels. Swap this for Winston/Pino in production.
 */

"use strict";

const LOG_LEVEL = process.env.LOG_LEVEL || "info"; // debug | info | warn | error

function ts() {
  return new Date().toISOString();
}

function log(msg) {
  console.log(`[${ts()}] INFO  ${msg}`);
}
function debug(msg) {
  if (LOG_LEVEL === "debug") console.log(`[${ts()}] DEBUG ${msg}`);
}
function warn(msg) {
  console.warn(`[${ts()}] WARN  ${msg}`);
}
function error(msg) {
  console.error(`[${ts()}] ERROR ${msg}`);
}

module.exports = { log, debug, warn, error };
