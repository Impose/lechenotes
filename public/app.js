// --- State ---
const state = {
  user: null,
  notes: [],
  labels: [],
  otherUsers: [],
  view: 'notes',         // 'notes' | 'archive' | label id (number)
  search: '',
  lastSync: new Date(0).toISOString(),
  activeNoteId: null,
  activeNote: null,      // live copy being edited
  syncTimer: null,
  itemSortable: null,
  dragging: false,
  pinnedSortable: null,
  mainSortable: null,
  trashNotes: [],
};

// --- API ---
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (res.status === 401) { window.location = '/login.html'; return null; }
  return res.ok ? res.json() : null;
}
const GET  = (p)    => api('GET', p);
const POST = (p, b) => api('POST', p, b);
const PUT  = (p, b) => api('PUT', p, b);
const DEL  = (p, b) => api('DELETE', p, b);

// --- Init ---
function initDarkMode() {
  if (state.user.dark_mode) document.body.classList.add('dark');
  updateDarkToggle();
  document.getElementById('darkToggle').addEventListener('click', async () => {
    await toggleDarkMode();
  });
  document.getElementById('acctDarkToggle').addEventListener('click', async () => {
    await toggleDarkMode();
  });
}

async function toggleDarkMode() {
  document.body.classList.toggle('dark');
  const dark = document.body.classList.contains('dark');
  updateDarkToggle();
  await PUT('/api/preferences', { dark_mode: dark ? 1 : 0 });
}

function updateDarkToggle() {
  const dark = document.body.classList.contains('dark');
  document.getElementById('darkToggle').textContent = dark ? '☀' : '☾';
  document.getElementById('acctDarkBadge').textContent = dark ? 'On' : 'Off';
}

async function init() {
  state.user = await GET('/api/auth/me');
  if (!state.user) { window.location = '/login.html'; return; }

  initDarkMode();
  document.getElementById('headerUsername').textContent = state.user.username;
  document.getElementById('acctUsername').textContent = state.user.username;
  if (state.user.is_admin) {
    document.getElementById('adminLink').style.display = '';
    document.getElementById('acctAdminLink').style.display = '';
  }

  [state.notes, state.labels, state.otherUsers] = await Promise.all([
    GET('/api/notes'),
    GET('/api/labels'),
    GET('/api/users'),
  ]);

  state.lastSync = new Date().toISOString();

  bindEvents();
  renderSidebar();
  renderGrid();
  startSync();
}

// --- Sync (polling) ---
function startSync() {
  state.syncTimer = setInterval(async () => {
    const since = state.lastSync;
    state.lastSync = new Date().toISOString();
    const updates = await GET(`/api/sync?since=${encodeURIComponent(since)}`);
    if (!updates?.length) return;

    updates.forEach(updated => {
      const idx = state.notes.findIndex(n => n.id === updated.id);
      if (idx >= 0) {
        // Don't override the note currently open in the editor
        if (updated.id !== state.activeNoteId) {
          state.notes[idx] = updated;
        }
      } else if (!updated.deleted) {
        state.notes.unshift(updated);
      }
      // Remove deleted notes
      if (updated.deleted) {
        state.notes = state.notes.filter(n => n.id !== updated.id);
        if (state.activeNoteId === updated.id) closeModal();
      }
    });

    renderGrid();
  }, 2000);
}

// --- Sidebar ---
function renderSidebar() {
  const labelNav = document.getElementById('labelNav');
  labelNav.innerHTML = state.labels.map(l => `
    <li class="nav-item label-nav-item" data-view="label-${l.id}" data-label-id="${l.id}">
      <svg viewBox="0 0 24 24"><path d="M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16z"/></svg>
      ${esc(l.name)}
    </li>
  `).join('');

  labelNav.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => {
      const labelId = parseInt(el.dataset.labelId);
      setView(labelId);
    });
  });

  // Highlight active
  document.querySelectorAll('.nav-item').forEach(el => {
    const v = el.dataset.view;
    const isActive = (state.view === 'notes' && v === 'notes') ||
                     (state.view === 'archive' && v === 'archive') ||
                     (state.view === 'trash' && v === 'trash') ||
                     (typeof state.view === 'number' && v === `label-${state.view}`);
    el.classList.toggle('active', isActive);
  });
}

async function setView(view) {
  state.view = view;
  if (view === 'trash') {
    state.trashNotes = await GET('/api/trash') || [];
  }
  renderSidebar();
  renderGrid();
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarBackdrop').classList.remove('open');
}

// --- Trash ---
function renderTrash() {
  document.getElementById('pinnedSection').style.display = 'none';
  document.getElementById('othersLabel').style.display = 'none';
  document.getElementById('emptyState').style.display = state.trashNotes.length ? 'none' : '';

  const emptyEl = document.getElementById('emptyState');
  emptyEl.querySelector('p').textContent = 'Trash is empty';

  const section = document.getElementById('othersSection');
  const grid = document.getElementById('notesGrid');

  let header = document.getElementById('trashHeader');
  if (!header) {
    header = document.createElement('div');
    header.id = 'trashHeader';
    section.insertBefore(header, grid);
  }
  header.style.display = '';
  header.innerHTML = `
    <div class="trash-header">
      <div class="trash-retention">
        <span>Auto-delete after</span>
        <label><input type="radio" name="trashDays" value="7" ${state.user.trash_days === 7 ? 'checked' : ''}> 7 days</label>
        <label><input type="radio" name="trashDays" value="30" ${state.user.trash_days === 30 ? 'checked' : ''}> 30 days</label>
      </div>
      ${state.trashNotes.length ? `<button class="empty-trash-btn">Empty trash</button>` : ''}
    </div>
  `;
  header.querySelectorAll('input[name=trashDays]').forEach(radio => {
    radio.addEventListener('change', async () => {
      const days = parseInt(radio.value);
      state.user.trash_days = days;
      await PUT('/api/preferences', { trash_days: days });
      renderTrash();
    });
  });
  header.querySelector('.empty-trash-btn')?.addEventListener('click', async () => {
    if (!confirm('Permanently delete all notes in trash?')) return;
    await DEL('/api/trash');
    state.trashNotes = [];
    renderTrash();
  });

  grid.innerHTML = state.trashNotes.map(trashCard).join('');
  grid.querySelectorAll('.trash-restore-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const noteId = parseInt(btn.dataset.id);
      const restored = await POST(`/api/notes/${noteId}/restore`);
      if (restored) {
        state.trashNotes = state.trashNotes.filter(n => n.id !== noteId);
        mergeNoteIntoState(restored);
        renderTrash();
        renderGrid();
      }
    });
  });
  grid.querySelectorAll('.trash-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const noteId = parseInt(btn.dataset.id);
      if (!confirm('Permanently delete this note?')) return;
      await DEL(`/api/trash/${noteId}`);
      state.trashNotes = state.trashNotes.filter(n => n.id !== noteId);
      renderTrash();
    });
  });
}

function trashCard(note) {
  const colorClass = note.color !== 'default' ? `color-${note.color}` : '';
  const daysLeft = note.deleted_at
    ? Math.max(0, Math.ceil((new Date(note.deleted_at).getTime() + state.user.trash_days * 86400000 - Date.now()) / 86400000))
    : state.user.trash_days;
  const items = (note.items || []).filter(i => !i.checked).slice(0, 5);
  return `
    <div class="note-card trash-card ${colorClass}" data-id="${note.id}">
      ${note.title ? `<div class="note-card-title">${esc(note.title)}</div>` : ''}
      ${note.body  ? `<div class="note-card-body">${esc(note.body)}</div>` : ''}
      ${items.map(i => `<div class="note-card-body" style="font-size:13px">☐ ${esc(i.text)}</div>`).join('')}
      <div class="trash-card-meta">Deletes in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}</div>
      <div class="trash-card-actions">
        <button class="trash-restore-btn" data-id="${note.id}">Restore</button>
        <button class="trash-delete-btn" data-id="${note.id}">Delete forever</button>
      </div>
    </div>
  `;
}

// --- Grid ---
function renderGrid() {
  if (state.dragging) return;

  // Hide trash header when not in trash view
  const trashHeader = document.getElementById('trashHeader');
  if (trashHeader) trashHeader.style.display = 'none';
  document.getElementById('emptyState').querySelector('p').textContent = 'No notes yet';

  if (state.view === 'trash') {
    renderTrash();
    return;
  }

  let visible = state.notes.filter(n => {
    if (n.deleted) return false;
    if (state.search) {
      const q = state.search.toLowerCase();
      const titleMatch = n.title.toLowerCase().includes(q);
      const bodyMatch  = n.body.toLowerCase().includes(q);
      const itemMatch  = n.items?.some(i => i.text.toLowerCase().includes(q));
      if (!titleMatch && !bodyMatch && !itemMatch) return false;
    }
    if (state.view === 'archive') return n.archived;
    if (typeof state.view === 'number') {
      return !n.archived && n.labels?.some(l => l.id === state.view);
    }
    return !n.archived;
  });

  const byOrder = (a, b) => (a.sort_order - b.sort_order) || (new Date(b.updated_at) - new Date(a.updated_at));
  const pinned  = visible.filter(n => n.pinned).sort(byOrder);
  const others  = visible.filter(n => !n.pinned).sort(byOrder);

  document.getElementById('pinnedSection').style.display = pinned.length ? '' : 'none';
  document.getElementById('othersLabel').style.display = (pinned.length && others.length) ? '' : 'none';
  document.getElementById('emptyState').style.display = visible.length ? 'none' : '';

  document.getElementById('pinnedGrid').innerHTML = pinned.map(noteCard).join('');
  document.getElementById('notesGrid').innerHTML  = others.map(noteCard).join('');

  document.querySelectorAll('.note-card').forEach(el => {
    el.addEventListener('click', () => openModal(parseInt(el.dataset.id)));
  });

  setupGridSort();
}

function setupGridSort() {
  if (state.pinnedSortable) { state.pinnedSortable.destroy(); state.pinnedSortable = null; }
  if (state.mainSortable)   { state.mainSortable.destroy();   state.mainSortable   = null; }

  // Disable drag-to-sort during search or label filter — only a partial set of notes is shown
  if (state.search || typeof state.view === 'number') return;

  const makeSortable = (el) => Sortable.create(el, {
    animation: 150,
    delay: 200,
    delayOnTouchOnly: true,
    ghostClass: 'card-ghost',
    onStart: () => { state.dragging = true; },
    onEnd: (evt) => {
      state.dragging = false;
      if (evt.oldIndex === evt.newIndex) return;
      const ids = Array.from(evt.to.querySelectorAll('.note-card')).map(el => parseInt(el.dataset.id));
      ids.forEach((id, i) => {
        const note = state.notes.find(n => n.id === id);
        if (note) note.sort_order = i + 1;
      });
      PUT('/api/notes/reorder', { order: ids });
    },
  });

  state.pinnedSortable = makeSortable(document.getElementById('pinnedGrid'));
  state.mainSortable   = makeSortable(document.getElementById('notesGrid'));
}

function noteCard(note) {
  const colorClass = note.color !== 'default' ? `color-${note.color}` : '';
  const items = note.items || [];
  const unchecked = items.filter(i => !i.checked);
  const checked   = items.filter(i => i.checked);
  const visibleItems = unchecked.slice(0, 8);

  const sharedLabel = note.owner_id !== state.user.id
    ? `<div class="note-card-shared">Shared by ${esc(note.owner_username || '')}</div>`
    : (note.shared_with?.length ? `<div class="note-card-shared">Shared</div>` : '');

  return `
    <div class="note-card ${colorClass}" data-id="${note.id}">
      ${note.pinned ? `<div class="note-card-pin"><svg viewBox="0 0 24 24"><path d="M17 4v7l2 3H5l2-3V4h10m0-2H7c-.55 0-1 .45-1 1v7.81L4 14v2h7v5h2v-5h7v-2l-2-3.19V3c0-.55-.45-1-1-1z"/></svg></div>` : ''}
      ${note.title ? `<div class="note-card-title">${esc(note.title)}</div>` : ''}
      ${note.body  ? `<div class="note-card-body">${esc(note.body)}</div>` : ''}
      ${(visibleItems.length || checked.length) ? `
        <ul class="note-card-items">
          ${visibleItems.map(i => `
            <li>
              <span>☐</span>
              ${esc(i.text)}
            </li>
          `).join('')}
          ${unchecked.length > 8 ? `<li class="card-items-more">+${unchecked.length - 8} more</li>` : ''}
          ${checked.length ? `<li class="card-items-checked-count">+ ${checked.length} checked item${checked.length === 1 ? '' : 's'}</li>` : ''}
        </ul>
      ` : ''}
      ${note.labels?.length ? `
        <div class="note-card-labels">
          ${note.labels.map(l => `<span class="note-label-chip">${esc(l.name)}</span>`).join('')}
        </div>
      ` : ''}
      ${sharedLabel}
    </div>
  `;
}

// Counteract iOS panning the visual viewport when keyboard opens inside a fixed overlay
function syncModalToViewport() {
  if (!window.visualViewport) return;
  document.getElementById('modalOverlay').style.transform =
    `translateY(${window.visualViewport.offsetTop}px)`;
}

// --- Modal ---
function openModal(noteId) {
  const note = state.notes.find(n => n.id === noteId);
  if (!note) return;
  state.activeNoteId = noteId;
  state.activeNote = JSON.parse(JSON.stringify(note)); // deep copy

  const modal = document.getElementById('modal');
  modal.className = 'modal' + (note.color !== 'default' ? ` color-${note.color}` : '');

  document.getElementById('modalTitle').value = note.title || '';
  document.getElementById('modalBody').value  = note.body  || '';

  renderModalItems();
  updateModalButtons();

  document.getElementById('modalOverlay').classList.add('open');
  if (window.visualViewport) {
    window.visualViewport.addEventListener('scroll', syncModalToViewport);
    window.visualViewport.addEventListener('resize', syncModalToViewport);
  }
  const scrollY = window.scrollY;
  document.body.dataset.scrollY = scrollY;
  document.body.style.position = 'fixed';
  document.body.style.top = `-${scrollY}px`;
  document.body.style.width = '100%';
  document.body.style.overflow = 'hidden';

  closePickers();
}

function itemHTML(item) {
  return `
    <li class="modal-item" data-item-id="${item.id}">
      <span class="drag-handle">⠿</span>
      <input type="checkbox" ${item.checked ? 'checked' : ''} data-item-id="${item.id}">
      <input type="text" class="item-text ${item.checked ? 'checked-text' : ''}" value="${esc(item.text)}" data-item-id="${item.id}" placeholder="List item">
      <button class="item-delete" data-item-id="${item.id}">×</button>
    </li>
  `;
}

function renderModalItems() {
  const note = state.activeNote;
  const list = document.getElementById('modalItems');
  const unchecked = (note.items || []).filter(i => !i.checked);
  const checked   = (note.items || []).filter(i => i.checked);

  list.innerHTML = [
    ...unchecked.map(itemHTML),
    ...(checked.length ? [`
      <li class="checked-divider">
        <span>Checked</span>
        <button class="delete-checked-btn">Delete all</button>
      </li>
    `] : []),
    ...checked.map(itemHTML),
  ].join('');

  // Sortable — exclude the checked divider from dragging
  if (state.itemSortable) state.itemSortable.destroy();
  state.itemSortable = Sortable.create(list, {
    handle: '.drag-handle',
    filter: '.checked-divider',
    animation: 150,
    delay: 150,
    delayOnTouchOnly: true,
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    onEnd: async () => {
      const order = [...list.querySelectorAll('.modal-item[data-item-id]')]
        .map(el => parseInt(el.dataset.itemId))
        .filter(id => !isNaN(id));
      await PUT(`/api/notes/${state.activeNoteId}/items/reorder`, { order });
      const itemsMap = Object.fromEntries((state.activeNote.items || []).map(i => [i.id, i]));
      state.activeNote.items = order.map(id => itemsMap[id]).filter(Boolean);
    },
  });

  // Delete all checked
  list.querySelector('.delete-checked-btn')?.addEventListener('click', async () => {
    await DEL(`/api/notes/${state.activeNoteId}/items/checked`);
    state.activeNote.items = (state.activeNote.items || []).filter(i => !i.checked);
    renderModalItems();
  });

  // Checkbox events
  list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', async () => {
      const itemId = parseInt(cb.dataset.itemId);
      const checked = cb.checked ? 1 : 0;
      await PUT(`/api/notes/${state.activeNoteId}/items/${itemId}`, { checked });
      const item = (state.activeNote.items || []).find(i => i.id === itemId);
      if (item) item.checked = checked;
      cb.closest('.modal-item').querySelector('.item-text').classList.toggle('checked-text', !!checked);
      // Re-render to move checked items to bottom
      renderModalItems();
    });
  });

  // Text edit events
  list.querySelectorAll('.item-text').forEach(input => {
    let didScroll = false;
    input.addEventListener('touchstart', () => { didScroll = false; }, { passive: true });
    input.addEventListener('touchmove', () => { didScroll = true; }, { passive: true });
    input.addEventListener('touchend', () => { if (!didScroll) input.focus(); });
    input.addEventListener('blur', async () => {
      const itemId = parseInt(input.dataset.itemId);
      await PUT(`/api/notes/${state.activeNoteId}/items/${itemId}`, { text: input.value });
      const item = (state.activeNote.items || []).find(i => i.id === itemId);
      if (item) item.text = input.value;
    });
    input.addEventListener('keydown', async e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const itemId = parseInt(input.dataset.itemId);
        const text = input.value;
        await PUT(`/api/notes/${state.activeNoteId}/items/${itemId}`, { text });
        const item = (state.activeNote.items || []).find(i => i.id === itemId);
        if (item) item.text = text;
        await addItemAfter(itemId);
      }
    });
  });

  // Delete events
  list.querySelectorAll('.item-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const itemId = parseInt(btn.dataset.itemId);
      await DEL(`/api/notes/${state.activeNoteId}/items/${itemId}`);
      state.activeNote.items = (state.activeNote.items || []).filter(i => i.id !== itemId);
      renderModalItems();
    });
  });
}

function updateModalButtons() {
  const note = state.activeNote;
  const isOwner = note.owner_id === state.user.id;

  document.getElementById('pinBtn').classList.toggle('active', !!note.pinned);
  document.getElementById('archiveBtn').title = note.archived ? 'Unarchive' : 'Archive';
  document.getElementById('deleteBtn').style.display = isOwner ? '' : 'none';
  document.getElementById('shareBtn').style.display  = isOwner ? '' : 'none';
}

async function saveActiveNote() {
  if (!state.activeNoteId) return;
  const title = document.getElementById('modalTitle').value;
  const body  = document.getElementById('modalBody').value;
  if (title === state.activeNote.title && body === state.activeNote.body) return;
  const updated = await PUT(`/api/notes/${state.activeNoteId}`, { title, body });
  if (updated) {
    state.activeNote.title = title;
    state.activeNote.body  = body;
    mergeNoteIntoState(updated);
    renderGrid();
  }
}

function mergeNoteIntoState(note) {
  const idx = state.notes.findIndex(n => n.id === note.id);
  if (idx >= 0) state.notes[idx] = note;
  else state.notes.unshift(note);
}

async function addItem() {
  const maxPos = Math.max(-1, ...(state.activeNote.items || []).map(i => i.position));
  const item = await POST(`/api/notes/${state.activeNoteId}/items`, { text: '', position: maxPos + 1 });
  if (item) {
    state.activeNote.items = [...(state.activeNote.items || []), item];
    renderModalItems();
    const inputs = document.querySelectorAll('#modalItems .item-text');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }
}

async function addItemAfter(afterItemId) {
  const items = state.activeNote.items || [];
  const idx = items.findIndex(i => i.id === afterItemId);
  const afterItem = items[idx];
  const nextItem = items[idx + 1];
  const position = nextItem
    ? (afterItem.position + nextItem.position) / 2
    : (afterItem?.position ?? 0) + 1;

  const newItem = await POST(`/api/notes/${state.activeNoteId}/items`, { text: '', position });
  if (newItem) {
    items.splice(idx + 1, 0, newItem);
    renderModalItems();
    const el = document.querySelector(`#modalItems .modal-item[data-item-id="${newItem.id}"]`);
    el?.querySelector('.item-text')?.focus();
  }
}

async function closeModal() {
  await saveActiveNote();

  // Sync final note back to grid
  const final = await GET(`/api/notes`);
  if (final) state.notes = final;
  renderGrid();

  state.activeNoteId = null;
  state.activeNote   = null;
  if (state.itemSortable) { state.itemSortable.destroy(); state.itemSortable = null; }
  document.getElementById('modalOverlay').classList.remove('open');
  document.getElementById('modalOverlay').style.transform = '';
  if (window.visualViewport) {
    window.visualViewport.removeEventListener('scroll', syncModalToViewport);
    window.visualViewport.removeEventListener('resize', syncModalToViewport);
  }
  const scrollY = parseInt(document.body.dataset.scrollY || '0');
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.width = '';
  document.body.style.overflow = '';
  window.scrollTo(0, scrollY);
  closePickers();
}

function closePickers() {
  document.getElementById('colorPicker').classList.remove('open');
  document.getElementById('labelPicker').classList.remove('open');
  document.getElementById('sharePanel').classList.remove('open');
}

// --- Create note ---
async function createNote(withItems = false) {
  const title = document.getElementById('quickTitle').value.trim();
  const note = await POST('/api/notes', { title, body: '', color: 'default' });
  if (!note) return;
  state.notes.unshift(note);
  document.getElementById('quickTitle').value = '';
  document.getElementById('createActions').style.display = 'none';
  renderGrid();
  openModal(note.id);
  if (withItems) addItem();
}

// --- Events ---
function bindEvents() {
  // Logout
  const doLogout = async () => { await POST('/api/auth/logout'); window.location = '/login.html'; };
  document.getElementById('logoutBtn').addEventListener('click', doLogout);
  document.getElementById('acctSignout').addEventListener('click', doLogout);

  // Mobile menu
  const closeSidebar = () => {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarBackdrop').classList.remove('open');
  };
  document.getElementById('menuBtn').addEventListener('click', () => {
    const open = document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebarBackdrop').classList.toggle('open', open);
  });
  document.getElementById('sidebarBackdrop').addEventListener('click', closeSidebar);

  // Search (desktop)
  document.getElementById('searchInput').addEventListener('input', e => {
    state.search = e.target.value;
    renderGrid();
  });

  // Mobile search overlay
  const mobileOverlay = document.getElementById('mobileSearchOverlay');
  const mobileInput  = document.getElementById('mobileSearchInput');
  document.getElementById('mobileSearchBtn').addEventListener('click', () => {
    mobileOverlay.classList.add('open');
    mobileInput.focus();
  });
  document.getElementById('mobileSearchClose').addEventListener('click', () => {
    mobileOverlay.classList.remove('open');
    mobileInput.value = '';
    state.search = '';
    renderGrid();
  });
  mobileInput.addEventListener('input', e => {
    state.search = e.target.value;
    renderGrid();
  });

  // Account dropdown
  const acctBtn = document.getElementById('acctBtn');
  const acctDropdown = document.getElementById('acctDropdown');
  acctBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    acctDropdown.classList.toggle('open');
  });
  document.addEventListener('click', () => acctDropdown.classList.remove('open'));

  // Sidebar nav
  document.getElementById('sidebar').querySelectorAll('.nav-item[data-view]').forEach(el => {
    el.addEventListener('click', () => {
      const v = el.dataset.view;
      setView(v === 'archive' ? 'archive' : v === 'trash' ? 'trash' : 'notes');
    });
  });

  // New label
  document.getElementById('newLabelBtn').addEventListener('click', async () => {
    const name = prompt('Label name:');
    if (!name?.trim()) return;
    const label = await POST('/api/labels', { name });
    if (label) {
      state.labels.push(label);
      renderSidebar();
    }
  });

  // Create bar
  document.getElementById('quickTitle').addEventListener('focus', () => {
    document.getElementById('quickTitle').removeAttribute('readonly');
    document.getElementById('createActions').style.display = 'flex';
  });
  document.getElementById('createSaveBtn').addEventListener('click', () => createNote(false));
  document.getElementById('createChecklistBtn').addEventListener('click', () => createNote(true));

  // Modal close
  document.getElementById('modalCloseBtn').addEventListener('click', closeModal);
  document.getElementById('modalOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modalOverlay')) closeModal();
  });

  // Auto-save on title/body blur
  document.getElementById('modalTitle').addEventListener('blur', saveActiveNote);
  document.getElementById('modalBody').addEventListener('blur', saveActiveNote);

  // Add item
  document.getElementById('addItemBtn').addEventListener('click', addItem);

  // Pin
  document.getElementById('pinBtn').addEventListener('click', async () => {
    const pinned = state.activeNote.pinned ? 0 : 1;
    const updated = await POST(`/api/notes/${state.activeNoteId}/pin`, { pinned });
    if (updated) {
      state.activeNote.pinned = pinned;
      mergeNoteIntoState(updated);
      updateModalButtons();
      renderGrid();
    }
  });

  // Archive
  document.getElementById('archiveBtn').addEventListener('click', async () => {
    const archived = state.activeNote.archived ? 0 : 1;
    await PUT(`/api/notes/${state.activeNoteId}`, { archived });
    state.activeNote.archived = archived;
    mergeNoteIntoState({ ...state.activeNote });
    closeModal();
  });

  // Delete
  document.getElementById('deleteBtn').addEventListener('click', async () => {
    if (!confirm('Delete this note?')) return;
    await DEL(`/api/notes/${state.activeNoteId}`);
    state.notes = state.notes.filter(n => n.id !== state.activeNoteId);
    closeModal();
  });

  // Color picker toggle
  document.getElementById('colorBtn').addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('colorPicker').classList.toggle('open');
    document.getElementById('labelPicker').classList.remove('open');
    document.getElementById('sharePanel').classList.remove('open');
  });

  document.querySelectorAll('.color-swatch').forEach(swatch => {
    swatch.addEventListener('click', async () => {
      const color = swatch.dataset.color;
      const updated = await PUT(`/api/notes/${state.activeNoteId}`, { color });
      if (updated) {
        state.activeNote.color = color;
        mergeNoteIntoState(updated);
        const modal = document.getElementById('modal');
        modal.className = 'modal' + (color !== 'default' ? ` color-${color}` : '');
        document.querySelectorAll('.color-swatch').forEach(s => s.classList.toggle('selected', s.dataset.color === color));
        renderGrid();
      }
      document.getElementById('colorPicker').classList.remove('open');
    });
  });

  // Label picker toggle
  document.getElementById('labelBtn').addEventListener('click', e => {
    e.stopPropagation();
    renderLabelPicker();
    document.getElementById('labelPicker').classList.toggle('open');
    document.getElementById('colorPicker').classList.remove('open');
    document.getElementById('sharePanel').classList.remove('open');
  });

  // Share panel toggle
  document.getElementById('shareBtn').addEventListener('click', e => {
    e.stopPropagation();
    renderSharePanel();
    document.getElementById('sharePanel').classList.toggle('open');
    document.getElementById('colorPicker').classList.remove('open');
    document.getElementById('labelPicker').classList.remove('open');
  });

  // Close pickers on outside click
  document.addEventListener('click', closePickers);
  document.getElementById('modal').addEventListener('click', e => e.stopPropagation());
}

function renderLabelPicker() {
  const note = state.activeNote;
  const activeIds = new Set((note.labels || []).map(l => l.id));
  document.getElementById('labelPickerList').innerHTML = state.labels.map(l => `
    <label class="label-picker-item">
      <input type="checkbox" data-label-id="${l.id}" ${activeIds.has(l.id) ? 'checked' : ''}>
      ${esc(l.name)}
    </label>
  `).join('');

  document.querySelectorAll('#labelPickerList input').forEach(cb => {
    cb.addEventListener('change', async () => {
      const labelId = parseInt(cb.dataset.labelId);
      if (cb.checked) {
        await POST(`/api/notes/${state.activeNoteId}/labels/${labelId}`);
        const label = state.labels.find(l => l.id === labelId);
        if (label) state.activeNote.labels = [...(state.activeNote.labels || []), label];
      } else {
        await DEL(`/api/notes/${state.activeNoteId}/labels/${labelId}`);
        state.activeNote.labels = (state.activeNote.labels || []).filter(l => l.id !== labelId);
      }
      mergeNoteIntoState({ ...state.activeNote });
      renderGrid();
    });
  });
}

function renderSharePanel() {
  const note = state.activeNote;
  const sharedIds = new Set((note.shared_with || []).map(u => u.id));
  document.getElementById('sharePanelList').innerHTML = state.otherUsers.map(u => `
    <label class="share-panel-item">
      <input type="checkbox" data-user-id="${u.id}" ${sharedIds.has(u.id) ? 'checked' : ''}>
      ${esc(u.username)}
    </label>
  `).join('');

  document.querySelectorAll('#sharePanelList input').forEach(cb => {
    cb.addEventListener('change', async () => {
      const userId = parseInt(cb.dataset.userId);
      if (cb.checked) {
        const updated = await POST(`/api/notes/${state.activeNoteId}/share`, { userId });
        if (updated) { state.activeNote.shared_with = updated.shared_with; mergeNoteIntoState(updated); }
      } else {
        const updated = await DEL(`/api/notes/${state.activeNoteId}/share`, { userId });
        if (updated) { state.activeNote.shared_with = updated.shared_with; mergeNoteIntoState(updated); }
      }
    });
  });
}

// --- Utility ---
function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

init();
