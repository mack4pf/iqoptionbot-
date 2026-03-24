const express = require('express');
const { MongoClient } = require('mongodb');
const app = express();
app.use(express.json());

let tradingBotInstance = null;

function setTradingBot(bot) {
    tradingBotInstance = bot;
}

// Helper function to get global trade duration setting from database
async function getGlobalTradeDuration() {
    let duration = 5; // Default 5 minutes

    try {
        const uri = process.env.MONGODB_URI;
        const client = new MongoClient(uri);
        await client.connect();
        const db = client.db('trading_bot');

        const setting = await db.collection('settings').findOne({ key: 'trade_duration' });
        if (setting && setting.value) {
            duration = setting.value;
            console.log(`📊 Global trade duration setting: ${duration} minutes`);
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
    } catch (err) {
        console.error('⚠️ Failed to get duration setting from DB, using default 5 min:', err.message);
    }

    return duration;
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

    // Convert seconds to minutes (from signal source)
    const rawDuration = Math.floor(time / 60);

    // Get global trade duration setting from database
    const globalDuration = await getGlobalTradeDuration();

    // Determine which duration to use:
    // - If signal duration is 3 or 5 minutes, use that (signal overrides)
    // - Otherwise use the admin's global setting
    let duration;
    if (rawDuration === 3 || rawDuration === 5) {
        duration = rawDuration;
        console.log(`📡 Using signal-specified duration: ${duration} minutes`);
    } else {
        duration = globalDuration;
        console.log(`📡 Using admin global duration setting: ${duration} minutes`);
    }

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

// ❌ RESULT ENDPOINT REMOVED - TradingView results are ignored

function startServer(port = 3000) {
    app.listen(port, () => {
        console.log(`📡 Signal receiver API listening on port ${port}`);
    });
}

module.exports = { setTradingBot, startServer };