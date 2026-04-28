const express = require('express');
const { MongoClient } = require('mongodb');
const app = express();
app.use(express.json());
app.use(express.text()); // To parse plain text signals from TradingView
app.use(express.urlencoded({ extended: true }));

let tradingBotInstance = null;

// Cache for duration to avoid hitting database on every signal
let cachedDuration = 5;
let lastCacheTime = 0;
const CACHE_TTL = 60000; // Cache for 60 seconds

function setTradingBot(bot) {
    tradingBotInstance = bot;
}

// Helper function to get global trade duration setting from database with caching
async function getGlobalTradeDuration() {
    // Return cached value if still fresh
    const now = Date.now();
    if (lastCacheTime && (now - lastCacheTime) < CACHE_TTL) {
        console.log(`📊 Using cached duration: ${cachedDuration} minutes`);
        return cachedDuration;
    }

    let duration = 5; // Default 5 minutes

    try {
        const uri = process.env.MONGODB_URI;
        const client = new MongoClient(uri);
        await client.connect();
        const dbName = uri.includes('mongodb.net/') ? uri.split('mongodb.net/')[1].split('?')[0] : 'niels-autotrade';
        const db = client.db(dbName || 'niels-autotrade');

        const setting = await db.collection('settings').findOne({ key: 'trade_duration' });
        if (setting && setting.value) {
            duration = setting.value;
            console.log(`📊 Global trade duration setting loaded from DB: ${duration} minutes`);
        } else {
            console.log(`📊 No global duration setting found, using default: ${duration} minutes`);
            // Create default setting if not exists
            await db.collection('settings').updateOne(
                { key: 'trade_duration' },
                { $set: { value: 5, updated_at: new Date() } },
                { upsert: true }
            );
        }

        await client.close();

        // Update cache
        cachedDuration = duration;
        lastCacheTime = now;

    } catch (err) {
        console.error('⚠️ Failed to get duration setting from DB, using cached or default:', err.message);
        // If DB fails, use cached value or default
        duration = cachedDuration;
    }

    return duration;
}

// Force refresh cache (call after admin changes duration)
async function refreshDurationCache() {
    console.log('🔄 Refreshing duration cache...');
    lastCacheTime = 0; // Invalidate cache
    const newDuration = await getGlobalTradeDuration();
    console.log(`✅ Duration cache refreshed to: ${newDuration} minutes`);
    return newDuration;
}

// 📡 Signal creation endpoint (Support both aliases)
app.post(['/api/signals/create', '/api/tradingview'], async (req, res) => {
    // 1. Authenticate
    const adminSecret = req.headers['x-admin-secret'];
    if (!adminSecret || adminSecret !== process.env.SIGNAL_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { ticker, signal, price, time } = req.body;
    if (!ticker || !signal || !time) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Improved direction mapping - case insensitive
    const rawSignal = signal.toLowerCase().trim();
    let direction;
    if (['buy', 'call', 'higher', 'up'].includes(rawSignal)) {
        direction = 'call';
    } else if (['sell', 'put', 'lower', 'down'].includes(rawSignal)) {
        direction = 'put';
    } else {
        console.warn(`⚠️ Unknown signal value: "${signal}", defaulting to call.`);
        direction = 'call';
    }

    // CRITICAL: ALWAYS use the admin's global setting from database
    // Ignore whatever duration came from the signal source
    const duration = await getGlobalTradeDuration();

    const signalId = `SIG_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    console.log(`📡 Received signal: ${signal} on ${ticker} (signal time was ${time}s)`);
    console.log(`📡 Using admin global duration: ${duration} minutes → mapped direction: ${direction}`);

    // Respond immediately
    res.json({
        status: 'success',
        signalId: signalId,
        duration: duration
    });

    // Trigger auto‑trading in background
    if (tradingBotInstance) {
        tradingBotInstance.executeSignalForAllUsers({
            asset: ticker,
            direction: direction,
            duration: duration,
            price: price,
            signalId: signalId
        }).catch(err => console.error('❌ Signal execution error:', err));
    } else {
        console.error('❌ Trading bot not initialized');
    }
});

// 📡 New specific TradingView webhook for 5-minute trades (Plain Text or JSON)
app.post('/api/tv-webhook', async (req, res) => {
    // Support secret in query params (easier for TradingView alerts) or headers
    const secret = req.query.secret || req.headers['x-admin-secret'] || (req.body && req.body.secret);
    if (!secret || secret !== process.env.SIGNAL_SECRET) {
        return res.status(401).json({ error: 'Unauthorized. Please include ?secret=YOUR_SECRET in the URL.' });
    }

    // Normalize body to uppercase string for easy keyword matching
    let rawText = '';
    if (typeof req.body === 'object') {
        rawText = JSON.stringify(req.body).toUpperCase();
    } else if (typeof req.body === 'string') {
        rawText = req.body.toUpperCase();
    }

    console.log(`📨 Raw signal received: ${rawText}`);

    // ── STEP 1: Detect direction ──────────────────────────────────────────────
    // Simply check if BUY or SELL appears ANYWHERE in the text
    let direction = null;

    if (rawText.includes('BUY') || rawText.includes('CALL') || rawText.includes('LONG')) {
        direction = 'call';
    } else if (rawText.includes('SELL') || rawText.includes('PUT') || rawText.includes('SHORT')) {
        direction = 'put';
    }

    if (!direction) {
        const errMsg = `⚠️ Webhook Error\n\nSignal has no BUY or SELL:\n\n${rawText}\n\nMake sure your alert message contains the word BUY or SELL.`;
        console.error(errMsg);
        if (tradingBotInstance && tradingBotInstance.telegramBot && process.env.ADMIN_CHAT_ID) {
            tradingBotInstance.telegramBot.bot.telegram.sendMessage(process.env.ADMIN_CHAT_ID, errMsg).catch(console.error);
        }
        return res.status(200).json({ error: 'No BUY or SELL found in signal', raw: rawText });
    }

    // ── STEP 2: Detect ticker ─────────────────────────────────────────────────
    // Priority: ?ticker= URL param → text body scan
    let ticker = req.query.ticker ? req.query.ticker.toUpperCase() : null;

    if (!ticker && req.body && typeof req.body === 'object' && req.body.ticker) {
        ticker = req.body.ticker.toUpperCase();
    }

    if (!ticker) {
        // Try to extract from the signal body (handles OANDA:EURUSD, EUR/USD, EURUSD, etc.)
        const pairRegex = /([A-Z]{3})[\/\-:]?([A-Z]{3})/;
        const pairMatch = rawText.match(pairRegex);
        if (pairMatch) {
            const candidate = pairMatch[1] + pairMatch[2];
            const commonPairs = [
                'EURUSD', 'GBPUSD', 'USDJPY', 'USDCAD', 'USDCHF', 'AUDUSD', 'NZDUSD',
                'EURJPY', 'GBPJPY', 'EURGBP', 'EURCAD', 'EURAUD', 'EURCHF', 'AUDJPY',
                'CADJPY', 'CHFJPY', 'NZDJPY', 'GBPCAD', 'GBPAUD', 'GBPCHF',
                'XAUUSD', 'XAGUSD', 'BTCUSD', 'ETHUSD'
            ];
            if (commonPairs.includes(candidate)) {
                ticker = candidate;
            }
        }
    }

    if (!ticker) {
        const errMsg = `⚠️ Webhook Error\n\nDetected direction: ${direction.toUpperCase()} ✅\nBut no asset/pair found!\n\nFix: Add ?ticker=EURUSD to your webhook URL:\nhttps://iqoptionbot.pxxl.pro/api/tv-webhook?secret=1234ea1&ticker=EURUSD\n\nOriginal signal:\n${rawText}`;
        console.error(errMsg);
        if (tradingBotInstance && tradingBotInstance.telegramBot && process.env.ADMIN_CHAT_ID) {
            tradingBotInstance.telegramBot.bot.telegram.sendMessage(process.env.ADMIN_CHAT_ID, errMsg).catch(console.error);
        }
        return res.status(200).json({ error: 'No asset/pair detected. Add ?ticker=EURUSD to URL.', raw: rawText });
    }

    // Strip broker prefix (e.g. OANDA:EURUSD → EURUSD)
    if (ticker.includes(':')) {
        ticker = ticker.split(':').pop();
    }

    // Handle OTC
    if (rawText.includes('OTC') && !ticker.includes('OTC')) {
        ticker += '-OTC';
    }
    }

    // 3. Force 5-minute trade duration
    const duration = 5;
    const signalId = `TV_5M_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    console.log(`📡 TradingView Webhook: Executing ${direction.toUpperCase()} on ${ticker} for ${duration} minutes`);

    // Respond to TradingView immediately
    res.json({
        status: 'success',
        message: 'Signal accepted for 5 minute trade',
        signalId: signalId,
        ticker: ticker,
        direction: direction,
        duration: duration
    });

    // Send to bot
    if (tradingBotInstance) {
        tradingBotInstance.executeSignalForAllUsers({
            asset: ticker,
            direction: direction,
            duration: duration,
            price: 0,
            signalId: signalId
        }).catch(err => console.error('❌ TV Signal execution error:', err));
    }
});

// Endpoint to manually refresh duration cache (for testing)
app.post('/api/admin/refresh-duration', async (req, res) => {
    const adminSecret = req.headers['x-admin-secret'];
    if (!adminSecret || adminSecret !== process.env.SIGNAL_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const newDuration = await refreshDurationCache();
    res.json({
        status: 'success',
        duration: newDuration,
        message: `Duration cache refreshed to ${newDuration} minutes`
    });
});

// ❌ RESULT ENDPOINT REMOVED - TradingView results are ignored

function startServer(port = 3000) {
    app.listen(port, '0.0.0.0', () => {
        console.log(`📡 Signal receiver API listening on port ${port}`);
    });
}

module.exports = { setTradingBot, startServer, refreshDurationCache };