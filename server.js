require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const MicrosoftStrategy = require('passport-microsoft').Strategy;

const app = express();

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'your_fallback_secret_key',
    resave: false,
    saveUninitialized: true
}));

app.use(passport.initialize());
app.use(passport.session());

// --- Safe Google Strategy Setup ---
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_ID.trim() !== "") {
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL || 'https://unsub-app-w0c7.onrender.com/auth/google/callback'
    }, (accessToken, refreshToken, profile, done) => {
        return done(null, profile);
    }));
    console.log("✅ Google Auth Strategy Loaded Successfully");
} else {
    console.log("⚠️ Google Client ID not found. Skipping Google Strategy setup for local test.");
}

// --- Safe Microsoft Strategy Setup ---
if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_ID.trim() !== "") {
    passport.use(new MicrosoftStrategy({
        clientID: process.env.MICROSOFT_CLIENT_ID,
        clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
        callbackURL: process.env.MICROSOFT_CALLBACK_URL || 'https://unsub-app-w0c7.onrender.com/auth/microsoft/callback',
        scope: ['user.read', 'mail.read']
    }, (accessToken, refreshToken, profile, done) => {
        return done(null, profile);
    }));
    console.log("✅ Microsoft Auth Strategy Loaded Successfully");
} else {
    console.log("⚠️ Microsoft Client ID not found. Skipping Microsoft Strategy setup for local test.");
}

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// --- Base Routes ---
app.get('/', (req, res) => {
    res.send('Welcome to Unsub! Select your provider on the Daily Swipe screen.');
});

// --- Google Auth Routes ---
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', 
    passport.authenticate('google', { failureRedirect: '/' }),
    (req, res) => {
        res.redirect('/dashboard');
    }
);

// --- Microsoft Auth Routes ---
app.get('/auth/microsoft', passport.authenticate('microsoft'));
app.get('/auth/microsoft/callback', 
    passport.authenticate('microsoft', { failureRedirect: '/' }),
    (req, res) => {
        res.redirect('/dashboard');
    }
);

// --- Dynamic Provider Routes ---
['yahoo', 'apple', 'imap', 'other'].forEach(provider => {
    app.get(`/auth/${provider}`, (req, res) => {
        const clientIdKey = `${provider.toUpperCase()}_CLIENT_ID`;
        if (process.env[clientIdKey]) {
            res.send(`${provider.toUpperCase()} authentication route is live.`);
        } else {
            res.status(501).send(`Configuring ${provider.toUpperCase()} authentication strategy...`);
        }
    });
});

app.get('/dashboard', (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/');
    }
    res.send(`Hello, ${req.user.displayName || 'User'}! Welcome to your Unsub dashboard.`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});