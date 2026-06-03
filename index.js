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

const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN?.trim() });
const GAS_URL = "https://script.google.com/macros/s/AKfycbwvSTFpClvlYupAvfgpR7YTvd90x7AN0t4EJZ5x7xarJ-ga1wRtWxNTDDy-Wm4judEX/exec";
const MP_USER_ID = process.env.MP_USER_ID?.trim();
const MP_POS_ID = process.env.MP_POS_ID?.trim();

const socketClientes = new Map();

io.on("connection", (socket) => {
    socket.on("join", (ordenId) => {
        socketClientes.set(ordenId, socket.id);
        console.log(`[SOCKET] Cliente unido: ${ordenId}`);
    });
});

// Función auxiliar para empaquetar datos
const getExternalReference = (data) => JSON.stringify(data);

function safeParseExternalReference(externalReference) {
    let meta = { email: undefined, referencias: [], id: undefined, tipoPago: undefined };
    try {
        meta = JSON.parse(externalReference);
    } catch (e) {
        meta.id = externalReference;
    }
    if (!Array.isArray(meta.referencias)) meta.referencias = [];
    return meta;
}

/** MP exige montos con ≤2 decimales; sumamos en centavos como en Pagos/index.html */
function redondearPrecio(valor) {
    const n = Number(valor);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100) / 100;
}

function totalDesdeItems(items, total_amount) {
    if (total_amount != null && Number.isFinite(Number(total_amount))) {
        return redondearPrecio(total_amount);
    }
    const cents = (items || []).reduce(
        (acc, i) => acc + Math.round(redondearPrecio(i.price) * 100),
        0
    );
    return cents / 100;
}

function metaOrdenQR(tipoPago) {
    switch (tipoPago) {
        case "horas":
            return {
                title: "Compra de horas",
                description: "Horas individuales o sueltas — Clases Particulares UTN"
            };
        case "pack":
            return {
                title: "Compra de pack de horas",
                description: "Pack de horas — Clases Particulares UTN"
            };
        case "pack_horas":
            return {
                title: "Compra de horas y packs",
                description: "Packs y horas sueltas — Clases Particulares UTN"
            };
        case "personalizado":
            return {
                title: "Pago personalizado",
                description: "Pago personalizado — Clases Particulares UTN"
            };
        case "admin":
            return {
                title: "Pago manual",
                description: "Pago manual (admin) — Clases Particulares UTN"
            };
        default:
            return {
                title: "Pago de clases",
                description: "Pago de clases particulares UTN"
            };
    }
}

function descripcionItem(tipoPago) {
    if (tipoPago === "horas" || tipoPago === "pack_horas") return "Horas / pack UTN";
    if (tipoPago === "pack") return "Pack de horas UTN";
    return "Clase particular";
}

/** Arma el POST a GAS. tipoPago: clase | pack | horas | pack_horas | personalizado | admin */
function buildPayloadGAS(meta, paymentId, monto) {
    const referencias = meta.referencias || [];
    const precioPagado = redondearPrecio(monto);
    const payload = {
        funcion: "registrarPagoAutomatico",
        correo: meta.email || "sin_correo",
        referencia: JSON.stringify(referencias),
        payment_id: paymentId,
        monto: precioPagado,
        precio: precioPagado,
        tipoPago: meta.tipoPago || "clase"
    };

    const horasSueltas = referencias.find(
        (r) => r && typeof r === "object" && r.tipo === "horas_sueltas"
    );
    if (horasSueltas) {
        payload.modalidad = horasSueltas.modalidad;
        payload.cantidadHoras = horasSueltas.cantidad;
    }

    return payload;
}

app.post("/crear-preferencia", async (req, res) => {
    try {
        const { items, email, referencias, external_reference, tipoPago } = req.body;
        if (!external_reference || !items?.length) {
            return res.status(400).json({ error: "Datos incompletos" });
        }
        const refData = getExternalReference({ id: external_reference, email, referencias, tipoPago });

        const preference = new Preference(client);
        const response = await preference.create({
            body: {
                items: items.map((i, idx) => ({
                    id: String(i.codigo || i.packKey || `item_${idx}`),
                    title: i.title,
                    quantity: 1,
                    currency_id: "ARS",
                    unit_price: redondearPrecio(i.price)
                })),
                payer: { email: email },
                external_reference: refData,
                binary_mode: true
            }
        });
        res.json({ init_point: response.init_point });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/crear-qr", async (req, res) => {
    const { items, email, referencias, external_reference, tipoPago, total_amount } = req.body;
    
    if (!external_reference || !items?.length) return res.status(400).json({ error: "Datos incompletos" });

    try {
        const total = totalDesdeItems(items, total_amount);
        const refData = getExternalReference({ id: external_reference, email, referencias, tipoPago });
        const { title, description } = metaOrdenQR(tipoPago);
        const itemDescription = descripcionItem(tipoPago);
        
        const url = `https://api.mercadopago.com/instore/orders/qr/seller/collectors/${MP_USER_ID}/pos/${MP_POS_ID}/qrs`;
        
        const payload = {
            external_reference: refData,
            title,
            description,
            total_amount: total,
            items: items.map(i => {
                const price = redondearPrecio(i.price);
                return {
                    title: i.title,
                    unit_price: price,
                    quantity: 1,
                    total_amount: price,
                    unit_measure: "unit",
                    description: itemDescription
                };
            })
        };

        const response = await axios.post(url, payload, { 
            headers: { "Authorization": `Bearer ${process.env.MP_ACCESS_TOKEN}` } 
        });
        
        res.json({ qr_data: response.data.qr_data });
    } catch (error) {
        // Mostramos el detalle completo del error de MP
        console.error("[QR Error Detallado]:", JSON.stringify(error.response?.data, null, 2));
        res.status(500).json({ error: "Error en servidor externo" });
    }
});

app.post("/webhook", async (req, res) => {
    const dataId = req.query.id || req.body.data?.id || req.body.id;
    const topic = req.query.topic || req.query.type || req.body.type;

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
                // Si no hay aprobado, intentamos detectar rechazo/cancelación para notificar al frontend.
                const rejected = order.data.payments.find(p => ["rejected", "cancelled"].includes(p.status));
                if (rejected) paymentId = rejected.id;
                else return res.sendStatus(200);
            }
        }

        const { data } = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN?.trim()}` }
        });

        // Desempaquetar los datos del external_reference (siempre que podamos)
        const meta = safeParseExternalReference(data.external_reference);
        if (!meta.email) meta.email = data.payer?.email;

        const socketId = meta.id ? socketClientes.get(meta.id) : undefined;

        if (data.status === "approved") {
            if (socketId) io.to(socketId).emit("pago_aprobado", { success: true, tipoPago: meta.tipoPago });

            const payloadGAS = buildPayloadGAS(meta, paymentId, data.transaction_amount);
            console.log("[GAS] registrarPagoAutomatico:", JSON.stringify(payloadGAS));

            await axios.post(GAS_URL, payloadGAS);
            if (meta.id) socketClientes.delete(meta.id);
        } else if (["rejected", "cancelled"].includes(data.status)) {
            if (socketId) io.to(socketId).emit("pago_rechazado", { status: data.status, tipoPago: meta.tipoPago });
            if (meta.id) socketClientes.delete(meta.id);
        }
        res.sendStatus(200);
    } catch (e) {
        console.error("[Webhook Error]", e.message);
        res.sendStatus(200);
    }
});

app.get("/ping", (req, res) => {
    res.status(200).send("OK");
});

server.listen(process.env.PORT || 3000, () => console.log("Servidor activo"));
