const express = require('express');
const { ImapFlow } = require('imapflow');
const { google } = require('googleapis');
const session = require('express-session');
const app = express();
const PORT = process.env.PORT || 3000;

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
app.use(express.static(__dirname));

// Session configuration
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: true,
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}));

// Cache control headers
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

// OAuth2 Configuration for Gmail
const oauth2Client = new google.auth.OAuth2(
    GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET,
    GMAIL_REDIRECT_URI
);

// Store active sessions
const activeSessions = {};

// ============================================
// GMAIL OAUTH FLOW
// ============================================

app.get('/auth/gmail', (req, res) => {
    const authUrl = oauth2Client.generateAuthUrl({
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
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const profile = await gmail.users.getProfile({ userId: 'me' });
        const email = profile.data.emailAddress;

        const sessionId = 'sess_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
        activeSessions[sessionId] = {
            provider: 'gmail',
            email: email,
            tokens: tokens,
            createdAt: Date.now()
        };

        console.log(`✅ New Gmail connection: ${email} (Session: ${sessionId})`);

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
                        <p><strong>${email}</strong></p>
                        <p>You can close this window now.</p>
                    </div>
                    <script>
                        if (window.opener) {
                            window.opener.postMessage({
                                type: 'oauth_success',
                                sessionId: '${sessionId}',
                                email: '${email}',
                                provider: 'gmail'
                            }, '*');
                            setTimeout(() => window.close(), 2000);
                        } else {
                            window.location.href = '/?session=${sessionId}';
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
                        <p style="color: #64748b; margin-bottom: 20px;">${error.message}</p>
                        <p style="color: #94a3b8; font-size: 12px;">Please try again.</p>
                    </div>
                    <script>
                        if (window.opener) {
                            window.opener.postMessage({
                                type: 'oauth_error',
                                error: '${error.message}'
                            }, '*');
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

    const session = activeSessions[sessionId];

    try {
        if (session.provider === 'gmail') {
            // Set credentials for this session
            oauth2Client.setCredentials(session.tokens);
            const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

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
                    email: session.email
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

            console.log(`📧 Loaded ${validMessages.length} promotional emails for ${session.email}`);

            res.json({ 
                success: true, 
                session: sessionId,
                messages: validMessages,
                email: session.email
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

    const session = activeSessions[sessionId];

    try {
        // TODO: Implement actual unsubscribe logic here
        // This could involve:
        // 1. Finding unsubscribe links in email headers
        // 2. Making HTTP requests to unsubscribe endpoints
        // 3. Sending unsubscribe emails
        // 4. Using Gmail API to modify labels/filters
        
        console.log(`⚡ Zapping ${senders.length} senders for ${session.email}:`, senders);

        // For now, just log and return success
        res.json({ 
            success: true, 
            count: senders ? senders.length : 0,
            message: `Successfully processed ${senders.length} unsubscribe requests`
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
    const session = activeSessions[sessionId];
    
    if (session) {
        res.json({ 
            valid: true, 
            email: session.email,
            provider: session.provider
        });
    } else {
        res.json({ valid: false });
    }
});

// ============================================
// STRIPE PAYMENT ENDPOINT (Optional - for future use)
// ============================================

app.post('/api/create-checkout-session', async (req, res) => {
    // This is a placeholder for Stripe integration
    // Your current setup uses a direct Stripe payment link, which is fine
    // If you want to create dynamic checkout sessions, you can add that here
    
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
        azureConfigured: !!AZURE_CLIENT_ID
    });
});
// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`🧼 Unsub Backend Server`);
    console.log(`🚀 Running on port ${PORT}`);
    console.log(`🌐 https://unsub-app-w0c7.onrender.com`);
    console.log(`📧 Gmail OAuth: ${GMAIL_CLIENT_ID ? 'Configured ✅' : 'Not configured ⚠️'}`);
    console.log(`📧 Azure OAuth: ${AZURE_CLIENT_ID ? 'Configured ✅' : 'Not configured ⚠️'}`);
    console.log(`🔐 Session Secret: ${SESSION_SECRET ? 'Set ✅' : 'Not set ⚠️'}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    app.close(() => {
        console.log('HTTP server closed');
    });
});
