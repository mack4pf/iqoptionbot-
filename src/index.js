const TelegramBot = require('./telegram/bot');
const MongoDB = require('./database/mongodb');
const AutoTrader = require('./core/auto-trader');
const apiServer = require('./api/server');
require('dotenv').config();

class TradingBot {
    constructor() {
        this.db = null;
        this.telegramBot = null;
        this.autoTrader = null;
        this.adminClient = null;
        // Cache for recent signals (key: signalId, value: timestamp)
        this.recentSignals = new Map();
        // Locks to prevent multiple executions for same user
        this.userLocks = new Set();
        // Track processed users per signal
        this.signalUserTrades = new Map();
    }

    async initialize() {
        console.log('🚀 STARTING IQ OPTION TRADING BOT');
        console.log('='.repeat(60));

        // Debug environment
        console.log('🔍 Environment Check:');
        console.log(`   TELEGRAM_BOT_TOKEN: ${process.env.TELEGRAM_BOT_TOKEN ? '✅ Set' : '❌ Missing'}`);
        console.log(`   ADMIN_CHAT_ID: ${process.env.ADMIN_CHAT_ID ? '✅ Set' : '❌ Missing'}`);
        console.log(`   ADMIN_CHAT_ID value: "${process.env.ADMIN_CHAT_ID}"`);
        console.log(`   ADMIN_CHAT_ID length: ${process.env.ADMIN_CHAT_ID?.length || 0}`);
        console.log(`   SIGNAL_SECRET: ${process.env.SIGNAL_SECRET ? '✅ Set' : '❌ Missing'}`);
        console.log('='.repeat(60));

        // Connect to MongoDB
        console.log('📁 Connecting to MongoDB...');
        this.db = new MongoDB();
        await this.db.connect();
        console.log('✅ MongoDB connected\n');

        // Initialize Auto-Trader FIRST
        console.log('🤖 Initializing Auto-Trader...');
        this.autoTrader = new AutoTrader(this.telegramBot, this.db);
        console.log('✅ Auto-Trader initialized\n');

        // START API SERVER
        console.log('📡 Starting Signal Receiver API...');
        apiServer.setTradingBot(this);
        const apiPort = process.env.API_PORT;
        apiServer.startServer(apiPort);
        console.log(`✅ Signal Receiver API listening on port ${apiPort}\n`);

        // Initialize Telegram Bot
        console.log('🤖 Initializing Telegram Bot...');
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (!token) {
            console.error('❌ TELEGRAM_BOT_TOKEN not found in .env - Telegram bot disabled');
        } else {
            try {
                this.telegramBot = new TelegramBot(token, this.db, this);
                if (this.autoTrader) {
                    this.autoTrader.telegramBot = this.telegramBot;
                }
                await this.telegramBot.start();
                console.log('✅ Telegram Bot running\n');
            } catch (error) {
                console.error('❌ Telegram Bot failed to start:', error.message);
            }
        }

        // Connect Admin's IQ Option account
        await this.connectAdminAccount();

        console.log('='.repeat(60));
        console.log('🎯 BOT IS OPERATIONAL');
        console.log('✅ Auto-trader will use 5 MINUTES for ALL trades');
        console.log('✅ User notifications go to user DMs');
        console.log('✅ Admin notifications go to admin DM');
        console.log('='.repeat(60));
    }

    async connectAdminAccount() {
        const adminEmail = process.env.IQ_EMAIL;
        const adminPass = process.env.IQ_PASSWORD;

        if (!adminEmail || !adminPass) {
            console.log('⚠️ Admin IQ Option credentials not configured');
            return;
        }

        console.log('🔌 Connecting Admin IQ Option account...');

        const IQOptionClient = require('./client');
        this.adminClient = new IQOptionClient(adminEmail, adminPass, process.env.ADMIN_CHAT_ID);

        const loggedIn = await this.adminClient.login();
        if (!loggedIn) {
            console.log('⚠️ Admin IQ Option login failed');
            return;
        }

        // Set up admin callbacks
        if (this.telegramBot) {
            // Add to user connections so admin can use /balance, /status, etc.
            this.telegramBot.userConnections.set(process.env.ADMIN_CHAT_ID, this.adminClient);

            this.adminClient.onTradeOpened = (tradeData) => {
                this.telegramBot.handleUserTradeOpened(process.env.ADMIN_CHAT_ID, tradeData);
                // Trigger copy for enabled users
                this.executeCopyForUsers(tradeData).catch(err => console.error('Copy error:', err));
            };
            this.adminClient.onTradeClosed = (tradeResult) => {
                this.telegramBot.handleUserTradeClosed(process.env.ADMIN_CHAT_ID, tradeResult);
            };
        }

        this.adminClient.connect();
        console.log('✅ Admin IQ Option connected and registered in bot\n');
    }

    async executeCopyForUsers(adminTradeData) {
        console.log(`👥 Checking for copy users after admin trade: ${adminTradeData.asset} ${adminTradeData.direction}`);

        // Get all connected clients (users currently logged in)
        const clients = this.telegramBot.getAllConnectedClients();

        for (const { userId, client } of clients) {
            // Skip the admin themselves
            if (userId === process.env.ADMIN_CHAT_ID) continue;

            const user = await this.db.getUser(userId);
            if (!user || !user.copyAdminEnabled) continue;

            // Execute a copy trade for this user
            console.log(`📋 Copying trade for user ${userId} (${user.email})`);

            // Use the same signal parameters (asset, direction, duration) but amount will be handled by autoTrader (user's own martingale)
            const signal = {
                asset: adminTradeData.asset,
                direction: adminTradeData.direction === 'CALL' ? 'call' : 'put', // ensure lowercase
                duration: adminTradeData.duration
            };

            try {
                const result = await this.autoTrader.executeTrade(userId, client, signal);
                if (result.success) {
                    console.log(`✅ Copy trade placed for user ${userId}: ${result.amount}`);
                } else {
                    console.log(`❌ Copy trade failed for user ${userId}: ${result.error}`);
                }
            } catch (error) {
                console.error(`Error copying trade for user ${userId}:`, error.message);
            }

            // Small delay to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    async executeSignalForAllUsers(signal) {
        // ----- DEDUPLICATION -----
        if (!signal.signalId) {
            console.warn('⚠️ Signal received without signalId, cannot deduplicate');
        } else {
            const now = Date.now();
            if (this.recentSignals.has(signal.signalId)) {
                console.log(`⏸️ Duplicate signal ${signal.signalId} ignored`);
                return;
            }
            this.recentSignals.set(signal.signalId, now);
            for (const [id, ts] of this.recentSignals) {
                if (now - ts > 60000) this.recentSignals.delete(id);
            }
        }
        // -------------------------

        console.log(`📢 Executing signal ${signal.signalId || 'unknown'} for all users | Asset: ${signal.asset} | Direction: ${signal.direction} | Duration: ${signal.duration} min`);

        if (!this.telegramBot) {
            console.log('⚠️ Telegram bot not available');
            return;
        }

        const clients = this.telegramBot.getAllConnectedClients();
        console.log(`👥 Found ${clients.length} connected user(s)`);

        if (clients.length === 0) {
            console.log('⚠️ No connected users to execute signal');
            return;
        }

        // 🚀 FIX: Execute all trades in parallel (no delays)
        const tradePromises = [];
        const processedUsers = [];

        for (const { userId, client } of clients) {
            // Per-user lock
            if (this.userLocks.has(userId)) {
                console.log(`⏸️ User ${userId} is already processing a trade, skipping.`);
                continue;
            }

            // Track if this user already traded for this signal
            const tradeKey = `${signal.signalId}_${userId}`;
            if (this.signalUserTrades?.has(tradeKey)) {
                console.log(`⏸️ User ${userId} already traded for signal ${signal.signalId}, skipping.`);
                continue;
            }
            if (!this.signalUserTrades) this.signalUserTrades = new Map();
            this.signalUserTrades.set(tradeKey, true);

            // Clean up after 5 minutes
            setTimeout(() => {
                if (this.signalUserTrades) this.signalUserTrades.delete(tradeKey);
            }, 300000);

            this.userLocks.add(userId);
            processedUsers.push(userId);

            // Create promise for this trade
            const tradePromise = (async () => {
                try {
                    const currency = client?.currency || 'NGN';
                    console.log(`🔍 User ${userId} — Currency: ${currency} | Account: ${client?.accountType}`);

                    const user = await this.db.getUser(userId);
                    if (user && !user.autoTraderEnabled) {
                        console.log(`⏸️ User ${userId} has auto‑trader disabled, skipping.`);
                        return;
                    }

                    const result = await this.autoTrader.executeTrade(userId, client, {
                        asset: signal.asset,
                        direction: signal.direction,
                        duration: signal.duration
                    });

                    if (result.success) {
                        console.log(`✅ Trade placed for user ${userId}: ${currency}${result.amount} for ${signal.duration} min`);
                    } else {
                        console.log(`❌ Trade failed for user ${userId}: ${result.error}`);
                    }

                } catch (error) {
                    console.error(`Error executing for user ${userId}:`, error.message);
                } finally {
                    this.userLocks.delete(userId);
                }
            })();

            tradePromises.push(tradePromise);
        }

        // Wait for ALL trades to complete in parallel
        await Promise.all(tradePromises);

        console.log(`✅ Signal execution complete for ${processedUsers.length} users (all executed in parallel)`);
    }

    async shutdown() {
        console.log('\n🛑 Shutting down...');
        if (this.adminClient) this.adminClient.disconnect();
        if (this.db) await this.db.close();
        process.exit(0);
    }
}

const bot = new TradingBot();

process.on('SIGINT', () => bot.shutdown());
process.on('SIGTERM', () => bot.shutdown());

bot.initialize().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});