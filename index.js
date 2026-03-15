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
    socket.on("join", (ordenId) => socketClientes.set(ordenId, socket.id));
});

// --- RUTA CREAR PREFERENCIA ---
app.post("/crear-preferencia", async (req, res) => {
    try {
        const { items, email, nombre, apellido } = req.body;
        const ordenId = "orden_" + Date.now();
        const preference = new Preference(client);

        const response = await preference.create({
            body: {
                items: items.map(i => ({
                    id: i.codigo,
                    title: i.title,
                    description: "Clase particular universitaria",
                    quantity: 1,
                    currency_id: "ARS",
                    unit_price: Number(i.price)
                })),
                payer: { email: email, first_name: nombre || "Alumno", last_name: apellido || "UTN" },
                external_reference: ordenId,
                auto_return: "approved",
                back_urls: {
                    success: "https://clasesparticularesutn.com.ar/Pagos/Exito.html",
                    failure: "https://clasesparticularesutn.com.ar/Pagos/Fracaso.html"
                },
                binary_mode: true
            }
        });
        res.json({ init_point: response.init_point, orden_id: ordenId });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- RUTA CREAR QR ---
app.post("/crear-qr", async (req, res) => {
    try {
        const { items, email } = req.body;
        const total = items.reduce((acc, i) => acc + Number(i.price), 0);
        const ordenId = "ordenQR_" + Date.now();

        const url = `https://api.mercadopago.com/instore/orders/qr/seller/collectors/${MP_USER_ID}/pos/${MP_POS_ID}/qrs`;
        
        const response = await axios.post(url, {
            external_reference: ordenId,
            title: "Pago clases particulares",
            description: "Clases universitarias", // Obligatorio nivel superior
            total_amount: total,
            items: items.map(i => ({
                title: i.title,
                description: "Clase particular universitaria", // OBLIGATORIO PARA CADA ITEM
                unit_price: Number(i.price),
                quantity: 1,
                unit_measure: "unit",
                total_amount: Number(i.price)
            }))
        }, { headers: { "Authorization": `Bearer ${process.env.MP_ACCESS_TOKEN}` } });

        res.json({ qr_data: response.data.qr_data, orden_id: ordenId });
    } catch (error) {
        console.error("Error QR:", error.response?.data || error.message);
        res.status(500).json({ error: "Error creando QR", details: error.response?.data });
    }
});

// --- WEBHOOK ---
app.post("/webhook", async (req, res) => {
    const paymentId = req.query.id || req.body.data?.id;
    if (!paymentId) return res.sendStatus(200);

    try {
        const { data } = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` }
        });

        if (data.status === "approved") {
            const ordenId = data.external_reference;
            // Notificar por socket
            const socketId = socketClientes.get(ordenId);
            if (socketId) io.to(socketId).emit("pago_aprobado", { success: true });

            // Registrar en GAS
            await axios.post(GAS_URL, {
                funcion: "registrarPagoAutomatico",
                correo: data.payer.email,
                referencia: data.external_reference,
                orden: ordenId,
                payment_id: paymentId,
                monto: data.transaction_amount
            });
        }
        res.sendStatus(200);
    } catch (e) {
        res.sendStatus(200);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Servidor activo puerto " + PORT));