// Stage 3's persistence layer. A plain JSON file, not a real database --
// the dashboard (Stage 6) is being built with placeholder data for now, so
// this just needs to durably hold whatever real webhook events come in
// underneath it, ready to be wired to the dashboard next. Swap this out for
// Postgres/SQLite behind the same four functions if this ever needs to run
// concurrently or at real scale.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DB_PATH = path.join(__dirname, "data", "events.json");

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    return [];
  }
}

function writeAll(events) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(events, null, 2));
}

function addEvent(event) {
  const events = readAll();
  const record = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: "classified",
    prUrl: null,
    issueUrl: null,
    ...event,
  };
  events.unshift(record);
  writeAll(events);
  return record;
}

function updateEvent(id, patch) {
  const events = readAll();
  const idx = events.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  events[idx] = { ...events[idx], ...patch };
  writeAll(events);
  return events[idx];
}

function listEvents() {
  return readAll();
}

module.exports = { addEvent, updateEvent, listEvents };
