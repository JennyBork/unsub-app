const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');
const session = require('express-session');
const app = express();
const PORT = process.env.PORT || 3000;

// Render sits behind a proxy. This line is REQUIRED for secure cookies to work there.
app.set('trust proxy', 1);

// ============================================
// ENVIRONMENT VARIABLES (Read from Render Dashboard)
// ============================================
const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REDIRECT_URI = process.env.GMAIL_REDIRECT_URI || 'https://unsub-app-w0c7.onrender.com/auth/google/callback';

const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID;
const AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID;

const SESSION_SECRET = process.env.SESSION_SECRET || 'unsub-secret-key-change-this-in-production';

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// SECURITY: never let the public download your server code or package files
app.use((req, res, next) => {
    let p = req.path;
    try { p = decodeURIComponent(req.path); } catch (e) { /* ignore */ }
    if (/^\/(server\.js|package(-lock)?\.json|node_modules|\.git|\.env)/i.test(p)) {
        return res.status(404).send('Not found');
    }
    next();
});
app.use(express.static(__dirname));

// Session configuration
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: true,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}));

// Cache control headers
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

// ============================================
// HELPERS
// ============================================

// A NEW Google client for every request, so one customer's login can never
// overwrite another customer's login.
function makeOAuthClient() {
    return new google.auth.OAuth2(
        GMAIL_CLIENT_ID,
        GMAIL_CLIENT_SECRET,
        GMAIL_REDIRECT_URI
    );
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Safely place a value inside a <script> block
function jsValue(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

// Store active sessions
const activeSessions = {};

// Remove sessions older than 7 days (once an hour)
setInterval(() => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const id of Object.keys(activeSessions)) {
        if (activeSessions[id].createdAt < cutoff) delete activeSessions[id];
    }
}, 60 * 60 * 1000);

// ============================================
// GMAIL OAUTH FLOW
// ============================================

app.get('/auth/gmail', (req, res) => {
    const client = makeOAuthClient();
    const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/gmail.modify'
        ],
        prompt: 'consent'
    });
    res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
    const { code } = req.query;

    if (!code) {
        return res.send(`
            <html>
                <body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f4f7f6;">
                    <div style="text-align: center; background: white; padding: 40px; border-radius: 20px; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
                        <h2 style="color: #ef4444; margin-bottom: 10px;">❌ Authentication Failed</h2>
                        <p style="color: #64748b;">No authorization code received.</p>
                        <script>
                            setTimeout(() => window.close(), 3000);
                        </script>
                    </div>
                </body>
            </html>
        `);
    }

    try {
        const client = makeOAuthClient();
        const { tokens } = await client.getToken(code);
        client.setCredentials(tokens);

        const gmail = google.gmail({ version: 'v1', auth: client });
        const profile = await gmail.users.getProfile({ userId: 'me' });
        const email = profile.data.emailAddress;

        const sessionId = 'sess_' + crypto.randomBytes(24).toString('hex');
        activeSessions[sessionId] = {
            provider: 'gmail',
            email: email,
            tokens: tokens,
            createdAt: Date.now()
        };

        console.log(`✅ New Gmail connection: ${email}`);

        res.send(`
            <html>
                <head>
                    <style>
                        body {
                            font-family: system-ui, -apple-system, sans-serif;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            height: 100vh;
                            margin: 0;
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        }
                        .success-card {
                            text-align: center;
                            background: white;
                            padding: 40px;
                            border-radius: 20px;
                            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                            max-width: 400px;
                        }
                        .checkmark {
                            width: 80px;
                            height: 80px;
                            border-radius: 50%;
                            display: block;
                            stroke-width: 2;
                            stroke: #10b981;
                            stroke-miterlimit: 10;
                            margin: 0 auto 20px;
                            animation: fill 0.4s ease-in-out 0.4s forwards, scale 0.3s ease-in-out 0.9s both;
                        }
                        .checkmark-circle {
                            stroke-dasharray: 166;
                            stroke-dashoffset: 166;
                            stroke-width: 2;
                            stroke-miterlimit: 10;
                            stroke: #10b981;
                            fill: none;
                            animation: stroke 0.6s cubic-bezier(0.65, 0, 0.45, 1) forwards;
                        }
                        .checkmark-check {
                            transform-origin: 50% 50%;
                            stroke-dasharray: 48;
                            stroke-dashoffset: 48;
                            animation: stroke 0.3s cubic-bezier(0.65, 0, 0.45, 1) 0.8s forwards;
                        }
                        @keyframes stroke {
                            100% { stroke-dashoffset: 0; }
                        }
                        @keyframes scale {
                            0%, 100% { transform: none; }
                            50% { transform: scale3d(1.1, 1.1, 1); }
                        }
                        @keyframes fill {
                            100% { box-shadow: inset 0px 0px 0px 30px #10b981; }
                        }
                        h2 { color: #1e293b; margin-bottom: 10px; }
                        p { color: #64748b; margin-bottom: 20px; }
                    </style>
                </head>
                <body>
                    <div class="success-card">
                        <svg class="checkmark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52">
                            <circle class="checkmark-circle" cx="26" cy="26" r="25" fill="none"/>
                            <path class="checkmark-check" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8"/>
                        </svg>
                        <h2>✅ Connected Successfully!</h2>
                        <p><strong>${escapeHtml(email)}</strong></p>
                        <p>You can close this window now.</p>
                    </div>
                    <script>
                        if (window.opener) {
                            window.opener.postMessage({
                                type: 'oauth_success',
                                sessionId: ${jsValue(sessionId)},
                                email: ${jsValue(email)},
                                provider: 'gmail'
                            }, window.location.origin);
                            setTimeout(() => window.close(), 2000);
                        } else {
                            window.location.href = '/?session=' + encodeURIComponent(${jsValue(sessionId)});
                        }
                    </script>
                </body>
            </html>
        `);
    } catch (error) {
        console.error('OAuth Error:', error);
        res.send(`
            <html>
                <body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f4f7f6;">
                    <div style="text-align: center; background: white; padding: 40px; border-radius: 20px; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
                        <h2 style="color: #ef4444; margin-bottom: 10px;">❌ Connection Failed</h2>
                        <p style="color: #64748b; margin-bottom: 20px;">${escapeHtml(error.message)}</p>
                        <p style="color: #94a3b8; font-size: 12px;">Please try again.</p>
                    </div>
                    <script>
                        if (window.opener) {
                            window.opener.postMessage({
                                type: 'oauth_error',
                                error: ${jsValue(error.message)}
                            }, window.location.origin);
                            setTimeout(() => window.close(), 3000);
                        }
                    </script>
                </body>
            </html>
        `);
    }
});

// ============================================
// FETCH PROMOTIONAL EMAILS FROM USER'S INBOX
// ============================================

app.post('/api/connect', async (req, res) => {
    const { sessionId } = req.body;

    if (!sessionId || !activeSessions[sessionId]) {
        return res.status(401).json({
            success: false,
            message: 'Not authenticated. Please connect your email first.'
        });
    }

    const userSession = activeSessions[sessionId];

    try {
        if (userSession.provider === 'gmail') {
            // Each user gets their OWN client with THEIR OWN tokens
            const client = makeOAuthClient();
            client.setCredentials(userSession.tokens);
            const gmail = google.gmail({ version: 'v1', auth: client });

            // Search for promotional emails
            const response = await gmail.users.messages.list({
                userId: 'me',
                q: 'category:promotions',
                maxResults: 50
            });

            if (!response.data.messages || response.data.messages.length === 0) {
                return res.json({
                    success: true,
                    session: sessionId,
                    messages: [],
                    email: userSession.email
                });
            }

            // Fetch details for each message
            const messages = await Promise.all(
                response.data.messages.map(async (msg) => {
                    try {
                        const details = await gmail.users.messages.get({
                            userId: 'me',
                            id: msg.id,
                            format: 'metadata',
                            metadataHeaders: ['From', 'Subject']
                        });

                        const from = details.data.payload.headers.find(h => h.name === 'From')?.value || '';
                        const subject = details.data.payload.headers.find(h => h.name === 'Subject')?.value || 'No Subject';

                        // Parse "Name <email@domain.com>" format
                        const emailMatch = from.match(/<(.+?)>/);
                        const senderEmail = emailMatch ? emailMatch[1] : from;
                        const senderName = from.split('<')[0].trim().replace(/"/g, '') || senderEmail;

                        return {
                            id: msg.id,
                            name: senderName,
                            email: senderEmail,
                            subject: subject,
                            category: 'Promotions'
                        };
                    } catch (err) {
                        console.error('Error fetching message details:', err);
                        return null;
                    }
                })
            );

            // Filter out any null results
            const validMessages = messages.filter(m => m !== null);

            console.log(`📧 Loaded ${validMessages.length} promotional emails for ${userSession.email}`);

            res.json({
                success: true,
                session: sessionId,
                messages: validMessages,
                email: userSession.email
            });
        } else {
            res.status(400).json({
                success: false,
                message: 'Provider not supported yet. Currently only Gmail is available.'
            });
        }
    } catch (error) {
        console.error('Fetch Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch emails: ' + error.message
        });
    }
});

// ============================================
// UNSUBSCRIBE/ZAP SENDERS
// ============================================

app.post('/api/zap', async (req, res) => {
    const { senders } = req.body;
    const sessionId = req.headers['x-user-session'];

    if (!sessionId || !activeSessions[sessionId]) {
        return res.status(401).json({
            success: false,
            message: 'Not authenticated'
        });
    }

    const userSession = activeSessions[sessionId];

    try {
        if (userSession.provider !== 'gmail') {
            return res.status(400).json({
                success: false,
                message: 'Provider not supported yet. Currently only Gmail is available.'
            });
        }

        if (!Array.isArray(senders) || senders.length === 0 || senders.length > 200) {
            return res.status(400).json({
                success: false,
                message: 'Please select between 1 and 200 senders.'
            });
        }

        const client = makeOAuthClient();
        client.setCredentials(userSession.tokens);
        const gmail = google.gmail({ version: 'v1', auth: client });

        let trashed = 0;
        let sendersProcessed = 0;

        for (const sender of senders) {
            // Only accept plain email addresses (blocks search-operator tricks)
            if (typeof sender !== 'string' || !/^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+$/.test(sender)) continue;

            // Find EVERY promotional email from this sender (not just the ones shown on screen)
            const ids = [];
            let pageToken;
            do {
                const page = await gmail.users.messages.list({
                    userId: 'me',
                    q: `from:${sender} category:promotions`,
                    maxResults: 500,
                    pageToken: pageToken
                });
                (page.data.messages || []).forEach(m => ids.push(m.id));
                pageToken = page.data.nextPageToken;
            } while (pageToken && ids.length < 5000);

            // Move them to Trash (recoverable for 30 days), 1000 at a time
            for (let i = 0; i < ids.length; i += 1000) {
                await gmail.users.messages.batchModify({
                    userId: 'me',
                    requestBody: {
                        ids: ids.slice(i, i + 1000),
                        addLabelIds: ['TRASH'],
                        removeLabelIds: ['INBOX']
                    }
                });
            }

            trashed += ids.length;
            sendersProcessed++;
        }

        console.log(`⚡ Zapped ${sendersProcessed} senders (${trashed} emails moved to Trash) for ${userSession.email}`);

        res.json({
            success: true,
            count: sendersProcessed,
            trashed: trashed,
            message: `Moved ${trashed} emails from ${sendersProcessed} senders to Trash`
        });
    } catch (error) {
        console.error('Zap Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to process unsubscribe requests'
        });
    }
});

// ============================================
// SESSION VALIDATION
// ============================================

app.get('/api/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const found = activeSessions[sessionId];

    if (found) {
        res.json({
            valid: true,
            email: found.email,
            provider: found.provider
        });
    } else {
        res.json({ valid: false });
    }
});

// ============================================
// STRIPE PAYMENT ENDPOINT (Optional - for future use)
// ============================================

app.post('/api/create-checkout-session', async (req, res) => {
    // Your current setup uses a direct Stripe payment link, which is fine
    res.json({
        message: 'Using direct Stripe payment link',
        url: 'https://buy.stripe.com/00waEQeX27xscBscVTfAc04'
    });
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        activeSessions: Object.keys(activeSessions).length,
        gmailConfigured: !!GMAIL_CLIENT_ID,
        gmailSecretConfigured: !!GMAIL_CLIENT_SECRET,
        azureConfigured: !!AZURE_CLIENT_ID
    });
});

// ============================================
// START SERVER
// ============================================

const server = app.listen(PORT, () => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`🧼 Unsub Backend Server`);
    console.log(`🚀 Running on port ${PORT}`);
    console.log(`🌐 https://unsub-app-w0c7.onrender.com`);
    console.log(`📧 Gmail OAuth: ${GMAIL_CLIENT_ID && GMAIL_CLIENT_SECRET ? 'Configured ✅' : 'Not configured ⚠️'}`);
    console.log(`📧 Azure OAuth: ${AZURE_CLIENT_ID ? 'Configured ✅' : 'Not configured ⚠️'}`);
    console.log(`🔐 Session Secret: ${process.env.SESSION_SECRET ? 'Set ✅' : 'Using default ⚠️ (set SESSION_SECRET on Render)'}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
    });
});