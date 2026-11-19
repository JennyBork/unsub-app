const express = require('express');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const path = require('path');
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

// STRIPE (set these on Render → Environment)
// STRIPE_SECRET_KEY  = your sk_live_... key (REQUIRED – without it nobody gets in)
// STRIPE_PRICE_ID    = price_... for the $1.99/month plan (optional – if blank,
//                      the server finds it from your payment link below)
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID;
const STRIPE_PAYMENT_LINK = 'https://buy.stripe.com/00waEQeX27xscBscVTfAc04';

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
// HOMEPAGE: appunsub.com (and www.) show the marketing homepage; app.appunsub.com shows the app
app.get(['/', '/index.html'], (req, res, next) => {
    const host = (req.hostname || '').toLowerCase();
    if (host === 'appunsub.com' || host === 'www.appunsub.com') {
        return res.sendFile(path.join(__dirname, 'home.html'));
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

// Which emails the app works on: Promotions + Updates tabs, only with an unsubscribe link.
// Used for BOTH the scan and the zap, so zapping never touches a sender's receipts etc.
const MAILING_LIST_QUERY = '{category:promotions category:updates} unsubscribe';
const MAX_SCAN = 500; // how many recent emails to scan

// Store active sessions
const activeSessions = {};

// ============================================
// STRIPE HELPERS (uses Stripe's web API directly – no extra package needed)
// ============================================

async function stripeRequest(method, path, params) {
    if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set on the server');
    const query = new URLSearchParams(params || {}).toString();
    const isGet = method === 'GET';
    const res = await fetch('https://api.stripe.com/v1' + path + (isGet && query ? '?' + query : ''), {
        method,
        headers: {
            Authorization: 'Bearer ' + STRIPE_SECRET_KEY,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: isGet ? undefined : query
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data.error && data.error.message) || 'Stripe request failed');
    return data;
}

// Find the $1.99 price: from STRIPE_PRICE_ID, or by looking up the payment link
let cachedPriceId = STRIPE_PRICE_ID || null;
async function getPriceId() {
    if (cachedPriceId) return cachedPriceId;
    let startingAfter;
    for (let page = 0; page < 5; page++) {
        const params = { limit: 100 };
        if (startingAfter) params.starting_after = startingAfter;
        const links = await stripeRequest('GET', '/payment_links', params);
        const match = links.data.find(l => l.url === STRIPE_PAYMENT_LINK);
        if (match) {
            const items = await stripeRequest('GET', `/payment_links/${match.id}/line_items`, { limit: 1 });
            cachedPriceId = items.data[0].price.id;
            console.log(`💳 Using Stripe price ${cachedPriceId} (from payment link)`);
            return cachedPriceId;
        }
        if (!links.has_more || links.data.length === 0) break;
        startingAfter = links.data[links.data.length - 1].id;
    }
    throw new Error('Could not find the Stripe price. Set STRIPE_PRICE_ID on Render.');
}

// Does this email address have an active subscription in Stripe?
async function findSubscription(email) {
    const variants = [...new Set([email, email.toLowerCase()])];
    let anyCustomerId = null;
    for (const address of variants) {
        const customers = await stripeRequest('GET', '/customers', { email: address, limit: 10 });
        for (const customer of customers.data) {
            anyCustomerId = anyCustomerId || customer.id;
            const subs = await stripeRequest('GET', '/subscriptions', { customer: customer.id, status: 'all', limit: 10 });
            if (subs.data.some(s => s.status === 'active' || s.status === 'trialing')) {
                return { paid: true, customerId: customer.id };
            }
        }
    }
    return { paid: false, customerId: anyCustomerId };
}

// Checks payment for a session. A "paid" answer is remembered for 10 minutes;
// an "unpaid" answer is re-checked every time, so access opens right after paying.
async function isPaid(userSession) {
    if (userSession.paid && Date.now() - userSession.paidCheckedAt < 10 * 60 * 1000) return true;
    const result = await findSubscription(userSession.email);
    userSession.paid = result.paid;
    userSession.paidCheckedAt = Date.now();
    userSession.stripeCustomerId = result.customerId;
    return result.paid;
}

// Sends the right "you must pay" or "couldn't check" reply. Returns true if the user may continue.
async function requirePaid(userSession, res) {
    try {
        if (await isPaid(userSession)) return true;
        res.status(402).json({
            success: false,
            needsPayment: true,
            email: userSession.email,
            message: 'An active Unsub subscription is required.'
        });
    } catch (err) {
        // Fail CLOSED: if we can't confirm payment, we don't give access
        console.error('Payment check failed:', err.message);
        res.status(503).json({
            success: false,
            message: 'We could not verify your subscription right now. Please try again in a minute.'
        });
    }
    return false;
}

function siteUrl(req) {
    return `${req.protocol}://${req.get('host')}`;
}

// Remove sessions older than 7 days (once an hour)
setInterval(() => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const id of Object.keys(activeSessions)) {
        if (activeSessions[id].createdAt < cutoff) delete activeSessions[id];
    }
}, 60 * 60 * 1000);

// ============================================
// ONE-CLICK UNSUBSCRIBE (the standard Gmail's own Unsubscribe button uses)
// ============================================

// Pull the https link out of a List-Unsubscribe header, e.g.
// "<mailto:u@x.com>, <https://x.com/unsub?id=1>"  ->  "https://x.com/unsub?id=1"
function getUnsubscribeUrl(listUnsubscribeHeader) {
    const parts = String(listUnsubscribeHeader || '').match(/<[^>]+>/g) || [];
    for (const part of parts) {
        const url = part.slice(1, -1).trim();
        if (/^https:\/\//i.test(url)) return url;
    }
    return null;
}

// True when the email supports one-click unsubscribe
function supportsOneClick(headers) {
    const get = (name) => (headers.find(h => h.name.toLowerCase() === name.toLowerCase()) || {}).value || '';
    return !!getUnsubscribeUrl(get('List-Unsubscribe')) &&
        /List-Unsubscribe\s*=\s*One-Click/i.test(get('List-Unsubscribe-Post'));
}

// SAFETY: never let an email's link make our server contact private/internal addresses
function isPrivateAddress(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
            (a === 100 && b >= 64 && b <= 127) || a >= 224;
    }
    const v6 = ip.toLowerCase();
    if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
    return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

async function isSafePublicUrl(rawUrl) {
    let url;
    try { url = new URL(rawUrl); } catch (e) { return false; }
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (net.isIP(host)) return !isPrivateAddress(host);
    try {
        const addresses = await dns.lookup(host, { all: true });
        return addresses.length > 0 && addresses.every(a => !isPrivateAddress(a.address));
    } catch (e) {
        return false;
    }
}

// Look at a sender's newest emails for a one-click link and use it.
// Returns { supported, unsubscribed }
async function unsubscribeFromSender(gmail, messageIds) {
    for (const id of messageIds.slice(0, 5)) {
        let headers;
        try {
            const msg = await gmail.users.messages.get({
                userId: 'me', id, format: 'metadata',
                metadataHeaders: ['List-Unsubscribe', 'List-Unsubscribe-Post']
            });
            headers = msg.data.payload.headers || [];
        } catch (e) {
            continue;
        }
        if (!supportsOneClick(headers)) continue;

        const url = getUnsubscribeUrl(headers.find(h => h.name.toLowerCase() === 'list-unsubscribe').value);
        if (!(await isSafePublicUrl(url))) return { supported: false, unsubscribed: false };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Unsub/1.0 (+https://appunsub.com)' },
                body: 'List-Unsubscribe=One-Click',
                redirect: 'manual',              // don't follow redirects to unknown places
                signal: AbortSignal.timeout(8000)
            });
            return { supported: true, unsubscribed: response.status < 400 };
        } catch (e) {
            console.error('Unsubscribe request failed:', e.message);
            return { supported: true, unsubscribed: false };
        }
    }
    return { supported: false, unsubscribed: false };
}

// ============================================
// GMAIL OAUTH FLOW
// ============================================

app.get('/auth/gmail', (req, res) => {
    const client = makeOAuthClient();
    const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        // gmail.modify alone covers reading sender/subject AND moving to Trash
        // (Google requires the narrowest permission the app needs)
        scope: [
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
                        <p style="color: #64748b; margin-bottom: 20px;">Gmail access wasn't approved.</p>
                        <a href="/" style="display:inline-block; background:#2c3e50; color:#fff; padding:12px 20px; border-radius:10px; text-decoration:none; font-weight:700;">Back to Unsub</a>
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
                        <p>Taking you back to Unsub...</p>
                    </div>
                    <script>
                        // Save the login in the browser so the app remembers it
                        try {
                            localStorage.setItem('unsub_session', ${jsValue(sessionId)});
                            localStorage.setItem('unsub_email', ${jsValue(email)});
                        } catch (e) { /* storage blocked – fall through to redirect */ }

                        // Go straight back to the app, now connected
                        setTimeout(() => {
                            window.location.replace('/?session=' + encodeURIComponent(${jsValue(sessionId)}));
                        }, 1200);
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
                        <a href="/" style="display:inline-block; background:#2c3e50; color:#fff; padding:12px 20px; border-radius:10px; text-decoration:none; font-weight:700;">Back to Unsub</a>
                    </div>
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

    // PAYWALL: no inbox access until Stripe confirms an active subscription
    if (!(await requirePaid(userSession, res))) return;

    try {
        if (userSession.provider === 'gmail') {
            // Each user gets their OWN client with THEIR OWN tokens
            const client = makeOAuthClient();
            client.setCredentials(userSession.tokens);
            const gmail = google.gmail({ version: 'v1', auth: client });

            // Find mailing-list emails: Promotions + Updates tabs, but ONLY ones
            // that contain an unsubscribe link (skips receipts, bank alerts, etc.)
            const ids = [];
            let pageToken;
            do {
                const page = await gmail.users.messages.list({
                    userId: 'me',
                    q: MAILING_LIST_QUERY,
                    maxResults: 500,
                    pageToken: pageToken
                });
                (page.data.messages || []).forEach(m => ids.push(m.id));
                pageToken = page.data.nextPageToken;
            } while (pageToken && ids.length < MAX_SCAN);
            ids.length = Math.min(ids.length, MAX_SCAN);

            if (ids.length === 0) {
                return res.json({
                    success: true,
                    session: sessionId,
                    messages: [],
                    email: userSession.email
                });
            }

            // Fetch sender + subject for each email, 20 at a time (stays under Gmail's speed limits)
            const fetchOne = async (id, retry = true) => {
                try {
                    const details = await gmail.users.messages.get({
                        userId: 'me',
                        id: id,
                        format: 'metadata',
                        metadataHeaders: ['From', 'Subject', 'List-Unsubscribe', 'List-Unsubscribe-Post']
                    });

                    const headers = details.data.payload.headers || [];
                    const from = headers.find(h => h.name === 'From')?.value || '';
                    const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
                    const labels = details.data.labelIds || [];

                    // Parse "Name <email@domain.com>" format
                    const emailMatch = from.match(/<(.+?)>/);
                    const senderEmail = (emailMatch ? emailMatch[1] : from).trim();
                    const senderName = from.split('<')[0].trim().replace(/"/g, '') || senderEmail;

                    return {
                        id: id,
                        name: senderName,
                        email: senderEmail,
                        subject: subject,
                        category: labels.includes('CATEGORY_UPDATES') ? 'Updates' : 'Promotions',
                        oneClick: supportsOneClick(headers)
                    };
                } catch (err) {
                    const code = err.code || (err.response && err.response.status);
                    if (retry && (code === 429 || code === 403)) {
                        await new Promise(r => setTimeout(r, 1500));
                        return fetchOne(id, false);
                    }
                    console.error('Error fetching message details:', err.message);
                    return null;
                }
            };

            const messages = [];
            for (let i = 0; i < ids.length; i += 20) {
                const chunk = await Promise.all(ids.slice(i, i + 20).map(id => fetchOne(id)));
                messages.push(...chunk);
            }

            // Filter out any null results
            const validMessages = messages.filter(m => m !== null);

            console.log(`📧 Loaded ${validMessages.length} mailing-list emails for ${userSession.email}`);

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

    // PAYWALL: no zapping until Stripe confirms an active subscription
    if (!(await requirePaid(userSession, res))) return;

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

        // Zap one sender: unsubscribe (if they support one-click), then move their emails to Trash
        const zapSender = async (sender) => {
            // Find EVERY mailing-list email from this sender (newest first)
            const ids = [];
            let pageToken;
            do {
                const page = await gmail.users.messages.list({
                    userId: 'me',
                    q: `from:${sender} ${MAILING_LIST_QUERY}`,
                    maxResults: 500,
                    pageToken: pageToken
                });
                (page.data.messages || []).forEach(m => ids.push(m.id));
                pageToken = page.data.nextPageToken;
            } while (pageToken && ids.length < 5000);

            const unsub = ids.length ? await unsubscribeFromSender(gmail, ids) : { supported: false, unsubscribed: false };

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

            return { sender, trashed: ids.length, supported: unsub.supported, unsubscribed: unsub.unsubscribed };
        };

        // Only accept plain email addresses (blocks search-operator tricks)
        const validSenders = senders.filter(s => typeof s === 'string' && /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+$/.test(s));

        // 5 senders at a time keeps it quick without tripping Gmail's speed limits
        const results = [];
        for (let i = 0; i < validSenders.length; i += 5) {
            results.push(...await Promise.all(validSenders.slice(i, i + 5).map(zapSender)));
        }

        const trashed = results.reduce((sum, r) => sum + r.trashed, 0);
        const unsubscribed = results.filter(r => r.unsubscribed).length;

        console.log(`⚡ Zapped ${results.length} senders (${unsubscribed} unsubscribed, ${trashed} emails moved to Trash) for ${userSession.email}`);

        res.json({
            success: true,
            count: results.length,
            trashed: trashed,
            unsubscribed: unsubscribed,
            results: results,
            message: `Unsubscribed from ${unsubscribed} of ${results.length} senders and moved ${trashed} emails to Trash`
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
            provider: found.provider,
            paid: !!found.paid
        });
    } else {
        res.json({ valid: false });
    }
});

// ============================================
// STRIPE: START CHECKOUT (subscription tied to the connected Gmail address)
// ============================================

app.post('/api/checkout', async (req, res) => {
    const sessionId = req.headers['x-user-session'];
    const userSession = sessionId && activeSessions[sessionId];
    if (!userSession) {
        return res.status(401).json({ success: false, message: 'Please connect your Gmail first.' });
    }

    try {
        if (await isPaid(userSession)) {
            return res.json({ success: true, alreadyPaid: true });
        }

        const base = siteUrl(req);
        const params = {
            mode: 'subscription',
            'line_items[0][price]': await getPriceId(),
            'line_items[0][quantity]': 1,
            client_reference_id: userSession.email,
            success_url: `${base}/?session=${encodeURIComponent(sessionId)}&checkout=success`,
            cancel_url: `${base}/?session=${encodeURIComponent(sessionId)}&checkout=cancelled`
        };
        // Reuse their old Stripe customer if they subscribed before; otherwise
        // lock the checkout to their Gmail address so the payment matches their login.
        if (userSession.stripeCustomerId) params.customer = userSession.stripeCustomerId;
        else params.customer_email = userSession.email;

        const checkout = await stripeRequest('POST', '/checkout/sessions', params);
        res.json({ success: true, url: checkout.url });
    } catch (err) {
        console.error('Checkout Error:', err.message);
        // Backup plan: the payment link, with the email locked to their Gmail address
        res.json({
            success: true,
            url: `${STRIPE_PAYMENT_LINK}?locked_prefilled_email=${encodeURIComponent(userSession.email)}`
        });
    }
});

// ============================================
// STRIPE: CUSTOMER BILLING PORTAL (cancel / update card)
// ============================================

app.post('/api/billing-portal', async (req, res) => {
    const sessionId = req.headers['x-user-session'];
    const userSession = sessionId && activeSessions[sessionId];
    if (!userSession) {
        return res.status(401).json({ success: false, message: 'Please connect your Gmail first.' });
    }

    try {
        if (!userSession.stripeCustomerId) await isPaid(userSession);
        if (!userSession.stripeCustomerId) {
            return res.status(404).json({ success: false, message: 'No subscription found for ' + userSession.email });
        }
        const portal = await stripeRequest('POST', '/billing_portal/sessions', {
            customer: userSession.stripeCustomerId,
            return_url: siteUrl(req) + '/'
        });
        res.json({ success: true, url: portal.url });
    } catch (err) {
        console.error('Billing Portal Error:', err.message);
        res.status(500).json({ success: false, message: 'Could not open the billing portal. Please email jenny@jentlestay.com.' });
    }
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
        stripeConfigured: !!STRIPE_SECRET_KEY,
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
    console.log(`💳 Stripe: ${STRIPE_SECRET_KEY ? 'Configured ✅' : 'NOT configured ⚠️ (set STRIPE_SECRET_KEY on Render – nobody can get in until you do)'}`);
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