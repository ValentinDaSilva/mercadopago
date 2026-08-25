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

const GAS_URL = "https://script.google.com/macros/s/AKfycbwvSTFpClvlYupAvfgpR7YTvd90x7AN0t4EJZ5x7xarJ-ga1wRtWxNTDDy-Wm4judEX/exec";
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

// Llama a GAS una vez por cada "bloque" de la compra (clases sueltas / pack),
// en el orden en que se pasen. Se espera cada llamado antes de hacer el siguiente
// para garantizar que las clases se registren antes que el pack.
async function registrarPagosEnGAS({ email, paymentId, monto, bloques }) {
    for (const bloque of bloques) {
        if (!bloque?.referencias?.length) continue;
        const payloadGAS = {
            funcion: "registrarPagoAutomatico",
            correo: email || "sin_correo",
            referencia: JSON.stringify(bloque.referencias),
            payment_id: paymentId,
            monto,
            tipoPago: bloque.tipoPago || "clase"
        };
        console.log(`[GAS] Registrando bloque | tipoPago: ${payloadGAS.tipoPago} | referencias:`, payloadGAS.referencia);
        await axios.post(GAS_URL, payloadGAS);
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

        if (data.status === "approved") {
            if (socketId) {
                io.to(socketId).emit("pago_aprobado", {
                    success: true,
                    tipoPago: meta.tipoPago
                });
            }

            // Si al crear la orden se guardó un "desglose" (pack + clases sueltas en la
            // misma compra), avisamos a GAS en dos llamados separados y en orden:
            // primero las clases, después el pack. Si no hay desglose, es una compra
            // normal (un solo tipo) y avisamos como siempre en un único llamado.
            const desglose = tomarDesglose(meta.id);
            const bloques = (desglose && desglose.clases && desglose.pack)
                ? [desglose.clases, desglose.pack]
                : [{ referencias: meta.referencias || [], tipoPago: meta.tipoPago || "clase" }];

            await registrarPagosEnGAS({
                email: meta.email,
                paymentId,
                monto: data.transaction_amount,
                bloques
            });

            if (meta.id) socketClientes.delete(meta.id);
        } else if (["rejected", "cancelled"].includes(data.status)) {
            if (socketId) {
                io.to(socketId).emit("pago_rechazado", {
                    status: data.status,
                    tipoPago: meta.tipoPago
                });
            }

            if (meta.id) socketClientes.delete(meta.id);
        }

        res.sendStatus(200);
    } catch (e) {
        console.error("[Webhook Error]", e.message, JSON.stringify(e.response?.data || {}, null, 2));
        res.sendStatus(200);
    }
});

// 🚀 SERVER (CLAVE PARA NORTHFLANK)
const PORT = process.env.PORT || 8080;

server.listen(PORT, "0.0.0.0", () => {
    console.log("Servidor activo en puerto", PORT);
});
