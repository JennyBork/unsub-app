const express = require('express');
const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// Cache-busting safety configurations to prevent outdated local views
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

app.post('/api/connect', (req, res) => {
    console.log("🔌 POST /api/connect - Connection handshake captured.");
    res.json({ success: true });
});

app.post('/api/zap', (req, res) => {
    const { senders } = req.body;
    console.log("⚡ POST /api/zap - Batch processing deletion vectors:");
    if (senders && senders.length > 0) {
        senders.forEach(email => console.log("🧹 Target cleared from database backlog tracks: " + email));
    }
    res.json({ success: true });
});

app.get('/api/scan', (req, res) => {
    console.log("📡 GET /api/scan - Database stream request verified.");
    res.json([
        { name: "🛒 Halara Shop", email: "deals@thehalara.com", count: 47 },
        { name: "🛍️ Temu Updates", email: "orders@temu.com", count: 142 },
        { name: "🏷️ Groupon Deals", email: "offers@groupon.com", count: 89 },
        { name: "📦 Amazon Offers", email: "shipments@amazon.com", count: 64 },
        { name: "👟 Nike Member", email: "nike@nike-news.com", count: 31 },
        { name: "🍕 Domino's Deals", email: "pizza@dominos-rewards.com", count: 18 }
    ]);
});

app.listen(PORT, () => {
    console.log("🧼 Unsub LOCAL CACHE-BUSTED engine operational.");
    console.log("📡 Listening live link on: http://localhost:" + PORT);
});
