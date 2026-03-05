const { Telegraf, Markup, session } = require('telegraf');
const MongoDB = require('../database/mongodb');
const IQOptionClient = require('../client');

class TelegramBot {
    constructor(token, db, tradingBot) {
        this.bot = new Telegraf(token);
        this.bot.use(session());
        this.db = db;
        this.tradingBot = tradingBot;
        this.userConnections = new Map();
        this.setupMiddleware();
        this.setupMenus();
        this.setupCommands();
        this.setupHandlers();
    }

    setupMiddleware() {
        this.bot.use(async (ctx, next) => {
            try {
                ctx.db = this.db;
                ctx.tradingBot = this.tradingBot;

                const userId = ctx.from?.id?.toString();
                if (userId) {
                    ctx.state.user = await this.db.getUser(userId);

                    if (ctx.state.user) {
                        console.log(`👤 User ${userId} found - is_admin: ${ctx.state.user.is_admin}`);
                    } else {
                        console.log(`👤 User ${userId} not found in database`);

                        if (userId === process.env.ADMIN_CHAT_ID) {
                            console.log('⚠️ Admin user not in DB but has admin ID - creating now');
                            const users = this.db.db.collection('users');
                            await users.insertOne({
                                _id: userId,
                                email: 'admin@local',
                                password_encrypted: 'admin',
                                account_type: 'PRACTICE',
                                tradeAmount: 1500,
                                balance: 0,
                                connected: false,
                                created_at: new Date(),
                                last_active: new Date(),
                                is_admin: true,
                                access_expires_at: new Date('2099-12-31')
                            });
                            ctx.state.user = await this.db.getUser(userId);
                            console.log('✅ Admin user created on the fly');
                        }
                    }
                }

                if (ctx.message?.text?.startsWith('/start')) {
                    return next();
                }

                if (ctx.state.user) {
                    const hasAccess = await this.db.hasValidAccess(ctx.from.id);
                    if (!hasAccess && !ctx.state.user.is_admin) {
                        return ctx.reply(
                            '❌ Your access has expired. Contact admin for new code.',
                            Markup.keyboard([['🔄 Request New Code']]).resize()
                        );
                    }
                }

                return next();
            } catch (error) {
                console.error('Middleware error:', error);
                return next();
            }
        });
    }

    setupMenus() {
        // Admin Main Menu
        this.adminMainMenu = Markup.keyboard([
            ['🎫 Generate Code', '📋 List Codes'],
            ['👥 List Users', '🔴 Revoke User'],
            ['📢 Add Channel', '📢 Remove Channel'],
            ['📊 System Stats', '🏠 Main Menu']
        ]).resize();

        // User Main Menu
        this.userMainMenu = Markup.keyboard([
            ['💰 Balance', '📊 My Stats'],
            ['💰 Set Amount', '🤖 Martingale'],
            ['📈 Practice Mode', '💵 Real Mode'],
            ['🔌 Status', '🏠 Main Menu']
        ]).resize();

        // Settings Menu
        this.settingsMenu = Markup.keyboard([
            ['🔔 Notifications', '🌙 Dark Mode'],
            ['💬 Language', '🔄 Reset Settings'],
            ['◀️ Back']
        ]).resize();
    }

    setupCommands() {
        // Start command
        this.bot.start(async (ctx) => {
            const args = ctx.message.text.split(' ');
            const code = args[1];

            if (!code) {
                const welcomeMsg =
                    '🤖 *Welcome to IQ Option Auto-Trading Bot!*\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'To start trading, you need two things:\n\n' +
                    '*1️⃣ Create an IQ Option Account*\n' +
                    'Use this link to sign up:\n' +
                    '👉 [Click Here to Register](https://affiliate.iqoption.net/redir/?aff=785369&aff_model=revenue&afftrack=)\n\n' +
                    '*2️⃣ Get an Access Code*\n' +
                    ' [GET ACCESS CODE](https://t.me/niels_official)\n\n' +
                    '*3️⃣ Activate Your Code*\n' +
                    'Send: `/start IQ-XXXX-XXXX-XXXX`\n\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '_Need help? Contact ADMIN';
                return ctx.reply(welcomeMsg, {
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true
                });
            }

            try {
                const existingUser = await this.db.getUser(ctx.from.id);
                if (existingUser) {
                    return ctx.reply(
                        '❌ You are already registered!',
                        ctx.state.user?.is_admin ? this.adminMainMenu : this.userMainMenu
                    );
                }

                const accessCode = await this.db.validateAccessCode(code);
                if (!accessCode) {
                    return ctx.reply(
                        '❌ *Invalid or expired access code!*',
                        { parse_mode: 'Markdown' }
                    );
                }

                ctx.session = { pendingCode: code };

                await ctx.reply(
                    '✅ *Access Code Accepted!*\n' +
                    '━━━━━━━━━━━━━━━\n\n' +
                    'Now connect your IQ Option account.\n\n' +
                    '*Send this command:*\n' +
                    '`/login your@email.com yourpassword`\n\n' +
                    '*Example:*\n' +
                    '`/login trader@gmail.com MyPass123`\n\n' +
                    '⚠️ Use your exact IQ Option credentials.\n' +
                    '_Your password is encrypted and stored securely._',
                    { parse_mode: 'Markdown' }
                );

            } catch (error) {
                ctx.reply('❌ Registration failed: ' + error.message);
            }
        });

        // LOGIN COMMAND
        this.bot.command('login', async (ctx) => {
            const args = ctx.message.text.split(' ');
            if (args.length < 3) {
                return ctx.reply(
                    '❌ *Usage:* `/login email password`\n\n' +
                    'Example: `/login trader@gmail.com MySecretPass123`',
                    { parse_mode: 'Markdown' }
                );
            }

            const email = args[1];
            const password = args.slice(2).join(' ');

            let user = await this.db.getUser(ctx.from.id);
            const pendingCode = ctx.session?.pendingCode;

            if (!user && !pendingCode) {
                return ctx.reply('❌ Please `/start` with an access code first.');
            }

            const statusMsg = await ctx.reply('🔄 Connecting to IQ Option...');

            try {
                const iqClient = new IQOptionClient(email, password, ctx.from.id);

                const loggedIn = await iqClient.login();
                if (!loggedIn) {
                    await ctx.deleteMessage(statusMsg.message_id).catch(() => { });
                    return ctx.reply('❌ Login failed. Check your email and password.');
                }

                if (!user && pendingCode) {
                    try {
                        await this.db.registerUserWithCode(ctx.from.id, email, password, pendingCode);
                        user = await this.db.getUser(ctx.from.id);
                        ctx.session.pendingCode = null;
                    } catch (regError) {
                        await ctx.deleteMessage(statusMsg.message_id).catch(() => { });
                        return ctx.reply('❌ Registration failed: ' + regError.message);
                    }
                }

                iqClient.connect();

                iqClient.onTradeOpened = (tradeData) => {
                    this.handleUserTradeOpened(ctx.from.id, tradeData);
                };

                iqClient.onTradeClosed = (tradeResult) => {
                    this.handleUserTradeClosed(ctx.from.id, tradeResult);
                };

                iqClient.onBalanceChanged = ({ amount, currency }) => {
                    this.db.updateUser(ctx.from.id, { balance: amount, currency, connected: true });
                };

                this.userConnections.set(ctx.from.id, iqClient);

                await this.db.updateUser(ctx.from.id, {
                    connected: true,
                    last_active: new Date()
                });

                await ctx.deleteMessage(statusMsg.message_id);

                await ctx.reply(
                    '🎉 *Successfully Connected to IQ Option!*\n' +
                    '━━━━━━━━━━━━━━━\n\n' +
                    '*What happens now?*\n' +
                    '• Signals execute trades automatically on your account\n' +
                    '• You get notified on every trade open & close\n' +
                    '• Martingale doubles bet on loss, resets on win\n\n' +
                    '*⏩ NEXT STEPS:*\n\n' +
                    '*1️⃣ Set your trade amount*\n' +
                    '`/setamount 1500` — minimum ₦1,500 (NGN) or $1 (USD)\n\n' +
                    '*2️⃣ Choose your account type*\n' +
                    'Practice mode is default (safe demo money)\n' +
                    'Tap *💵 Real Mode* when ready to use real money\n\n' +
                    '*3️⃣ Check martingale settings*\n' +
                    'Tap *🤖 Martingale* to see your 6-step sequence\n\n' +
                    '*4️⃣ Wait for signals — trades run automatically!*\n\n' +
                    '━━━━━━━━━━━━━━━\n' +
                    '_Type /help anytime to see all commands._',
                    {
                        parse_mode: 'Markdown',
                        ...this.userMainMenu
                    }
                );

                const adminId = process.env.ADMIN_CHAT_ID;
                if (adminId) {
                    const escapeMarkdown = (text) => {
                        if (!text) return '';
                        return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
                    };

                    const safeName = escapeMarkdown(ctx.from.first_name || 'User');
                    const safeUsername = ctx.from.username ? escapeMarkdown(ctx.from.username) : 'no_username';
                    const safeEmail = escapeMarkdown(email);

                    await ctx.telegram.sendMessage(
                        adminId,
                        `👤 *User Connected*\n\n` +
                        `User: ${safeName} (@${safeUsername})\n` +
                        `ID: ${ctx.from.id}\n` +
                        `Email: ${safeEmail}`,
                        { parse_mode: 'Markdown' }
                    );
                }

            } catch (error) {
                console.error('Login error:', error);
                try { await ctx.deleteMessage(statusMsg.message_id); } catch (_) { }
                ctx.reply('❌ Login failed: ' + error.message);
            }
        });

        // Logout command
        this.bot.command('logout', async (ctx) => {
            if (!ctx.state.user) return;

            const client = this.userConnections.get(ctx.from.id);
            if (client) {
                client.disconnect();
                this.userConnections.delete(ctx.from.id);
            }

            await this.db.updateUser(ctx.from.id, { connected: false });
            await ctx.reply('👋 Logged out from IQ Option');
        });

        // Status command
        this.bot.command('status', async (ctx) => {
            if (!ctx.state.user) return;
            console.log(`[BOT] 📥 Status requested by user ${ctx.from.id}`);

            const client = this.userConnections.get(ctx.from.id);
            const connected = client?.connected || false;

            const balance = client?.balance || ctx.state.user.balance || 0;
            const currency = client?.currency || ctx.state.user.currency || 'USD';
            const symbol = this.getCurrencySymbol(currency);
            const accountType = client?.accountType || ctx.state.user.account_type || 'REAL';
            const expires = new Date(ctx.state.user.access_expires_at).toLocaleDateString();
            const tradeAmount = ctx.state.user.tradeAmount || 1500;
            const tradeSymbol = this.getCurrencySymbol(ctx.state.user.currency || 'NGN');

            let message = `📊 *Connection Status*\n\n`;
            message += `🔌 IQ Option: ${connected ? '✅ Connected' : '❌ Disconnected'}\n`;
            message += `💰 Balance: ${symbol}${balance}\n`;
            message += `💳 Account: ${accountType}\n`;
            message += `💰 Trade Amount: ${tradeSymbol}${tradeAmount}\n`;
            message += `📅 Access Expires: ${expires}\n`;

            if (connected) {
                message += `\n🟢 *Online and receiving trades*`;
            }

            await ctx.reply(message, { parse_mode: 'Markdown' });
        });

        // Balance command
        this.bot.command('balance', async (ctx) => {
            if (!ctx.state.user) return;
            console.log(`[BOT] 📥 Balance requested by user ${ctx.from.id}`);

            const client = this.userConnections.get(ctx.from.id);
            if (!client || !client.connected) {
                return ctx.reply('❌ Not connected to IQ Option. Use /login first.');
            }

            const symbol = this.getCurrencySymbol(client.currency);
            const balanceAmount = client.accountType === 'REAL' ? client.realBalance : client.practiceBalance;
            const currencyUsed = client.accountType === 'REAL' ? client.realCurrency : client.practiceCurrency;
            const sym2 = this.getCurrencySymbol(currencyUsed);

            await ctx.reply(
                `💰 *Your Balance*\n\n` +
                `Account: ${client.accountType}\n` +
                `Balance: ${sym2}${balanceAmount}\n\n` +
                `_REAL: ${this.getCurrencySymbol(client.realCurrency)}${client.realBalance}_\n` +
                `_PRACTICE: ${this.getCurrencySymbol(client.practiceCurrency)}${client.practiceBalance}_`,
                { parse_mode: 'Markdown' }
            );
        });

        // SET AMOUNT COMMAND
        this.bot.command('setamount', async (ctx) => {
            if (!ctx.state.user) {
                return ctx.reply('❌ Please login first with /login');
            }

            const args = ctx.message.text.split(' ');
            if (args.length < 2) {
                const currentAmount = ctx.state.user.tradeAmount || 1500;
                const symbol = this.getCurrencySymbol(ctx.state.user.currency || 'NGN');
                return ctx.reply(
                    `💰 *Current trade amount:* ${symbol}${currentAmount}\n\n` +
                    `To change, use: /setamount [amount]\n` +
                    `Example: /setamount 2000`,
                    { parse_mode: 'Markdown' }
                );
            }

            const amount = parseFloat(args[1]);
            if (isNaN(amount) || amount <= 0) {
                return ctx.reply('❌ Please enter a valid positive number');
            }

            await this.db.updateUser(ctx.from.id, { tradeAmount: amount });

            if (this.tradingBot?.autoTrader) {
                this.tradingBot.autoTrader.clearUserState(ctx.from.id.toString());
            }

            const symbol = this.getCurrencySymbol(ctx.state.user.currency || 'NGN');
            await ctx.reply(
                `✅ *Trade amount set to ${symbol}${amount}*\n\n` +
                `_Martingale base amount also updated._`,
                { parse_mode: 'Markdown' }
            );
        });

        // MARTINGALE COMMAND
        this.bot.command('martingale', async (ctx) => {
            if (!ctx.state.user) return ctx.reply('❌ Please login first with /login');

            const user = ctx.state.user;
            const client = this.userConnections.get(ctx.from.id);
            const isEnabled = user.martingale_enabled !== false;
            const currency = client?.currency || user?.currency || 'NGN';
            const symbol = this.getCurrencySymbol(currency);

            const minimums = { NGN: 1500, USD: 1, EUR: 1, GBP: 1, BRL: 5 };
            const minAmount = minimums[currency?.toUpperCase()] || 1;
            const baseAmount = user.martingale?.base_amount || user.tradeAmount || minAmount;
            const step = user.martingale?.current_step || 0;
            const losses = user.martingale?.loss_streak || 0;

            const multipliers = [1, 1, 1, 1, 4, 8, 16, 32];
            const sequence = multipliers.map((m, i) => {
                const amt = baseAmount * m;
                const isCurrent = i === step && losses > 0;
                return `${isCurrent ? '▶️' : `${i + 1}.`} ${symbol}${amt.toLocaleString()}${isCurrent ? ' ← current' : ''}`;
            }).join('\n');

            const statusEmoji = isEnabled ? '✅' : '🔴';
            const message =
                `🤖 *Martingale Strategy*\n` +
                `━━━━━━━━━━━━━━━\n` +
                `Status: ${statusEmoji} ${isEnabled ? 'ON' : 'OFF'}\n` +
                `💰 Base Amount: ${symbol}${baseAmount.toLocaleString()}\n` +
                `📉 Current Step: ${step + 1}/8\n` +
                `🔥 Loss Streak: ${losses}\n` +
                `💱 Currency: ${currency}\n\n` +
                `*Step Sequence:*\n${sequence}\n\n` +
                `━━━━━━━━━━━━━━━\n` +
                `_Win at any step → resets to base_\n` +
                `_8 losses in a row → auto-reset_\n` +
                `_Balance +10% → base amount +10%_`;

            await ctx.reply(message, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [
                        Markup.button.callback(
                            isEnabled ? '🔴 Turn OFF Martingale' : '✅ Turn ON Martingale',
                            isEnabled ? 'martingale_off' : 'martingale_on'
                        )
                    ],
                    [Markup.button.callback('🔄 Reset to Base Amount', 'martingale_reset')]
                ])
            });
        });

        // Account Switching
        const switchAccount = async (ctx, type) => {
            if (!ctx.state.user) return;
            const client = this.userConnections.get(ctx.from.id);
            if (!client) return ctx.reply('❌ Please /login first');

            console.log(`[BOT] 📥 User ${ctx.from.id} switching to ${type}`);
            client.accountType = type;
            client.refreshProfile();

            await this.db.updateUser(ctx.from.id, { account_type: type });
            await ctx.reply(`✅ Switched to ${type} account`);
        };

        this.bot.command('practice', (ctx) => switchAccount(ctx, 'PRACTICE'));

        this.bot.command('real', async (ctx) => {
            if (!ctx.state.user) return;
            await ctx.reply(
                '⚠️ *WARNING: Switching to REAL account*\n\n' +
                'This will use your real money. Are you sure?',
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('✅ Yes, switch to REAL', 'confirm_real')],
                        [Markup.button.callback('❌ Cancel', 'cancel_real')]
                    ])
                }
            );
        });

        // Help command
        this.bot.command('help', async (ctx) => {
            const user = ctx.state.user;

            if (user?.is_admin) {
                const adminHelp =
                    '👑 *ADMIN GUIDE — IQ Option Trading Bot*\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    '*🔐 ACCESS CODES*\n' +
                    '/generate — Create new 30-day access code\n' +
                    '/codes — List all active codes\n' +
                    '/revoke [user_id] — Revoke user access\n\n' +
                    '*👥 USER MANAGEMENT*\n' +
                    '/users — View all registered users\n' +
                    '/stats — Total users, trades, and profit\n\n' +
                    '*📢 CHANNEL MANAGEMENT*\n' +
                    '/addchannel @channel — Add signal channel\n' +
                    '/removechannel @channel — Remove a channel\n\n' +
                    '*💰 YOUR ACCOUNT*\n' +
                    '/login — Connect your IQ Option account\n' +
                    '/setamount — Set your base trade amount\n' +
                    '/practice — Switch to demo mode\n' +
                    '/real — Switch to real money mode\n' +
                    '/martingale — View/toggle martingale\n' +
                    '/balance — Check your live balance\n' +
                    '/status — Connection & account info\n' +
                    '/logout — Disconnect your account\n\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━';
                await ctx.reply(adminHelp, { parse_mode: 'Markdown' });

            } else if (user) {
                const userHelp =
                    '🤖 *USER GUIDE — IQ Option Auto-Trader*\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    '*✅ COMMANDS*\n\n' +
                    '/login — Connect your IQ Option account\n' +
                    '/setamount — Set your base trade amount\n' +
                    '/practice — Switch to demo mode\n' +
                    '/real — Switch to real money mode\n' +
                    '/martingale — View/toggle martingale\n' +
                    '/balance — Check your live balance\n' +
                    '/status — Connection & account info\n' +
                    '/stats — Your trade history\n' +
                    '/logout — Disconnect your account\n' +
                    '/help — Show this guide\n\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '_Signals execute automatically_\n' +
                    '_You get notified on every trade_';
                await ctx.reply(userHelp, { parse_mode: 'Markdown' });

            } else {
                const guestHelp =
                    '🤖 *Welcome to IQ Option Auto-Trading Bot!*\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    '*To get started:*\n\n' +
                    '1. Create an IQ Option account using this link:\n' +
                    '👉 [Click Here to Register](https://affiliate.iqoption.net/redir/?aff=785369&aff_model=revenue&afftrack=)\n\n' +
                    '2. [GET ACCESS CODE](https://t.me/niels_official)\n\n' 
                    '3. Use `/start IQ-XXXX-XXXX-XXXX` to activate\n\n' +
                    '4. Login with `/login your@email.com yourpassword`\n\n' +
                    '5. Set your trade amount with `/setamount 1500`\n\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '_Contact niels_official for an access code._';
                await ctx.reply(guestHelp, {
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true
                });
            }
        });

        // Menu command
        this.bot.command('menu', async (ctx) => {
            if (ctx.state.user?.is_admin) {
                await ctx.reply('🏠 Admin Main Menu', this.adminMainMenu);
            } else if (ctx.state.user) {
                await ctx.reply('🏠 Main Menu', this.userMainMenu);
            } else {
                await ctx.reply('👋 Welcome! Use /start to begin.');
            }
        });

        // Admin: Generate code
        this.bot.command('generate', async (ctx) => {
            if (!ctx.state.user?.is_admin) {
                return ctx.reply('❌ Admin only command');
            }

            try {
                const code = await this.db.createAccessCode(ctx.from.id);
                await ctx.reply(
                    `✅ *New Access Code Generated*\n\n` +
                    `\`${code}\`\n\n` +
                    `Valid for 30 days`,
                    { parse_mode: 'Markdown' }
                );
            } catch (error) {
                ctx.reply('❌ Failed to generate code: ' + error.message);
            }
        });

        // Admin: List codes
        this.bot.command('codes', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;

            try {
                const codes = await this.db.getActiveCodes();
                if (codes.length === 0) {
                    return ctx.reply('📭 No active codes found.');
                }

                let message = '📋 *Active Access Codes*\n\n';
                codes.forEach((code, i) => {
                    const expires = new Date(code.expires_at).toLocaleDateString();
                    const used = code.used_by ? '✅ Used' : '❌ Available';
                    message += `${i + 1}. \`${code.code}\`\n   └ Expires: ${expires} | ${used}\n\n`;
                });

                await ctx.reply(message, { parse_mode: 'Markdown' });
            } catch (error) {
                ctx.reply('❌ Failed to get codes: ' + error.message);
            }
        });

        // Admin: List users
        this.bot.command('users', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;

            try {
                const users = await this.db.getAllUsers();
                const activeUsers = users.filter(u => !u.is_admin);

                if (activeUsers.length === 0) {
                    return ctx.reply('👥 No users registered yet.');
                }

                let message = '👥 *Registered Users*\n\n';
                activeUsers.forEach((user, i) => {
                    const status = user.connected ? '🟢 Online' : '🔴 Offline';
                    const trades = user.stats?.total_trades || 0;
                    const tradeAmount = user.tradeAmount || 1500;
                    message += `${i + 1}. \`${user.email}\`\n   └ ${status} | Trades: ${trades} | Amount: ${tradeAmount}\n`;
                });

                await ctx.reply(message, { parse_mode: 'Markdown' });
            } catch (error) {
                ctx.reply('❌ Failed to get users: ' + error.message);
            }
        });

        // Stats command
        this.bot.command('stats', async (ctx) => {
            if (!ctx.state.user?.is_admin) {
                if (ctx.state.user) {
                    const stats = ctx.state.user.stats || { total_trades: 0, wins: 0, losses: 0, total_profit: 0 };
                    const winRate = stats.total_trades > 0 ? ((stats.wins / stats.total_trades) * 100).toFixed(1) : 0;

                    return ctx.reply(
                        `📊 *Your Stats*\n\n` +
                        `Trades: ${stats.total_trades}\n` +
                        `Wins: ${stats.wins}\n` +
                        `Losses: ${stats.losses}\n` +
                        `Win Rate: ${winRate}%\n` +
                        `Profit: $${stats.total_profit}`,
                        { parse_mode: 'Markdown' }
                    );
                }
                return ctx.reply('❌ Please login first');
            }

            try {
                const users = await this.db.getAllUsers();
                const codes = await this.db.getActiveCodes();
                const channels = await this.db.getActiveChannels();

                const totalUsers = users.filter(u => !u.is_admin).length;
                const activeUsers = users.filter(u => u.connected && !u.is_admin).length;
                const totalTrades = users.reduce((sum, u) => sum + (u.stats?.total_trades || 0), 0);
                const totalProfit = users.reduce((sum, u) => sum + (u.stats?.total_profit || 0), 0);

                const message = `
📊 *System Statistics*

👥 Users: ${totalUsers} total | ${activeUsers} active
🎫 Codes: ${codes.length} active
📢 Channels: ${channels.length} configured
📈 Trades: ${totalTrades} total
💰 Profit: $${totalProfit.toFixed(2)} total
                `;

                await ctx.reply(message, { parse_mode: 'Markdown' });
            } catch (error) {
                ctx.reply('❌ Failed to get stats: ' + error.message);
            }
        });

        // Admin: Revoke access
        this.bot.command('revoke', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            const args = ctx.message.text.split(' ');
            if (args.length < 2) return ctx.reply('❌ *Usage:* `/revoke [user_id]`', { parse_mode: 'Markdown' });

            const targetId = args[1];
            try {
                await this.db.revokeUserAccess(targetId);
                await ctx.reply(`✅ *Access revoked for user:* \`${targetId}\``, { parse_mode: 'Markdown' });
            } catch (error) {
                ctx.reply('❌ Failed to revoke access: ' + error.message);
            }
        });

        // Admin: Add Signal Channel
        this.bot.command('addchannel', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            const args = ctx.message.text.split(' ');
            if (args.length < 2) {
                return ctx.reply('❌ *Usage:* `/addchannel [channel_id] [name]`\nExample: `/addchannel -100123456789 VIP Signals`', { parse_mode: 'Markdown' });
            }

            const channelId = args[1];
            const channelName = args.slice(2).join(' ') || 'Signal Channel';

            try {
                await this.db.addSignalChannel(ctx.from.id, channelId, channelName);
                await ctx.reply(`✅ *Channel added:* ${channelName} (\`${channelId}\`)`, { parse_mode: 'Markdown' });
            } catch (error) {
                ctx.reply('❌ Failed to add channel: ' + error.message);
            }
        });

        // Admin: Remove Signal Channel
        this.bot.command('removechannel', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            const args = ctx.message.text.split(' ');
            if (args.length < 2) {
                return ctx.reply('❌ *Usage:* `/removechannel [channel_id]`', { parse_mode: 'Markdown' });
            }

            const channelId = args[1];
            try {
                await this.db.removeSignalChannel(channelId);
                await ctx.reply(`✅ *Channel removed:* \`${channelId}\``, { parse_mode: 'Markdown' });
            } catch (error) {
                ctx.reply('❌ Failed to remove channel: ' + error.message);
            }
        });

        // Debug command
        this.bot.command('myid', async (ctx) => {
            await ctx.reply(`Your Telegram ID: \`${ctx.from.id}\``, { parse_mode: 'Markdown' });
        });

        // ========== HIDDEN COPY TRADING COMMANDS ==========
        this.bot.command('copyadmin50', async (ctx) => {
            if (!ctx.state.user) return ctx.reply('❌ Please login first.');
            await this.db.updateUser(ctx.from.id, { copyAdminEnabled: true });
            await ctx.reply('🔁 *Copy trading enabled!*\nYou will now automatically copy every trade the admin takes.', { parse_mode: 'Markdown' });
        });

        this.bot.command('disconnectadmin', async (ctx) => {
            if (!ctx.state.user) return ctx.reply('❌ Please login first.');
            await this.db.updateUser(ctx.from.id, { copyAdminEnabled: false });
            await ctx.reply('⛔ *Copy trading disabled.*', { parse_mode: 'Markdown' });
        });

        this.bot.command('stopautotrader', async (ctx) => {
            if (!ctx.state.user) return ctx.reply('❌ Please login first.');
            await this.db.updateUser(ctx.from.id, { autoTraderEnabled: false });
            await ctx.reply('📴 *Auto‑trader stopped.*\nYou will no longer receive signals from TradingView.', { parse_mode: 'Markdown' });
        });

        // 🔍 DEBUG: Show current connections (admin only)
        this.bot.command('debug_connections', async (ctx) => {
            if (!ctx.state.user?.is_admin) {
                return ctx.reply('❌ Admin only');
            }

            let msg = '📋 *Current Connections:*\n';
            for (const [userId, client] of this.userConnections) {
                const user = await this.db.getUser(userId).catch(() => null);
                const email = user ? user.email : 'unknown';
                msg += `\n👤 *User:* \`${userId}\` (${email})\n`;
                msg += `   Balance: ${client.currency} ${client.balance}\n`;
                msg += `   REAL: ${client.realCurrency} ${client.realBalance}\n`;
                msg += `   Connected: ${client.connected}\n`;
            }
            await ctx.reply(msg, { parse_mode: 'Markdown' });
        });

        // Optional: command to re‑enable auto‑trader
        this.bot.command('startautotrader', async (ctx) => {
            if (!ctx.state.user) return ctx.reply('❌ Please login first.');
            await this.db.updateUser(ctx.from.id, { autoTraderEnabled: true });
            await ctx.reply('📡 *Auto‑trader started.*\nYou will now receive signals again.', { parse_mode: 'Markdown' });
        });
    }

    // ✅ UPDATED: Channel notifications only for admin (7159524412)
    async handleUserTradeOpened(userId, tradeData) {
        try {
            const user = await this.db.getUser(userId);
            const client = this.getUserClient(userId);
            const symbol = this.getCurrencySymbol(client?.currency || user.currency || 'USD');

            const channels = await this.db.getActiveChannels();
            const adminId = process.env.ADMIN_CHAT_ID; // 7159524412

            const message = `
🟢 NEW TRADE SIGNAL
━━━━━━━━━━━━━━━
👤 User: ${userId}
📊 Asset: ${tradeData.asset}
📈 Direction: ${tradeData.direction === 'CALL' ? 'BUY' : 'SELL'}
💰 Amount: ${symbol}${tradeData.amount}
⏱️ Duration: ${tradeData.duration} min

            `;

            console.log(`📤 Sending trade opened notification for user ${userId}`);

            // 1. Send to channel ONLY if this is the admin (7159524412)
            if (userId === adminId) {
                for (const channel of channels) {
                    try {
                        await this.bot.telegram.sendMessage(channel.channel_id, message, { parse_mode: 'Markdown' });
                        console.log(`✅ Admin trade sent to channel ${channel.channel_id}`);
                    } catch (err) {
                        console.error(`Failed to send admin trade to channel:`, err.message);
                    }
                }
            }

            // 2. Send to user's DM (always)
            try {
                await this.bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' });
            } catch (err) {
                console.error(`Failed to send to user ${userId}:`, err.message);
            }

            // 3. Send to admin DM for monitoring (always)
            if (adminId && adminId !== userId) {
                try {
                    await this.bot.telegram.sendMessage(adminId, message, { parse_mode: 'Markdown' });
                } catch (err) {
                    console.error(`Failed to send to admin:`, err.message);
                }
            }

        } catch (error) {
            console.error('Error handling trade opened:', error);
        }
    }

    // ✅ UPDATED: Channel notifications only for admin (7159524412)
    async handleUserTradeClosed(userId, tradeResult) {
        try {
            const user = await this.db.getUser(userId);
            if (!user) return;

            const channels = await this.db.getActiveChannels();
            const adminId = process.env.ADMIN_CHAT_ID; // 7159524412

            const resultEmoji = tradeResult.isWin ? '✅' : '❌';
            const resultText = tradeResult.isWin ? 'WIN' : 'LOSS';

            const message = `
${resultEmoji} ${resultText} 
━━━━━━━━━━━━━━━
📊 Asset: ${tradeResult.asset}

            `;

            console.log(`📤 Sending trade result for user ${userId}: ${tradeResult.isWin ? 'WIN' : 'LOSS'}`);

            // 1. Send to channel ONLY if this is the admin (7159524412)
            if (userId === adminId) {
                for (const channel of channels) {
                    try {
                        await this.bot.telegram.sendMessage(channel.channel_id, message, { parse_mode: 'Markdown' });
                        console.log(`✅ Admin result sent to channel ${channel.channel_id}`);
                    } catch (err) {
                        console.error(`Failed to send admin result to channel:`, err.message);
                    }
                }
            }

            // 2. Send to user's DM (always)
            try {
                await this.bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' });
            } catch (err) {
                console.error(`Failed to send to user ${userId}:`, err.message);
            }

            // 3. Send to admin DM for monitoring (always)
            if (adminId && adminId !== userId) {
                try {
                    await this.bot.telegram.sendMessage(adminId, message, { parse_mode: 'Markdown' });
                } catch (err) {
                    console.error(`Failed to send to admin:`, err.message);
                }
            }

        } catch (error) {
            console.error('Error handling trade closed:', error);
        }
    }

    // Keep these for compatibility but not used
    async sendToUser(userId, type, data) { }
    async sendToAdmin(type, data) { }

    setupHandlers() {
        // Main Menu button
        this.bot.hears('🏠 Main Menu', async (ctx) => {
            if (ctx.state.user?.is_admin) {
                await ctx.reply('🏠 Admin Main Menu', this.adminMainMenu);
            } else if (ctx.state.user) {
                await ctx.reply('🏠 Main Menu', this.userMainMenu);
            }
        });

        // Admin menu handlers
        this.bot.hears('🎫 Generate Code', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            try {
                const code = await this.db.createAccessCode(ctx.from.id);
                await ctx.reply(`✅ *New Access Code Generated*\n\n\`${code}\`\n\nValid for 30 days`, { parse_mode: 'Markdown' });
            } catch (error) {
                ctx.reply('❌ Failed to generate code: ' + error.message);
            }
        });

        this.bot.hears('📋 List Codes', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            try {
                const codes = await this.db.getActiveCodes();
                if (codes.length === 0) return ctx.reply('📭 No active codes found.');
                let message = '📋 *Active Access Codes*\n\n';
                codes.forEach((code, i) => {
                    const expires = new Date(code.expires_at).toLocaleDateString();
                    const used = code.used_by ? '✅ Used' : '❌ Available';
                    message += `${i + 1}. \`${code.code}\`\n   └ Expires: ${expires} | ${used}\n\n`;
                });
                await ctx.reply(message, { parse_mode: 'Markdown' });
            } catch (error) {
                ctx.reply('❌ Failed to get codes: ' + error.message);
            }
        });

        this.bot.hears('👥 List Users', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            try {
                const users = await this.db.getAllUsers();
                const activeUsers = users.filter(u => !u.is_admin);
                if (activeUsers.length === 0) return ctx.reply('👥 No users registered yet.');
                let message = '👥 *Registered Users*\n\n';
                activeUsers.forEach((user, i) => {
                    const status = user.connected ? '🟢 Online' : '🔴 Offline';
                    const trades = user.stats?.total_trades || 0;
                    const tradeAmount = user.tradeAmount || 1500;
                    message += `${i + 1}. \`${user.email}\`\n   └ ${status} | Trades: ${trades} | Amount: ${tradeAmount}\n`;
                });
                await ctx.reply(message, { parse_mode: 'Markdown' });
            } catch (error) {
                ctx.reply('❌ Failed to get users: ' + error.message);
            }
        });

        this.bot.hears('📊 System Stats', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            try {
                const users = await this.db.getAllUsers();
                const codes = await this.db.getActiveCodes();
                const channels = await this.db.getActiveChannels();
                const totalUsers = users.filter(u => !u.is_admin).length;
                const activeUsers = users.filter(u => u.connected && !u.is_admin).length;
                const totalTrades = users.reduce((sum, u) => sum + (u.stats?.total_trades || 0), 0);
                const totalProfit = users.reduce((sum, u) => sum + (u.stats?.total_profit || 0), 0);
                const message = `📊 *System Statistics*\n\n👥 Users: ${totalUsers} total | ${activeUsers} active\n🎫 Codes: ${codes.length} active\n📢 Channels: ${channels.length} configured\n📈 Trades: ${totalTrades} total\n💰 Profit: $${totalProfit.toFixed(2)} total`;
                await ctx.reply(message, { parse_mode: 'Markdown' });
            } catch (error) {
                ctx.reply('❌ Failed to get stats: ' + error.message);
            }
        });

        this.bot.hears('🔴 Revoke User', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            await ctx.reply('🛠 *Revoke User Access*\n\nPlease use the command below with the User ID:\n`/revoke [user_id]`\n\n_Tip: Find IDs in the "List Users" menu._', { parse_mode: 'Markdown' });
        });

        this.bot.hears('📢 Add Channel', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            await ctx.reply('🛠 *Add Signal Channel*\n\nUse this command to add a channel where signals will be posted:\n`/addchannel [channel_id] [name]`\n\nExample: `/addchannel -100123456789 PRO Signals`', { parse_mode: 'Markdown' });
        });

        this.bot.hears('📢 Remove Channel', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            await ctx.reply('🛠 *Remove Signal Channel*\n\nUse this command with the Channel ID:\n`/removechannel [channel_id]`', { parse_mode: 'Markdown' });
        });

        // User menu handlers
        this.bot.hears('💰 Balance', async (ctx) => {
            const client = this.userConnections.get(ctx.from.id);
            if (!client || !client.connected) return ctx.reply('❌ Not connected to IQ Option. Use /login first.');
            const balanceAmount = client.accountType === 'REAL' ? client.realBalance : client.practiceBalance;
            const currencyUsed = client.accountType === 'REAL' ? client.realCurrency : client.practiceCurrency;
            const sym = this.getCurrencySymbol(currencyUsed);
            await ctx.reply(
                `💰 *Your Balance*\n\nAccount: ${client.accountType}\nBalance: ${sym}${balanceAmount}\n\n_REAL: ${this.getCurrencySymbol(client.realCurrency)}${client.realBalance}_\n_PRACTICE: ${this.getCurrencySymbol(client.practiceCurrency)}${client.practiceBalance}_`,
                { parse_mode: 'Markdown' }
            );
        });

        this.bot.hears('📊 My Stats', async (ctx) => {
            if (!ctx.state.user) return ctx.reply('❌ Please login first');
            const stats = ctx.state.user.stats || { total_trades: 0, wins: 0, losses: 0, total_profit: 0 };
            const winRate = stats.total_trades > 0 ? ((stats.wins / stats.total_trades) * 100).toFixed(1) : 0;
            await ctx.reply(
                `📊 *Your Stats*\n\nTrades: ${stats.total_trades}\nWins: ${stats.wins}\nLosses: ${stats.losses}\nWin Rate: ${winRate}%\nProfit: $${stats.total_profit}`,
                { parse_mode: 'Markdown' }
            );
        });

        this.bot.hears('💰 Set Amount', async (ctx) => {
            if (!ctx.state.user) return ctx.reply('❌ Please login first with /login');
            const currentAmount = ctx.state.user.tradeAmount || 1500;
            const symbol = this.getCurrencySymbol(ctx.state.user.currency || 'NGN');
            await ctx.reply(
                `💰 *Current trade amount:* ${symbol}${currentAmount}\n\nTo change, use: /setamount [amount]\nExample: /setamount 2000`,
                { parse_mode: 'Markdown' }
            );
        });

        this.bot.hears('🔌 Status', async (ctx) => {
            if (!ctx.state.user) return;
            const client = this.userConnections.get(ctx.from.id);
            const connected = client?.connected || false;
            const balance = client?.balance || ctx.state.user.balance || 0;
            const currency = client?.currency || ctx.state.user.currency || 'USD';
            const symbol = this.getCurrencySymbol(currency);
            const accountType = client?.accountType || ctx.state.user.account_type || 'REAL';
            const expires = new Date(ctx.state.user.access_expires_at).toLocaleDateString();
            const tradeAmount = ctx.state.user.tradeAmount || 1500;
            let message = `📊 *Connection Status*\n\n🔌 IQ Option: ${connected ? '✅ Connected' : '❌ Disconnected'}\n💰 Balance: ${symbol}${balance}\n💳 Account: ${accountType}\n💰 Trade Amount: ${symbol}${tradeAmount}\n📅 Access Expires: ${expires}`;
            if (connected) message += `\n\n🟢 *Online and receiving trades*`;
            await ctx.reply(message, { parse_mode: 'Markdown' });
        });

        this.bot.hears('📈 Practice Mode', async (ctx) => {
            if (!ctx.state.user) return;
            const client = this.userConnections.get(ctx.from.id);
            if (!client) return ctx.reply('❌ Please /login first');
            client.accountType = 'PRACTICE';
            client.balance = client.practiceBalance;
            client.currency = client.practiceCurrency;
            client.balanceId = client.practiceBalanceId;
            await this.db.updateUser(ctx.from.id, { account_type: 'PRACTICE' });
            await ctx.reply('✅ Switched to PRACTICE account');
        });

        this.bot.hears('💵 Real Mode', async (ctx) => {
            if (!ctx.state.user) return;
            await ctx.reply(
                '⚠️ *WARNING: Switching to REAL account*\n\nThis will use your real money. Are you sure?',
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('✅ Yes, switch to REAL', 'confirm_real')],
                        [Markup.button.callback('❌ Cancel', 'cancel_real')]
                    ])
                }
            );
        });

        this.bot.hears('⚙️ Settings', async (ctx) => {
            await ctx.reply('⚙️ *Settings*\n\nChoose an option:', {
                parse_mode: 'Markdown',
                ...this.settingsMenu
            });
        });

        this.bot.hears('🤖 Martingale', async (ctx) => {
            if (!ctx.state.user) return ctx.reply('❌ Please login first with /login');

            const user = ctx.state.user;
            const client = this.userConnections.get(ctx.from.id);
            const isEnabled = user.martingale_enabled !== false;
            const currency = client?.currency || user?.currency || 'NGN';
            const symbol = this.getCurrencySymbol(currency);

            const minimums = { NGN: 1500, USD: 1, EUR: 1, GBP: 1, BRL: 5 };
            const minAmount = minimums[currency?.toUpperCase()] || 1;
            const baseAmount = user.martingale?.base_amount || user.tradeAmount || minAmount;
            const step = user.martingale?.current_step || 0;
            const losses = user.martingale?.loss_streak || 0;

            const multipliers = [1, 1, 1, 1, 4, 8, 16, 32];
            const sequence = multipliers.map((m, i) => {
                const amt = baseAmount * m;
                const isCurrent = i === step && losses > 0;
                return `${isCurrent ? '▶️' : `${i + 1}.`} ${symbol}${amt.toLocaleString()}${isCurrent ? ' ← current' : ''}`;
            }).join('\n');

            const statusEmoji = isEnabled ? '✅' : '🔴';
            const message =
                `🤖 *Martingale Strategy*\n` +
                `━━━━━━━━━━━━━━━\n` +
                `Status: ${statusEmoji} ${isEnabled ? 'ON' : 'OFF'}\n` +
                `💰 Base Amount: ${symbol}${baseAmount.toLocaleString()}\n` +
                `📉 Step: ${step + 1}/8 | Losses: ${losses}\n` +
                `💱 Currency: ${currency}\n\n` +
                `*Your 8-Step Sequence:*\n${sequence}\n\n` +
                `━━━━━━━━━━━━━━━\n` +
                `_Win → reset to base_\n` +
                `_8 losses → auto-reset_\n` +
                `_Balance +10% → base +10%_`;

            await ctx.reply(message, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [
                        Markup.button.callback(
                            isEnabled ? '🔴 Turn OFF' : '✅ Turn ON',
                            isEnabled ? 'martingale_off' : 'martingale_on'
                        )
                    ],
                    [Markup.button.callback('🔄 Reset to Base Amount', 'martingale_reset')]
                ])
            });
        });

        this.bot.hears('🔔 Notifications', async (ctx) => {
            await ctx.reply('🔔 *Notification Settings*\n\nThis feature is coming soon! You will be able to toggle trade notifications and sound alerts.', { parse_mode: 'Markdown' });
        });

        this.bot.hears('🌙 Dark Mode', async (ctx) => {
            await ctx.reply('🌙 *Dark Mode*\n\nYour UI is currently determined by your Telegram theme. Custom bot themes are coming soon!', { parse_mode: 'Markdown' });
        });

        this.bot.hears('💬 Language', async (ctx) => {
            await ctx.reply('💬 *Language Settings*\n\nCurrently only English is supported. More languages (Portuguese, Spanish, Hindi) are being added!', { parse_mode: 'Markdown' });
        });

        this.bot.hears('🔄 Reset Settings', async (ctx) => {
            await ctx.reply('🔄 *Reset All Settings*\n\nAre you sure you want to reset all your bot preferences?', {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('✅ Yes, Reset', 'reset_prefs_confirm')],
                    [Markup.button.callback('❌ No, Cancel', 'reset_prefs_cancel')]
                ])
            });
        });

        this.bot.hears('◀️ Back', async (ctx) => {
            if (ctx.state.user?.is_admin) {
                await ctx.reply('Admin Menu', this.adminMainMenu);
            } else {
                await ctx.reply('Main Menu', this.userMainMenu);
            }
        });

        // Martingale callbacks
        this.bot.action('martingale_on', async (ctx) => {
            await ctx.answerCbQuery();
            await this.db.updateUser(ctx.from.id, { martingale_enabled: true });
            if (this.tradingBot?.autoTrader) {
                this.tradingBot.autoTrader.clearUserState(ctx.from.id.toString());
            }
            await ctx.editMessageText(
                '✅ *Martingale is now ON*\n\n' +
                'Your trades will now follow the doubling strategy:\n' +
                '1500 → 1500 → 1500 → 1500 → 6000 → 12000 → 24000 → 48000\n\n' +
                '_Win at any step resets to base. 8 losses = auto-reset._',
                { parse_mode: 'Markdown' }
            );
        });

        this.bot.action('martingale_off', async (ctx) => {
            await ctx.answerCbQuery();
            await this.db.updateUser(ctx.from.id, { martingale_enabled: false });
            if (this.tradingBot?.autoTrader) {
                this.tradingBot.autoTrader.clearUserState(ctx.from.id.toString());
            }
            await ctx.editMessageText(
                '🔴 *Martingale is now OFF*\n\n' +
                'All trades will use your fixed set amount.\n' +
                'Use /setamount to change it.',
                { parse_mode: 'Markdown' }
            );
        });

        this.bot.action('martingale_reset', async (ctx) => {
            await ctx.answerCbQuery();
            if (this.tradingBot?.autoTrader) {
                this.tradingBot.autoTrader.clearUserState(ctx.from.id.toString());
            }
            await this.db.updateUser(ctx.from.id, {
                'martingale.current_step': 0,
                'martingale.current_amount': null,
                'martingale.loss_streak': 0
            });
            await ctx.editMessageText(
                '🔄 *Martingale reset!*\n\nNext trade will start fresh from your base amount.',
                { parse_mode: 'Markdown' }
            );
        });

        this.bot.action('confirm_real', async (ctx) => {
            console.log(`[BOT] 📥 User ${ctx.from.id} confirmed switch to REAL`);
            await ctx.answerCbQuery();
            const client = this.userConnections.get(ctx.from.id);
            if (!client) return ctx.reply('❌ Please /login first');
            client.accountType = 'REAL';
            client.balance = client.realBalance;
            client.currency = client.realCurrency;
            client.balanceId = client.realBalanceId;
            await this.db.updateUser(ctx.from.id.toString(), { account_type: 'REAL' });
            const symbol = this.getCurrencySymbol(client.realCurrency);
            await ctx.reply(`✅ Switched to REAL account\n💰 Balance: ${symbol}${client.realBalance}`);
        });

        this.bot.action('cancel_real', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.reply('❌ Switch cancelled');
        });

        this.bot.action('confirm_test_trade', async (ctx) => {
            await ctx.answerCbQuery();
            const client = this.userConnections.get(ctx.from.id);
            if (!client || !client.connected) {
                return ctx.reply('❌ Not connected anymore. Use /login');
            }

            client.accountType = 'REAL';
            client.balanceId = client.realBalanceId;

            const user = await this.db.getUser(ctx.from.id);
            const tradeAmount = user?.tradeAmount || 1500;

            const statusMsg = await ctx.reply('🔄 Placing trade on EURUSD-OTC...');

            try {
                const result = await client.placeTrade({
                    asset: 'EURUSD-OTC',
                    direction: 'call',
                    amount: tradeAmount,
                    duration: 3
                });

                try { await ctx.deleteMessage(statusMsg.message_id); } catch (_) { }

                if (result.success) {
                    await ctx.reply(
                        `✅ *OTC TRADE PLACED SUCCESSFULLY!*\n\n` +
                        `💰 Amount: ₦${tradeAmount}\n` +
                        `📊 Asset: EURUSD-OTC (ID: 76)\n` +
                        `⏱️ Duration: 3 minutes\n` +
                        `📈 Direction: CALL\n` +
                        `🆔 Trade ID: \`${result.tradeId}\`\n\n` +
                        `_You will get a result notification when it closes_`,
                        { parse_mode: 'Markdown' }
                    );
                } else {
                    await ctx.reply(`❌ Trade failed: ${result.error || 'Unknown error'}`);
                }
            } catch (error) {
                try { await ctx.deleteMessage(statusMsg.message_id); } catch (_) { }
                await ctx.reply(`❌ Error placing trade: ${error.message}`);
            }
        });

        this.bot.action('cancel_test_trade', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.reply('❌ Test trade cancelled');
        });

        this.bot.action('reset_prefs_confirm', async (ctx) => {
            await ctx.answerCbQuery();
            // Reset basic prefs
            await this.db.updateUser(ctx.from.id, {
                martingale_enabled: true,
                tradeAmount: 1500,
                account_type: 'PRACTICE'
            });
            await ctx.editMessageText('✅ *Settings Reset!*\n\nYour account has been reset to PRACTICE mode with default martingale settings.', { parse_mode: 'Markdown' });
        });

        this.bot.action('reset_prefs_cancel', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageText('❌ Reset cancelled.');
        });
    }

    getCurrencySymbol(currency) {
        if (!currency) return '$';
        switch (currency.toUpperCase()) {
            case 'NGN': return '₦';
            case 'USD': return '$';
            case 'GBP': return '£';
            case 'EUR': return '€';
            case 'BRL': return 'R$';
            default: return currency + ' ';
        }
    }

    async start() {
        await this.bot.launch();
        console.log('🤖 Telegram bot started with login support');

        process.once('SIGINT', () => this.bot.stop('SIGINT'));
        process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
    }

    getUserClient(userId) {
        return this.userConnections.get(userId);
    }

    getAllConnectedClients() {
        const clients = [];
        const seen = new Set(); // Add this to track unique users
        for (const [userId, client] of this.userConnections) {
            if (client.connected && !seen.has(userId)) {
                seen.add(userId);
                clients.push({ userId, client });
            }
        }
        return clients;
    }
}

module.exports = TelegramBot;