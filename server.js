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

// --- Google Strategy Setup ---
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback'
}, (accessToken, refreshToken, profile, done) => {
    // Save or find user in your database here
    return done(null, profile);
}));

// --- Microsoft Strategy Setup ---
passport.use(new MicrosoftStrategy({
    clientID: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    callbackURL: process.env.MICROSOFT_CALLBACK_URL || '/auth/microsoft/callback',
    scope: ['user.read', 'mail.read']
}, (accessToken, refreshToken, profile, done) => {
    // Save or find user in your database here
    return done(null, profile);
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// Routes
app.get('/', (req, res) => {
    res.send('Welcome to Unsub! <a href="/auth/google">Login with Google</a> | <a href="/auth/microsoft">Login with Microsoft</a>');
});

// Google Auth Routes
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', 
    passport.authenticate('google', { failureRedirect: '/' }),
    (req, res) => {
        res.redirect('/dashboard');
    }
);

// Microsoft Auth Routes
app.get('/auth/microsoft', passport.authenticate('microsoft'));
app.get('/auth/microsoft/callback', 
    passport.authenticate('microsoft', { failureRedirect: '/' }),
    (req, res) => {
        res.redirect('/dashboard');
    }
);

app.get('/dashboard', (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/');
    }
    res.send(`Hello, ${req.displayName || req.user.displayName || 'User'}! Welcome to your Unsub dashboard.`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});