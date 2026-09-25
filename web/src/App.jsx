import { useEffect, useState } from "react";

// Set at build time. On Light Cloud, add them as environment variables on
// the web app; locally, put them in web/.env.local.
const CATALOG_API_URL = import.meta.env.VITE_CATALOG_API_URL || "http://localhost:8080";
const ORDERS_API_URL = import.meta.env.VITE_ORDERS_API_URL || "http://localhost:8000";

const price = (cents) => `$${(cents / 100).toFixed(2)}`;

export default function App() {
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function loadData() {
    try {
      const [productsReply, ordersReply] = await Promise.all([
        fetch(`${CATALOG_API_URL}/products`),
        fetch(`${ORDERS_API_URL}/orders`),
      ]);
      setProducts(await productsReply.json());
      setOrders(await ordersReply.json());
      setError("");
    } catch {
      setError("Could not reach the APIs. Check VITE_CATALOG_API_URL and VITE_ORDERS_API_URL.");
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function buy(product) {
    setMessage("");
    const reply = await fetch(`${ORDERS_API_URL}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_id: product.id, quantity: 1 }),
    });
    const body = await reply.json();
    setMessage(reply.ok ? `Order #${body.id} placed: ${body.product}` : body.detail);
    loadData();
  }

  return (
    <main>
      <header>
        <h1>Bean There</h1>
        <p>A tiny coffee shop built from three services on Light Cloud.</p>
      </header>

      {error && <p className="error">{error}</p>}
      {message && <p className="message">{message}</p>}

      <section>
        <h2>Products <span className="source">from catalog-api</span></h2>
        <ul className="products">
          {products.map((product) => (
            <li key={product.id}>
              <strong>{product.name}</strong>
              <span>{price(product.price_cents)}</span>
              <span className={`stock ${product.stock_status === "low" ? "low" : ""}`}>
                {product.stock_status ? `${product.stock_status} (${product.stock})` : `${product.stock} in stock`}
              </span>
              <button onClick={() => buy(product)} disabled={product.stock === 0}>
                Buy
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Latest orders <span className="source">from orders-api</span></h2>
        {orders.length === 0 ? (
          <p className="empty">No orders yet.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Order</th><th>Product</th><th>Qty</th><th>Total</th></tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id}>
                  <td>#{order.id}</td>
                  <td>{products.find((p) => p.id === order.product_id)?.name ?? order.product_id}</td>
                  <td>{order.quantity}</td>
                  <td>{price(order.total_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
