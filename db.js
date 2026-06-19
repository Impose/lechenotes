const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(process.env.DATA_DIR || './data', 'lechenotes.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Migrations
const noteCols = db.prepare("PRAGMA table_info(notes)").all();
if (noteCols.length && !noteCols.find(c => c.name === 'sort_order')) {
  db.prepare("ALTER TABLE notes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0").run();
}
if (noteCols.length && !noteCols.find(c => c.name === 'deleted_at')) {
  db.prepare("ALTER TABLE notes ADD COLUMN deleted_at TEXT").run();
}

// Migrate existing pinned notes into note_pins for their owners
const notePinsExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='note_pins'").get();
if (!notePinsExists && noteCols.length) {
  db.exec(`CREATE TABLE IF NOT EXISTS note_pins (
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, user_id)
  )`);
  db.prepare(`INSERT OR IGNORE INTO note_pins (note_id, user_id) SELECT id, owner_id FROM notes WHERE pinned = 1`).run();
}

const userCols = db.prepare("PRAGMA table_info(users)").all();
if (userCols.length && !userCols.find(c => c.name === 'trash_days')) {
  db.prepare("ALTER TABLE users ADD COLUMN trash_days INTEGER NOT NULL DEFAULT 30").run();
}
if (!userCols.find(c => c.name === 'dark_mode')) {
  db.prepare("ALTER TABLE users ADD COLUMN dark_mode INTEGER NOT NULL DEFAULT 0").run();
}
if (!userCols.find(c => c.name === 'is_admin')) {
  db.prepare("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0").run();
  // Promote the first user to admin so existing installs aren't locked out
  db.prepare("UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users)").run();
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    trash_days INTEGER NOT NULL DEFAULT 30
  );

  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT 'default',
    pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS note_shares (
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    shared_with_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, shared_with_user_id)
  );

  CREATE TABLE IF NOT EXISTS note_pins (
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    text TEXT NOT NULL DEFAULT '',
    checked INTEGER NOT NULL DEFAULT 0,
    position REAL NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    UNIQUE(user_id, name)
  );

  CREATE TABLE IF NOT EXISTS note_labels (
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, label_id)
  );
`);

function touchNote(noteId) {
  db.prepare(`UPDATE notes SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(noteId);
}

function hydrateNote(note) {
  note.items = db.prepare(`SELECT * FROM items WHERE note_id = ? ORDER BY position ASC, id ASC`).all(note.id);
  note.labels = db.prepare(`
    SELECT l.* FROM labels l
    JOIN note_labels nl ON nl.label_id = l.id
    WHERE nl.note_id = ?
  `).all(note.id);
  note.shared_with = db.prepare(`
    SELECT u.id, u.username FROM users u
    JOIN note_shares ns ON ns.shared_with_user_id = u.id
    WHERE ns.note_id = ?
  `).all(note.id);
  return note;
}

module.exports = {
  db,

  // Users
  getUserByUsername: (username) =>
    db.prepare(`SELECT * FROM users WHERE username = ?`).get(username),
  getUserById: (id) =>
    db.prepare(`SELECT id, username, dark_mode, is_admin, trash_days FROM users WHERE id = ?`).get(id),
  setDarkMode: (userId, value) =>
    db.prepare(`UPDATE users SET dark_mode = ? WHERE id = ?`).run(value ? 1 : 0, userId),
  getAllOtherUsers: (userId) =>
    db.prepare(`SELECT id, username FROM users WHERE id != ?`).all(userId),
  getAllUsers: () =>
    db.prepare(`SELECT id, username, is_admin FROM users ORDER BY id ASC`).all(),
  createUser: (username, passwordHash, isAdmin = 0) =>
    db.prepare(`INSERT OR IGNORE INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)`).run(username, passwordHash, isAdmin ? 1 : 0),
  deleteUser: (id) =>
    db.prepare(`DELETE FROM users WHERE id = ?`).run(id),
  setUserPassword: (id, hash) =>
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, id),
  setUserAdmin: (id, value) =>
    db.prepare(`UPDATE users SET is_admin = ? WHERE id = ?`).run(value ? 1 : 0, id),
  userCount: () =>
    db.prepare(`SELECT COUNT(*) as count FROM users`).get().count,

  // Notes
  getNoteById: (noteId) => {
    const note = db.prepare(`SELECT * FROM notes WHERE id = ? AND deleted = 0`).get(noteId);
    return note ? hydrateNote(note) : null;
  },

  getNotesForUser: (userId) => {
    const notes = db.prepare(`
      SELECT DISTINCT n.*, u.username AS owner_username,
        CASE WHEN np.user_id IS NOT NULL THEN 1 ELSE 0 END AS pinned
      FROM notes n
      LEFT JOIN note_shares ns ON ns.note_id = n.id
      LEFT JOIN users u ON u.id = n.owner_id
      LEFT JOIN note_pins np ON np.note_id = n.id AND np.user_id = ?
      WHERE (n.owner_id = ? OR ns.shared_with_user_id = ?)
        AND n.deleted = 0
      ORDER BY pinned DESC, n.sort_order ASC, n.updated_at DESC
    `).all(userId, userId, userId);
    return notes.map(hydrateNote);
  },

  getSyncedNotes: (userId, since) => {
    const notes = db.prepare(`
      SELECT DISTINCT n.*, u.username AS owner_username,
        CASE WHEN np.user_id IS NOT NULL THEN 1 ELSE 0 END AS pinned
      FROM notes n
      LEFT JOIN note_shares ns ON ns.note_id = n.id
      LEFT JOIN users u ON u.id = n.owner_id
      LEFT JOIN note_pins np ON np.note_id = n.id AND np.user_id = ?
      WHERE (n.owner_id = ? OR ns.shared_with_user_id = ?)
        AND n.updated_at > ?
      ORDER BY n.updated_at DESC
    `).all(userId, userId, userId, since);
    return notes.map(hydrateNote);
  },

  createNote: (ownerId, title, body, color) => {
    const result = db.prepare(`
      INSERT INTO notes (owner_id, title, body, color) VALUES (?, ?, ?, ?)
    `).run(ownerId, title || '', body || '', color || 'default');
    return result.lastInsertRowid;
  },

  reorderNotes: db.transaction((noteIds) => {
    const stmt = db.prepare(`UPDATE notes SET sort_order = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`);
    noteIds.forEach((id, i) => stmt.run(i + 1, id));
  }),

  updateNote: (noteId, fields) => {
    const allowed = ['title', 'body', 'color', 'archived'];
    const updates = Object.keys(fields).filter(k => allowed.includes(k) && fields[k] !== undefined);
    if (!updates.length) return;
    const set = updates.map(k => `${k} = ?`).join(', ');
    const values = updates.map(k => fields[k]);
    db.prepare(`UPDATE notes SET ${set}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(...values, noteId);
  },

  setPinned: (noteId, userId, pin) => {
    if (pin) {
      db.prepare(`INSERT OR IGNORE INTO note_pins (note_id, user_id) VALUES (?, ?)`).run(noteId, userId);
    } else {
      db.prepare(`DELETE FROM note_pins WHERE note_id = ? AND user_id = ?`).run(noteId, userId);
    }
  },

  softDeleteNote: (noteId) => {
    db.prepare(`UPDATE notes SET deleted = 1, deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(noteId);
  },

  getTrashNotes: (userId) => {
    const notes = db.prepare(`
      SELECT n.* FROM notes n
      WHERE n.owner_id = ? AND n.deleted = 1
      ORDER BY n.deleted_at DESC
    `).all(userId);
    return notes.map(hydrateNote);
  },

  restoreNote: (noteId) => {
    db.prepare(`UPDATE notes SET deleted = 0, deleted_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(noteId);
  },

  permanentDeleteNote: (noteId) => {
    db.prepare(`DELETE FROM notes WHERE id = ?`).run(noteId);
  },

  emptyTrash: (userId) => {
    db.prepare(`DELETE FROM notes WHERE owner_id = ? AND deleted = 1`).run(userId);
  },

  purgeExpiredNotes: () => {
    db.prepare(`
      DELETE FROM notes
      WHERE deleted = 1
        AND deleted_at IS NOT NULL
        AND deleted_at <= datetime('now', '-' || (
          SELECT trash_days FROM users WHERE id = notes.owner_id
        ) || ' days')
    `).run();
  },

  setTrashDays: (userId, days) => {
    db.prepare(`UPDATE users SET trash_days = ? WHERE id = ?`).run(days, userId);
  },

  isNoteOwner: (noteId, userId) => {
    const note = db.prepare(`SELECT owner_id FROM notes WHERE id = ? AND deleted = 0`).get(noteId);
    return note ? note.owner_id === userId : false;
  },

  canAccessNote: (noteId, userId) => {
    const result = db.prepare(`
      SELECT 1 FROM notes n
      LEFT JOIN note_shares ns ON ns.note_id = n.id
      WHERE n.id = ? AND (n.owner_id = ? OR ns.shared_with_user_id = ?) AND n.deleted = 0
    `).get(noteId, userId, userId);
    return !!result;
  },

  // Sharing
  shareNote: (noteId, withUserId) => {
    db.prepare(`INSERT OR IGNORE INTO note_shares (note_id, shared_with_user_id) VALUES (?, ?)`).run(noteId, withUserId);
    touchNote(noteId);
  },

  unshareNote: (noteId, withUserId) => {
    db.prepare(`DELETE FROM note_shares WHERE note_id = ? AND shared_with_user_id = ?`).run(noteId, withUserId);
    touchNote(noteId);
  },

  // Items
  addItem: (noteId, text, position) => {
    const result = db.prepare(`INSERT INTO items (note_id, text, position) VALUES (?, ?, ?)`).run(noteId, text || '', position ?? 9999);
    touchNote(noteId);
    return result.lastInsertRowid;
  },

  updateItem: (itemId, fields) => {
    const allowed = ['text', 'checked'];
    const updates = Object.keys(fields).filter(k => allowed.includes(k) && fields[k] !== undefined);
    if (!updates.length) return;
    const set = updates.map(k => `${k} = ?`).join(', ');
    const values = updates.map(k => fields[k]);
    const item = db.prepare(`SELECT note_id FROM items WHERE id = ?`).get(itemId);
    db.prepare(`UPDATE items SET ${set} WHERE id = ?`).run(...values, itemId);
    if (item) touchNote(item.note_id);
  },

  deleteCheckedItems: (noteId) => {
    db.prepare(`DELETE FROM items WHERE note_id = ? AND checked = 1`).run(noteId);
    touchNote(noteId);
  },

  deleteItem: (itemId) => {
    const item = db.prepare(`SELECT note_id FROM items WHERE id = ?`).get(itemId);
    db.prepare(`DELETE FROM items WHERE id = ?`).run(itemId);
    if (item) touchNote(item.note_id);
  },

  reorderItems: (noteId, orderedIds) => {
    const update = db.prepare(`UPDATE items SET position = ? WHERE id = ? AND note_id = ?`);
    db.transaction((ids) => {
      ids.forEach((id, index) => update.run(index, id, noteId));
    })(orderedIds);
    touchNote(noteId);
  },

  // Import
  importNote: db.transaction((userId, { title, body, color, pinned, archived, items, labels }) => {
    const result = db.prepare(`
      INSERT INTO notes (owner_id, title, body, color, pinned, archived)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, title || '', body || '', color || 'default', pinned ? 1 : 0, archived ? 1 : 0);
    const noteId = result.lastInsertRowid;

    if (items?.length) {
      const insertItem = db.prepare(`INSERT INTO items (note_id, text, position, checked) VALUES (?, ?, ?, ?)`);
      items.forEach((item, i) => insertItem.run(noteId, item.text || '', i, item.checked ? 1 : 0));
    }

    if (labels?.length) {
      const upsertLabel = db.prepare(`INSERT OR IGNORE INTO labels (user_id, name) VALUES (?, ?)`);
      const getLabel = db.prepare(`SELECT id FROM labels WHERE user_id = ? AND name = ?`);
      const linkLabel = db.prepare(`INSERT OR IGNORE INTO note_labels (note_id, label_id) VALUES (?, ?)`);
      for (const name of labels) {
        upsertLabel.run(userId, name);
        const label = getLabel.get(userId, name);
        if (label) linkLabel.run(noteId, label.id);
      }
    }

    return noteId;
  }),

  // Labels
  getLabels: (userId) =>
    db.prepare(`SELECT * FROM labels WHERE user_id = ? ORDER BY name ASC`).all(userId),

  createLabel: (userId, name) => {
    const result = db.prepare(`INSERT OR IGNORE INTO labels (user_id, name) VALUES (?, ?)`).run(userId, name.trim());
    return result.lastInsertRowid || db.prepare(`SELECT id FROM labels WHERE user_id = ? AND name = ?`).get(userId, name.trim()).id;
  },

  deleteLabel: (labelId, userId) => {
    db.prepare(`DELETE FROM labels WHERE id = ? AND user_id = ?`).run(labelId, userId);
  },

  addLabelToNote: (noteId, labelId) => {
    db.prepare(`INSERT OR IGNORE INTO note_labels (note_id, label_id) VALUES (?, ?)`).run(noteId, labelId);
    touchNote(noteId);
  },

  removeLabelFromNote: (noteId, labelId) => {
    db.prepare(`DELETE FROM note_labels WHERE note_id = ? AND label_id = ?`).run(noteId, labelId);
    touchNote(noteId);
  },
};
