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

// Log de variables para depuración (solo imprime si existen para no revelar todo)
console.log("Iniciando servidor...");
console.log("Configuración MP:", process.env.MP_ACCESS_TOKEN ? "Token detectado" : "ERROR: MP_ACCESS_TOKEN no definido");

const client = new MercadoPagoConfig({ 
    accessToken: process.env.MP_ACCESS_TOKEN?.trim() 
});

const GAS_URL = "https://script.google.com/macros/s/AKfycbwvSTFpClvlYupAvfgpR7YTvd90x7AN0t4EJZ5x7xarJ-ga1wRtWxNTDDy-Wm4judEX/exec";
const MP_USER_ID = process.env.MP_USER_ID?.trim();
const MP_POS_ID = process.env.MP_POS_ID?.trim();

const ordenesPendientes = new Map();
const socketClientes = new Map();

io.on("connection", (socket) => {
    console.log("Nuevo cliente Socket.io:", socket.id);
    socket.on("join", (ordenId) => {
        console.log(`Socket ${socket.id} unido a orden: ${ordenId}`);
        socketClientes.set(ordenId, socket.id);
    });
});

async function procesarPagoAprobado(payment, items, email, ordenId) {
    try {
        console.log("Enviando a Google Apps Script para orden:", ordenId);
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
    } catch (err) {
        console.error("Error al registrar en GAS:", err.message);
    }
}

app.post("/crear-preferencia", async (req, res) => {
    console.log("Recibida solicitud /crear-preferencia");
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
                back_urls: {
                    success: "https://clasesparticularesutn.com.ar/Pagos/Exito.html", // Cambia esto por tu URL de éxito
                    failure: "https://clasesparticularesutn.com.ar/Pagos/Fracaso.html", // Cambia esto por tu URL de fracaso
                    pending: "https://clasesparticularesutn.com.ar/Pagos/Pendiente.html" // Cambia esto por tu URL de pendiente
                },
                binary_mode: true
            }
        });

        ordenesPendientes.set(ordenId, { items, email });
        console.log("Preferencia creada exitosamente:", ordenId);
        res.json({ init_point: response.init_point, orden_id: ordenId });
    } catch (e) {
        console.error("Error en /crear-preferencia:", e.message);
        res.status(500).json({ error: "Error en preferencia", details: e.message });
    }
});
app.post("/crear-qr", async (req, res) => {
    console.log("Recibida solicitud /crear-qr");
    try {
        const { items, email } = req.body;
        const total = items.reduce((acc, i) => acc + Number(i.price), 0);
        const ordenId = "ordenQR_" + Date.now();

        ordenesPendientes.set(ordenId, { items, email });

        const url = `https://api.mercadopago.com/instore/orders/qr/seller/collectors/${MP_USER_ID}/pos/${MP_POS_ID}/qrs`;
        
        const response = await axios.post(url, {
            external_reference: ordenId,
            title: "Pago clases",
            description: "Pago de servicios educativos", // Descripción de la orden
            total_amount: total,
            items: items.map(i => ({ 
                title: i.title, 
                description: i.description || "Clase personalizada", // Descripción del ítem
                unit_price: Number(i.price), 
                quantity: 1, 
                unit_measure: "unit", 
                total_amount: Number(i.price) 
            }))
        }, { 
            headers: { 
                "Authorization": `Bearer ${process.env.MP_ACCESS_TOKEN}`,
                "Content-Type": "application/json" 
            } 
        });

        console.log("QR creado con éxito para orden:", ordenId);
        res.json({ qr_data: response.data.qr_data, orden_id: ordenId });
    } catch (error) {
        // Mostramos el cuerpo que enviamos para detectar fallos en la estructura
        console.error("Error en QR. Respuesta API:", error.response?.data?.message);
        console.error("Causa del error:", error.response?.data?.causes);
        res.status(500).json({ error: "Error creando QR", details: error.response?.data?.message });
    }
});

app.post("/webhook", async (req, res) => {
    const paymentId = req.query.id || req.body.data?.id;
    console.log("Webhook recibido. ID Pago:", paymentId);
    
    if (!paymentId) return res.sendStatus(200);

    try {
        const response = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` }
        });
        
        const payment = response.data;
        console.log("Estado del pago:", payment.status, "Ref:", payment.external_reference);

        if (payment.status === "approved") {
            const ordenId = payment.external_reference;
            const datos = ordenesPendientes.get(ordenId);

            if (datos) {
                await procesarPagoAprobado(payment, datos.items, datos.email, ordenId);
                const socketId = socketClientes.get(ordenId);
                if (socketId) {
                    console.log("Notificando éxito por socket a:", socketId);
                    io.to(socketId).emit("pago_aprobado", { success: true });
                }
                ordenesPendientes.delete(ordenId);
                socketClientes.delete(ordenId);
            }
        }
        res.sendStatus(200);
    } catch (e) {
        console.error("Error en Webhook:", e.message);
        res.sendStatus(200);
    }
});

app.get("/ping", (req, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Servidor escuchando en puerto " + PORT));