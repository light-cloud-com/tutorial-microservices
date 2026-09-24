# Bean There: a microservices tutorial app for Light Cloud

A tiny coffee shop split into three services and one database. It is the
example app for the "Microservices on Light Cloud" tutorial series on the
[Light Cloud blog](https://blog.light-cloud.com/tutorials).

```
                 browser
                    |
                    v
          +------------------+
          |  web (React)     |   static site
          +------------------+
            |              |
            v              v
+------------------+   +------------------+
| catalog-api      |<--| orders-api       |   containers
| Node.js, Express |   | Python, FastAPI  |
+------------------+   +------------------+
            |              |
            v              v
          +------------------+
          |  PostgreSQL      |
          +------------------+
```

| Folder | What it is | Light Cloud deploys it as |
|---|---|---|
| `web/` | React (Vite) shop front | Static site |
| `catalog-api/` | Products and stock (Express) | Container, port from `$PORT` |
| `orders-api/` | Orders (FastAPI); asks catalog-api to reserve stock | Container, port from `$PORT` |

Each folder is a separate Light Cloud app on this same repository, with its
own **Root directory**. A push only redeploys the apps whose folder changed.

## How the services talk

- The browser calls both APIs directly, so both APIs allow the web app's
  address with CORS (`WEB_ORIGIN`).
- `orders-api` calls `catalog-api` at `POST /internal/products/:id/reserve`.
  Internal routes require the `x-internal-secret` header, which must match
  `INTERNAL_SECRET` on both services.
- Every request carries an `x-request-id`. It is passed from orders-api to
  catalog-api and printed in both logs, so one order can be followed across
  services.
- Both APIs use the same PostgreSQL database. Each service owns its own
  table (`products`, `orders`) and never reads the other's.

## Environment variables

| Variable | Service | Example |
|---|---|---|
| `VITE_CATALOG_API_URL` | web (build time) | `https://main-catalog-api-<workspace>.light-cloud.io` |
| `VITE_ORDERS_API_URL` | web (build time) | `https://main-orders-api-<workspace>.light-cloud.io` |
| `DATABASE_URL` | catalog-api, orders-api | the database connection string |
| `INTERNAL_SECRET` | catalog-api, orders-api | a long random string, same on both |
| `WEB_ORIGIN` | catalog-api, orders-api | `https://main-web-<workspace>.light-cloud.io` |
| `CATALOG_API_URL` | orders-api | `https://main-catalog-api-<workspace>.light-cloud.io` |

For `catalog-api` (Node.js), end the Light Cloud connection string with
`?sslmode=require&uselibpqcompat=true`, otherwise the `pg` driver rejects
the database certificate.

## Run it locally

You need Node.js 22, Python 3.11 or later, and a local PostgreSQL with a
database called `shop`.

```bash
# catalog-api
cd catalog-api
cp .env.example .env        # then edit DATABASE_URL
npm install
node --env-file=.env server.js

# orders-api (second terminal)
cd orders-api
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
set -a && source .env.example && set +a   # or your own .env
uvicorn main:app --port 8000

# web (third terminal)
cd web
cp .env.example .env.local
npm install
npm run dev
```

Open http://localhost:5173.

## The tutorial series

| Part | Tutorial | Code at |
|---|---|---|
| 1 | Deploy a frontend, two APIs and a database | tag `part-1` |
| 2 | Connect services: URLs, CORS and a shared secret | tag `part-2` |
| 3 | Autoscaling with a load test | tag `part-3` |
| 4 | Scale to zero or always on: cold starts | tag `part-4` |
| 5 | Branch environments and rollback | tag `part-5` |
| 6 | Following a request across services with logs and metrics | tag `part-6` |

## License

MIT
