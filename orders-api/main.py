# orders-api: owns the orders table.
# Public: GET /health, GET /orders, POST /orders
# To place an order it asks catalog-api to reserve stock first.

import json
import os
import uuid
from contextlib import asynccontextmanager

import httpx
import psycopg
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

DATABASE_URL = os.environ.get("DATABASE_URL", "")
CATALOG_API_URL = os.environ.get("CATALOG_API_URL", "http://localhost:8080")
INTERNAL_SECRET = os.environ.get("INTERNAL_SECRET", "")
# One or more browser origins allowed to call this API, comma-separated.
WEB_ORIGINS = [o.strip() for o in os.environ.get("WEB_ORIGIN", "http://localhost:5173").split(",") if o.strip()]
# How long to wait for catalog-api before giving up on an order.
CATALOG_TIMEOUT_SECONDS = float(os.environ.get("CATALOG_TIMEOUT_SECONDS", "5"))


# One JSON object per line. "severity" is what the Logs tab's level filter
# reads (INFO, WARNING, ERROR); requestId ties lines from all services together.
def log(request_id: str, message: str, severity: str = "INFO", **extra):
    print(json.dumps({"severity": severity, "service": "orders-api", "requestId": request_id, "message": message, **extra}), flush=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    with psycopg.connect(DATABASE_URL) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS orders (
                id          SERIAL PRIMARY KEY,
                product_id  INTEGER NOT NULL,
                quantity    INTEGER NOT NULL,
                total_cents INTEGER NOT NULL,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
    yield


app = FastAPI(title="orders-api", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=WEB_ORIGINS, allow_methods=["*"], allow_headers=["*"])


# Every request gets an ID. It is passed on to catalog-api, so one order can
# be followed across both services in the logs.
@app.middleware("http")
async def request_id(request: Request, call_next):
    request.state.request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    response = await call_next(request)
    response.headers["x-request-id"] = request.state.request_id
    return response


class NewOrder(BaseModel):
    product_id: int
    quantity: int = Field(gt=0)


@app.get("/health")
def health():
    return {"status": "ok", "service": "orders-api"}


@app.get("/orders")
def list_orders():
    with psycopg.connect(DATABASE_URL) as conn:
        rows = conn.execute(
            "SELECT id, product_id, quantity, total_cents, created_at FROM orders ORDER BY id DESC LIMIT 20"
        ).fetchall()
    return [
        {"id": r[0], "product_id": r[1], "quantity": r[2], "total_cents": r[3], "created_at": r[4].isoformat()}
        for r in rows
    ]


@app.post("/orders", status_code=201)
async def create_order(order: NewOrder, request: Request):
    request_id = request.state.request_id
    log(request_id, "placing order", product_id=order.product_id, quantity=order.quantity)

    try:
        async with httpx.AsyncClient(timeout=CATALOG_TIMEOUT_SECONDS) as client:
            reply = await client.post(
                f"{CATALOG_API_URL}/internal/products/{order.product_id}/reserve",
                json={"quantity": order.quantity},
                headers={"x-internal-secret": INTERNAL_SECRET, "x-request-id": request_id},
            )
    except httpx.HTTPError as error:
        # Timed out or could not connect: fail fast with a clear answer
        # instead of hanging the customer's request.
        log(request_id, "catalog-api unreachable", "ERROR", error=type(error).__name__)
        raise HTTPException(status_code=503, detail="Catalog service unavailable, please try again")

    if reply.status_code == 404:
        log(request_id, "order for unknown product", "WARNING", product_id=order.product_id)
        raise HTTPException(status_code=404, detail="Product not found")
    if reply.status_code == 409:
        log(request_id, "not enough stock", "WARNING", product_id=order.product_id)
        raise HTTPException(status_code=409, detail="Not enough stock")
    if reply.status_code != 200:
        log(request_id, "catalog-api error", "ERROR", status=reply.status_code)
        raise HTTPException(status_code=502, detail="Catalog service unavailable")

    product = reply.json()
    total = product["price_cents"] * order.quantity
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        cursor = await conn.execute(
            "INSERT INTO orders (product_id, quantity, total_cents) VALUES (%s, %s, %s) RETURNING id",
            (order.product_id, order.quantity, total),
        )
        row = await cursor.fetchone()

    log(request_id, "order placed", order_id=row[0], total_cents=total)
    return {"id": row[0], "product": product["name"], "quantity": order.quantity, "total_cents": total}
