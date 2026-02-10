const express = require("express");
const cors = require("cors");
const mercadopago = require("mercadopago");
const axios = require("axios"); // Necesitarás instalar axios: npm install axios

const app = express();
app.use(cors());
app.use(express.json());

const GAS_URL = "https://script.google.com/macros/s/AKfycbwvSTFpClvlYupAvfgpR7YTvd90x7AN0t4EJZ5x7xarJ-ga1wRtWxNTDDy-Wm4judEX/exec";

mercadopago.configure({
    access_token: process.env.MP_ACCESS_TOKEN
});

app.get("/ping", (req, res) => {
    res.send("ok");
});


app.post("/crear-preferencia", async (req, res) => {
    const { items, email } = req.body; 

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "No se enviaron items" });
    }

    // Unimos los códigos de las clases en un solo string para guardarlo
    const codigos = items.map(i => i.codigo).join(",");

    const mpItems = items.map(i => ({
        title: i.title,
        unit_price: Number(i.price),
        quantity: 1,
        currency_id: "ARS"
    }));

    const preference = {
        items: mpItems,
        // Guardamos el correo y los códigos en external_reference
        // Formato: correo|codigo1,codigo2
        external_reference: `${email}|${codigos}`,
        back_urls: {
            success: "https://clasesparticularesutn.com.ar/Pagos/Exito.html",
            failure: "https://clasesparticularesutn.com.ar/Pagos/Fracaso.html",
            pending: "https://clasesparticularesutn.com.ar/Pagos/Pendiente.html"
        },
        auto_return: "approved",
        // Importante: URL donde MP avisará del pago
        notification_url: "https://mercadopago-di7q.onrender.com/webhook" 
    };

    try {
        const response = await mercadopago.preferences.create(preference);
        res.json({ init_point: response.body.init_point });
    } catch (error) {
        res.status(500).json({ error: "Error Mercado Pago", details: error.message });
    }
});

// NUEVO ENDPOINT: Webhook para recibir la confirmación de Mercado Pago
app.post("/webhook", async (req, res) => {
    const { query } = req;
    const topic = query.topic || query.type;

    try {
        if (topic === "payment") {
            const paymentId = query.id || query["data.id"];
            const payment = await mercadopago.payment.findById(paymentId);
            const status = payment.body.status;

            if (status === "approved") {
                // Recuperamos el correo y códigos que guardamos antes
                const [email, codigos] = payment.body.external_reference.split("|");
                const listaCodigos = codigos.split(",");

                console.log(`Pago aprobado para: ${email}. Procesando códigos: ${codigos}`);

                // Enviamos una petición a GAS por cada código pagado
                for (const codigo of listaCodigos) {
                    await axios.post(GAS_URL, {
                        funcion: "registrarPagoAutomatico",
                        correo: email,
                        referencia: codigo
                    });
                }
            }
        }
        res.sendStatus(200); // Respondemos siempre 200 a MP
    } catch (error) {
        console.error("Error en Webhook:", error);
        res.sendStatus(500);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));
