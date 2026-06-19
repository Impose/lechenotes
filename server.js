const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');
const { rateLimit } = require('express-rate-limit');
const SqliteStore = require('better-sqlite3-session-store')(session);
const multer = require('multer');
const AdmZip = require('adm-zip');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3333;

if (!process.env.SESSION_SECRET) {
  console.error('ERROR: SESSION_SECRET environment variable is not set.');
  console.error('Generate one with: openssl rand -hex 32');
  process.exit(1);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { etag: true, lastModified: true, setHeaders: (res) => {
  res.setHeader('Cache-Control', 'no-cache');
}}));
app.use('/sortable.min.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules/sortablejs/Sortable.min.js'))
);
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: new SqliteStore({ client: db.db }),
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 },
}));


// --- Middleware ---
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function requireAdmin(req, res, next) {
  const user = db.getUserById(req.session.userId);
  if (!user?.is_admin) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// Redirect to setup if no users exist
app.use((req, res, next) => {
  if (req.path.startsWith('/api/setup') || req.path === '/setup.html') return next();
  if (db.userCount() === 0) {
    if (req.path.startsWith('/api/')) return res.status(503).json({ error: 'Setup required' });
    return res.redirect('/setup.html');
  }
  next();
});

function withNoteAccess(req, res, next) {
  if (!db.canAccessNote(parseInt(req.params.id), req.session.userId))
    return res.status(404).json({ error: 'Note not found' });
  next();
}

function withNoteOwnership(req, res, next) {
  if (!db.isNoteOwner(parseInt(req.params.id), req.session.userId))
    return res.status(403).json({ error: 'Forbidden' });
  next();
}

function withTrashOwnership(req, res, next) {
  const note = db.db.prepare(`SELECT owner_id FROM notes WHERE id = ? AND deleted = 1`).get(parseInt(req.params.id));
  if (!note || note.owner_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
  next();
}

const MIN_PASSWORD_LENGTH = 8;

// --- Setup (first run) ---
app.post('/api/setup', async (req, res) => {
  if (db.userCount() > 0) return res.status(403).json({ error: 'Already set up' });
  const { username, password } = req.body;
  if (!username?.trim() || !password) return res.status(400).json({ error: 'Username and password required' });
  if (password.length < MIN_PASSWORD_LENGTH) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  const hash = await bcrypt.hash(password, 10);
  db.createUser(username.trim(), hash, 1);
  const user = db.getUserByUsername(username.trim());
  req.session.userId = user.id;
  res.json({ ok: true });
});

// --- Admin ---
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  res.json(db.getAllUsers());
});

app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { username, password, is_admin } = req.body;
  if (!username?.trim() || !password) return res.status(400).json({ error: 'Username and password required' });
  if (password.length < MIN_PASSWORD_LENGTH) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  const existing = db.getUserByUsername(username.trim());
  if (existing) return res.status(409).json({ error: 'Username already taken' });
  const hash = await bcrypt.hash(password, 10);
  db.createUser(username.trim(), hash, is_admin ? 1 : 0);
  res.json(db.getUserByUsername(username.trim()));
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.session.userId) return res.status(400).json({ error: 'Cannot delete your own account' });
  db.deleteUser(id);
  res.json({ ok: true });
});

app.put('/api/admin/users/:id/password', requireAuth, requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (password.length < MIN_PASSWORD_LENGTH) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  const hash = await bcrypt.hash(password, 10);
  db.setUserPassword(parseInt(req.params.id), hash);
  res.json({ ok: true });
});

const keepColorMap = {
  DEFAULT: 'default', RED: 'red', ORANGE: 'orange', YELLOW: 'yellow',
  GREEN: 'green', TEAL: 'teal', BLUE: 'blue', CERULEAN: 'blue',
  PURPLE: 'purple', GRAPE: 'purple', PINK: 'pink', GRAY: 'default', WHITE: 'default',
};

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

app.post('/api/admin/import/keep', requireAuth, requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let entries;
  try {
    entries = new AdmZip(req.file.buffer).getEntries();
  } catch (e) {
    return res.status(400).json({ error: 'Invalid zip file' });
  }

  let imported = 0, skipped = 0;
  for (const entry of entries) {
    if (entry.isDirectory || !entry.entryName.endsWith('.json')) continue;
    let note;
    try { note = JSON.parse(entry.getData().toString('utf8')); } catch { skipped++; continue; }
    if (note.textContent === undefined && note.listContent === undefined) { skipped++; continue; }
    if (note.isTrashed) { skipped++; continue; }

    try {
      db.importNote(req.session.userId, {
        title: note.title || '',
        body: note.textContent || '',
        color: keepColorMap[note.color] || 'default',
        pinned: !!note.isPinned,
        archived: !!note.isArchived,
        items: Array.isArray(note.listContent) ? note.listContent.map(i => ({ text: i.text, checked: !!i.isChecked })) : [],
        labels: Array.isArray(note.labels) ? note.labels.map(l => l.name).filter(Boolean) : [],
      });
      imported++;
    } catch { skipped++; }
  }

  res.json({ imported, skipped });
});

app.put('/api/admin/users/:id/role', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.session.userId) return res.status(400).json({ error: 'Cannot change your own role' });
  const { is_admin } = req.body;
  db.setUserAdmin(id, is_admin ? 1 : 0);
  res.json({ ok: true });
});

// --- Auth ---
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: { error: 'Too many login attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  const user = db.getUserByUsername(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  req.session.userId = user.id;
  res.json({ id: user.id, username: user.username });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json(db.getUserById(req.session.userId));
});

app.put('/api/preferences', requireAuth, (req, res) => {
  const { dark_mode, trash_days } = req.body;
  if (dark_mode !== undefined) db.setDarkMode(req.session.userId, dark_mode);
  if (trash_days !== undefined && [7, 30].includes(trash_days)) db.setTrashDays(req.session.userId, trash_days);
  res.json({ ok: true });
});

// --- Users ---
app.get('/api/users', requireAuth, (req, res) => {
  res.json(db.getAllOtherUsers(req.session.userId));
});

// --- Trash ---
app.get('/api/trash', requireAuth, (req, res) => {
  db.purgeExpiredNotes();
  res.json(db.getTrashNotes(req.session.userId));
});

app.post('/api/notes/:id/restore', requireAuth, withTrashOwnership, (req, res) => {
  const noteId = parseInt(req.params.id);
  db.restoreNote(noteId);
  res.json(db.getNoteById(noteId) || { ok: true });
});

app.delete('/api/trash', requireAuth, (req, res) => {
  db.emptyTrash(req.session.userId);
  res.json({ ok: true });
});

app.delete('/api/trash/:id', requireAuth, withTrashOwnership, (req, res) => {
  db.permanentDeleteNote(parseInt(req.params.id));
  res.json({ ok: true });
});

// --- Notes ---
app.get('/api/notes', requireAuth, (req, res) => {
  res.json(db.getNotesForUser(req.session.userId));
});

app.post('/api/notes', requireAuth, (req, res) => {
  const { title, body, color } = req.body;
  const id = db.createNote(req.session.userId, title, body, color);
  res.json(db.getNoteById(id));
});

app.put('/api/notes/reorder', requireAuth, (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be array' });
  const ids = order.map(id => parseInt(id)).filter(id => !isNaN(id) && db.canAccessNote(id, req.session.userId));
  if (ids.length) db.reorderNotes(ids);
  res.json({ ok: true });
});

app.put('/api/notes/:id', requireAuth, withNoteAccess, (req, res) => {
  const { title, body, color, archived } = req.body;
  db.updateNote(parseInt(req.params.id), { title, body, color, archived });
  res.json(db.getNoteById(parseInt(req.params.id)));
});

app.post('/api/notes/:id/pin', requireAuth, withNoteAccess, (req, res) => {
  const { pinned } = req.body;
  db.setPinned(parseInt(req.params.id), req.session.userId, !!pinned);
  res.json({ ok: true, pinned: !!pinned });
});

app.delete('/api/notes/:id', requireAuth, withNoteOwnership, (req, res) => {
  db.softDeleteNote(parseInt(req.params.id));
  res.json({ ok: true });
});

// --- Sharing ---
app.post('/api/notes/:id/share', requireAuth, withNoteOwnership, (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  db.shareNote(parseInt(req.params.id), userId);
  res.json(db.getNoteById(parseInt(req.params.id)));
});

app.delete('/api/notes/:id/share', requireAuth, withNoteOwnership, (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  db.unshareNote(parseInt(req.params.id), userId);
  res.json(db.getNoteById(parseInt(req.params.id)));
});

// --- Items --- (reorder must be defined before :itemId)
app.delete('/api/notes/:id/items/checked', requireAuth, withNoteAccess, (req, res) => {
  db.deleteCheckedItems(parseInt(req.params.id));
  res.json({ ok: true });
});

app.put('/api/notes/:id/items/reorder', requireAuth, withNoteAccess, (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be array of ids' });
  db.reorderItems(parseInt(req.params.id), order);
  res.json({ ok: true });
});

app.post('/api/notes/:id/items', requireAuth, withNoteAccess, (req, res) => {
  const { text, position } = req.body;
  const id = db.addItem(parseInt(req.params.id), text, position);
  res.json({ id, note_id: parseInt(req.params.id), text: text || '', checked: 0, position: position ?? 9999 });
});

app.put('/api/notes/:id/items/:itemId', requireAuth, withNoteAccess, (req, res) => {
  const { text, checked } = req.body;
  db.updateItem(parseInt(req.params.itemId), { text, checked });
  res.json({ ok: true });
});

app.delete('/api/notes/:id/items/:itemId', requireAuth, withNoteAccess, (req, res) => {
  db.deleteItem(parseInt(req.params.itemId));
  res.json({ ok: true });
});

// --- Labels ---
app.get('/api/labels', requireAuth, (req, res) => {
  res.json(db.getLabels(req.session.userId));
});

app.post('/api/labels', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const id = db.createLabel(req.session.userId, name);
  res.json({ id, name: name.trim() });
});

app.delete('/api/labels/:id', requireAuth, (req, res) => {
  db.deleteLabel(parseInt(req.params.id), req.session.userId);
  res.json({ ok: true });
});

app.post('/api/notes/:id/labels/:labelId', requireAuth, withNoteAccess, (req, res) => {
  db.addLabelToNote(parseInt(req.params.id), parseInt(req.params.labelId));
  res.json({ ok: true });
});

app.delete('/api/notes/:id/labels/:labelId', requireAuth, withNoteAccess, (req, res) => {
  db.removeLabelFromNote(parseInt(req.params.id), parseInt(req.params.labelId));
  res.json({ ok: true });
});

// --- Sync ---
app.get('/api/sync', requireAuth, (req, res) => {
  const since = req.query.since || new Date(0).toISOString();
  res.json(db.getSyncedNotes(req.session.userId, since));
});

// SPA fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

db.purgeExpiredNotes();
app.listen(PORT, () => console.log(`Lechenotes running on port ${PORT}`));
