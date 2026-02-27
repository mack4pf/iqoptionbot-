const express = require('express');
const app = express();
app.use(express.json());

let tradingBotInstance = null;

function setTradingBot(bot) {
    tradingBotInstance = bot;
}

// 📡 Signal creation endpoint
app.post('/api/signals/create', async (req, res) => {
    // 1. Authenticate
    const adminSecret = req.headers['x-admin-secret'];
    if (!adminSecret || adminSecret !== process.env.SIGNAL_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { ticker, signal, price, time } = req.body;
    if (!ticker || !signal || !time) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Map signal: 'buy' -> 'call', 'sell' -> 'put', handling case-sensitivity
    const direction = signal.toLowerCase() === 'buy' ? 'call' : 'put';
    // TradingView sends `time` in seconds (e.g. 300 = 5 min).
    // Convert to minutes and fallback to 5 min if zero/missing.
    const rawDuration = Math.floor(time / 60);
    const duration = rawDuration > 0 ? rawDuration : 5; // Default: 5 minutes

    // Generate a unique signal ID (for tracking, optional)
    const signalId = `SIG_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    console.log(`📡 Received signal: ${signal} on ${ticker} for ${duration} min`);

    // Respond immediately – do NOT await the trading
    res.json({
        status: 'success',
        signalId: signalId
    });

    // Trigger auto‑trading in the background
    if (tradingBotInstance) {
        tradingBotInstance.executeSignalForAllUsers({
            asset: ticker,          // e.g., 'EURUSD'
            direction: direction,
            duration: duration,
            price: price,            // optional, for logging
            signalId: signalId
        }).catch(err => console.error('❌ Signal execution error:', err));
    } else {
        console.error('❌ Trading bot not initialized');
    }
});

// (Optional) Result endpoint – if you want to log outcomes
app.post('/api/signals/result', async (req, res) => {
    const adminSecret = req.headers['x-admin-secret'];
    if (!adminSecret || adminSecret !== process.env.SIGNAL_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { signalId, signal } = req.body; // signal: "WIN" or "LOSS"
    console.log(`📊 Result for ${signalId}: ${signal}`);
    // You could store this in your database for analytics
    res.json({ status: 'success' });
});

function startServer(port = 3000) {
    app.listen(port, () => {
        console.log(`📡 Signal receiver API listening on port ${port}`);
    });
}

module.exports = { setTradingBot, startServer };