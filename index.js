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
        const { items, email, referencias, external_reference } = req.body;
        console.log(`[PREFERENCIA] Creando para: ${external_reference}`);
        
        const preference = new Preference(client);
        const response = await preference.create({
            body: {
                items: items.map(i => ({ id: i.codigo, title: i.title, quantity: 1, currency_id: "ARS", unit_price: Number(i.price) })),
                payer: { email: email },
                external_reference: external_reference,
                metadata: { referencias: referencias, correo: email }, // Guardamos metadata
                binary_mode: true
            }
        });
        res.json({ init_point: response.init_point });
    } catch (e) {
        console.error("[ERROR PREFERENCIA]", e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post("/crear-qr", async (req, res) => {
    const { items, email, referencias, external_reference } = req.body;
    
    if (!external_reference || !items || items.length === 0) {
        return res.status(400).json({ error: "Datos incompletos" });
    }

    try {
        console.log(`[QR] Iniciando para: ${external_reference}`);
        const total = items.reduce((acc, i) => acc + Number(i.price), 0);
        const url = `https://api.mercadopago.com/instore/orders/qr/seller/collectors/${MP_USER_ID}/pos/${MP_POS_ID}/qrs`;
        
        const payload = {
            external_reference: external_reference,
            title: "Pago de clases",
            description: "Pago de clases particulares UTN",
            total_amount: total,
            // Guardamos referencias y correo en metadata para recuperar luego
            metadata: { referencias: referencias, correo: email },
            items: items.map(i => ({ 
                title: i.title, 
                unit_price: Number(i.price), 
                quantity: 1, 
                total_amount: Number(i.price),
                unit_measure: "unit",
                description: "Clase particular universitaria" 
            }))
        };

        const response = await axios.post(url, payload, { 
            headers: { "Authorization": `Bearer ${process.env.MP_ACCESS_TOKEN}` } 
        });
        
        res.json({ qr_data: response.data.qr_data });
    } catch (error) {
        console.error("[QR] Error API MP:", JSON.stringify(error.response?.data, null, 2));
        res.status(500).json({ error: "Error en servidor externo" });
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
            if (approved) paymentId = approved.id;
            else return res.sendStatus(200);
        }

        const { data } = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN?.trim()}` }
        });

        if (data.status === "approved") {
            const socketId = socketClientes.get(data.external_reference);
            if (socketId) io.to(socketId).emit("pago_aprobado", { success: true });

            // Recuperamos datos desde metadata
            const meta = data.metadata || {};
            const payloadGAS = {
                funcion: "registrarPagoAutomatico",
                correo: meta.correo || data.payer?.email || "sin_correo",
                referencia: JSON.stringify(meta.referencias || []),
                payment_id: paymentId,
                monto: data.transaction_amount
            };
            
            console.log("[GAS] Enviando payload:", JSON.stringify(payloadGAS, null, 2));
            await axios.post(GAS_URL, payloadGAS);
            socketClientes.delete(data.external_reference);
        }
        res.sendStatus(200);
    } catch (e) {
        console.error("[ERROR WEBHOOK]", e.message);
        res.sendStatus(200);
    }
});

server.listen(process.env.PORT || 3000, () => console.log("Servidor activo"));