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

    // Convert seconds to minutes
    const rawDuration = Math.floor(time / 60);
    const duration = rawDuration > 0 ? rawDuration : 5; // Default 5 minutes

    const signalId = `SIG_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    console.log(`📡 Received signal: ${signal} (raw) on ${ticker} for ${duration} min → mapped direction: ${direction}`);

    // Respond immediately
    res.json({
        status: 'success',
        signalId: signalId
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

// (Optional) Result endpoint
app.post('/api/signals/result', async (req, res) => {
    const adminSecret = req.headers['x-admin-secret'];
    if (!adminSecret || adminSecret !== process.env.SIGNAL_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { signalId, signal } = req.body;
    console.log(`📊 Result for ${signalId}: ${signal}`);
    res.json({ status: 'success' });
});

function startServer(port = 3000) {
    app.listen(port, () => {
        console.log(`📡 Signal receiver API listening on port ${port}`);
    });
}

module.exports = { setTradingBot, startServer };