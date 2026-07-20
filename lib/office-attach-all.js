'use strict';

function sanitizeTerminalTitle(value) {
  const title = String(value || 'Codex')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (title || 'Codex').slice(0, 80);
}

function selectNativeSessions(sessions) {
  const byThread = new Map();
  for (const session of sessions) {
    if (!session?.nativeTuiAvailable || typeof session.sessionId !== 'string' || typeof session.threadId !== 'string' ||
      !session.sessionId || !session.threadId || byThread.has(session.threadId)) {
      continue;
    }
    byThread.set(session.threadId, {
      sessionId: session.sessionId,
      threadId: session.threadId,
      title: sanitizeTerminalTitle(session.title),
    });
  }
  return [...byThread.values()];
}

async function runOfficeAttachAll({ listSessions, registry, openTabs }) {
  if (typeof listSessions !== 'function' || !registry || typeof registry.acquireAllLock !== 'function' ||
    typeof registry.reserve !== 'function' || typeof registry.release !== 'function' || typeof openTabs !== 'function') {
    throw new TypeError('Office attach-all requires a session list, attachment registry, and Windows Terminal launcher.');
  }
  const lock = registry.acquireAllLock();
  try {
    const selected = selectNativeSessions(await listSessions());
    const entries = [];
    let skipped = 0;
    for (const session of selected) {
      const reservation = registry.reserve(session);
      if (!reservation) {
        skipped += 1;
        continue;
      }
      entries.push({ ...session, attachmentToken: reservation.attachmentToken });
    }
    if (entries.length === 0) { return { opened: 0, skipped }; }
    try { await openTabs(entries); }
    catch (error) {
      for (const entry of entries) { registry.release(entry); }
      throw error;
    }
    return { opened: entries.length, skipped };
  }
  finally { lock.release(); }
}

module.exports = { runOfficeAttachAll, sanitizeTerminalTitle, selectNativeSessions };
