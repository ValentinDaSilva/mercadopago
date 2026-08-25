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

// Log enmascarado para confirmar en los logs del servidor que las variables
// están seteadas y no tienen espacios/caracteres raros (sin exponer el token completo).
const mask = (v) => v ? `${v.slice(0, 4)}...${v.slice(-4)} (len ${v.length})` : "VACÍO";
console.log(`[ENV] MP_ACCESS_TOKEN: ${mask(process.env.MP_ACCESS_TOKEN?.trim())}`);
console.log(`[ENV] MP_USER_ID: ${process.env.MP_USER_ID?.trim() || "VACÍO"}`);
console.log(`[ENV] MP_POS_ID: ${process.env.MP_POS_ID?.trim() || "VACÍO"}`);

const client = new MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN?.trim()
});

const GAS_URL = "https://script.google.com/macros/s/AKfycbwvSTFpClvlYupAvfgpR7YTvd90x7AN0t4EJZ5x7xarJ-ga1wRtWxNTDDy-Wm4judEX/exec";
const MP_USER_ID = process.env.MP_USER_ID?.trim();
const MP_POS_ID = process.env.MP_POS_ID?.trim();

const socketClientes = new Map();

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
    let meta = { email: undefined, referencias: [], id: undefined, tipoPago: undefined, desglose: null };
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

// 💳 CREAR PREFERENCIA
app.post("/crear-preferencia", async (req, res) => {
    try {
        const { items, email, referencias, external_reference, tipoPago, desglose } = req.body;
        const refData = getExternalReference({ id: external_reference, email, referencias, tipoPago, desglose });

        console.log(`[Preferencia] Orden ${external_reference} | external_reference length: ${refData.length} caracteres`);
        if (refData.length > 500) {
            console.warn(`[Preferencia] ⚠️ external_reference MUY LARGO (${refData.length} chars):`, refData);
        }

        const body = {
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
        };
        console.log(`[Preferencia] Orden ${external_reference} | Enviando a MP:`, JSON.stringify(body, null, 2));

        const preference = new Preference(client);
        const response = await preference.create({ body });

        console.log(`[Preferencia] Orden ${external_reference} | init_point recibido:`, response.init_point);

        res.json({ init_point: response.init_point });
    } catch (e) {
        console.error(`[ERROR crear-preferencia] Mensaje:`, e.message);
        console.error(`[ERROR crear-preferencia] Status HTTP:`, e.status || e.response?.status);
        console.error(`[ERROR crear-preferencia] Cause/detail:`, JSON.stringify(e.cause || e.response?.data || e, null, 2));
        res.status(500).json({ error: e.message });
    }
});

// 🧾 CREAR QR
app.post("/crear-qr", async (req, res) => {
    const { items, email, referencias, external_reference, tipoPago, desglose } = req.body;

    if (!external_reference || !items?.length) {
        console.warn("[QR] Datos incompletos recibidos del frontend:", JSON.stringify(req.body, null, 2));
        return res.status(400).json({ error: "Datos incompletos" });
    }

    try {
        const total = items.reduce((acc, i) => acc + Number(i.price), 0);
        const refData = getExternalReference({ id: external_reference, email, referencias, tipoPago, desglose });

        // ⚠️ Mercado Pago tiene un límite de longitud para external_reference.
        // Si esto se pasa (por ejemplo, por venir con "desglose" de pack+clases muy largo),
        // MP puede aceptar la creación del QR pero fallar al momento de escanearlo/pagarlo.
        console.log(`[QR] Orden ${external_reference} | external_reference length: ${refData.length} caracteres`);
        if (refData.length > 500) {
            console.warn(`[QR] ⚠️ external_reference MUY LARGO (${refData.length} chars). Esto puede causar "Algo salió mal" al escanear en Mercado Pago. Contenido:`, refData);
        }

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

        // Chequeo de consistencia: la suma de total_amount de cada item DEBE dar
        // exactamente igual al total_amount general, o MP puede rechazar/fallar el QR.
        const sumaItems = payload.items.reduce((acc, i) => acc + i.total_amount, 0);
        if (Math.round(sumaItems * 100) !== Math.round(payload.total_amount * 100)) {
            console.warn(`[QR] ⚠️ Inconsistencia de montos: suma de items = ${sumaItems}, total_amount = ${payload.total_amount}`);
        }

        console.log(`[QR] Orden ${external_reference} | Enviando a MP:`, JSON.stringify(payload, null, 2));
        console.log(`[QR] Orden ${external_reference} | URL: ${url} | MP_USER_ID: ${MP_USER_ID} | MP_POS_ID: ${MP_POS_ID}`);

        const response = await axios.post(url, payload, {
            headers: {
                Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`
            }
        });

        console.log(`[QR] Orden ${external_reference} | Respuesta MP status: ${response.status}`);
        console.log(`[QR] Orden ${external_reference} | Respuesta MP data:`, JSON.stringify(response.data, null, 2));

        res.json({ qr_data: response.data.qr_data });
    } catch (error) {
        console.error(`[QR Error] Orden ${external_reference} | Mensaje: ${error.message}`);
        console.error(`[QR Error] Orden ${external_reference} | Status HTTP: ${error.response?.status}`);
        console.error(`[QR Error] Orden ${external_reference} | Data MP:`, JSON.stringify(error.response?.data, null, 2));
        console.error(`[QR Error] Orden ${external_reference} | Headers MP:`, JSON.stringify(error.response?.headers, null, 2));
        if (!error.response) {
            // No hubo respuesta de MP: puede ser timeout, DNS, o el request nunca salió.
            console.error(`[QR Error] Orden ${external_reference} | Sin respuesta de MP. error.code: ${error.code}, error.stack:`, error.stack);
        }
        // Devolvemos el detalle de MP al frontend para poder verlo también en la consola del navegador.
        res.status(500).json({
            error: "Error en servidor externo",
            mp_status: error.response?.status || null,
            mp_error: error.response?.data || null
        });
    }
});

// 🔔 WEBHOOK
app.post("/webhook", async (req, res) => {
    const dataId = req.query.id || req.body.data?.id || req.body.id;
    const topic = req.query.topic || req.query.type || req.body.type;

    console.log(`[WEBHOOK] Llegó notificación | topic: ${topic} | dataId: ${dataId}`);
    console.log(`[WEBHOOK] query:`, JSON.stringify(req.query, null, 2));
    console.log(`[WEBHOOK] body:`, JSON.stringify(req.body, null, 2));

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

        console.log(`[WEBHOOK] Payment ${paymentId} | status: ${data.status} | status_detail: ${data.status_detail} | external_reference:`, data.external_reference);

        const meta = safeParseExternalReference(data.external_reference);
        if (!meta.email) meta.email = data.payer?.email;

        const socketId = meta.id ? socketClientes.get(meta.id) : undefined;
        console.log(`[WEBHOOK] Payment ${paymentId} | meta.id (miOrdenId): ${meta.id} | socketId encontrado: ${socketId || "NINGUNO (el cliente ya no está conectado o el id no matchea)"}`);

        if (data.status === "approved") {
            if (socketId) {
                io.to(socketId).emit("pago_aprobado", {
                    success: true,
                    tipoPago: meta.tipoPago
                });
            }

            // Si la orden tenía clases sueltas Y pack combinados, avisamos a GAS
            // en dos llamados separados y en orden: primero las clases, después el pack.
            const bloques = (meta.desglose && meta.desglose.clases && meta.desglose.pack)
                ? [meta.desglose.clases, meta.desglose.pack]
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
        console.error("[Webhook Error] Mensaje:", e.message);
        console.error("[Webhook Error] Status HTTP:", e.response?.status);
        console.error("[Webhook Error] Data MP:", JSON.stringify(e.response?.data, null, 2));
        console.error("[Webhook Error] Stack:", e.stack);
        res.sendStatus(200);
    }
});

// 🚀 SERVER (CLAVE PARA NORTHFLANK)
const PORT = process.env.PORT || 8080;

server.listen(PORT, "0.0.0.0", () => {
    console.log("Servidor activo en puerto", PORT);
});
