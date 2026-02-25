const ChartGenerator = require('../services/chart-generator');
const fs = require('fs');

class AutoTrader {
    constructor(telegramBot, db) {
        this.telegramBot = telegramBot;
        this.db = db;
        this.chartGen = new ChartGenerator();

        // Martingale step multipliers: 1x, 2x, 4x, 8x, 16x, 32x
        // e.g. base=1500 → 1500, 3000, 6000, 12000, 24000, 48000
        this.martingaleMultipliers = [1, 2, 4, 8, 16, 32];
        this.MAX_STEPS = 6; // After 6 losses, reset

        // In-memory state per user (userId -> martingale state)
        this.activeTrades = new Map();

        // Minimum trade amounts per currency (IQ Option rules)
        this.currencyMinimums = {
            NGN: 1500,  // Nigerian Naira
            USD: 1,     // US Dollar
            EUR: 1,     // Euro
            GBP: 1,     // British Pound
            BRL: 5,     // Brazilian Real
            INR: 70,    // Indian Rupee
            MXN: 20,    // Mexican Peso
            AED: 5,     // UAE Dirham
            ZAR: 20,    // South African Rand
        };
    }

    // ─────────────────────────────────────────
    // CURRENCY HELPERS
    // ─────────────────────────────────────────

    getCurrencyMinimum(currency) {
        return this.currencyMinimums[(currency || 'USD').toUpperCase()] || 1;
    }

    getBaseAmount(user, currency) {
        const min = this.getCurrencyMinimum(currency);
        const userSet = user?.tradeAmount;
        // Use user's custom amount only if it's ≥ the currency minimum
        return (userSet && userSet >= min) ? userSet : min;
    }

    // ─────────────────────────────────────────
    // MARTINGALE STATE
    // ─────────────────────────────────────────

    getMartingaleState(userId, user, currency) {
        // Check in-memory first
        if (this.activeTrades.has(userId)) {
            return this.activeTrades.get(userId);
        }

        // Rebuild from DB
        const base = this.getBaseAmount(user, currency);
        const db = user?.martingale || {};

        const state = {
            step: db.current_step || 0,
            losses: db.loss_streak || 0,
            baseAmount: db.base_amount || base,
            currentAmount: db.current_amount || base,
            initialBalance: db.initial_balance || 0,
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
            // Hit max steps — reset to protect balance
            console.log(`🔄 User ${userId}: 6 consecutive losses. Resetting martingale.`);
            this.resetMartingale(userId, state);
        } else {
            state.step = Math.min(state.step + 1, this.martingaleMultipliers.length - 1);
            state.currentAmount = state.baseAmount * this.martingaleMultipliers[state.step];
            console.log(`📉 User ${userId} loss streak: ${state.losses} | Next: ${state.currentAmount} (Step ${state.step + 1}/6)`);
            this.activeTrades.set(userId, state);
        }
    }

    checkBalanceGrowth(userId, state, currentBalance) {
        // If balance grew 10%+ from the last recorded baseline → bump base amount by 10%
        if (state.initialBalance > 0 && currentBalance >= state.initialBalance * 1.10) {
            const newBase = Math.round(state.baseAmount * 1.10);
            console.log(`📈 User ${userId}: Balance grew 10%! Boosting base ${state.baseAmount} → ${newBase}`);
            state.baseAmount = newBase;
            state.initialBalance = currentBalance; // reset the baseline
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
            const user = await this.db.getUser(userId);
            const martingaleEnabled = user?.martingale_enabled !== false; // default true

            // Detect currency from live client (real account) or fallback to DB
            const currency = client?.currency || user?.currency || 'USD';
            const min = this.getCurrencyMinimum(currency);

            let tradeAmount;

            if (martingaleEnabled) {
                const state = this.getMartingaleState(userId, user, currency);

                // Set initial balance baseline if not set
                if (state.initialBalance === 0 && client.balance > 0) {
                    state.initialBalance = client.balance;
                    this.activeTrades.set(userId, state);
                }

                // Check 10% growth
                this.checkBalanceGrowth(userId, state, client.balance || 0);

                tradeAmount = state.currentAmount;
            } else {
                // Martingale OFF — just use user's set amount or currency minimum
                tradeAmount = user?.tradeAmount || min;
            }

            // Always enforce currency minimum
            if (tradeAmount < min) tradeAmount = min;

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
    // TRACK TRADE RESULT (WebSocket listener)
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

        // Timeout = duration + 30s buffer
        const durationMs = (tradeInfo.duration > 0) ? tradeInfo.duration * 60 * 1000 : 5 * 60 * 1000;
        setTimeout(() => {
            client.ws?.removeListener('message', messageHandler);
            console.log(`⏰ Trade ${tradeInfo.tradeId} timeout (waited ${durationMs / 60000} min)`);
        }, durationMs + 30000);
    }

    // ─────────────────────────────────────────
    // HANDLE RESULT + MARTINGALE UPDATE + CHART GENERATION
    // ─────────────────────────────────────────

    async handleTradeResult(userId, position, tradeInfo) {
        try {
            // ========== DEBUG ENTRY ==========
            console.log('\n🎯 CHART DEBUG: ===== STARTING TRADE RESULT HANDLING =====');
            console.log(`🎯 CHART DEBUG: User ID: ${userId}`);
            console.log(`🎯 CHART DEBUG: Trade ID: ${tradeInfo.tradeId}`);
            console.log(`🎯 CHART DEBUG: Asset: ${tradeInfo.asset}`);
            console.log(`🎯 CHART DEBUG: Direction: ${tradeInfo.direction}`);
            console.log(`🎯 CHART DEBUG: Client exists: ${!!client}`);
            console.log(`🎯 CHART DEBUG: Client methods:`, client ? Object.keys(client) : 'No client');
            // ========== END DEBUG ==========

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

            // Get open and close times from position
            const openTime = position.open_time || position.raw_event?.open_time_millisecond || tradeInfo.timestamp;
            const closeTime = position.close_time || Date.now();

            // ── Martingale Update ──
            let state = this.activeTrades.get(userId);
            if (!state) {
                const base = this.getBaseAmount(user, currency);
                state = { step: 0, losses: 0, baseAmount: base, currentAmount: base, initialBalance: 0 };
            }

            if (martingaleEnabled) {
                if (isWin) {
                    console.log(`✅ User ${userId} WIN ${currencySymbol}${profit.toFixed(2)}. Resetting martingale to base ${currencySymbol}${state.baseAmount}`);
                    this.resetMartingale(userId, state);
                } else {
                    this.advanceMartingale(userId, state);
                }
            }

            // ── Update Stats in DB ──
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

            // ========== CHART GENERATION DEBUG START ==========
            console.log('\n🎯 CHART DEBUG: ===== ATTEMPTING CHART GENERATION =====');
            console.log(`🎯 CHART DEBUG: client.getCandles exists? ${!!(client && client.getCandles)}`);

            if (!client) {
                console.log('🎯 CHART DEBUG: ❌ FAILED - No client object');
            } else if (!client.getCandles) {
                console.log('🎯 CHART DEBUG: ❌ FAILED - client.getCandles is not a function');
                console.log('🎯 CHART DEBUG: Available client methods:', Object.keys(client));
            }
            // ========== CHART GENERATION DEBUG END ==========

            // ── Generate and Send Chart ──
            try {
                // Get asset ID from client
                let assetId = 1861; // Default to EURUSD
                console.log(`🎯 CHART DEBUG: Looking for asset: ${tradeInfo.asset}`);
                console.log(`🎯 CHART DEBUG: Client assetMap exists? ${!!(client && client.assetMap)}`);

                if (client && client.assetMap) {
                    console.log(`🎯 CHART DEBUG: AssetMap entries:`);
                    for (const [id, name] of Object.entries(client.assetMap)) {
                        console.log(`   ${id} -> ${name}`);
                        if (name === tradeInfo.asset) {
                            assetId = parseInt(id);
                            console.log(`🎯 CHART DEBUG: ✅ Found match! Asset ID: ${assetId}`);
                            break;
                        }
                    }
                } else {
                    console.log(`🎯 CHART DEBUG: ⚠️ Using default assetId: ${assetId}`);
                }

                // Calculate duration in seconds
                const durationMs = closeTime - openTime;
                const durationSec = Math.floor(durationMs / 1000);
                const candleCount = Math.ceil(durationSec / 30); // 30-second candles

                console.log(`🎯 CHART DEBUG: openTime: ${new Date(openTime).toISOString()}`);
                console.log(`🎯 CHART DEBUG: closeTime: ${new Date(closeTime).toISOString()}`);
                console.log(`🎯 CHART DEBUG: durationMs: ${durationMs}`);
                console.log(`🎯 CHART DEBUG: durationSec: ${durationSec}`);
                console.log(`🎯 CHART DEBUG: candleCount: ${candleCount}`);

                // Fetch candles from client
                if (client && client.getCandles) {
                    console.log(`🎯 CHART DEBUG: Calling client.getCandles(${assetId}, 30, ${candleCount}, ${Math.floor(closeTime / 1000)})`);

                    const candles = await client.getCandles(
                        assetId,
                        30, // 30-second interval
                        candleCount,
                        Math.floor(closeTime / 1000) // end time in seconds
                    );

                    console.log(`🎯 CHART DEBUG: getCandles returned:`, candles ? `Array with ${candles.length} items` : 'null/undefined');

                    if (candles && candles.length > 0) {
                        console.log(`🎯 CHART DEBUG: First candle sample:`, JSON.stringify(candles[0]));

                        // Generate chart
                        console.log(`🎯 CHART DEBUG: Calling generateTradeChart...`);
                        const chartPath = await this.chartGen.generateTradeChart({
                            asset: tradeInfo.asset,
                            direction: tradeInfo.direction === 'CALL' ? 'BUY' : 'SELL',
                            investment: investment,
                            profit: profit,
                            isWin: isWin,
                            entryPrice: position.open_quote || position.raw_event?.value || 0,
                            exitPrice: position.close_quote || position.raw_event?.expiration_value || 0,
                            openTime: openTime,
                            closeTime: closeTime,
                            tradeId: tradeInfo.tradeId,
                            currency: currencySymbol
                        }, candles);

                        console.log(`🎯 CHART DEBUG: ✅ Chart generated at: ${chartPath}`);

                        // Send to user
                        if (user && this.telegramBot) {
                            try {
                                console.log(`🎯 CHART DEBUG: Sending chart to user ${userId}`);
                                await this.telegramBot.bot.telegram.sendPhoto(
                                    userId,
                                    { source: fs.createReadStream(chartPath) },
                                    {
                                        caption: `📊 *Trade Result: ${tradeInfo.asset}*\n${isWin ? '✅ WIN' : '❌ LOSS'} • ${currencySymbol}${Math.abs(profit).toFixed(2)}`,
                                        parse_mode: 'Markdown'
                                    }
                                );
                                console.log(`🎯 CHART DEBUG: ✅ Chart sent to user`);
                            } catch (e) {
                                console.error(`🎯 CHART DEBUG: ❌ Failed to send chart to user:`, e.message);
                            }
                        }

                        // Send to channels (for admin trades)
                        if (userId.toString() === process.env.ADMIN_CHAT_ID) {
                            const channels = await this.db.getActiveChannels();
                            console.log(`🎯 CHART DEBUG: Sending to ${channels.length} channels`);
                            for (const channel of channels) {
                                try {
                                    await this.telegramBot.bot.telegram.sendPhoto(
                                        channel.channel_id,
                                        { source: fs.createReadStream(chartPath) },
                                        {
                                            caption: `📊 *Trade Result: ${tradeInfo.asset}*\n${isWin ? '✅ WIN' : '❌ LOSS'} • ${currencySymbol}${Math.abs(profit).toFixed(2)}`,
                                            parse_mode: 'Markdown'
                                        }
                                    );
                                } catch (err) {
                                    console.error(`🎯 CHART DEBUG: ❌ Failed to send to channel:`, err.message);
                                }
                            }
                        }

                        // Cleanup
                        this.chartGen.cleanup(chartPath);
                        console.log(`🎯 CHART DEBUG: ✅ Chart generation complete and cleaned up`);
                    } else {
                        console.log('🎯 CHART DEBUG: ⚠️ No candles returned from getCandles');
                    }
                } else {
                    console.log('🎯 CHART DEBUG: ❌ Cannot fetch candles - client.getCandles not available');
                }
            } catch (chartError) {
                console.error('🎯 CHART DEBUG: ❌ Error in chart generation:', chartError);
                console.error('🎯 CHART DEBUG: Error stack:', chartError.stack);
            }

            // ── Send Text Notification (as backup) ──
            if (user && this.telegramBot) {
                const stepDisplay = martingaleEnabled
                    ? (isWin
                        ? `↩️ Reset to ${currencySymbol}${state.currentAmount}`
                        : `📉 Step ${state.step + 1}/6 → Next: ${currencySymbol}${state.currentAmount}`)
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

            console.log('🎯 CHART DEBUG: ===== TRADE RESULT HANDLING COMPLETE =====\n');

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
🤖 Martingale active • Max 6 steps • Auto-reset
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
    }
}

module.exports = AutoTrader;