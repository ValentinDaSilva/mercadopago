const express = require("express");
const cors = require("cors");
const mercadopago = require("mercadopago");

const app = express();
app.use(cors());
app.use(express.json());

mercadopago.configure({
    access_token: process.env.MP_ACCESS_TOKEN
});

// Endpoint que recibe directamente los items con precio dinámico
app.post("/crear-preferencia", async (req, res) => {
    const items = req.body.items; // espera [{ title: "Clase X", price: 5000 }]

    // Validación básica
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "No se enviaron items" });
    }

    // Normalizar items para Mercado Pago
    const mpItems = items.map((i, index) => {
        const price = Number(i.price);
        if (isNaN(price) || price <= 0) {
            throw new Error(`Precio inválido en item ${index}: ${i.price}`);
        }
        return {
            title: i.title,
            unit_price: price,
            quantity: 1,
            currency_id: "ARS" // obligatorio para Mercado Pago
        };
    });

    const preference = {
        items: mpItems,
        back_urls: {
            success: "https://clasesparticularesutn.com.ar/success.html",
            failure: "https://clasesparticularesutn.com.ar/failure.html"
        },
        auto_return: "approved"
    };

    try {
        const response = await mercadopago.preferences.create(preference);
        res.json({ init_point: response.body.init_point });
    } catch (error) {
        console.error("Error creando preferencia:", error);
        res.status(500).json({ error: "Error Mercado Pago", details: error.message });
    }
});

// Puerto de producción o default 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));
