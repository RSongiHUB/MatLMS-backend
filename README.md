# Matrix LMS

Self-hosted Learning Management System — Node.js/Express API, PostgreSQL,
and a static frontend served by the same backend container. Fully
containerized with Docker Compose.

**Build status:** Complete (Steps 1 + 2). Infrastructure, schema, seed data,
full Express API with JWT auth and role-based access control, and a working
frontend (landing/auth, dashboard, course viewer, quiz engine, printable
certificates) are all in place and boot cleanly end to end via
`docker compose up --build`.

## Project structure

```
matrix-lms/
├── docker-compose.yml       # orchestrates db + backend
├── .env.example             # copy to .env before first run
├── README.md
├── database/
│   ├── schema.sql           # mounted as 001_schema.sql — tables, indexes, triggers
│   └── seed.sql             # mounted as 002_seed.sql — sample course content
├── backend/
│   ├── Dockerfile           # multi-stage Node 20 build
│   ├── .dockerignore
│   ├── package.json
│   └── src/
│       ├── server.js        # Express entry point — mounts all routes below
│       ├── db.js            # pg Pool + readiness check
│       ├── seed.js          # bcrypt-hashed demo account seeding (idempotent)
│       ├── services/
│       │   └── certificate.service.js   # completion % + auto-issue logic, shared by 3 routers
│       ├── middleware/
│       │   ├── auth.middleware.js       # requireAuth / optionalAuth (JWT)
│       │   └── role.middleware.js       # checkRole(['admin', 'instructor'])
│       └── routes/
│           ├── auth.routes.js           # register (students only), login, /me
│           ├── course.routes.js         # courses, modules, lessons CRUD + enrollment
│           ├── progress.routes.js       # mark complete, per-course/-user completion %
│           ├── quiz.routes.js           # fetch (answers hidden), submit+autograde, question authoring
│           ├── assignment.routes.js     # fetch, submit, instructor grading queue
│           └── certificate.routes.js    # list mine, issue, fetch one, PUBLIC verify-by-code
└── frontend/
    ├── index.html           # landing page + login/register modals
    ├── dashboard.html       # role-based: student browse/progress vs instructor course management
    ├── course-viewer.html   # sidebar + lesson pane; instructor authoring tools in ?manage=1
    ├── quiz.html            # take a quiz, see per-question right/wrong + explanations
    ├── certificate.html     # printable certificate (window.print() → Save as PDF)
    ├── css/app.css          # the handful of things Tailwind utilities don't cover (print styles)
    └── js/api.js            # token-aware fetch wrapper used by every page
```

**Why `database/schema.sql` + `database/seed.sql` instead of one `init.sql`:**
PostgreSQL's official image runs *every* `.sql`/`.sh` file it finds in
`/docker-entrypoint-initdb.d/`, in alphabetical order, the first time the
data volume is empty. `docker-compose.yml` mounts the two files as
`001_schema.sql` and `002_seed.sql` into that directory, which gives you the
same "auto-populates on first boot" behavior as a single `init.sql`, with
schema and content kept in separate, easier-to-review files.

**Why demo user accounts aren't in `seed.sql`:** passwords must be hashed
with bcrypt, and SQL init scripts have no access to a hashing library.
`backend/src/seed.js` runs once on first container boot — after the database
is confirmed reachable — hashes the demo passwords, inserts the users, links
the instructor to the seeded course, and enrolls the demo students. It's
idempotent: it checks `SELECT COUNT(*) FROM users` and does nothing if
accounts already exist, so it's safe to leave running on every restart.

## Prerequisites

- Docker Engine 24+ and Docker Compose v2 (`docker compose`, not the old
  `docker-compose` binary)
- Node.js 20 LTS — only needed if you want to run the backend outside
  Docker for local development

## Running with Docker Compose (recommended)

```bash
cp .env.example .env
# edit .env — at minimum change POSTGRES_PASSWORD and JWT_SECRET

docker compose up --build
```

What happens on first run:

1. Postgres starts, waits to pass `pg_isready`, then automatically executes
   `001_schema.sql` followed by `002_seed.sql`.
2. The backend container waits for `db`'s healthcheck to report healthy
   (`depends_on: condition: service_healthy`) before it starts.
3. On boot, the backend polls the database (`waitForDb()` in `db.js`) as a
   second safety net, then runs `runApplicationSeed()` to create demo
   accounts if none exist yet.
4. Express starts listening on `PORT` (default `4000`) and serves the
   frontend from the bind-mounted `./frontend` directory.

Once it's up:

- App: <http://localhost:4000> — log in with a demo account or register a new student
- Health check: <http://localhost:4000/api/health> → `{"status":"ok","db":"connected",...}`
- API root: <http://localhost:4000/api> — lists every route

### Try it end to end

1. Open <http://localhost:4000>, log in as `instructor@matrixlms.dev`.
2. On the dashboard, click **Manage** on "Excel Mastery for New Joiners" (seeded already).
3. You're in `course-viewer.html?manage=1` — add a module, add a lesson, add a quiz question.
   Publish the course from the dashboard if it isn't already.
4. Log out, log back in as `student1@matrixlms.dev` (already enrolled by the seed script).
5. Work through a video lesson (Mark as complete), an assignment (submit text or a link),
   and a quiz (auto-graded with explanations) — watch the top progress bar move.
6. Complete every lesson in the course → a certificate is issued automatically.
   Find it under "My Certificates" on the dashboard, open it, and hit **Print / Save PDF**.
7. As the instructor, revisit the assignment lesson in `?manage=1` mode to see the
   grading queue and post a score + feedback.

### API surface

All endpoints are prefixed with `/api`. Everything except register/login/health
and the public certificate verification endpoint requires
`Authorization: Bearer <token>`.

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register` | Always creates a `student` — see note below |
| POST | `/auth/login` | Returns `{ token, user }` |
| GET | `/auth/me` | Current user profile |
| GET | `/courses` | Published courses; instructors also see their drafts, admins see all |
| GET | `/courses/:id` | Full module→lesson tree, with `completed` flags if logged in |
| POST/PUT/DELETE | `/courses/:id` | instructor/admin, owner-checked |
| POST | `/courses/:id/enroll` | Any logged-in user |
| GET | `/courses/me/enrolled` | Enrolled courses + live completion % |
| POST/PUT/DELETE | `/courses/:id/modules`, `/courses/modules/:id` | Authoring |
| POST/PUT/DELETE | `/courses/modules/:id/lessons`, `/courses/lessons/:id` | Authoring |
| POST | `/progress/lessons/:id/complete` | Video/text lessons |
| GET | `/progress/courses/:id`, `/progress/me` | Completion detail/summary |
| GET | `/quizzes/lesson/:id` | Questions WITHOUT `correct_index`/`explanation` |
| POST | `/quizzes/:id/attempts` | Grades server-side, marks lesson complete if passed |
| POST/PUT/DELETE | `/quizzes/:id/questions`, `/quizzes/questions/:id` | Authoring |
| GET | `/assignments/lesson/:id` | Instructions + your latest submission |
| POST | `/assignments/:id/submissions` | Marks lesson complete on submit |
| GET | `/assignments/:id/submissions` | Grading queue, instructor/admin only |
| PUT | `/assignments/submissions/:id/grade` | Instructor/admin only |
| GET | `/certificates/me`, `/certificates/:id` | Yours, or admin |
| POST | `/certificates/courses/:id/issue` | Self-service retry (auto-issue already fires on 100%) |
| GET | `/certificates/verify/:code` | **No auth** — public verification |

### Known scope boundaries (by design, not oversights)

- **Public registration only creates students.** Instructor/admin accounts are
  provisioned via the seed script or directly in the database — appropriate
  for an internal onboarding tool, not a self-serve SaaS.
- **JWTs are stateless with no refresh/revocation list.** `JWT_EXPIRES_IN`
  (default 7d) is the only expiry mechanism; there's no logout-everywhere or
  token blacklist. Fine for an internal tool, worth adding before anything
  public-facing.
- **Assignment "grading" is manual, not auto-checked.** Unlike the earlier
  static Excel-LMS prototype (which parsed uploaded `.xlsx` files client-side
  with SheetJS), this backend stores whatever text/link a student submits and
  leaves scoring to the instructor. Wiring in real file upload + server-side
  `.xlsx` parsing is a reasonable next step if that matters to you.
- **`helmet`'s Content-Security-Policy is disabled** (`contentSecurityPolicy: false`
  in `server.js`) because the frontend loads Tailwind from its CDN. Tighten
  this once Tailwind is compiled locally instead of loaded at runtime.

### Demo accounts

Printed to the backend container logs on first boot (see below), and
also documented here for convenience — **change these before any real
deployment**, either by setting different values in `.env` before first
boot, or by updating the `users` table directly afterward:

| Role       | Email                      | Password (default)   |
|------------|-----------------------------|-----------------------|
| Admin      | `admin@matrixlms.dev`       | `Admin@12345`         |
| Instructor | `instructor@matrixlms.dev`  | `Instructor@12345`    |
| Student    | `student1@matrixlms.dev`    | `Student@12345`       |
| Student    | `student2@matrixlms.dev`    | `Student@12345`       |

## Verifying container logs

```bash
# Follow both services
docker compose logs -f

# Just the backend — confirm DB connection + seed output
docker compose logs -f backend

# Just Postgres — confirm 001_schema.sql / 002_seed.sql ran
docker compose logs -f db
```

A healthy first boot looks like:

```
matrix_lms_db       | ... database system is ready to accept connections
matrix_lms_backend  | [db] connected
matrix_lms_backend  | [seed] no users found — creating demo accounts
matrix_lms_backend  | [seed] demo accounts ready — sign in with:
matrix_lms_backend  |   - admin      admin@matrixlms.dev / Admin@12345
matrix_lms_backend  |   - instructor instructor@matrixlms.dev / Instructor@12345
matrix_lms_backend  |   - student    student1@matrixlms.dev / Student@12345
matrix_lms_backend  |   - student    student2@matrixlms.dev / Student@12345
matrix_lms_backend  | [server] Matrix LMS backend listening on port 4000
```

Check both services report healthy:

```bash
docker compose ps
```

## Running raw SQL migrations / inspecting the database

Schema changes after the first boot won't re-run automatically (Postgres
only executes `/docker-entrypoint-initdb.d` against an empty data volume).
To apply a change or inspect data directly:

```bash
# Open a psql shell inside the running db container
docker compose exec db psql -U ${POSTGRES_USER:-matrix_admin} -d ${POSTGRES_DB:-matrix_lms}

# Or pipe a new migration file straight in
docker compose exec -T db psql -U matrix_admin -d matrix_lms < database/migrations/003_add_something.sql
```

To start completely fresh (drops all data — including the demo accounts,
which will be recreated by `seed.js` on next boot):

```bash
docker compose down -v   # -v also removes the db_data volume
docker compose up --build
```

## Local development without Docker

```bash
cd backend
npm install
cp ../.env.example ../.env   # then edit DB_HOST=localhost if Postgres runs locally
npm run dev                  # nodemon, restarts on file changes
```

You'll need a local PostgreSQL 16 instance with the schema and seed scripts
applied manually:

```bash
psql -U matrix_admin -d matrix_lms -f database/schema.sql
psql -U matrix_admin -d matrix_lms -f database/seed.sql
```

## Suggested next steps beyond this build

- Real file upload for assignments (e.g. to a Drive/S3-compatible bucket) plus
  server-side `.xlsx` parsing for auto-graded submissions
- Refresh tokens / a revocation list if this ever needs to be internet-facing
- Compile Tailwind locally and re-enable `helmet`'s default CSP
- Rate limiting on `/auth/login` and `/auth/register`
- Automated tests (the whole API was syntax- and cross-reference-validated
  during development, but there's no test suite yet)
