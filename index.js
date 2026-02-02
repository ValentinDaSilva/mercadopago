const express = require("express");
const cors = require("cors");
const mercadopago = require("mercadopago");

const app = express();
app.use(cors());
app.use(express.json());

mercadopago.configure({
    access_token: process.env.MP_ACCESS_TOKEN
});

const productos = {
    individual_1: { title: "Clase Individual 1 Hora", price: 5000 },
    individual_2: { title: "Clase Individual 2 Horas", price: 9000 },
    pack10_individual: { title: "Pack 10 Clases Individuales", price: 72000 },
    pack20_individual: { title: "Pack 20 Clases Individuales", price: 100000 },
    grupal_2: { title: "Clase Grupal 2 Horas", price: 6000 },
    pack10_grupal: { title: "Pack 10 Clases Grupales", price: 48000 },
    pack20_grupal: { title: "Pack 20 Clases Grupales", price: 80000 }
};

app.post("/crear-preferencia", async (req, res) => {
    const producto = productos[req.body.producto];

    if (!producto) {
        return res.status(400).json({ error: "Producto inválido" });
    }

    const preference = {
        items: [{
            title: producto.title,
            unit_price: producto.price,
            quantity: 1
        }],
        back_urls: {
            success: "https://clasesparticularesutn.com.ar/success.html",
            failure: "https://clasesparticularesutn.com.ar/failure.html"
        }

        auto_return: "approved"
    };

    try {
        const response = await mercadopago.preferences.create(preference);
        res.json({ init_point: response.body.init_point });
    } catch (error) {
        res.status(500).json({ error: "Error Mercado Pago" });
    }
});

app.listen(3000, () => {
    console.log("Servidor activo en puerto 3000");
});
