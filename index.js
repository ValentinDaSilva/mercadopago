const express = require("express");
const cors = require("cors");
const mercadopago = require("mercadopago");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

/* ===============================
   VARIABLES (Con .trim() para evitar errores de espacio)
================================ */
const GAS_URL = "https://script.google.com/macros/s/AKfycbwvSTFpClvlYupAvfgpR7YTvd90x7AN0t4EJZ5x7xarJ-ga1wRtWxNTDDy-Wm4judEX/exec";
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN?.trim();
const MP_USER_ID = process.env.MP_USER_ID?.trim();
const MP_POS_ID = process.env.MP_POS_ID?.trim();

mercadopago.configure({ access_token: MP_ACCESS_TOKEN });

app.get("/ping", (req, res) => res.send("ok"));

/* ===============================
   CHECKOUT PRO
================================ */
app.post("/crear-preferencia", async (req, res) => {
    try {
        const { items, email, nombre, apellido } = req.body;
        if (!items || items.length === 0) return res.status(400).json({ error: "Items requeridos" });

        const ordenId = "orden_" + Date.now();
        const mpItems = items.map(i => ({
            id: i.codigo,
            title: i.title,
            description: "Clase particular universitaria",
            category_id: "services",
            quantity: 1,
            currency_id: "ARS",
            unit_price: Number(i.price)
        }));

        const preference = {
            items: mpItems,
            payer: { email: email, first_name: nombre || "Alumno", last_name: apellido || "UTN" },
            external_reference: ordenId,
            statement_descriptor: "CLASES UTN",
            notification_url: "https://mercadopago-di7q.onrender.com/webhook",
            back_urls: {
                success: "https://clasesparticularesutn.com.ar/Pagos/Exito.html",
                failure: "https://clasesparticularesutn.com.ar/Pagos/Fracaso.html",
                pending: "https://clasesparticularesutn.com.ar/Pagos/Pendiente.html"
            },
            auto_return: "approved",
            binary_mode: true
        };

        const response = await mercadopago.preferences.create(preference);
        res.json({ init_point: response.body.init_point, orden_id: ordenId });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Error creando preferencia" });
    }
});

/* ===============================
   QR DINÁMICO (CORREGIDO CON DIAGNÓSTICO)
================================ */
app.post("/crear-qr", async (req, res) => {
    try {
        const { items, email } = req.body;
        if (!items || items.length === 0) return res.status(400).json({ error: "Items requeridos" });

        const total = items.reduce((acc, i) => acc + Number(i.price), 0);
        const ordenId = "ordenQR_" + Date.now();

        const body = {
            external_reference: ordenId,
            title: "Pago clases particulares",
            description: "Clases universitarias",
            notification_url: "https://mercadopago-di7q.onrender.com/webhook",
            total_amount: total,
            items: items.map(i => ({
                title: i.title,
                unit_price: Number(i.price),
                quantity: 1,
                unit_measure: "unit",
                total_amount: Number(i.price)
            }))
        };

        // URL reconstruida estrictamente
        const url = `https://api.mercadopago.com/instore/orders/qr/seller/collectors/${MP_USER_ID}/pos/${MP_POS_ID}/qrs`;
        console.log("DEBUG URL QR:", url);

        const response = await axios.post(url, body, {
            headers: {
                "Authorization": `Bearer ${MP_ACCESS_TOKEN}`,
                "Content-Type": "application/json"
            }
        });

        res.json({ qr_data: response.data.qr_data, orden_id: ordenId, total: total });
    } catch (error) {
        console.error("Error QR:", error.response?.data || error.message);
        res.status(500).json({ error: "Error creando QR", details: error.response?.data });
    }
});

/* ===============================
   WEBHOOK
================================ */
const pagosProcesados = new Set();
app.post("/webhook", async (req, res) => {
    try {
        const topic = req.query.topic || req.query.type;
        if (topic === "payment") {
            const paymentId = req.query.id || req.query["data.id"];
            if (!paymentId || pagosProcesados.has(paymentId)) return res.sendStatus(200);

            const payment = await mercadopago.payment.findById(paymentId);
            if (payment.body.status === "approved") {
                pagosProcesados.add(paymentId);
                const email = payment.body.payer?.email;
                const ordenId = payment.body.external_reference;
                const items = payment.body.additional_info?.items || [];

                console.log("Pago aprobado:", paymentId);
                Promise.all(items.map(i =>
                    axios.post(GAS_URL, {
                        funcion: "registrarPagoAutomatico",
                        correo: email,
                        referencia: i.id,
                        orden: ordenId,
                        payment_id: paymentId,
                        monto: i.unit_price
                    })
                ));
            }
        }
        res.sendStatus(200);
    } catch (e) {
        console.error("Webhook error:", e);
        res.sendStatus(200);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor activo puerto " + PORT));
