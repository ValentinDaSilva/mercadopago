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
        console.log("Preferencia creada:", response);
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
        console.log("QR creado:", response.data);
        res.json({ qr_data: response.data.qr_data, orden_id: ordenId });
    } catch (error) {
        console.error("Error QR:", error.response?.data || error.message);
        res.status(500).json({ error: "Error creando QR", details: error.response?.data });
    }
});

app.post("/webhook", async (req, res) => {
    // 1. Logs de entrada crudos
    console.log("--- WEBHOOK RECIBIDO ---");
    console.log("Query Params:", JSON.stringify(req.query));
    console.log("Body:", JSON.stringify(req.body));
    
    // Identificar tipo de notificación
    const topic = req.query.topic || req.query.type || req.body.type;
    const dataId = req.query.id || req.body.data?.id || req.body.id;

    if (!dataId) {
        console.warn("Webhook sin ID detectado, ignorando...");
        return res.sendStatus(200);
    }

    try {
        let paymentId = dataId;

        // 2. Lógica para Merchant Orders (QR)
        if (topic === "merchant_order" || topic === "topic_merchant_order_wh") {
            console.log("Detectada Merchant Order (ID:", dataId, "). Consultando orden...");
            const orderResponse = await axios.get(`https://api.mercadopago.com/merchant_orders/${dataId}`, {
                headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN?.trim()}` }
            });
            
            console.log("Respuesta de Orden:", JSON.stringify(orderResponse.data));
            const approvedPayment = orderResponse.data.payments.find(p => p.status === 'approved');
            
            if (approvedPayment) {
                paymentId = approvedPayment.id;
                console.log("Pago encontrado dentro de la orden. ID:", paymentId);
            } else {
                console.log("No se encontró pago aprobado en esta orden aún.");
                return res.sendStatus(200);
            }
        }

        // 3. Consultar estado del pago
        console.log("Consultando estado del pago en API:", paymentId);
        const { data } = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN?.trim()}` }
        });

        console.log("Estado final del pago:", data.status);

        if (data.status === "approved") {
            console.log("Procesando pago aprobado. Referencia:", data.external_reference);
            
            // 4. Notificación vía Socket
            const socketId = socketClientes.get(data.external_reference);
            if (socketId) {
                console.log("Socket encontrado, emitiendo pago_aprobado a:", socketId);
                io.to(socketId).emit("pago_aprobado", { success: true, paymentId });
            } else {
                console.log("No se encontró socket activo para la orden:", data.external_reference);
            }

            // 5. Envío a Google Apps Script
            const payload = {
                funcion: "registrarPagoAutomatico",
                correo: data.payer?.email || "sin_correo",
                referencia: data.external_reference,
                orden: data.external_reference,
                payment_id: paymentId,
                monto: data.transaction_amount
            };
            console.log("Payload a enviar a GAS:", JSON.stringify(payload));
            
            const gasResponse = await axios.post(GAS_URL, payload);
            console.log("Respuesta de GAS (Status):", gasResponse.status);
            console.log("Cuerpo de respuesta GAS:", JSON.stringify(gasResponse.data));
            
            socketClientes.delete(data.external_reference);
        }
        
        res.sendStatus(200);
    } catch (e) {
        console.error("--- ERROR EN WEBHOOK ---");
        console.error("Mensaje:", e.message);
        if (e.response) {
            console.error("Datos error API:", JSON.stringify(e.response.data));
        }
        res.sendStatus(200);
    }
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Servidor activo puerto " + PORT));