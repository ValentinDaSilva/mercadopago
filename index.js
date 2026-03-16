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

app.post("/crear-preferencia", async (req, res) => {
    try {
        const { items, email, referencias, external_reference } = req.body;
        const refData = getExternalReference({ id: external_reference, email, referencias });

        const preference = new Preference(client);
        const response = await preference.create({
            body: {
                items: items.map(i => ({ id: i.codigo, title: i.title, quantity: 1, currency_id: "ARS", unit_price: Number(i.price) })),
                payer: { email: email },
                external_reference: refData, // Pasamos el JSON stringificado
                binary_mode: true
            }
        });
        res.json({ init_point: response.init_point });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/crear-qr", async (req, res) => {
    const { items, email, referencias, external_reference } = req.body;
    
    if (!external_reference || !items?.length) return res.status(400).json({ error: "Datos incompletos" });

    try {
        const total = items.reduce((acc, i) => acc + Number(i.price), 0);
        const refData = getExternalReference({ id: external_reference, email, referencias });
        
        const url = `https://api.mercadopago.com/instore/orders/qr/seller/collectors/${MP_USER_ID}/pos/${MP_POS_ID}/qrs`;
        
        const payload = {
            external_reference: refData,
            title: "Pago de clases",
            description: "Pago de clases particulares UTN", // Descripción global obligatoria
            total_amount: total,
            items: items.map(i => ({ 
                title: i.title, 
                unit_price: Number(i.price), 
                quantity: 1, 
                total_amount: Number(i.price),
                unit_measure: "unit",
                description: "Clase particular" // ESTA ES LA CLAVE PARA EL ERROR
            }))
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
            const approved = order.data.payments.find(p => p.status === 'approved');
            if (approved) paymentId = approved.id;
            else return res.sendStatus(200);
        }

        const { data } = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN?.trim()}` }
        });

        if (data.status === "approved") {
            // Desempaquetar los datos del external_reference
            let meta = { email: data.payer?.email, referencias: [] };
            try {
                meta = JSON.parse(data.external_reference);
            } catch(e) { meta.id = data.external_reference; }

            const socketId = socketClientes.get(meta.id);
            if (socketId) io.to(socketId).emit("pago_aprobado", { success: true });

            const payloadGAS = {
                funcion: "registrarPagoAutomatico",
                correo: meta.email || "sin_correo",
                referencia: JSON.stringify(meta.referencias || []),
                payment_id: paymentId,
                monto: data.transaction_amount
            };
            
            await axios.post(GAS_URL, payloadGAS);
            socketClientes.delete(meta.id);
        }
        res.sendStatus(200);
    } catch (e) {
        console.error("[Webhook Error]", e.message);
        res.sendStatus(200);
    }
});

server.listen(process.env.PORT || 3000, () => console.log("Servidor activo"));