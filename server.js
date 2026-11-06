const express = require('express');
const { ImapFlow } = require('imapflow');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

const PROVIDER_PORTS = {
    gmail: { host: '://gmail.com', port: 993 },
    yahoo: { host: '://yahoo.com', port: 993 },
    aol: { host: '://aol.com', port: 993 },
    outlook: { host: '://office365.com', port: 993 },
    icloud: { host: '://me.com', port: 993 }
};

const activeCredentials = {};

app.post('/api/connect', (req, res) => {
    const { email, token, provider, customHost, customPort } = req.body;
    const userSessionId = req.headers['x-user-session'] || 'anonymous';
    
    let config = PROVIDER_PORTS[provider ? provider.toLowerCase() : ''];
    if (provider === 'imap' && customHost) {
        config = { host: customHost, port: customPort || 993 };
    }
    
    if (!config) return res.status(400).json({ success: false, message: 'Invalid server configuration.' });

    activeCredentials[userSessionId] = { email, token, config };
    console.log(`🔌 Production session securely locked: ${userSessionId}`);
    res.json({ success: true });
});
// ⚡ THE ARCHITECTURE WIRE: Captures the one-tap click and hands it to your Render variables instantly!
app.get('/api/auth/:provider', (req, res) => {
    const { provider } = req.params;
    const { session, host, port } = req.query;
    
    console.log(`📡 Redirect incoming channel active for: ${provider.toUpperCase()}`);
    
    // Redirects directly to the respective carrier authentication gates using your credentials
    if (provider === 'gmail') {
        const googleAuthUrl = `https://google.com{process.env.GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.GOOGLE_REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent('https://google.com')}&state=${session}`;
        return res.redirect(googleAuthUrl);
    } else if (provider === 'outlook') {
        const azureAuthUrl = `https://microsoftonline.com{process.env.OUTLOOK_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.OUTLOOK_REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent('https://office.com offline_access')}&state=${session}`;
        return res.redirect(azureAuthUrl);
    }
    
    // Fallback for providers utilizing native handshake credentials 
    res.send(`🛜 Secure 1-tap pipeline initialized for ${provider.toUpperCase()}. Callback loop pending.`);
});
app.post('/api/zap', async (req, res) => {
    const { senders } = req.body;
    const userSessionId = req.headers['x-user-session'] || 'anonymous';
    const creds = activeCredentials[userSessionId];
    if (!creds) return res.json({ success: true });

    const client = new ImapFlow({
        host: creds.config.host,
        port: creds.config.port,
        secure: true,
        auth: { user: creds.email, pass: creds.token },
        logger: false
    });

    try {
        await client.connect();
        try { await client.mailboxOpen('[Gmail]/All Mail'); } catch(e) { await client.mailboxOpen('INBOX'); }
        if (senders && senders.length > 0) {
            for (const targetEmail of senders) {
                for await (let msg of client.fetch({ sentsince: new Date(Date.now() - 7*24*3600*1000) }, { envelope: true })) {
                    if (msg.envelope && msg.envelope.from && msg.envelope.from.length > 0) {
                        const currentSender = (msg.envelope.from[0].address || '').toLowerCase();
                        if (currentSender === targetEmail.toLowerCase()) {
                            await client.messageDelete(String(msg.uid));
                        }
                    }
                }
            }
        }
        await client.logout();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/scan', async (req, res) => {
    const userSessionId = req.headers['x-user-session'] || 'anonymous';
    const creds = activeCredentials[userSessionId];
    if (!creds) return res.json([]);

    const client = new ImapFlow({
        host: creds.config.host,
        port: creds.config.port,
        secure: true,
        auth: { user: creds.email, pass: creds.token },
        logger: false
    });

    try {
        await client.connect();
        try { await client.mailboxOpen('[Gmail]/All Mail'); } catch(e) { await client.mailboxOpen('INBOX'); }
        const sendersMap = {};

        for await (let message of client.fetch('1:100', { envelope: true })) {
            if (message.envelope && message.envelope.from && message.envelope.from.length > 0) {
                const senderNode = message.envelope.from[0];
                if (senderNode) {
                    const rawName = senderNode.name || senderNode.mailbox || 'Unknown Sender';
                    const senderEmail = (senderNode.address || `${senderNode.mailbox}@${senderNode.host}`).toLowerCase();

                    if (!sendersMap[senderEmail]) {
                        sendersMap[senderEmail] = { name: rawName, email: senderEmail, count: 0 };
                    }
                    sendersMap[senderEmail].count++;
                }
            }
        }
        await client.logout();
        res.json(Object.values(sendersMap).sort((a, b) => b.count - a.count));
    } catch (err) {
        res.status(500).json([]);
    }
});

app.listen(PORT, () => {
    console.log(`🧼 Universal All-Provider Production Engine online on port: ${PORT}`);
});
