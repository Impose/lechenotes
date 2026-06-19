# Lechenotes

A self-hosted Google Keep-style notes app. Card-based notes with checklists, labels, colors, pinning, archiving, and real-time sync across devices and users — all in a single Docker container with no external dependencies.

Built for small groups: family, housemates, a small team. Admin-controlled accounts, no open registration.

---

## Features

- Card grid layout with 8 color options
- Rich checklists — drag to reorder, checked items collapse into a summary on cards, "Checked" section with delete-all in the editor
- Labels and sidebar filtering
- Pin and archive notes
- Real-time sync between users (2-second polling)
- Per-user dark mode, stored server-side
- Admin panel — create, delete, promote/demote users and reset passwords
- Mobile-friendly — optimised touch targets, scroll lock, single-tap to edit
- No external database — SQLite, single file on disk

---

## Quick start

The image is published at `ghcr.io/impose/lechenotes:latest`.

```yaml
services:
  lechenotes:
    image: ghcr.io/impose/lechenotes:latest
    container_name: lechenotes
    restart: unless-stopped
    ports:
      - "3333:3333"
    volumes:
      - /path/to/data:/data
    environment:
      SESSION_SECRET: "change-this-to-a-random-string"  # openssl rand -hex 32
```

1. Replace `/path/to/data` with a directory on your host for the SQLite database
2. Set `SESSION_SECRET` to a random string — `openssl rand -hex 32` generates a good one
3. Run `docker compose up -d`
4. Open `http://localhost:3333` — you'll be taken to the setup page to create your admin account

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SESSION_SECRET` | Yes | Secret used to sign session cookies. Must be set or the app will refuse to start. Generate with `openssl rand -hex 32`. |
| `PORT` | No | Port to listen on. Defaults to `3333`. |
| `DATA_DIR` | No | Path inside the container where the SQLite database is stored. Defaults to `/data`. |

---

## First run

When no users exist in the database, all routes redirect to `/setup`. This page creates the initial admin account. Once submitted, you're logged in and taken to the app.

After setup, manage users from the admin panel — click the ⚙ gear icon in the header (visible to admins only).

---

## Reverse proxy

Lechenotes works behind any reverse proxy. Set the upstream to `http://localhost:3333` (or whichever port you mapped).

If you're using Cloudflare Tunnel, note that Cloudflare caches static JS and CSS aggressively. The app uses versioned asset URLs (`?v=N`) to bust this cache on updates.

---

## Updating

```bash
docker compose pull
docker compose up -d
```

Database migrations run automatically on startup — no manual steps needed.

---

## Contributing

Pull requests welcome. The stack is intentionally simple — Node.js, Express, SQLite, and vanilla JS with no frontend framework.

See the project files section below for a map of the codebase.

---

## Project files

### Root

#### `server.js`
Express app entry point. Handles all HTTP routing, session management, and auth middleware. Serves static files from `public/` with `Cache-Control: no-cache`. All API routes live here — auth, setup, notes, items, labels, sharing, sync, user preferences, and admin user management.

Key middleware:
- `requireAuth` — rejects unauthenticated requests with 401
- `requireAdmin` — rejects non-admin users with 403
- First-run redirect — if no users exist, redirects all non-setup routes to `/setup.html`
- Login rate limiter — 10 attempts per IP per 15 minutes via `express-rate-limit`

#### `db.js`
All SQLite logic. Opens (or creates) the database at `$DATA_DIR/lechenotes.db`. Defines the full schema — `users`, `notes`, `note_shares`, `items`, `labels`, `note_labels` — and runs migrations on startup:
- Adds `dark_mode INTEGER` column to `users` if missing
- Adds `is_admin INTEGER` column to `users` if missing; on that migration, auto-promotes the first user (lowest id) to admin so existing installs aren't locked out

Exports every query function used by `server.js`: notes CRUD, item CRUD, reordering, sharing, labels, sync, preference storage, and user management (create, delete, set password, set admin role).

#### `package.json`
Node.js project manifest. Dependencies:
- `express` — HTTP server and routing
- `express-session` — cookie-based session handling (MemoryStore)
- `express-rate-limit` — brute force protection on the login endpoint
- `bcrypt` — password hashing
- `better-sqlite3` — synchronous SQLite driver
- `sortablejs` — drag-to-reorder (served to the browser from `node_modules`)

#### `Dockerfile`
Builds the production image on Node 20 Alpine. Installs production dependencies, copies `Sortable.min.js` from `node_modules` into `public/` so it's available to the browser, copies the rest of the app, creates `/data` for the SQLite volume mount, and starts `node server.js` on port 3333.

#### `docker-compose.yml`
Sample compose file for self-hosting. Copy, fill in your data path and `SESSION_SECRET`, and run `docker compose up -d`.

#### `.dockerignore`
Excludes `node_modules` and `.git` from the Docker build context.

---

### `public/`

Files in this directory are served statically by Express with `Cache-Control: no-cache`.

#### `index.html`
The main app shell. Contains the full page structure: fixed header (logo, search, admin link for admins, dark mode toggle, username, sign out), collapsible sidebar (Notes / Archive / Labels navigation), the "take a note" create bar, the pinned and regular note card grids, and the note modal. The modal holds the title input, body textarea, checklist item list, add-item button, and a footer toolbar with color picker, label picker, share panel, pin, archive, and delete. All asset tags use `?v=N` query strings for cache busting.

#### `login.html`
Standalone login page shown when the user is not authenticated. Simple centered form that POSTs credentials to `/api/auth/login` and redirects to `/` on success.

#### `setup.html`
First-run page. Shown automatically when no users exist in the database. Creates the initial admin account and logs the user in immediately. Blocked by the server once any user exists.

#### `admin.html`
Admin user management panel. Accessible only to admin users via the ⚙ gear icon in the header. Features: list all users, create users, reset passwords, promote/demote admin role, delete users. Admins cannot delete or change the role of their own account. Respects dark mode preference.

#### `app.js`
All client-side application logic (~600 lines, no framework). Responsibilities:
- **State** — single `state` object holds the current user, all notes, labels, other users, active note, view, search query, sync timer, and SortableJS instance
- **API helpers** — `GET`, `POST`, `PUT`, `DEL` wrappers around `fetch`
- **Admin link** — shown in header only when `state.user.is_admin` is true
- **Dark mode** — reads `dark_mode` from the user record returned by `/api/auth/me`, applies `body.dark` class on load, saves changes back to `PUT /api/preferences` on toggle
- **Sync** — polls `/api/sync?since=<timestamp>` every 2 seconds and merges updated notes into state without overwriting the currently open note
- **Grid rendering** — `noteCard()` builds each card; checked items are hidden on cards and replaced with a `+ X checked items` summary line
- **Modal** — `openModal()`, `closeModal()`, `renderModalItems()`: handles the full note editing experience. `openModal` locks body scroll to prevent the background scrolling; title does not auto-focus on open
- **Mobile input focus** — `touchend` → `focus()` on each checklist input bypasses iOS Safari's double-tap-to-focus issue caused by SortableJS. SortableJS uses `delayOnTouchOnly: true` with a 150ms hold so quick taps fall through to the input
- **Create bar, sidebar, pickers** — quick note creation, label/view switching, color picker, label picker, share panel

#### `style.css`
All styling. Uses CSS custom properties for theming. Dark mode via `body.dark`. Mobile media query (`max-width: 640px`) enlarges checklist items for touch: 16px font, padding on inputs and drag handle for full-height tap targets, drag handle always visible.

#### `favicon.svg`
Browser tab icon. 32×32 SVG, white background, black "L" and yellow `#FFD600` lowercase "n".

#### `apple-touch-icon-v2.png`
iOS home screen icon. 180×180 PNG. If you update it, rename the file (v3, v4, etc.) and update the `<link rel="apple-touch-icon">` href in `index.html` — iOS caches these aggressively by URL.

#### `sortable.min.js` *(generated at build time)*
Copied from `node_modules/sortablejs/Sortable.min.js` during the Docker build. Not committed to git.

---

## License

MIT — see [LICENSE](LICENSE).
