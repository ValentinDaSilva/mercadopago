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

// Configuración SDK v2
const client = new MercadoPagoConfig({ 
    accessToken: process.env.MP_ACCESS_TOKEN?.trim() 
});

const GAS_URL = "https://script.google.com/macros/s/AKfycbwvSTFpClvlYupAvfgpR7YTvd90x7AN0t4EJZ5x7xarJ-ga1wRtWxNTDDy-Wm4judEX/exec";
const MP_USER_ID = process.env.MP_USER_ID?.trim();
const MP_POS_ID = process.env.MP_POS_ID?.trim();

const ordenesPendientes = new Map();
const socketClientes = new Map();

io.on("connection", (socket) => {
    socket.on("join", (ordenId) => {
        socketClientes.set(ordenId, socket.id);
    });
});

async function procesarPagoAprobado(payment, items, email, ordenId) {
    for (const i of items) {
        await axios.post(GAS_URL, {
            funcion: "registrarPagoAutomatico",
            correo: email,
            referencia: i.codigo || i.id,
            orden: ordenId,
            payment_id: payment.id,
            monto: i.price || i.unit_price
        });
    }
}

app.post("/crear-preferencia", async (req, res) => {
    try {
        const { items, email, nombre, apellido } = req.body;
        const ordenId = "orden_" + Date.now();

        const preference = new Preference(client);
        const response = await preference.create({
            body: {
                items: items.map(i => ({ 
                    id: i.codigo, title: i.title, quantity: 1, 
                    unit_price: Number(i.price), currency_id: "ARS" 
                })),
                payer: { email: email, first_name: nombre, last_name: apellido },
                external_reference: ordenId,
                auto_return: "approved",
                binary_mode: true
            }
        });

        ordenesPendientes.set(ordenId, { items, email });
        res.json({ init_point: response.init_point, orden_id: ordenId });
    } catch (e) {
        res.status(500).json({ error: "Error en preferencia", details: e.message });
    }
});

app.post("/crear-qr", async (req, res) => {
    try {
        const { items, email } = req.body;
        const total = items.reduce((acc, i) => acc + Number(i.price), 0);
        const ordenId = "ordenQR_" + Date.now();

        ordenesPendientes.set(ordenId, { items, email });

        const url = `https://api.mercadopago.com/instore/orders/qr/seller/collectors/${MP_USER_ID}/pos/${MP_POS_ID}/qrs`;
        const response = await axios.post(url, {
            external_reference: ordenId,
            title: "Pago clases",
            total_amount: total,
            items: items.map(i => ({ title: i.title, unit_price: Number(i.price), quantity: 1, unit_measure: "unit", total_amount: Number(i.price) }))
        }, { headers: { "Authorization": `Bearer ${process.env.MP_ACCESS_TOKEN}` } });

        res.json({ qr_data: response.data.qr_data, orden_id: ordenId });
    } catch (error) {
        res.status(500).json({ error: "Error creando QR" });
    }
});

app.post("/webhook", async (req, res) => {
    try {
        const paymentId = req.query.id || req.body.data?.id;
        if (!paymentId) return res.sendStatus(200);

        const response = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` }
        });
        
        const payment = response.data;
        if (payment.status === "approved") {
            const ordenId = payment.external_reference;
            const datos = ordenesPendientes.get(ordenId);

            if (datos) {
                await procesarPagoAprobado(payment, datos.items, datos.email, ordenId);
                const socketId = socketClientes.get(ordenId);
                if (socketId) io.to(socketId).emit("pago_aprobado", { success: true });
                
                ordenesPendientes.delete(ordenId);
                socketClientes.delete(ordenId);
            }
        }
        res.sendStatus(200);
    } catch (e) {
        res.sendStatus(200);
    }
});

app.get("/ping", (req, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Servidor OK en puerto " + PORT));