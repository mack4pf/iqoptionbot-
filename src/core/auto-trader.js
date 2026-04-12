const fs = require('fs');

const { checkSubscription } = require('../utils/webapp');

class AutoTrader {
    constructor(telegramBot, db) {
        this.telegramBot = telegramBot;
        this.db = db;

        // Hardcoded martingale multipliers: 1x, 1x, 2x, 4x, 8x (5 steps)
        this.martingaleMultipliers = [1, 1, 2, 4, 8];
        this.MAX_STEPS = 5;

        this.activeTrades = new Map();
        this.openPositions = new Map();
        this.lastTradeCloseTime = new Map();

        this.currencyLimits = {
            NGN: { min: 1500, max: 50000000 },
            USD: { min: 1, max: 10000000 },
            EUR: { min: 1, max: 100000 },
            GBP: { min: 1, max: 100000 },
            BRL: { min: 5, max: 500000 },
            INR: { min: 70, max: 7000000 },
            MXN: { min: 20, max: 2000000 },
            AED: { min: 5, max: 500000 },
            ZAR: { min: 20, max: 2000000 },
        };
    }

    getCurrencyMin(currency) {
        return this.currencyLimits[(currency || 'USD').toUpperCase()]?.min || 1;
    }

    getCurrencyMax(currency) {
        return this.currencyLimits[(currency || 'USD').toUpperCase()]?.max || 1000;
    }

    validateAmount(amount, currency) {
        const min = this.getCurrencyMin(currency);
        const max = this.getCurrencyMax(currency);
        if (amount < min) return min;
        if (amount > max) return max;
        return amount;
    }

    getBaseAmount(user, currency) {
        const min = this.getCurrencyMin(currency);
        const userSet = user?.tradeAmount;
        return this.validateAmount(userSet || min, currency);
    }

    getMartingaleState(userId, user, currency) {
        let state = this.activeTrades.get(userId);
        if (state && state.currency === currency) {
            console.log(`📊 User ${userId}: Using memory state - losses=${state.losses}, step=${state.step}, amount=${state.currentAmount}`);
            return state;
        }
        const base = this.getBaseAmount(user, currency);
        const dbState = user?.martingale || {};
        let losses = dbState.loss_streak || 0;
        let step = Math.min(losses, this.martingaleMultipliers.length - 1);
        let amount = base * this.martingaleMultipliers[step];
        const max = this.getCurrencyMax(currency);
        if (amount > max) amount = max;
        state = {
            step, losses, baseAmount: base, currentAmount: amount,
            initialBalance: dbState.initial_balance || 0, currency
        };
        this.activeTrades.set(userId, state);
        console.log(`📊 User ${userId}: DB loaded - losses=${losses}, step=${step}, amount=${amount}`);
        return state;
    }

    resetMartingale(userId, state) {
        console.log(`🔄 Resetting martingale for user ${userId}`);
        console.log(`   BEFORE: step=${state.step}, losses=${state.losses}, amount=${state.currentAmount}`);
        state.step = 0;
        state.losses = 0;
        state.currentAmount = state.baseAmount;
        console.log(`   AFTER: step=${state.step}, losses=${state.losses}, amount=${state.currentAmount}`);
        this.activeTrades.set(userId, state);
    }

    advanceMartingale(userId, state) {
        console.log(`📊 User ${userId} BEFORE advance: step=${state.step}, losses=${state.losses}, amount=${state.currentAmount}`);
        state.losses++;
        if (state.losses >= this.MAX_STEPS) {
            console.log(`🔄 User ${userId}: ${this.MAX_STEPS} consecutive losses. Resetting martingale.`);
            this.resetMartingale(userId, state);
        } else {
            const newStep = Math.min(state.losses, this.martingaleMultipliers.length - 1);
            const multiplier = this.martingaleMultipliers[newStep];
            let newAmount = state.baseAmount * multiplier;
            const max = this.getCurrencyMax(state.currency);
            if (newAmount > max) newAmount = max;
            console.log(`📈 User ${userId}: loss streak=${state.losses} → step=${newStep}, multiplier=${multiplier}x, next amount=${newAmount}`);
            state.step = newStep;
            state.currentAmount = newAmount;
            this.activeTrades.set(userId, state);
        }
    }

    checkBalanceGrowth(userId, state, currentBalance) {
        return false;
    }

    async executeTrade(userId, client, signal) {
        try {
            if (this.openPositions.has(userId)) {
                console.log(`⏸️ User ${userId} has OPEN position. IGNORING signal.`);
                return { success: false, error: 'User has open position' };
            }
            if (this.lastTradeCloseTime.has(userId)) {
                const timeSince = Date.now() - this.lastTradeCloseTime.get(userId);
                if (timeSince < 10000) {
                    console.log(`⏸️ User ${userId} cooldown active.`);
                    return { success: false, error: 'Cooldown active' };
                }
            }
            if (!client.balanceId) {
                console.log(`❌ User ${userId} has no balanceId, refreshing...`);
                client.refreshProfile();
            }
            const user = await this.db.getUser(userId);
            if (!user) return { success: false, error: 'User not found' };

            // NOJAI Webapp Subscription Check
            if (user.email) {
                try {
                    const subStatus = await checkSubscription(user.email);
                    if (!subStatus || !subStatus.valid) {
                        console.log(`⛔ Subscription invalid/expired for ${user.email}. Skipping trade.`);
                        return { success: false, error: 'Subscription invalid' };
                    }
                    // Optional: fetch user credentials/settings if needed here, 
                    // though getCredentials is usually for login.
                } catch (err) {
                    console.error('Subscription check failed, assuming invalid:', err.message);
                    return { success: false, error: 'Subscription check failed' };
                }
            }

            // Fetch settings from WebApp to ensure we have latest config
            let webSettings = null;
            if (user.email) {
                try {
                    webSettings = await getCredentials(user.email);
                    if (webSettings) {
                        console.log(`🌐 Synced trade settings from WebApp for ${user.email}`);
                    }
                } catch (err) {
                    console.log(`⚠️ WebApp settings fetch failed for ${user.email}:`, err.message);
                }
            }

            let martingaleEnabled = user.martingale_enabled !== false;
            if (webSettings?.martingaleEnabled !== undefined) martingaleEnabled = webSettings.martingaleEnabled;

            const currency = client?.currency || user.currency || 'USD';
            const min = this.getCurrencyMin(currency);
            let tradeAmount;
            let state = null;
            if (martingaleEnabled) {
                let baseAmount = this.getBaseAmount(user, currency);
                if (webSettings?.tradeAmount) baseAmount = webSettings.tradeAmount;
                state = this.getMartingaleState(userId, user, currency);
                if (state.baseAmount !== baseAmount) {
                    state.baseAmount = baseAmount;
                    state.currentAmount = baseAmount * this.martingaleMultipliers[state.step];
                    this.activeTrades.set(userId, state);
                }
                if (state.initialBalance === 0 && client.balance > 0) {
                    state.initialBalance = client.balance;
                    this.activeTrades.set(userId, state);
                }
                tradeAmount = state.currentAmount;
            } else {
                tradeAmount = webSettings?.tradeAmount || user.tradeAmount || min;
            }
            tradeAmount = this.validateAmount(tradeAmount, currency);
            if (client.balance < tradeAmount) {
                return { success: false, error: `Insufficient balance: ${client.balance} < ${tradeAmount}` };
            }
            console.log(`💰 Placing ${signal.direction} trade for ${userId} — ${currency}${tradeAmount}`);
            const result = await client.placeTrade({
                asset: signal.asset || 'EURUSD-OTC',
                direction: signal.direction,
                amount: tradeAmount,
                duration: signal.duration
            });
            if (!result.success) return { success: false, error: result.error };
            this.openPositions.set(userId, result.tradeId);
            const tradeInfo = { userId, tradeId: result.tradeId, amount: tradeAmount, direction: signal.direction, duration: signal.duration, currency, martingaleEnabled, timestamp: Date.now() };
            this.trackTradeResult(userId, client, tradeInfo);
            return { success: true, tradeId: result.tradeId, amount: tradeAmount };
        } catch (error) {
            console.error(`Trade error for ${userId}:`, error);
            return { success: false, error: error.message };
        }
    }

    trackTradeResult(userId, client, tradeInfo) {
        console.log(`📡 Tracking trade ${tradeInfo.tradeId} for user ${userId}`);
        const durationMs = (tradeInfo.duration > 0) ? tradeInfo.duration * 60 * 1000 : 5 * 60 * 1000;
        setTimeout(() => {
            if (this.openPositions.get(userId) === tradeInfo.tradeId) {
                this.openPositions.delete(userId);
                console.log(`⏰ Trade ${tradeInfo.tradeId} cleared by safety timeout.`);
            }
        }, durationMs + 60000);
    }

    async handleTradeResult(userId, position, tradeInfo) {
        if (tradeInfo.tradeId && position.id && position.id !== tradeInfo.tradeId) return;
        try {
            const investment = position.invest || position.raw_event?.amount || tradeInfo.amount;
            const isWin = position.raw_event?.result === 'win' || position.close_reason === 'win';
            let profit = 0;
            if (isWin) {
                const totalPayout = position.close_profit || position.raw_event?.profit_amount || 0;
                profit = totalPayout > investment ? totalPayout - investment : totalPayout;
            }
            const user = await this.db.getUser(userId);
            const martingaleEnabled = user?.martingale_enabled !== false;
            const currency = tradeInfo.currency || position.currency || 'USD';
            const currencySymbol = this.getCurrencySymbol(currency);
            this.openPositions.delete(userId);
            this.lastTradeCloseTime.set(userId, Date.now());
            let state = this.activeTrades.get(userId);
            if (!state) {
                const base = this.getBaseAmount(user, currency);
                state = { step: 0, losses: 0, baseAmount: base, currentAmount: base, initialBalance: 0, currency };
            }
            if (martingaleEnabled) {
                if (isWin) {
                    console.log(`✅ User ${userId} WIN. Resetting martingale.`);
                    this.resetMartingale(userId, state);
                } else {
                    console.log(`❌ User ${userId} LOSS. Advancing martingale.`);
                    this.advanceMartingale(userId, state);
                }
            }
            if (user) {
                const stats = user.stats || { total_trades: 0, wins: 0, losses: 0, total_profit: 0 };
                stats.total_trades++;
                if (isWin) {
                    stats.wins++;
                    stats.total_profit += profit;
                } else {
                    stats.losses++;
                    stats.total_profit -= investment;
                }
                await this.db.updateUser(userId, {
                    stats,
                    martingale: {
                        current_step: state.step,
                        current_amount: state.currentAmount,
                        loss_streak: state.losses,
                        base_amount: state.baseAmount,
                        initial_balance: state.initialBalance
                    }
                });
            }
            if (user && this.telegramBot) {
                const stepDisplay = martingaleEnabled ? (isWin ? `↩️ Reset to ${currencySymbol}${state.currentAmount}` : `📉 Loss ${state.losses}/${this.MAX_STEPS} → Next: ${currencySymbol}${state.currentAmount}`) : '🔴 Martingale OFF';
                const message = `${isWin ? '✅' : '❌'} *Trade Result*\n━━━━━━━━━━━━━━━\n💰 Amount: ${currencySymbol}${investment}\n💵 ${isWin ? `Profit: +${currencySymbol}${profit.toFixed(2)}` : `Loss: -${currencySymbol}${investment}`}\n🎯 Result: ${isWin ? 'WIN 🎉' : 'LOSS'}\n${stepDisplay}\n━━━━━━━━━━━━━━━`;
                try {
                    await this.telegramBot.bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' });
                } catch (e) { console.error(`Failed to notify user ${userId}:`, e.message); }
                const adminId = process.env.ADMIN_CHAT_ID;
                if (adminId) {
                    const adminMsg = `${message}\n👤 User: ${user.email}`;
                    try { await this.telegramBot.bot.telegram.sendMessage(adminId, adminMsg, { parse_mode: 'Markdown' }); } catch (e) {}
                }
            }
        } catch (error) {
            console.error('Error handling trade result:', error);
        }
    }

    formatSignalMessage(signal, userCount) {
        const emoji = signal.direction === 'call' ? '🟢' : '🔴';
        const direction = signal.direction === 'call' ? 'BUY' : 'SELL';
        return `
${emoji} *AUTO-TRADE SIGNAL*
━━━━━━━━━━━━━━━
📊 Asset: ${signal.asset || 'EURUSD-OTC'}
📈 Direction: ${direction}
⏱️ Duration: ${signal.duration || 5} min
👥 Executing for: ${userCount} users
🕐 Time: ${new Date().toLocaleTimeString()}
━━━━━━━━━━━━━━━
🤖 Martingale active • Max ${this.MAX_STEPS} steps • Auto-reset
        `;
    }

    getCurrencySymbol(currency) {
        const symbols = { NGN: '₦', USD: '$', EUR: '€', GBP: '£', BRL: 'R$' };
        return symbols[(currency || '').toUpperCase()] || (currency + ' ');
    }

    getMartingaleStatus(userId) {
        return this.activeTrades.get(userId) || { step: 0, losses: 0, currentAmount: null, baseAmount: null };
    }

    clearUserState(userId) {
        this.activeTrades.delete(userId);
        this.openPositions.delete(userId);
        this.lastTradeCloseTime.delete(userId);
    }
}

module.exports = AutoTrader;