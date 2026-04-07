const fs = require('fs');
const webapp = require('../api/webapp');

class AutoTrader {
    constructor(telegramBot, db) {
        this.telegramBot = telegramBot;
        this.db = db;

        // Martingale step multipliers: 
        this.martingaleMultipliers = [1, 1, 2, 4, 8,];
        this.MAX_STEPS = 5;

        // In-memory state per user
        this.activeTrades = new Map();

        // Track open positions per user
        this.openPositions = new Map(); // userId -> tradeId

        // Track last trade close time per user (for cooldown)
        this.lastTradeCloseTime = new Map(); // userId -> timestamp

        // Minimum AND MAXIMUM trade amounts per currency
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
        // FIRST: Check if we have fresh state in memory
        const memoryState = this.activeTrades.get(userId);
        if (memoryState && memoryState.currency === currency && memoryState.baseAmount === this.getBaseAmount(user, currency)) {
            console.log(`📊 User ${userId}: Using memory state - losses=${memoryState.losses}, step=${memoryState.step}, amount=${memoryState.currentAmount}`);
            return memoryState;
        }

        // Otherwise load from database
        const base = this.getBaseAmount(user, currency);
        const db = user?.martingale || {};

        // Get losses from database
        let losses = db.loss_streak || 0;

        // Calculate step based on losses: step = losses (capped)
        let step = Math.min(losses, this.martingaleMultipliers.length - 1);
        let amount = base * this.martingaleMultipliers[step];

        const max = this.getCurrencyMax(currency);
        if (amount > max) amount = max;

        const state = {
            step: step,
            losses: losses,
            baseAmount: base,
            currentAmount: amount,
            initialBalance: db.initial_balance || 0,
            currency: currency
        };

        this.activeTrades.set(userId, state);
        console.log(`📊 User ${userId}: DB loaded - losses=${state.losses}, step=${state.step}, amount=${state.currentAmount}`);
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

        // Increase loss counter
        state.losses++;

        if (state.losses >= this.MAX_STEPS) {
            console.log(`🔄 User ${userId}: 8 consecutive losses. Resetting martingale.`);
            this.resetMartingale(userId, state);
        } else {
            // CORRECT: next step = number of losses (capped)
            state.step = Math.min(state.losses, this.martingaleMultipliers.length - 1);
            const multiplier = this.martingaleMultipliers[state.step];
            let newAmount = state.baseAmount * multiplier;

            const max = this.getCurrencyMax(state.currency);
            if (newAmount > max) {
                console.log(`⚠️ User ${userId}: Martingale would exceed max amount. Capping at ${max}`);
                newAmount = max;
            }
            state.currentAmount = newAmount;

            console.log(`📉 User ${userId} loss streak: ${state.losses} | Next: ${state.currentAmount} (Step ${state.step + 1}/8) - Multiplier: ${multiplier}x`);
            this.activeTrades.set(userId, state);
        }
    }

    checkBalanceGrowth(userId, state, currentBalance) {
        // COMPLETELY DISABLED - No auto-balance changes
        return false;
    }

    async executeTrade(userId, client, signal) {
        try {
            console.log(`🔍 Step 1: Checking open position for ${userId}`);
            if (this.openPositions.has(userId)) {
                const openTradeId = this.openPositions.get(userId);
                console.log(`⏸️ User ${userId} has OPEN position (Trade ID: ${openTradeId}). IGNORING signal.`);
                return { success: false, error: 'User has open position - trade blocked' };
            }

            console.log(`🔍 Step 2: Checking cooldown for ${userId}`);
            if (this.lastTradeCloseTime.has(userId)) {
                const timeSinceLastClose = Date.now() - this.lastTradeCloseTime.get(userId);
                if (timeSinceLastClose < 10000) {
                    console.log(`⏸️ User ${userId} traded ${timeSinceLastClose}ms ago. IGNORING signal (10s cooldown).`);
                    return { success: false, error: `Cooldown active - wait ${10 - Math.floor(timeSinceLastClose / 1000)}s` };
                }
            }

            console.log(`🔍 Step 3: Checking connection status for ${userId}`);
            console.log(`🔍 Connected: ${client?.connected}, ws readyState: ${client?.ws?.readyState}`);

            // Point 4: Check if balanceId exists
            if (!client.balanceId) {
                console.log(`❌ User ${userId} has no balanceId, refreshing profile...`);
                client.refreshProfile();
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            const user = await this.db.getUser(userId);
            const martingaleEnabled = user?.martingale_enabled !== false;
            const webSettings = null; // Forced null for now

            const currency = client?.currency || user?.currency || 'USD';
            const min = this.getCurrencyMin(currency);

            let tradeAmount;
            let state = null;

            if (martingaleEnabled) {
                // Use web settings trade amount as base if available
                const baseAmount = (webSettings && webSettings.tradeAmount) ? webSettings.tradeAmount : this.getBaseAmount(user, currency);
                if (webSettings && webSettings.tradeAmount) console.log(`🌐 Using web app trade amount as base: ${baseAmount}`);
                
                state = this.getMartingaleState(userId, user, currency);
                
                // Update state with new base if it changed
                if (state.baseAmount !== baseAmount) {
                    console.log(`🔄 Base amount changed from ${state.baseAmount} to ${baseAmount}. Updating state.`);
                    state.baseAmount = baseAmount;
                    state.currentAmount = baseAmount * this.martingaleMultipliers[state.step];
                    this.activeTrades.set(userId, state);
                }

                if (state.initialBalance === 0 && client.balance > 0) {
                    state.initialBalance = client.balance;
                    this.activeTrades.set(userId, state);
                }

                this.checkBalanceGrowth(userId, state, client.balance || 0);
                tradeAmount = state.currentAmount;
            } else {
                if (webSettings && webSettings.tradeAmount) {
                    tradeAmount = webSettings.tradeAmount;
                    console.log(`🌐 Using web app trade amount: ${tradeAmount}`);
                } else {
                    tradeAmount = user?.tradeAmount || min;
                    console.log(`📁 Using local trade amount: ${tradeAmount}`);
                }
            }

            tradeAmount = this.validateAmount(tradeAmount, currency);

            if (client.balance < tradeAmount) {
                return {
                    success: false,
                    error: `Insufficient balance. Need ${currency} ${tradeAmount.toLocaleString()}, have ${currency} ${client.balance.toLocaleString()}`
                };
            }

            console.log(`💰 Placing ${signal.direction} trade for user ${userId} — ${currency}${tradeAmount} [Martingale: ${martingaleEnabled ? 'ON' : 'OFF'}]`);

            const result = await client.placeTrade({
                asset: signal.asset || 'EURUSD-OTC',
                direction: signal.direction,
                amount: tradeAmount,
                duration: signal.duration
            });

            if (!result.success) {
                return { success: false, error: result.error };
            }

            this.openPositions.set(userId, result.tradeId);
            console.log(`🔒 User ${userId} now has OPEN position: ${result.tradeId}`);

            const tradeInfo = {
                userId,
                tradeId: result.tradeId,
                amount: tradeAmount,
                direction: signal.direction,
                duration: signal.duration,
                currency,
                martingaleEnabled,
                timestamp: Date.now()
            };

            this.trackTradeResult(userId, client, tradeInfo);
            return { success: true, tradeId: result.tradeId, amount: tradeAmount };

        } catch (error) {
            console.error(`Trade execution error for user ${userId}:`, error);
            return { success: false, error: error.message };
        }
    }

    trackTradeResult(userId, client, tradeInfo) {
        const checkResult = (position) => {
            if (position.external_id == tradeInfo.tradeId || position.id == tradeInfo.tradeId) {
                if (position.status === 'closed') {
                    client.ws?.removeListener('message', messageHandler);
                    this.handleTradeResult(userId, position, tradeInfo);
                }
            }
        };

        const messageHandler = (data) => {
            try {
                const msg = JSON.parse(data);
                if (msg.name === 'position-changed') {
                    checkResult(msg.msg);
                }
            } catch (e) { }
        };

        client.ws?.on('message', messageHandler);

        const durationMs = (tradeInfo.duration > 0) ? tradeInfo.duration * 60 * 1000 : 5 * 60 * 1000;
        setTimeout(() => {
            client.ws?.removeListener('message', messageHandler);
            console.log(`⏰ Trade ${tradeInfo.tradeId} timeout (waited ${durationMs / 60000} min)`);

            if (this.openPositions.has(userId) && this.openPositions.get(userId) === tradeInfo.tradeId) {
                this.openPositions.delete(userId);
                console.log(`🔓 User ${userId} open position cleared (timeout)`);
            }
        }, durationMs + 30000);
    }

    async handleTradeResult(userId, position, tradeInfo) {
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

            if (this.openPositions.has(userId)) {
                this.openPositions.delete(userId);
                console.log(`🔓 User ${userId} open position cleared (trade closed)`);
            }

            this.lastTradeCloseTime.set(userId, Date.now());
            console.log(`⏱️ User ${userId} cooldown started - 10 seconds`);

            let state = this.activeTrades.get(userId);
            if (!state) {
                const base = this.getBaseAmount(user, currency);
                state = { step: 0, losses: 0, baseAmount: base, currentAmount: base, initialBalance: 0, currency };
            }

            // Update martingale based on result
            if (martingaleEnabled) {
                if (isWin) {
                    console.log(`✅ User ${userId} WIN ${currencySymbol}${profit.toFixed(2)}. Resetting martingale to base ${currencySymbol}${state.baseAmount}`);
                    this.resetMartingale(userId, state);
                } else {
                    this.advanceMartingale(userId, state);
                }
            }

            // Update database - AWAIT to ensure completion
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

                console.log(`📝 User ${userId}: Database saved - losses=${state.losses}, step=${state.step}, amount=${state.currentAmount}`);
            }

            // Send notifications
            if (user && this.telegramBot) {
                const stepDisplay = martingaleEnabled
                    ? (isWin
                        ? `↩️ Reset to ${currencySymbol}${state.currentAmount}`
                        : `📉 Loss ${state.losses}/8 → Next: ${currencySymbol}${state.currentAmount}`)
                    : `🔴 Martingale OFF`;

                const message = `
${isWin ? '✅' : '❌'} *Trade Result*
━━━━━━━━━━━━━━━
💰 Amount: ${currencySymbol}${investment}
💵 ${isWin ? `Profit: +${currencySymbol}${profit.toFixed(2)}` : `Loss: -${currencySymbol}${investment}`}
🎯 Result: ${isWin ? 'WIN 🎉' : 'LOSS'}
${stepDisplay}
━━━━━━━━━━━━━━━`;

                try {
                    await this.telegramBot.bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' });
                } catch (e) {
                    console.error(`Failed to notify user ${userId}:`, e.message);
                }

                const adminId = process.env.ADMIN_CHAT_ID;
                if (adminId) {
                    const adminMsg = `${message}\n👤 User: ${user.email}`;
                    try {
                        await this.telegramBot.bot.telegram.sendMessage(adminId, adminMsg, { parse_mode: 'Markdown' });
                    } catch (e) { }
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
🤖 Martingale active • Max 8 steps • Auto-reset
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