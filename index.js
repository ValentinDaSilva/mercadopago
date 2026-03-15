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
        console.log(`[SOCKET] Cliente unido. Orden: ${ordenId} | SocketID: ${socket.id}`);
    });
});

app.post("/crear-preferencia", async (req, res) => {
    try {
        const { items, email, external_reference } = req.body;
        console.log(`[PREFERENCIA] Creando para: ${external_reference}`);
        
        const preference = new Preference(client);
        const response = await preference.create({
            body: {
                items: items.map(i => ({ id: i.codigo, title: i.title, quantity: 1, currency_id: "ARS", unit_price: Number(i.price) })),
                payer: { email: email },
                external_reference: external_reference,
                binary_mode: true
            }
        });
        console.log(`[PREFERENCIA] Exitosa. ID: ${response.id}`);
        res.json({ init_point: response.init_point });
    } catch (e) {
        console.error("[ERROR PREFERENCIA]", e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post("/crear-qr", async (req, res) => {
    try {
        const { items, email, external_reference } = req.body;
        console.log(`[QR] Creando para: ${external_reference}`);
        const total = items.reduce((acc, i) => acc + Number(i.price), 0);
        
        const url = `https://api.mercadopago.com/instore/orders/qr/seller/collectors/${MP_USER_ID}/pos/${MP_POS_ID}/qrs`;
        const response = await axios.post(url, {
            external_reference: external_reference,
            title: "Pago clases",
            total_amount: total,
            items: items.map(i => ({ title: i.title, unit_price: Number(i.price), quantity: 1, total_amount: Number(i.price) }))
        }, { headers: { "Authorization": `Bearer ${process.env.MP_ACCESS_TOKEN}` } });
        
        console.log(`[QR] Creado correctamente. Data: ${response.data.qr_data.substring(0, 20)}...`);
        res.json({ qr_data: response.data.qr_data });
    } catch (error) {
        console.error("[ERROR QR]", error.response?.data || error.message);
        res.status(500).json({ error: "Error creando QR" });
    }
});

app.post("/webhook", async (req, res) => {
    const dataId = req.query.id || req.body.data?.id || req.body.id;
    const topic = req.query.topic || req.query.type || req.body.type;
    console.log(`[WEBHOOK] Recibido ${topic} con ID: ${dataId}`);

    try {
        let paymentId = dataId;
        if (topic === "merchant_order" || topic === "topic_merchant_order_wh") {
            const order = await axios.get(`https://api.mercadopago.com/merchant_orders/${dataId}`, {
                headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN?.trim()}` }
            });
            const approved = order.data.payments.find(p => p.status === 'approved');
            if (approved) {
                paymentId = approved.id;
                console.log(`[WEBHOOK] Orden encontrada. PaymentID: ${paymentId}`);
            } else {
                console.log("[WEBHOOK] No hay pago aprobado aún.");
                return res.sendStatus(200);
            }
        }

        const { data } = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN?.trim()}` }
        });

        if (data.status === "approved") {
            console.log(`[WEBHOOK] Pago ${paymentId} aprobado. Buscando socket: ${data.external_reference}`);
            
            const socketId = socketClientes.get(data.external_reference);
            if (socketId) {
                console.log(`[WEBHOOK] ¡Socket encontrado! Emitiendo a ${socketId}`);
                io.to(socketId).emit("pago_aprobado", { success: true });
            } else {
                console.warn(`[WEBHOOK] ALERTA: No se encontró socket para ${data.external_reference}. Clientes activos: ${socketClientes.size}`);
            }

            await axios.post(GAS_URL, {
                funcion: "registrarPagoAutomatico",
                correo: data.payer?.email || "sin_correo",
                referencia: data.external_reference,
                payment_id: paymentId,
                monto: data.transaction_amount
            });
            socketClientes.delete(data.external_reference);
        }
        res.sendStatus(200);
    } catch (e) {
        console.error("[ERROR WEBHOOK]", e.message);
        res.sendStatus(200);
    }
});

server.listen(process.env.PORT || 3000, () => console.log("Servidor activo"));