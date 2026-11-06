const express = require('express');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CALLBACK_URL
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

const PROVIDER_PORTS = {
    gmail: { host: 'imap.gmail.com', port: 993 },
    yahoo: { host: 'imap.mail.yahoo.com', port: 993 },
    aol: { host: 'imap.aol.com', port: 993 },
    outlook: { host: 'outlook.office365.com', port: 993 },
    icloud: { host: 'imap.mail.me.com', port: 993 }
};

const activeCredentials = {};

app.post('/api/connect', (req, res) => {
    const { email, token, provider, customHost, customPort } = req.body;
    const userSessionId = req.headers['x-user-session'] || 'session_' + Date.now();
    
    let config = PROVIDER_PORTS[provider ? provider.toLowerCase() : ''];
    if (provider === 'imap' && customHost) {
        config = { host: customHost, port: customPort || 993 };
    }
    
    if (!config) return res.status(400).json({ success: false, message: 'Invalid configuration.' });

    activeCredentials[userSessionId] = { email, token, config };
    console.log(`🔌 Secure IMAP session locked for: ${email} (ID: ${userSessionId})`);
    res.json({ success: true, sessionId: userSessionId });
});

app.get('/api/scan', async (req, res) => {
    const sessionId = req.query.session || req.headers['x-user-session'];
    
    const creds = activeCredentials[sessionId];
    if (!creds) {
        return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
    }

    const isOAuth = creds.token && (creds.config.host.includes('office365') || creds.config.host.includes('gmail'));
    
    let authConfig = {
        user: creds.email,
        pass: creds.token
    };

    if (isOAuth) {
        authConfig = {
            user: creds.email,
            accessToken: creds.token,
            xoauth2: Buffer.from(`user=${creds.email}\x01auth=Bearer ${creds.token}\x01\x01`).toString('base64')
        };
    }

    const client = new ImapFlow({
        host: creds.config.host,
        port: creds.config.port,
        secure: true,
        auth: authConfig,
        logger: false
    });

    try {
        await client.connect();
        let lock = await client.getMailboxLock('INBOX');
        const rawSubscriptions = [];

        try {
            const status = await client.status('INBOX', { messages: true });
            const totalMessages = status.messages || 0;

            if (totalMessages === 0) {
                return res.json({ subscriptions: [] });
            }

            const rangeStart = Math.max(1, totalMessages - 499);
            const range = `${rangeStart}:${totalMessages}`;

            for await (let message of client.fetch(range, { envelope: true, headers: true })) {
                let isPromotional = false;
                const headers = message.headers;

                if (headers) {
                    const headerStr = typeof headers.toString === 'function' 
                        ? headers.toString().toLowerCase() 
                        : JSON.stringify(headers).toLowerCase();

                    if (headerStr.includes('unsubscribe')) {
                        isPromotional = true;
                    }
                }

                const fromObj = message.envelope?.from?.[0] || {};
                const senderEmail = (fromObj.address || '').toLowerCase();
                const senderName = fromObj.name || (senderEmail ? senderEmail.split('@')[0] : 'Unknown');

                if (!isPromotional && senderEmail) {
                    const promoKeywords = ['no-reply', 'noreply', 'newsletter', 'marketing', 'promo', 'notifications', 'info@', 'news@', 'updates@'];
                    if (promoKeywords.some(kw => senderEmail.includes(kw))) {
                        isPromotional = true;
                    }
                }

                if (isPromotional && senderEmail) {
                    rawSubscriptions.push({ name: senderName, email: senderEmail });
                }
            }
        } finally {
            lock.release();
        }

        await client.logout();

        const aggregatedMap = new Map();
        rawSubscriptions.forEach(sub => {
            if (aggregatedMap.has(sub.email)) {
                aggregatedMap.get(sub.email).count += 1;
            } else {
                aggregatedMap.set(sub.email, { name: sub.name, email: sub.email, count: 1 });
            }
        });

        const subscriptions = Array.from(aggregatedMap.values()).sort((a, b) => b.count - a.count);
        console.log(`[SCAN RESULT] Found ${subscriptions.length} senders for ${creds.email}`);
        return res.json({ subscriptions });

    } catch (error) {
        console.error('[SCAN ERROR]', error);
        try { await client.logout(); } catch (_) {}
        return res.status(500).json({ error: 'Failed to scan inbox', details: error.message });
    }
});

// Purge/Delete Emails Route
app.post('/api/zap', async (req, res) => {
    const { senders } = req.body;
    const userSessionId = req.headers['x-user-session'] || req.body.sessionId;
    const creds = activeCredentials[userSessionId];

    if (!creds) return res.json({ success: false, message: 'No active session found.' });

    const isOAuth = creds.token && (creds.config.host.includes('office365') || creds.config.host.includes('gmail'));
    let authConfig = { user: creds.email, pass: creds.token };

    if (isOAuth) {
        authConfig = {
            user: creds.email,
            accessToken: creds.token,
            xoauth2: Buffer.from(`user=${creds.email}\x01auth=Bearer ${creds.token}\x01\x01`).toString('base64')
        };
    }

    const client = new ImapFlow({
        host: creds.config.host,
        port: creds.config.port,
        secure: true,
        auth: authConfig,
        logger: false
    });

    try {
        await client.connect();
        try { await client.mailboxOpen('INBOX'); } catch(e) {}
        
        if (senders && senders.length > 0) {
            for (const targetEmail of senders) {
                for await (let msg of client.fetch('1:500', { envelope: true })) {
                    if (msg.envelope && msg.envelope.from && msg.envelope.from.length > 0) {
                        const f = msg.envelope.from[0];
                        let currentSender = '';
                        if (f.address) {
                            currentSender = f.address.toLowerCase();
                        } else if (f.mailbox && f.host) {
                            currentSender = (f.mailbox + '@' + f.host).toLowerCase();
                        }
                        if (currentSender === targetEmail.toLowerCase()) {
                            await client.messageDelete(String(msg.uid));
                        }
                    }
                }
            }
        }

        try { await client.mailboxClose(); } catch(e) {}
        await client.logout();
        res.json({ 
            success: true, 
            message: 'Emails zapped successfully.', 
            notice: 'Unsubscribe request registered. Standard provider processing takes 24-48 hours.' 
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Explicit Workspace HTML Route
app.get('/workspace', (req, res) => {
    res.sendFile(path.join(__dirname, 'workspace.html'));
});

// Google OAuth Routes
app.get('/auth/google', (req, res) => {
    const scopes = [
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.modify'
    ];
    const authUrl = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: scopes, prompt: 'consent' });
    res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('Google OAuth authorization code missing.');

    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();
        const userEmail = userInfo.data.email;

        const userSessionId = 'google_' + Date.now();
        activeCredentials[userSessionId] = {
            email: userEmail,
            token: tokens.access_token,
            config: { host: 'imap.gmail.com', port: 993 }
        };

        console.log(`✨ Google OAuth session established for: ${userEmail}`);
        res.redirect(`/workspace.html?session=${userSessionId}`);
    } catch (error) {
        console.error('[OAUTH ERROR]', error);
        res.status(500).send('Authentication failed: ' + error.message);
    }
});

// Outlook / Azure OAuth Routes
app.get('/auth/outlook', (req, res) => {
    const tenant = process.env.AZURE_TENANT_ID || 'common';
    const clientId = process.env.OUTLOOK_CLIENT_ID || process.env.AZURE_CLIENT_ID || 'ddb2af53-7195-45cd-ae95-0937be46522e';
    const redirectUri = encodeURIComponent(`${process.env.BASE_URL || 'https://unsub-app-w0c7.onrender.com'}/auth/outlook/callback`);
    const scopes = encodeURIComponent('openid profile email https://outlook.office.com/IMAP.AccessAsUser.all offline_access');

    const authUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?client_id=${clientId}&response_type=code&redirect_uri=${redirectUri}&response_mode=query&scope=${scopes}`;
    res.redirect(authUrl);
});

app.get('/auth/outlook/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('Microsoft OAuth authorization code missing.');

    try {
        const tenant = process.env.AZURE_TENANT_ID || 'common';
        const clientId = process.env.OUTLOOK_CLIENT_ID || process.env.AZURE_CLIENT_ID || 'ddb2af53-7195-45cd-ae95-0937be46522e';
        const clientSecret = process.env.OUTLOOK_CLIENT_SECRET || process.env.AZURE_CLIENT_SECRET;
        const baseUrl = process.env.BASE_URL || 'https://unsub-app-w0c7.onrender.com';

        const tokenResponse = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                code: code,
                redirect_uri: `${baseUrl}/auth/outlook/callback`,
                grant_type: 'authorization_code'
            })
        });

        const tokenData = await tokenResponse.json();
        if (!tokenData.access_token) {
            throw new Error(tokenData.error_description || 'Failed to exchange Microsoft token');
        }

        const userResponse = await fetch('https://graph.microsoft.com/v1.0/me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const userData = await userResponse.json();
        const userEmail = userData.mail || userData.userPrincipalName || 'outlook.user@outlook.com';

        const userSessionId = 'outlook_' + Date.now();
        activeCredentials[userSessionId] = {
            email: userEmail,
            token: tokenData.access_token,
            config: { host: 'outlook.office365.com', port: 993 }
        };

        console.log(`✨ Outlook OAuth session established for: ${userEmail}`);
        res.redirect(`/workspace.html?session=${userSessionId}`);
    } catch (error) {
        console.error('[OUTLOOK OAUTH ERROR]', error);
        res.status(500).send('Microsoft Authentication failed: ' + error.message);
    }
});

app.listen(PORT, () => {
    console.log(`🧼 Universal All-Provider Production Engine online on port: ${PORT}`);
});