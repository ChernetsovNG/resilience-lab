# Local Docker Compose Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run the existing backend and production frontend with one Docker Compose command and verify a real browser experiment through the container proxy.

**Architecture:** Two multi-stage images: Gradle/JDK 25 produces the Spring Boot JAR for a JRE 25 runtime; Node 25.5.0 produces static Vite assets for a non-root Nginx runtime. Nginx serves the SPA on container port 8080 and proxies `/api/` unchanged to `backend:8080`; Compose publishes frontend `127.0.0.1:5173:8080` and backend `127.0.0.1:8080:8080` on loopback only.

**Tech Stack:** Docker Compose, Eclipse Temurin JDK/JRE 25, Gradle Wrapper 9.8.2, Node 25.5.0, Nginx Alpine, existing React/Spring applications.

**Spec:** `docs/superpowers/specs/2026-10-26-local-docker-design.md`

## Global Constraints

- Entry point: `docker compose up --build`; browser URL `http://localhost:5173`; backend health `http://localhost:8080/api/v1/health`.
- Browser API remains same-origin `/api`; Nginx forwards `/api/` to `http://backend:8080` without rewriting the URI.
- No secrets, external production addresses, database, TLS, hot reload, persistent volumes, or additional application services.
- Preserve process-local jobs and 100-terminal FIFO retention; restart may lose jobs.
- Runtime containers use non-root users; frontend Nginx listens on unprivileged port 8080.
- Actual image tags must be confirmed by successful builds; do not assume availability.
- Real container build, health check and browser experiment are mandatory; YAML validation alone is insufficient.

## Review Focus

- Docker build context must exclude `.worktrees`, dependencies and outputs so recursive/local artifacts cannot poison builds; verify with successful clean image builds.
- SPA fallback must not convert API 404s or missing static assets into HTML 200 responses; verify API proxy and a missing static path.
- Non-root Nginx must have writable pid/cache/temp paths; verify container stays running and logs contain no permission fatal.
- Backend must be reachable by Docker service name, not host loopback; verify frontend health badge and a real experiment.
- Shutdown must remove both containers without deleting user source or named external resources; verify `docker compose down` and `docker compose ps`.

---

### Task 1: Production-like local Compose

**Files:**
- Create: `compose.yaml`
- Create: `.dockerignore`
- Create: `apps/server/Dockerfile`
- Create: `web/Dockerfile`
- Create: `web/nginx.conf`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: existing `./gradlew :apps:server:bootJar`, `npm ci`, `npm run build`, same-origin `/api/v1` client.
- Produces: `docker compose up --build -d`, frontend `127.0.0.1:5173`, backend `127.0.0.1:8080`, `docker compose down`.

- [ ] **Step 1: Capture the failing configuration gate**

Run: `docker compose -f compose.yaml config --quiet` before creating `compose.yaml`.
Expected: FAIL because the Compose file does not exist. Record this as configuration RED; do not claim behavioral TDD for infrastructure.

- [ ] **Step 2: Add minimal build/runtime configuration**

Create root `.dockerignore` excluding VCS metadata, `.worktrees/`, `.gradle/`, build/dist outputs, `node_modules/`, Playwright outputs, `kslOutput/`, `.superpowers/` and IDE files.

Create `apps/server/Dockerfile` with a JDK 25 build stage running `./gradlew --no-daemon :apps:server:bootJar` and a JRE 25 runtime copying only the executable server JAR. Use a non-root runtime user, expose 8080, and exec the JAR directly.

Create `web/Dockerfile` with Node 25.5.0 `npm ci` and `npm run build`, then an Nginx Alpine runtime copying `web/dist` and `web/nginx.conf`. Configure writable `/tmp` pid/cache paths and `USER nginx`; expose 8080.

Create `web/nginx.conf`: listen 8080; static root and `index.html`; exact `/api` returns 404; `location /api/` proxies to `http://backend:8080` preserving URI and setting `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`; SPA `try_files $uri $uri/ /index.html`; static assets must not fall back to HTML when the file is absent.

Create `compose.yaml` with only `backend` and `frontend`, build contexts at repository root and Dockerfiles above, `frontend` depending on `backend`, and exact loopback-only port mappings `127.0.0.1:8080:8080` and `127.0.0.1:5173:8080`.

- [ ] **Step 3: Validate and build the real images**

Run: `docker compose config --quiet && docker compose up --build -d`.
Expected: both images build and both containers start. Resolve unavailable base tags or build-context problems without weakening non-root/proxy requirements.

- [ ] **Step 4: Verify API, static behavior and real browser workflow**

Run host health request against `http://127.0.0.1:8080/api/v1/health`; expect HTTP 200 and healthy payload. Request `/api/v1/jobs/not-a-job` through frontend port; expect API JSON/error status, not `index.html`. Request a missing static asset; expect 404, not HTML 200.

Inspect `docker compose ps` and logs; expect running containers and no fatal permission/proxy errors.

Using installed Playwright Chromium against only the Compose services, open `http://127.0.0.1:5173`, verify healthy backend, click `New three-service chain`, set replications 2 and short execution bounds, run comparison, wait for `COMPLETED`, and verify Baseline/Candidate metrics. Use real UI interactions and no mock API or locally started application servers.

- [ ] **Step 5: Stop Compose and run regression gates**

Run: `docker compose down`; expect both containers removed and `docker compose ps` empty. Do not remove volumes, images, source files or unrelated Docker resources.

Run from repository root: `./gradlew clean build`.
Run from `web`: `npm run lint && npm test -- --run && npm run build && npm run test:e2e`.
Expected: all existing gates pass, including real local Playwright after Compose has released ports.

- [ ] **Step 6: Document and commit**

Update `AGENTS.md` with `docker compose up --build -d`, URLs, `docker compose down`, real verification results and process-local storage limitation. Update verified unit/E2E counts if tests changed.

Run: `git diff --check && git status --short`.

Commit:
```bash
git add compose.yaml .dockerignore apps/server/Dockerfile web/Dockerfile web/nginx.conf AGENTS.md docs/superpowers/specs/2026-10-26-local-docker-design.md docs/superpowers/plans/2026-10-26-local-docker.md
git commit -m "feat: add local Docker Compose startup"
```
