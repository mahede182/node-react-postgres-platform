# Node + React + Postgres — Production-Style Local Platform

This repository takes a simple React + Express + PostgreSQL app and builds a
local production-style platform around it: Docker Compose, Kubernetes,
Ingress as an API gateway, CI/CD across environments, Redis/queue/search,
read/write DB simulation, and observability with autoscaling.

The goal is not only to make it run, but to show clear deployment design,
networking, secrets handling, and operational reasoning.

---

## Table of contents

1. [Prerequisites](#prerequisites)
2. [Repository layout](#repository-layout)
3. [Architecture overview](#architecture-overview)
4. [Task 1 — Docker Compose](#task-1--docker-compose)
5. [Task 2 — Kubernetes](#task-2--kubernetes)
6. [Task 3 — Ingress / API gateway](#task-3--ingress--api-gateway)
7. [Task 4 — CI/CD](#task-4--cicd)
8. [Task 5 — Platform services](#task-5--platform-services)
9. [Task 6 — Observability & scaling](#task-6--observability--scaling)
10. [Technical decisions](#technical-decisions)
11. [What I would do with more time](#what-i-would-do-with-more-time)
12. [Evidence](#evidence)

---

## Prerequisites

| Tool | Purpose |
|------|---------|
| Docker + Compose (or Colima + Docker CLI) | Local container stack |
| `kubectl` | Talk to the cluster |
| `kind` or `minikube` | Local Kubernetes |
| bash | `scripts/kind-up.sh` helper |

Optional: GitHub repo with `KUBECONFIG_B64` secret for real CI deploys.

---

## Repository layout

```
.
├── Dockerfile.backend          Multi-stage Node API image
├── Dockerfile.frontend         Multi-stage Vite build → nginx
├── .dockerignore
├── docker-compose.yml          Full local stack (API, UI, DB, Redis, search, worker)
├── backend/
│   ├── src/index.js            HTTP API
│   ├── src/worker.js           BullMQ consumer
│   ├── src/db.js               Read/write Postgres pools
│   ├── src/queue.js            Job producer
│   ├── src/redisClient.js
│   ├── src/search.js
│   ├── src/metrics.js          Prometheus text metrics
│   └── .env.example
├── frontend/
│   ├── src/App.jsx
│   └── nginx.conf              Serves SPA + proxies /api in Compose
├── k8s/                        Namespace, Deployments, Services, Ingress, Config, Secrets, PV/PVC
├── observability/              Prometheus, Grafana, Loki, Fluent Bit, HPA
├── scripts/kind-up.sh          One-command kind bootstrap
├── docs/                       Screenshots and verification notes
└── .github/workflows/ci-cd.yml Branch → environment pipeline
```

---

## Architecture overview

### Local Compose

```
Browser → frontend:8080 (nginx)
              │ /api/*
              ▼
         backend:4000 ──► postgres
              │       ──► redis ──► worker
              └───────► opensearch
```

### Kubernetes

```
Browser → Ingress (node-react.local)
            ├─ /api/*  → backend-service  → backend pods → postgres / redis / search
            └─ /*      → frontend-service → frontend pods
                                              │
                                         worker pods ← Redis queue
```

Config and secrets are injected via ConfigMap + Secret. Metrics and logs flow
to Prometheus / Loki; Grafana is the UI.

---

## Task 1 — Docker Compose

### Start

```bash
docker compose up --build
```

### Endpoints

| Service | Address |
|---------|---------|
| Frontend | http://localhost:8080 |
| Backend health | http://localhost:4000/api/health |
| Redis health | http://localhost:4000/api/health/redis |
| Search health | http://localhost:4000/api/health/search |
| Metrics | http://localhost:4000/api/metrics |
| Postgres | localhost:5432 |
| Redis | localhost:6379 |
| OpenSearch | localhost:9200 |

### Implementation details

**Images**

- `Dockerfile.backend`: deps stage runs `npm ci --omit=dev`; runtime stage copies
  `node_modules` + `src` only, runs as non-root `app` user.
- `Dockerfile.frontend`: Node builds the Vite bundle; nginx Alpine serves it.
  `VITE_API_BASE_URL` defaults to `/api` at build time.

**Networking**

- All services share the `appnet` bridge network.
- Frontend nginx proxies `/api/` → `http://backend:4000/api/` so the browser
  never needs the backend hostname.
- Backend connects to `postgres`, `redis`, and `search` by Compose service name.

**Persistence & config**

- Postgres data: named volume `postgres_data` (survives container restarts).
- Redis AOF: `redis_data`.
- Credentials and URLs come from environment variables (override via shell or
  `.env`; see `backend/.env.example`). Nothing sensitive is baked into images.

**Worker**

- Same backend image, different command: `node src/worker.js`.
- API HEALTHCHECK is disabled for the worker (it is not an HTTP process).

### How to verify

1. Open http://localhost:8080
2. Add an item in the UI
3. Confirm it appears in the list and in `GET /api/items`
4. Check worker logs for `item-created` job processing

```bash
docker compose logs -f worker
```

---

## Task 2 — Kubernetes

### Quick start

```bash
./scripts/kind-up.sh
```

This creates a kind cluster (if needed), builds and loads images, installs
ingress-nginx, applies `k8s/` + `observability/`, and adds `node-react.local`
to `/etc/hosts`.

### Manual apply

```bash
kubectl apply -f k8s/namespace-dev.yaml
kubectl apply -n dev -f k8s/
kubectl apply -n dev -f observability/
```

Images in manifests default to `ghcr.io/example/...:dev-latest`. For local
kind, `scripts/kind-up.sh` rewrites them to `:local` images loaded into the
cluster.

### Resource model

| Kind | Name | Notes |
|------|------|-------|
| Namespace | `dev` | All app resources |
| Deployment + ClusterIP | backend, postgres, redis, search, worker | Internal only |
| Deployment + NodePort | frontend (`30080`) | Direct access without Ingress |
| ConfigMap | `app-config` | Non-secret settings |
| Secret | `app-secrets` | Passwords and DB URLs (sample values for local only) |
| PV + PVC | postgres | hostPath for kind persistence |

### Health probes (backend)

| Probe | Path | Intent |
|-------|------|--------|
| Liveness | `/api/health/live` | Process is up — no dependency checks |
| Readiness | `/api/health/ready` | Postgres is reachable — gates traffic |

Keeping them separate avoids restart loops when the database is temporarily slow.

### How to verify

```bash
kubectl get all -n dev
kubectl -n dev rollout status deployment/backend
kubectl -n dev port-forward svc/frontend-service 8080:80
```

---

## Task 3 — Ingress / API gateway

### Setup

```bash
echo "127.0.0.1 node-react.local" | sudo tee -a /etc/hosts
kubectl apply -n dev -f k8s/ingress-dev.yaml
```

App: http://node-react.local  
Grafana (NodePort): http://localhost:30300

### Full request path

```
Browser → Ingress Controller → Service → Pod → PostgreSQL
```

1. Browser resolves `node-react.local` (via `/etc/hosts` locally).
2. Ingress routes `/api` to `backend-service`, everything else to `frontend-service`.
3. The Service selects Ready pods and load-balances.
4. The backend Pod uses `postgres-service` for SQL.

### Kubernetes DNS

Format: `<service>.<namespace>.svc.cluster.local`

Example: `backend-service.dev.svc.cluster.local`

Pods use Service DNS instead of Pod IPs because Pod IPs change on every
reschedule. The Service is the stable front door.

### Debugging playbook

**Ingress reachable, backend is not**

```bash
kubectl get endpoints backend-service -n dev
kubectl describe pod -n dev -l app=backend
kubectl logs -n dev -l app=backend
```

Empty Endpoints usually means the label selector does not match any Ready pod
(often a failing readiness probe).

**Frontend cannot talk to the backend**

1. Confirm build-time `VITE_API_BASE_URL=/api` (same-origin via Ingress).
2. Confirm the browser calls `/api/...`, not `http://backend-service:4000`
   (that hostname only resolves inside the cluster).
3. Check Ingress controller logs for 404 / 502 on that path.

### Rate limiting

Ingress annotations:

- `limit-rps: "20"`
- `limit-burst-multiplier: "3"`
- `limit-connections: "10"`

Limits sit at the gateway so every backend replica is protected the same way,
without app middleware.

### Path to microservices

Treat Ingress as a lightweight API gateway. Split backends later by adding
path rules (`/api/users`, `/api/orders`, …) to new ClusterIP Services. DNS,
probes, and CI patterns do not need to change.

---

## Task 4 — CI/CD

Workflow: `.github/workflows/ci-cd.yml`

### Branch → environment map

| Branch pattern | Target namespace |
|----------------|-------------------|
| `master` | `dev` |
| `pre-release/v*` | `preprod` |
| `release/v*` | `release` |

### Pipeline stages

1. **build-and-test** — `npm ci`, syntax check backend, build frontend
2. **build-and-push** — Docker images to GHCR tagged `<branch>-<short-sha>`
   plus `<namespace>-latest`
3. **deploy** — patch image tags + namespace in manifests, `kubectl apply`,
   wait for rollout
4. **rollback** — manual `workflow_dispatch` with `rollback_namespace`

### Secrets handling

| Secret | Use |
|--------|-----|
| `GITHUB_TOKEN` | Short-lived, repo-scoped GHCR login — no long-lived registry password in the repo |
| `KUBECONFIG_B64` | Base64 kubeconfig stored as an encrypted Actions secret; decode only at runtime into `$HOME/.kube/config` |

Prefer a deploy service account limited to the target namespaces.

### Rollback strategy

1. **Fast:** `kubectl rollout undo` on backend + frontend Deployments
   (wired as the workflow_dispatch job).
2. **Precise:** re-run CI on a previous commit so the exact previous image
   tag is rebuilt/redeployed — does not depend on ReplicaSet garbage collection.

---

## Task 5 — Platform services

Present in both `docker-compose.yml` and `k8s/`.

### Redis

- URL via `REDIS_URL`
- Health: `GET /api/health/redis`
- Used as BullMQ broker and general cache-capable dependency

### Queue (BullMQ)

- `POST /api/items` writes to Postgres, then enqueues `item-created`
- Worker Deployment runs `node src/worker.js` on the same backend image
- Worker scales and fails independently of the API process

### Search (OpenSearch)

- Single-node, security disabled for local/dev
- Backend probes cluster health: `GET /api/health/search`
- Real indexing would hook into the queue consumer

### Simulated read / write DB cluster

`backend/src/db.js` maintains two pools:

| Helper | Env var | Role |
|--------|---------|------|
| `write()` | `DB_WRITE_URL` | Primary — INSERT / UPDATE / DELETE |
| `read()` | `DB_READ_URL` | Replica — SELECT |

Locally both URLs point at the same Postgres instance. Pointing `DB_READ_URL`
at a real replica later is a config change only — no application rewrite.

**Where routing lives**

- This repo: explicit in application helpers (`write` vs `read`).
- Alternative: a proxy (PgBouncer, ProxySQL, managed splitter) — simpler app
  code, another component and hop to operate.

**Replication lag**

Replicas can be milliseconds to seconds behind. Operations that must see
fresh data (read-your-writes, redirect-after-POST, uniqueness checks) must
use the primary (`writePool`).

Platform services are ClusterIP-only — never exposed through Ingress/NodePort.

---

## Task 6 — Observability & scaling

```bash
kubectl apply -n dev -f observability/
```

### Components

| Component | Role |
|-----------|------|
| Prometheus | Scrapes pods annotated `prometheus.io/scrape: "true"`; backend serves `/api/metrics` |
| Grafana | NodePort `30300`, login `admin` / `admin`; Prometheus + Loki datasources; Backend Overview dashboard |
| Fluent Bit | DaemonSet — one agent per node, tails container logs |
| Loki | Log store; query in Grafana Explore: `{job="backend"}` |
| HPA | Backend 2→6 replicas on 70% CPU or 80% memory |

### Testing Grafana

```bash
kubectl -n dev get pods -l app=grafana
# kind NodePort:
open http://localhost:30300
# or:
kubectl -n dev port-forward svc/grafana 3000:3000
```

1. Confirm Prometheus and Loki datasources (Connections → Data sources → Test)
2. Open **Platform / Backend Overview**
3. Generate traffic (`curl` or the UI) and watch request/error panels
4. Explore Loki with `{job="backend"}`

### What to alert on (and why)

| Signal | Why it matters |
|--------|----------------|
| High 5xx rate | Users are failing, independent of load level |
| High CPU while at max HPA replicas | No scale headroom left; latency follows |
| High p95/p99 latency | Catches slow queries, GC, dependency pain before hard errors |
| Sustained RPS with no replica growth | HPA misconfigured, missing metrics, or capped |

### Verify logging path

```bash
kubectl logs -n dev daemonset/fluent-bit
# Then Grafana Explore → Loki → {job="backend"}
```

---

## Technical decisions

| Decision | Rationale | Trade-off |
|----------|-----------|-----------|
| Multi-stage Alpine images | Smaller attack surface, faster pulls | Distroless + SBOM would be stricter |
| nginx `/api` proxy in Compose | Same-origin browser calls without CORS gymnastics | Hostname `backend` is Compose-specific; K8s uses Ingress instead |
| Separate liveness vs readiness | Slow DB should stop traffic, not thrash restarts | Requires careful probe timeouts |
| App-level R/W pools | Explicit routing, zero extra infra for the assessment | App must remember which helper to call |
| BullMQ worker as its own Deployment | Independent scale/failure domain from the API | Two Deployments to version together |
| Rate limits on Ingress | One policy for all replicas, no app change | Coarse per-IP limits; not per-tenant |
| hostPath PV for Postgres | Works on kind with minimal setup | Not HA; use CSI + backups in real clusters |
| Sample Secret committed | Local demo only | Never for production — use Sealed Secrets / External Secrets / CSI |
| Prometheus text metrics in-process | No heavy client dependency; enough for scrape demos | Prefer `prom-client` + histograms in production |
| Branch → namespace CI mapping | Simple, reviewable promotion path | Needs protected branches and environment approvals in real orgs |

---

## What I would do with more time

- TLS on Ingress (cert-manager) and network policies between namespaces
- Real Postgres primary/replica and optional PgBouncer
- Search indexing from the worker; dead-letter queue dashboards
- Helm or Kustomize overlays instead of `sed` in CI
- Image signing (cosign), dependency scanning, and SBOM in the pipeline
- Alertmanager rules wired to the signals above
- Load tests to validate HPA behavior and Ingress rate limits under pressure

---

## Evidence

Store artifacts in `docs/`:

- `kubectl get all -n dev`
- App running at http://node-react.local
- Grafana dashboards
- Loki log queries
- A passing GitHub Actions run
- Compose verification notes / screenshots

---

## Quick reference

```bash
# Local full stack
docker compose up --build

# Kubernetes (kind)
./scripts/kind-up.sh

# Useful checks
curl http://localhost:8080/api/health
curl http://localhost:4000/api/metrics
kubectl get all -n dev
kubectl logs -n dev -l app=backend --tail=50
```
