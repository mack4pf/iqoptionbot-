const fs = require('fs');

class AutoTrader {
    constructor(telegramBot, db) {
        this.telegramBot = telegramBot;
        this.db = db;

        // Martingale step multipliers: 1x, 1x, 1x, 1x, 4x, 8x, 16x, 32x
        this.martingaleMultipliers = [1, 1, 1, 1, 4, 8, 16, 32];
        this.MAX_STEPS = 8;

        // In-memory state per user
        this.activeTrades = new Map();

        // Track open positions per user
        this.openPositions = new Map(); // userId -> tradeId

        // Track last trade close time per user (for cooldown)
        this.lastTradeCloseTime = new Map(); // userId -> timestamp

        // Minimum AND MAXIMUM trade amounts per currency
        this.currencyLimits = {
            NGN: { min: 1500, max: 500000 },  // Nigerian Naira
            USD: { min: 1, max: 1000 },        // US Dollar
            EUR: { min: 1, max: 1000 },        // Euro
            GBP: { min: 1, max: 1000 },        // British Pound
            BRL: { min: 5, max: 5000 },        // Brazilian Real
            INR: { min: 70, max: 70000 },       // Indian Rupee
            MXN: { min: 20, max: 20000 },       // Mexican Peso
            AED: { min: 5, max: 5000 },         // UAE Dirham
            ZAR: { min: 20, max: 20000 },       // South African Rand
        };
    }

    // ─────────────────────────────────────────
    // CURRENCY HELPERS
    // ─────────────────────────────────────────

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

        // Validate the amount against currency limits
        return this.validateAmount(userSet || min, currency);
    }

    // ─────────────────────────────────────────
    // MARTINGALE STATE
    // ─────────────────────────────────────────

    getMartingaleState(userId, user, currency) {
        if (this.activeTrades.has(userId)) {
            return this.activeTrades.get(userId);
        }

        const base = this.getBaseAmount(user, currency);
        const db = user?.martingale || {};

        const storedBase = db.base_amount || base;
        const baseChanged = storedBase !== base;

        const state = {
            step: baseChanged ? 0 : (db.current_step || 0),
            losses: baseChanged ? 0 : (db.loss_streak || 0),
            baseAmount: base,
            currentAmount: baseChanged ? base : (db.current_amount || base),
            initialBalance: db.initial_balance || 0,
            currency: currency,
        };

        this.activeTrades.set(userId, state);
        return state;
    }

    resetMartingale(userId, state) {
        state.step = 0;
        state.losses = 0;
        state.currentAmount = state.baseAmount;
        this.activeTrades.set(userId, state);
    }

    advanceMartingale(userId, state) {
        state.losses++;
        if (state.losses >= this.MAX_STEPS) {
            console.log(`🔄 User ${userId}: 8 consecutive losses. Resetting martingale.`);
            this.resetMartingale(userId, state);
        } else {
            state.step = Math.min(state.step + 1, this.martingaleMultipliers.length - 1);
            state.currentAmount = state.baseAmount * this.martingaleMultipliers[state.step];

            // Ensure we don't exceed max amount
            const max = this.getCurrencyMax(state.currency);
            if (state.currentAmount > max) {
                console.log(`⚠️ User ${userId}: Martingale would exceed max amount. Capping at ${max}`);
                state.currentAmount = max;
            }

            console.log(`📉 User ${userId} loss streak: ${state.losses} | Next: ${state.currentAmount} (Step ${state.step + 1}/8)`);
            this.activeTrades.set(userId, state);
        }
    }

    checkBalanceGrowth(userId, state, currentBalance) {
        if (state.initialBalance > 0 && currentBalance >= state.initialBalance * 1.10) {
            let newBase = Math.round(state.baseAmount * 1.10);

            // Ensure new base doesn't exceed max
            const max = this.getCurrencyMax(state.currency);
            if (newBase > max) newBase = max;

            console.log(`📈 User ${userId}: Balance grew 10%! Boosting base ${state.baseAmount} → ${newBase}`);
            state.baseAmount = newBase;
            state.initialBalance = currentBalance;
            state.currentAmount = newBase;
            state.step = 0;
            state.losses = 0;
            this.activeTrades.set(userId, state);
            return true;
        }
        return false;
    }

    // ─────────────────────────────────────────
    // EXECUTE TRADE
    // ─────────────────────────────────────────

    async executeTrade(userId, client, signal) {
        try {
            // Check if user has an open position
            if (this.openPositions.has(userId)) {
                const openTradeId = this.openPositions.get(userId);
                console.log(`⏸️ User ${userId} has OPEN position (Trade ID: ${openTradeId}). IGNORING signal.`);
                return {
                    success: false,
                    error: 'User has open position - trade blocked'
                };
            }

            // Check 10 second cooldown after last trade close
            if (this.lastTradeCloseTime.has(userId)) {
                const timeSinceLastClose = Date.now() - this.lastTradeCloseTime.get(userId);
                if (timeSinceLastClose < 10000) { // 10 seconds
                    console.log(`⏸️ User ${userId} traded ${timeSinceLastClose}ms ago. IGNORING signal (10s cooldown).`);
                    return {
                        success: false,
                        error: `Cooldown active - wait ${10 - Math.floor(timeSinceLastClose / 1000)}s`
                    };
                }
            }

            const user = await this.db.getUser(userId);
            const martingaleEnabled = user?.martingale_enabled !== false;

            // IMPORTANT: Get currency from client first, then fallback to user
            const currency = client?.currency || user?.currency || 'USD';
            const min = this.getCurrencyMin(currency);
            const max = this.getCurrencyMax(currency);

            let tradeAmount;

            if (martingaleEnabled) {
                const state = this.getMartingaleState(userId, user, currency);
                // Store currency in state for later use
                state.currency = currency;

                if (state.initialBalance === 0 && client.balance > 0) {
                    state.initialBalance = client.balance;
                    this.activeTrades.set(userId, state);
                }

                this.checkBalanceGrowth(userId, state, client.balance || 0);

                tradeAmount = state.currentAmount;
            } else {
                tradeAmount = user?.tradeAmount || min;
            }

            // Validate amount against currency limits
            tradeAmount = this.validateAmount(tradeAmount, currency);

            if (client.balance < tradeAmount) {
                return {
                    success: false,
                    error: `Insufficient balance. Need ${currency} ${tradeAmount.toLocaleString()}, have ${currency} ${client.balance.toLocaleString()}`
                };
            }

            console.log(`💰 Placing ${signal.direction} trade for user ${userId} — ${currency}${tradeAmount} [Martingale: ${martingaleEnabled ? 'ON' : 'OFF'}]`);
            console.log(`🔍 Duration: ${signal.duration} minutes | Asset: ${signal.asset}`);

            const result = await client.placeTrade({
                asset: signal.asset || 'EURUSD-OTC',
                direction: signal.direction,
                amount: tradeAmount,
                duration: signal.duration
            });

            if (!result.success) {
                return { success: false, error: result.error };
            }

            // Track open position
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

    // ─────────────────────────────────────────
    // TRACK TRADE RESULT
    // ─────────────────────────────────────────

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

    // ─────────────────────────────────────────
    // HANDLE RESULT + MARTINGALE UPDATE
    // ─────────────────────────────────────────

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

            // Remove from open positions
            if (this.openPositions.has(userId)) {
                this.openPositions.delete(userId);
                console.log(`🔓 User ${userId} open position cleared (trade closed)`);
            }

            // Set last trade close time for cooldown
            this.lastTradeCloseTime.set(userId, Date.now());
            console.log(`⏱️ User ${userId} cooldown started - 10 seconds`);

            // Martingale Update
            let state = this.activeTrades.get(userId);
            if (!state) {
                const base = this.getBaseAmount(user, currency);
                state = { step: 0, losses: 0, baseAmount: base, currentAmount: base, initialBalance: 0, currency };
            }

            if (martingaleEnabled) {
                if (isWin) {
                    console.log(`✅ User ${userId} WIN ${currencySymbol}${profit.toFixed(2)}. Resetting martingale to base ${currencySymbol}${state.baseAmount}`);
                    this.resetMartingale(userId, state);
                } else {
                    this.advanceMartingale(userId, state);
                }
            }

            // Update Stats in DB
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

            // Send Notification
            if (user && this.telegramBot) {
                const stepDisplay = martingaleEnabled
                    ? (isWin
                        ? `↩️ Reset to ${currencySymbol}${state.currentAmount}`
                        : `📉 Step ${state.step + 1}/8 → Next: ${currencySymbol}${state.currentAmount}`)
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

                // Admin notification removed to prevent spam (sent via master signal logic)
            }

        } catch (error) {
            console.error('Error handling trade result:', error);
        }
    }

    // ─────────────────────────────────────────
    // SIGNAL MESSAGE FORMAT
    // ─────────────────────────────────────────

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

    // ─────────────────────────────────────────
    // UTILITY
    // ─────────────────────────────────────────

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