import fs from 'node:fs';
import { config } from './config.js';

export function emitMarkerLine(markerName, details = {}) {
  const payload = {
    pid: process.pid,
    marker: markerName,
    at: new Date().toISOString(),
    ...details,
  };
  const line = `MARKER ${markerName} ${JSON.stringify(payload)}\n`;
  fs.writeSync(1, line);
}

/**
 * Deterministic marker pause for real SIGKILL testing (F1, F2, F3, F7).
 * Never throws an exception: prints the marker line synchronously and parks
 * until the harness terminates the OS process with SIGKILL.
 */
export async function maybePauseAtMarker(markerName, details = {}) {
  if (!config.labMode || config.marker !== markerName) {
    return false;
  }
  emitMarkerLine(markerName, details);
  await new Promise(() => {
    setInterval(() => {}, 60_000);
  });
  return true;
}
