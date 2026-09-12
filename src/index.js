/**
 * 7AM Digital — Backend completo del checkout (un solo Worker)
 * ======================================================================
 * Rutas que expone:
 *
 *   GET  /check-domain?domain=tunegocio.com
 *        -> Disponibilidad real vía Cloudflare Registrar API.
 *
 *   POST /create-order
 *        body: { plan, priceValue, domainAddon, domain, domainMode, fullName, businessName, phone, email }
 *        -> Crea la orden en KV + un link de pago real en Bold.
 *        -> Devuelve { checkoutUrl, order_id }.
 *
 *   POST /bold-webhook
 *        -> Bold llama aquí cuando una venta es aprobada/rechazada.
 *        -> Si es aprobada y el dominio era "nuevo", lo registra
 *           automáticamente en Cloudflare Registrar.
 *
 *   GET  /order-status?order=<id>
 *        -> Usado por la landing para mostrarle al cliente si su pago
 *           y su dominio ya quedaron listos, al volver desde Bold.
 *
 * ----------------------------------------------------------------------
 * CONFIGURACIÓN REQUERIDA — ver README-CLOUDFLARE.md para el paso a paso.
 *
 * Secretos del Worker (Settings → Variables and Secrets):
 *   CLOUDFLARE_API_TOKEN   Token con permiso Registrar (check + registrar dominios)
 *   CLOUDFLARE_ACCOUNT_ID  Tu Account ID de Cloudflare
 *   BOLD_API_KEY           Llave de identidad de Bold (Botón de pagos / Link de pago)
 *   BOLD_SECRET_KEY        Llave secreta de Bold (para verificar el webhook)
 *   SITE_ORIGIN            https://tu-dominio.com  (sin / al final)
 *   N8N_WEBHOOK_URL        (opcional) URL del Webhook de n8n para notificarte
 *                          cada venta. Si se deja vacío, simplemente no notifica.
 *   N8N_WEBHOOK_SECRET     (opcional) valor propio que se envía en el header
 *                          X-Notify-Secret, para que en n8n puedas verificar
 *                          que la notificación viene realmente de este Worker.
 *
 * Binding de KV (Settings → Bindings → KV Namespace):
 *   Variable name: ORDERS
 * ----------------------------------------------------------------------
 */

const ALLOWED_ORIGIN = "https://tu-dominio.com"; // <-- reemplaza por tu dominio real

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

function isValidDomain(domain) {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPhone(phone) {
  const digits = phone.replace(/[\s-]/g, "");
  return /^\+?[0-9]{7,15}$/.test(digits);
}

/* ============================================================
   RUTA 1 — Disponibilidad de dominio (Cloudflare Registrar)
   ============================================================ */
async function handleCheckDomain(request, env) {
  const url = new URL(request.url);
  const domain = (url.searchParams.get("domain") || "").trim().toLowerCase();

  if (!domain || !isValidDomain(domain)) {
    return json({ status: "unknown", error: "invalid_domain" }, 400);
  }

  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    return json({ status: "unknown", error: "worker_not_configured" });
  }

  try {
    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/registrar/domain-check`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ domains: [domain] }),
      }
    );
    const data = await resp.json();
    if (!data || data.success !== true) return json({ status: "unknown" });

    const result = data.result && data.result.domains && data.result.domains[0];
    if (!result) return json({ status: "unknown" });

    if (result.registrable === true) {
      return json({ status: "available", pricing: result.pricing || null });
    }
    if (result.reason === "domain_unavailable") {
      return json({ status: "taken" });
    }
    return json({ status: "unsupported", reason: result.reason || null });
  } catch (err) {
    return json({ status: "unknown", error: "upstream_error" });
  }
}

/* ============================================================
   RUTA 2 — Crear orden + link de pago en Bold
   ============================================================ */
async function handleCreateOrder(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid_json" }, 400);
  }

  const plan = String(body.plan || "").slice(0, 60);
  const priceValue = Number(body.priceValue) || 0;
  const domainAddon = Number(body.domainAddon) || 0;
  const domain = body.domain ? String(body.domain).toLowerCase().slice(0, 253) : null;
  const domainMode = body.domainMode === "new" || body.domainMode === "existing" ? body.domainMode : null;
  const fullName = String(body.fullName || "").trim().slice(0, 120);
  const businessName = String(body.businessName || "").trim().slice(0, 120);
  const phone = String(body.phone || "").trim().slice(0, 30);
  const email = String(body.email || "").trim();

  if (!plan || priceValue <= 0) return json({ error: "invalid_plan" }, 400);
  if (fullName.length < 3) return json({ error: "invalid_full_name" }, 400);
  if (businessName.length < 2) return json({ error: "invalid_business_name" }, 400);
  if (!isValidPhone(phone)) return json({ error: "invalid_phone" }, 400);
  if (!isValidEmail(email)) return json({ error: "invalid_email" }, 400);
  if (domainMode === "new" && (!domain || !isValidDomain(domain))) {
    return json({ error: "invalid_domain" }, 400);
  }

  if (!env.BOLD_API_KEY || !env.ORDERS) {
    return json({ error: "worker_not_configured" }, 500);
  }

  const total = priceValue + domainAddon;
  const orderId = crypto.randomUUID();
  const siteOrigin = env.SITE_ORIGIN || ALLOWED_ORIGIN;

  const description = (
    "7AM Digital - Plan " + plan + (domainMode === "new" ? " + dominio " + domain : "")
  ).slice(0, 100);

  let boldResp, boldData;
  try {
    boldResp = await fetch("https://integrations.api.bold.co/online/link/v1", {
      method: "POST",
      headers: {
        Authorization: `x-api-key ${env.BOLD_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount_type: "CLOSE",
        amount: { currency: "COP", total_amount: total },
        description: description,
        callback_url: `${siteOrigin}/?order=${orderId}`,
        payer_email: email,
      }),
    });
    boldData = await boldResp.json();
  } catch (e) {
    return json({ error: "bold_unreachable" }, 502);
  }

  if (!boldResp.ok || !boldData || !boldData.payload || !boldData.payload.url) {
    return json({ error: "bold_error", detail: boldData }, 502);
  }

  const order = {
    order_id: orderId,
    plan,
    priceValue,
    domainAddon,
    total,
    domain: domain || null,
    domainMode,
    fullName,
    businessName,
    phone,
    email,
    status: "pending",
    boldPaymentLinkId: boldData.payload.payment_link,
    boldPaymentLinkUrl: boldData.payload.url,
    createdAt: Date.now(),
  };

  await env.ORDERS.put(`order:${orderId}`, JSON.stringify(order));

  // índice de órdenes pendientes por correo, usado para correlacionar el webhook
  const idxKey = `pending_by_email:${email.toLowerCase()}`;
  const existingRaw = await env.ORDERS.get(idxKey);
  const list = existingRaw ? JSON.parse(existingRaw) : [];
  list.push(orderId);
  await env.ORDERS.put(idxKey, JSON.stringify(list));

  return json({ checkoutUrl: boldData.payload.url, order_id: orderId });
}

/* ============================================================
   RUTA 3 — Webhook de Bold: confirma pago y registra el dominio
   ============================================================ */

function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

async function verifyBoldSignature(rawBody, secretKey, signature) {
  if (!signature) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretKey || ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(toBase64Utf8(rawBody)));
  const hex = [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(hex, signature);
}

/* ============================================================
   Notificaciones a n8n (opcional)
   ============================================================ */
function buildNotifyPayload(order, eventName) {
  return {
    event: eventName,
    order_id: order.order_id,
    plan: order.plan,
    priceValue: order.priceValue,
    domainAddon: order.domainAddon,
    total: order.total,
    domain: order.domain,
    domainMode: order.domainMode,
    fullName: order.fullName || null,
    businessName: order.businessName || null,
    phone: order.phone || null,
    email: order.email,
    status: order.status,
    boldTransactionId: order.boldTransactionId || null,
    registrationState: order.registrationState || null,
    timestamp: new Date().toISOString(),
  };
}

async function notifyN8n(order, eventName, env) {
  if (!env.N8N_WEBHOOK_URL) return; // no configurado — se omite en silencio
  try {
    const headers = { "Content-Type": "application/json" };
    if (env.N8N_WEBHOOK_SECRET) {
      headers["X-Notify-Secret"] = env.N8N_WEBHOOK_SECRET;
    }
    await fetch(env.N8N_WEBHOOK_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(buildNotifyPayload(order, eventName)),
    });
  } catch (e) {
    // una notificación fallida nunca debe romper el flujo del pedido
  }
}

async function registerDomainAndUpdate(orderId, order, env) {
  try {
    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/registrar/registrations`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ domain_name: order.domain }),
      }
    );
    let data = await resp.json();
    let state = data && data.result && data.result.state;

    let attempts = 0;
    while (state === "in_progress" && attempts < 5) {
      await new Promise((r) => setTimeout(r, 3000));
      const statusResp = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/registrar/registrations/${order.domain}/registration-status`,
        { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } }
      );
      data = await statusResp.json();
      state = data && data.result && data.result.state;
      attempts++;
    }

    if (state === "succeeded") order.status = "registered";
    else if (state === "failed") order.status = "registration_failed";
    else order.status = "registration_pending";

    order.registrationState = state || "unknown";
  } catch (e) {
    order.status = "registration_error";
    order.registrationError = String(e);
  }
  order.updatedAt = Date.now();
  await env.ORDERS.put(`order:${orderId}`, JSON.stringify(order));
  await notifyN8n(order, "domain_registration_result", env);
}

async function processApprovedSale(event, env) {
  const data = event.data || {};
  const payerEmail = (data.payer_email || "").toLowerCase();
  const total = data.amount && data.amount.total;
  if (!payerEmail || total == null) return;

  const idxKey = `pending_by_email:${payerEmail}`;
  const existingRaw = await env.ORDERS.get(idxKey);
  if (!existingRaw) return;
  const orderIds = JSON.parse(existingRaw);

  let matchedId = null;
  let matchedOrder = null;
  for (let i = orderIds.length - 1; i >= 0; i--) {
    const raw = await env.ORDERS.get(`order:${orderIds[i]}`);
    if (!raw) continue;
    const order = JSON.parse(raw);
    if (order.status === "pending" && order.total === total) {
      matchedId = orderIds[i];
      matchedOrder = order;
      break;
    }
  }
  if (!matchedOrder) return; // sin coincidencia — quedará para revisión manual

  matchedOrder.status = "paid";
  matchedOrder.paidAt = Date.now();
  matchedOrder.boldTransactionId = data.payment_id || null;
  await env.ORDERS.put(`order:${matchedId}`, JSON.stringify(matchedOrder));

  const remaining = orderIds.filter((id) => id !== matchedId);
  await env.ORDERS.put(idxKey, JSON.stringify(remaining));

  await notifyN8n(matchedOrder, "payment_approved", env);

  if (matchedOrder.domainMode === "new" && matchedOrder.domain) {
    await registerDomainAndUpdate(matchedId, matchedOrder, env);
  } else {
    matchedOrder.status = "completed";
    matchedOrder.updatedAt = Date.now();
    await env.ORDERS.put(`order:${matchedId}`, JSON.stringify(matchedOrder));
    await notifyN8n(matchedOrder, "order_completed", env);
  }
}

async function handleBoldWebhook(request, env, ctx) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-bold-signature") || "";
  const secret = env.BOLD_SECRET_KEY || "";

  const valid = await verifyBoldSignature(rawBody, secret, signature);
  if (!valid) {
    return new Response("invalid signature", { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return new Response("bad json", { status: 400 });
  }

  // idempotencia: Bold puede reintentar la misma notificación varias veces
  const seenKey = `webhookid:${event.id}`;
  const alreadySeen = env.ORDERS ? await env.ORDERS.get(seenKey) : null;
  if (alreadySeen) {
    return new Response("ok", { status: 200 });
  }
  if (env.ORDERS) {
    await env.ORDERS.put(seenKey, "1", { expirationTtl: 60 * 60 * 24 * 30 });
  }

  if (event.type === "SALE_APPROVED" && env.ORDERS) {
    ctx.waitUntil(processApprovedSale(event, env));
  }

  // Responder rápido (Bold exige <2s); el registro del dominio sigue en segundo plano
  return new Response("ok", { status: 200 });
}

/* ============================================================
   RUTA 4 — Estado de una orden (usado al volver desde Bold)
   ============================================================ */
async function handleOrderStatus(request, env) {
  const url = new URL(request.url);
  const orderId = url.searchParams.get("order");
  if (!orderId || !env.ORDERS) return json({ status: "not_found" });

  const raw = await env.ORDERS.get(`order:${orderId}`);
  if (!raw) return json({ status: "not_found" });

  const order = JSON.parse(raw);
  return json({
    status: order.status,
    plan: order.plan,
    domain: order.domain,
    domainMode: order.domainMode,
  });
}

/* ============================================================
   Router
   ============================================================ */
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    if (url.pathname === "/check-domain" && request.method === "GET") {
      return handleCheckDomain(request, env);
    }
    if (url.pathname === "/create-order" && request.method === "POST") {
      return handleCreateOrder(request, env);
    }
    if (url.pathname === "/bold-webhook" && request.method === "POST") {
      return handleBoldWebhook(request, env, ctx);
    }
    if (url.pathname === "/order-status" && request.method === "GET") {
      return handleOrderStatus(request, env);
    }

    return json({ error: "not_found" }, 404);
  },
};
