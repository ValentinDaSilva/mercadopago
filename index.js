const express = require("express");
const cors = require("cors");
const { MercadoPagoConfig, Preference } = require("mercadopago");
const axios = require("axios");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// 🔐 Variables de entorno (con validación)
if (!process.env.MP_ACCESS_TOKEN) {
    console.error("FALTA MP_ACCESS_TOKEN");
}
if (!process.env.MP_USER_ID) {
    console.error("FALTA MP_USER_ID");
}
if (!process.env.MP_POS_ID) {
    console.error("FALTA MP_POS_ID");
}

const client = new MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN?.trim()
});

const GAS_URL = "https://servidorusuarios.onrender.com";
const MP_USER_ID = process.env.MP_USER_ID?.trim();
const MP_POS_ID = process.env.MP_POS_ID?.trim();

const socketClientes = new Map();

// Guarda metadata extra de la orden (por ejemplo el "desglose" pack+clases) que NO
// mandamos a Mercado Pago para no inflar el external_reference (MP lo rechaza si es
// muy largo: el pago queda "No se realizó el pago" con cualquier cuenta/monto).
// Se guarda en memoria, indexado por el mismo id de orden (miOrdenId) que ya usamos
// para el external_reference corto. Se limpia solo cuando se usa o cuando expira.
const ordenesMeta = new Map();
const ORDEN_META_TTL_MS = 1000 * 60 * 60 * 2; // 2 horas, por las dudas de que nunca llegue el webhook

function guardarOrdenMeta(ordenId, desglose) {
    if (!ordenId || !desglose) return;
    ordenesMeta.set(ordenId, { desglose, creado: Date.now() });
    // Limpieza perezosa de entradas viejas para no acumular memoria indefinidamente.
    for (const [key, val] of ordenesMeta) {
        if (Date.now() - val.creado > ORDEN_META_TTL_MS) ordenesMeta.delete(key);
    }
}

function tomarDesglose(ordenId) {
    if (!ordenId) return null;
    const entry = ordenesMeta.get(ordenId);
    if (!entry) return null;
    ordenesMeta.delete(ordenId); // se usa una sola vez
    return entry.desglose;
}

// MP manda el webhook más de una vez para el mismo pago (se ve en los logs:
// "topic_merchant_order_wh" llega duplicado). Sin esto, cada reenvío dispara
// otra llamada a registrarPagosEnGAS y termina duplicando el registro del pago.
const pagosProcesados = new Map();
const PAGO_PROCESADO_TTL_MS = 1000 * 60 * 60 * 2; // 2 horas

function yaFueProcesado(paymentId) {
    const marca = pagosProcesados.get(paymentId);
    return marca !== undefined && (Date.now() - marca) < PAGO_PROCESADO_TTL_MS;
}

function marcarProcesado(paymentId) {
    pagosProcesados.set(paymentId, Date.now());
    for (const [key, ts] of pagosProcesados) {
        if (Date.now() - ts > PAGO_PROCESADO_TTL_MS) pagosProcesados.delete(key);
    }
}

// 🔌 SOCKET.IO
io.on("connection", (socket) => {
    socket.on("join", (ordenId) => {
        socketClientes.set(ordenId, socket.id);
        console.log(`[SOCKET] Cliente unido: ${ordenId}`);
    });
});

// 🧠 Helpers
const getExternalReference = (data) => JSON.stringify(data);

function safeParseExternalReference(externalReference) {
    let meta = { email: undefined, referencias: [], id: undefined, tipoPago: undefined };
    try {
        meta = JSON.parse(externalReference);
    } catch (e) {
        meta.id = externalReference;
    }
    return meta;
}

// ServidorUsuarios (GAS_URL) vive en el free tier de Render, que se duerme a
// los ~15 min sin tráfico y puede tardar 30-60s en volver a levantar (cold
// start). Con un timeout de 20s, esos primeros pagos después de la siesta del
// servidor se cortaban ANTES de que ServidorUsuarios llegue a responder (y en
// muchos casos ni a recibir la petición completa) => "no le llega nada".
// Por eso reintentamos con timeouts más generosos en vez de rendirnos al toque.
async function postConReintentos(url, payload, { intentos = 3, timeoutMs = 45000, esperaMs = 8000 } = {}) {
    let ultimoError;
    for (let intento = 1; intento <= intentos; intento++) {
        // 🔎 LOG DETALLADO: URL exacta, método y payload completo que se está mandando.
        // Esto es lo que hay que mirar en los logs de Render para confirmar si la
        // petición realmente sale hacia servidorusuarios y con qué contenido.
        console.log(`[GAS→OUT] Intento ${intento}/${intentos} | POST ${url}`);
        console.log(`[GAS→OUT] Payload:`, JSON.stringify(payload));

        try {
            const respuesta = await axios.post(url, payload, { timeout: timeoutMs });
            // 🔎 LOG DETALLADO: qué contestó servidorusuarios (status + body completo).
            console.log(`[GAS←IN] Respuesta | status: ${respuesta.status} | headers content-type: ${respuesta.headers?.["content-type"]}`);
            console.log(`[GAS←IN] Body:`, JSON.stringify(respuesta.data));
            return respuesta;
        } catch (err) {
            ultimoError = err;
            // 🔎 LOG DETALLADO: si axios ni siquiera recibió respuesta (err.response
            // undefined) vs. si servidorusuarios respondió pero con error HTTP.
            if (err.response) {
                console.error(`[GAS←IN] Intento ${intento}/${intentos} falló CON respuesta del servidor | url: ${url} | status: ${err.response.status} | body:`, JSON.stringify(err.response.data));
            } else {
                console.error(`[GAS←IN] Intento ${intento}/${intentos} falló SIN respuesta del servidor (no llegó nada) | url: ${url} | código: ${err.code} | mensaje: ${err.message}`);
            }
            if (intento < intentos) await new Promise(r => setTimeout(r, esperaMs));
        }
    }
    throw ultimoError;
}

// Llama a GAS una vez por cada "bloque" de la compra (clases sueltas / pack),
// en el orden en que se pasen. Se espera cada llamado antes de hacer el siguiente
// para garantizar que las clases se registren antes que el pack.
async function registrarPagosEnGAS({ email, paymentId, monto, bloques }) {
    console.log(`[GAS] URL configurada (GAS_URL): ${GAS_URL} | bloques a enviar: ${bloques.length}`);
    for (const bloque of bloques) {
        if (!bloque?.referencias?.length) continue;
        const payloadGAS = {
            funcion: "registrarPagoAutomatico",
            correo: email || "sin_correo",
            referencia: bloque.referencias, // array real: axios ya serializa todo el payload a JSON
            payment_id: paymentId,
            monto,
            tipoPago: bloque.tipoPago || "clase"
        };
        console.log(`[GAS] Registrando bloque | tipoPago: ${payloadGAS.tipoPago} | referencias:`, payloadGAS.referencia);
        try {
            const respuesta = await postConReintentos(GAS_URL, payloadGAS);
            console.log(`[GAS] Respuesta OK | tipoPago: ${payloadGAS.tipoPago} | status: ${respuesta.status} | data:`, respuesta.data);
        } catch (errGAS) {
            console.error(
                `[GAS] ERROR FINAL llamando a GAS (se agotaron los reintentos) | tipoPago: ${payloadGAS.tipoPago} | referencias:`,
                payloadGAS.referencia,
                '| paymentId:', paymentId,
                '| mensaje:', errGAS.message,
                '| status:', errGAS.response?.status,
                '| data:', errGAS.response?.data
            );
            // Re-lanzamos para que quien llama (el webhook) se entere de que este
            // bloque quedó sin registrar y pueda loguearlo bien fuerte para revisarlo a mano.
            throw errGAS;
        }
    }
}

// 🌐 TEST ROOT
app.get("/", (req, res) => {
    res.send("Servidor funcionando OK");
});

// 🌐 PING
app.get("/ping", (req, res) => {
    res.status(200).send("OK");
});

// 🔍 DIAGNÓSTICO DE CUENTA MP / POS
// Entrar desde el navegador a: https://TU_BACKEND/debug-mp
app.get("/debug-mp", async (req, res) => {
    const resultado = {};
    const headers = { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN?.trim()}` };

    try {
        const user = await axios.get("https://api.mercadopago.com/users/me", { headers });
        resultado.cuenta = {
            id: user.data.id,
            nickname: user.data.nickname,
            site_status: user.data.site_status,
            country_id: user.data.country_id,
            tags: user.data.tags,
        };
        if (user.data.id?.toString() !== MP_USER_ID) {
            resultado.advertencia_user_id = `⚠️ El MP_ACCESS_TOKEN pertenece al usuario ${user.data.id}, pero MP_USER_ID está seteado como ${MP_USER_ID}.`;
        }
    } catch (e) {
        resultado.error_cuenta = e.response?.data || e.message;
    }

    res.json(resultado);
});

// 💳 CREAR PREFERENCIA
app.post("/crear-preferencia", async (req, res) => {
    try {
        const { items, email, referencias, external_reference, tipoPago, desglose } = req.body;
        // ⚠️ IMPORTANTE: el external_reference que va a MP se mantiene CORTO a propósito
        // (sin "desglose"). Si se pasa de largo, MP rechaza el pago en el momento de cobrarlo
        // aunque la preferencia/QR se haya creado bien.
        const refData = getExternalReference({ id: external_reference, email, referencias, tipoPago });
        guardarOrdenMeta(external_reference, desglose);

        console.log(`[Preferencia] Orden ${external_reference} | external_reference length: ${refData.length} caracteres`);

        const preference = new Preference(client);
        const response = await preference.create({
            body: {
                items: items.map(i => ({
                    id: i.codigo,
                    title: i.title,
                    quantity: 1,
                    currency_id: "ARS",
                    unit_price: Number(i.price)
                })),
                payer: { email: email },
                external_reference: refData,
                binary_mode: true
            }
        });

        res.json({ init_point: response.init_point });
    } catch (e) {
        console.error("[ERROR crear-preferencia]", e.message, JSON.stringify(e.response?.data || e.cause || {}, null, 2));
        res.status(500).json({ error: e.message });
    }
});

// 🧾 CREAR QR
app.post("/crear-qr", async (req, res) => {
    const { items, email, referencias, external_reference, tipoPago, desglose } = req.body;

    if (!external_reference || !items?.length) {
        return res.status(400).json({ error: "Datos incompletos" });
    }

    try {
        const total = items.reduce((acc, i) => acc + Number(i.price), 0);
        // ⚠️ IMPORTANTE: mismo criterio que en crear-preferencia. El "desglose" NO va
        // dentro del external_reference que le mandamos a MP; se guarda aparte.
        const refData = getExternalReference({ id: external_reference, email, referencias, tipoPago });
        guardarOrdenMeta(external_reference, desglose);

        console.log(`[QR] Orden ${external_reference} | external_reference length: ${refData.length} caracteres`);

        const url = `https://api.mercadopago.com/instore/orders/qr/seller/collectors/${MP_USER_ID}/pos/${MP_POS_ID}/qrs`;

        const payload = {
            external_reference: refData,
            title: "Pago de clases",
            description: "Pago de clases particulares UTN",
            total_amount: total,
            items: items.map(i => ({
                title: i.title,
                unit_price: Number(i.price),
                quantity: 1,
                total_amount: Number(i.price),
                unit_measure: "unit",
                description: "Clase particular"
            }))
        };

        console.log(`[QR] Orden ${external_reference} | Enviando a MP:`, JSON.stringify(payload, null, 2));

        const response = await axios.post(url, payload, {
            headers: {
                Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`
            }
        });

        console.log(`[QR] Orden ${external_reference} | Respuesta MP status: ${response.status}`);

        res.json({ qr_data: response.data.qr_data });
    } catch (error) {
        console.error(`[QR Error] Orden ${external_reference} | Mensaje:`, error.message);
        console.error(`[QR Error] Orden ${external_reference} | Data MP:`, JSON.stringify(error.response?.data, null, 2));
        res.status(500).json({ error: "Error en servidor externo" });
    }
});

// 🔔 WEBHOOK
app.post("/webhook", async (req, res) => {
    const dataId = req.query.id || req.body.data?.id || req.body.id;
    const topic = req.query.topic || req.query.type || req.body.type;

    console.log(`[WEBHOOK] Llegó notificación | topic: ${topic} | dataId: ${dataId}`);

    try {
        let paymentId = dataId;

        if (topic === "merchant_order" || topic === "topic_merchant_order_wh") {
            const order = await axios.get(`https://api.mercadopago.com/merchant_orders/${dataId}`, {
                headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN?.trim()}` }
            });

            const approved = order.data.payments.find(p => p.status === "approved");

            if (approved) {
                paymentId = approved.id;
            } else {
                const rejected = order.data.payments.find(p =>
                    ["rejected", "cancelled"].includes(p.status)
                );

                if (rejected) paymentId = rejected.id;
                else return res.sendStatus(200);
            }
        }

        const { data } = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN?.trim()}` }
        });

        console.log(`[WEBHOOK] Payment ${paymentId} | status: ${data.status} | status_detail: ${data.status_detail}`);

        const meta = safeParseExternalReference(data.external_reference);
        if (!meta.email) meta.email = data.payer?.email;

        const socketId = meta.id ? socketClientes.get(meta.id) : undefined;

        // Le contestamos 200 a MP YA, antes de esperar a GAS. Si GAS está dormido
        // (Render free tier) el registro puede tardar bastante con los reintentos
        // de abajo, y si hacemos esperar a MP por eso, MP puede considerar que el
        // webhook "falló" y reenviarlo, generando más duplicados todavía.
        res.sendStatus(200);
        console.log(`[WEBHOOK] Ya respondí 200 a MP | paymentId: ${paymentId} | ahora intento registrar en servidorusuarios...`);

        if (data.status === "approved") {
            if (socketId) {
                io.to(socketId).emit("pago_aprobado", {
                    success: true,
                    tipoPago: meta.tipoPago
                });
            }

            if (meta.id) socketClientes.delete(meta.id);

            // MP reenvía notificaciones para el mismo pago (se ve en los logs de
            // merchant_order duplicados). Sin este chequeo, cada reenvío intenta
            // registrar el pago de nuevo en GAS.
            if (yaFueProcesado(paymentId)) {
                console.log(`[WEBHOOK] Payment ${paymentId} ya se había procesado, ignoro este reenvío del webhook.`);
                return;
            }
            marcarProcesado(paymentId);

            // Si al crear la orden se guardó un "desglose" (pack + clases sueltas en la
            // misma compra), avisamos a GAS en dos llamados separados y en orden:
            // primero las clases, después el pack. Si no hay desglose, es una compra
            // normal (un solo tipo) y avisamos como siempre en un único llamado.
            const desglose = tomarDesglose(meta.id);
            const bloques = (desglose && desglose.clases && desglose.pack)
                ? [desglose.clases, desglose.pack]
                : [{ referencias: meta.referencias || [], tipoPago: meta.tipoPago || "clase" }];

            console.log(`[WEBHOOK] meta.id (orden): ${meta.id} | meta.email: ${meta.email} | bloques:`, JSON.stringify(bloques));

            try {
                await registrarPagosEnGAS({
                    email: meta.email,
                    paymentId,
                    monto: data.transaction_amount,
                    bloques
                });
            } catch (errGASFinal) {
                // Ya se reintentó varias veces adentro de registrarPagosEnGAS y no se
                // pudo. Esto queda bien marcado en los logs para revisar a mano:
                // el pago SE COBRÓ en MP pero NO quedó registrado en ServidorUsuarios.
                console.error(`[WEBHOOK] ⚠️ PAGO APROBADO SIN REGISTRAR EN GAS | paymentId: ${paymentId} | orden: ${meta.id} | email: ${meta.email}`);
            }
        } else if (["rejected", "cancelled"].includes(data.status)) {
            if (socketId) {
                io.to(socketId).emit("pago_rechazado", {
                    status: data.status,
                    tipoPago: meta.tipoPago
                });
            }

            if (meta.id) socketClientes.delete(meta.id);
        }
    } catch (e) {
        console.error("[Webhook Error]", e.message, JSON.stringify(e.response?.data || {}, null, 2));
        if (!res.headersSent) res.sendStatus(200);
    }
});

// 🚀 SERVER (CLAVE PARA NORTHFLANK)
const PORT = process.env.PORT || 8080;

server.listen(PORT, "0.0.0.0", () => {
    console.log("Servidor activo en puerto", PORT);
    console.log("[CONFIG] GAS_URL (destino de registrarPagoAutomatico):", GAS_URL);
});
