const express = require('express');
const { ImapFlow } = require('imapflow');
const { google } = require('googleapis');
const session = require('express-session');
const axios = require('axios');
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
const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'common';
const AZURE_REDIRECT_URI = process.env.AZURE_REDIRECT_URI || 'https://unsub-app-w0c7.onrender.com/auth/microsoft/callback';

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
        return res.send(errorHtml('No authorization code received.'));
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
        res.send(successHtml(email, sessionId, 'gmail'));
    } catch (error) {
        console.error('OAuth Error:', error);
        res.send(errorHtml(error.message));
    }
});

// ============================================
// MICROSOFT (OUTLOOK / AZURE) OAUTH FLOW
// ============================================

app.get('/auth/microsoft', (req, res) => {
    const microsoftAuthUrl = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/authorize?` +
        `client_id=${AZURE_CLIENT_ID}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(AZURE_REDIRECT_URI)}` +
        `&response_mode=query` +
        `&scope=${encodeURIComponent('openid profile email offline_access Mail.ReadWrite')}`;
    
    res.redirect(microsoftAuthUrl);
});

app.get('/auth/microsoft/callback', async (req, res) => {
    const { code } = req.query;

    if (!code) {
        return res.send(errorHtml('No authorization code received from Microsoft.'));
    }

    try {
        const tokenResponse = await axios.post(`https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`, new URLSearchParams({
            client_id: AZURE_CLIENT_ID,
            client_secret: AZURE_CLIENT_SECRET,
            code: code,
            redirect_uri: AZURE_REDIRECT_URI,
            grant_type: 'authorization_code'
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const accessToken = tokenResponse.data.access_token;
        const refreshToken = tokenResponse.data.refresh_token;

        const userResponse = await axios.get('https://graph.microsoft.com/v1.0/me', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const email = userResponse.data.mail || userResponse.data.userPrincipalName;

        const sessionId = 'sess_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
        activeSessions[sessionId] = {
            provider: 'microsoft',
            email: email,
            tokens: { access_token: accessToken, refresh_token: refreshToken },
            createdAt: Date.now()
        };

        console.log(`✅ New Microsoft connection: ${email} (Session: ${sessionId})`);
        res.send(successHtml(email, sessionId, 'microsoft'));
    } catch (error) {
        console.error('Microsoft OAuth Error:', error.response?.data || error.message);
        res.send(errorHtml('Microsoft Authentication failed: ' + (error.response?.data?.error_description || error.message)));
    }
});

// ============================================
// HTML TEMPLATES FOR OAUTH REDIRECTS
// ============================================

function successHtml(email, sessionId, provider) {
    return `
        <html>
            <head>
                <style>
                    body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
                    .success-card { text-align: center; background: white; padding: 40px; border-radius: 20px; box-shadow: 0 10px 40px rgba(0,0,0,0.2); max-width: 400px; }
                    h2 { color: #1e293b; margin-bottom: 10px; }
                    p { color: #64748b; margin-bottom: 20px; }
                </style>
            </head>
            <body>
                <div class="success-card">
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
                            provider: '${provider}'
                        }, '*');
                        setTimeout(() => window.close(), 2000);
                    } else {
                        window.location.href = '/?session=${sessionId}';
                    }
                </script>
            </body>
        </html>
    `;
}

function errorHtml(message) {
    return `
        <html>
            <body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f4f7f6;">
                <div style="text-align: center; background: white; padding: 40px; border-radius: 20px; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
                    <h2 style="color: #ef4444; margin-bottom: 10px;">❌ Connection Failed</h2>
                    <p style="color: #64748b; margin-bottom: 20px;">${message}</p>
                </div>
            </body>
        </html>
    `;
}

// ============================================
// FETCH PROMOTIONAL EMAILS FROM USER'S INBOX
// ============================================

app.post('/api/connect', async (req, res) => {
    const { sessionId } = req.body;
    
    if (!sessionId || !activeSessions[sessionId]) {
        return res.status(401).json({ success: false, message: 'Not authenticated.' });
    }

    const sessionData = activeSessions[sessionId];

    try {
        if (sessionData.provider === 'gmail') {
            oauth2Client.setCredentials(sessionData.tokens);
            const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

            const response = await gmail.users.messages.list({
                userId: 'me',
                q: 'category:promotions',
                maxResults: 50
            });

            if (!response.data.messages || response.data.messages.length === 0) {
                return res.json({ success: true, session: sessionId, messages: [], email: sessionData.email });
            }

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
                        
                        const emailMatch = from.match(/<(.+?)>/);
                        const senderEmail = emailMatch ? emailMatch[1] : from;
                        const senderName = from.split('<')[0].trim().replace(/"/g, '') || senderEmail;

                        return { id: msg.id, name: senderName, email: senderEmail, subject: subject, category: 'Promotions' };
                    } catch (err) {
                        return null;
                    }
                })
            );

            res.json({ success: true, session: sessionId, messages: messages.filter(m => m !== null), email: sessionData.email });
        } else if (sessionData.provider === 'microsoft') {
            const response = await axios.get('https://graph.microsoft.com/v1.0/me/messages?$filter=categories/any(c:c eq \'Promotions\') or contains(subject, \'sale\')&$top=50', {
                headers: { Authorization: `Bearer ${sessionData.tokens.access_token}` }
            });

            const messages = response.data.value.map(msg => ({
                id: msg.id,
                name: msg.sender?.emailAddress?.name || 'Unknown',
                email: msg.sender?.emailAddress?.address || '',
                subject: msg.subject || 'No Subject',
                category: 'Promotions'
            }));

            res.json({ success: true, session: sessionId, messages, email: sessionData.email });
        } else {
            res.status(400).json({ success: false, message: 'Provider not supported.' });
        }
    } catch (error) {
        console.error('Fetch Error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch emails: ' + error.message });
    }
});

// ============================================
// HEALTH CHECK & START SERVER
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

app.listen(PORT, () => {
    console.log(`🚀 Unsub Backend Running on port ${PORT}`);
    console.log(`🌐 https://unsub-app-w0c7.onrender.com`);
});