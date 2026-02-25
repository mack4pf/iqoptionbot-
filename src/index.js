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
        const apiPort = process.env.API_PORT || 3000;
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
            this.adminClient.onTradeOpened = (tradeData) => {
                this.telegramBot.sendToAdmin('tradeOpened', tradeData);
            };
            this.adminClient.onTradeClosed = (tradeResult) => {
                this.telegramBot.sendToAdmin('tradeClosed', tradeResult);
            };
        }

        this.adminClient.connect();
        console.log('✅ Admin IQ Option connected and monitoring\n');
    }

    async executeSignalForAllUsers(signal) {
        console.log(`📢 Executing signal for all users | Asset: ${signal.asset} | Direction: ${signal.direction} | Duration: ${signal.duration} min`);

        if (!this.telegramBot) {
            console.log('⚠️ Telegram bot not available');
            return;
        }

        const clients = this.telegramBot.getAllConnectedClients();

        if (clients.length === 0) {
            console.log('⚠️ No connected users to execute signal');
            return;
        }

        console.log(`👥 Found ${clients.length} connected user(s)`);

        for (const { userId, client } of clients) {
            try {
                // Detect user's live currency from their IQ Option account
                const currency = client?.currency || 'NGN';
                console.log(`🔍 User ${userId} — Currency: ${currency} | Account: ${client?.accountType}`);

                // Auto-trader handles: martingale state, currency minimums, user trade amount
                const result = await this.autoTrader.executeTrade(userId, client, {
                    asset: signal.asset,
                    direction: signal.direction,
                    duration: signal.duration  // from signal (e.g. 5 min)
                });

                if (result.success) {
                    console.log(`✅ Trade placed for user ${userId}: ${currency}${result.amount} for ${signal.duration} min`);
                } else {
                    console.log(`❌ Trade failed for user ${userId}: ${result.error}`);
                }

                // Small delay between users to avoid rate limits
                await new Promise(resolve => setTimeout(resolve, 800));

            } catch (error) {
                console.error(`Error executing for user ${userId}:`, error.message);
            }
        }
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