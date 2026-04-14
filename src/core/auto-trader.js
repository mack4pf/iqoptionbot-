class AutoTrader {
    constructor(telegramBot, db) {
        this.telegramBot = telegramBot;
        this.db = db;

        // Martingale multipliers: step 0=1x, 1=1x, 2=2x, 3=4x, 4=8x
        this.MULTIPLIERS = [1, 1, 2, 4, 8];
        this.MAX_STEPS = this.MULTIPLIERS.length; // 5

        // Per-user in-memory state { step, losses, baseAmount, currentAmount, currency }
        this.userState = new Map();

        // Tracks open positions: userId -> tradeInfo
        this.openPositions = new Map();

        // Cooldown: userId -> timestamp of last close
        this.lastTradeCloseTime = new Map();

        this.currencyLimits = {
            NGN: { min: 30,  max: 50000000 },
            USD: { min: 1,   max: 10000000 },
            EUR: { min: 1,   max: 100000   },
            GBP: { min: 1,   max: 100000   },
            BRL: { min: 5,   max: 500000   },
            INR: { min: 1,   max: 7000000  },
            MXN: { min: 1,   max: 2000000  },
            AED: { min: 1,   max: 500000   },
            ZAR: { min: 1,   max: 2000000  },
        };
    }

    // ─── Helpers ────────────────────────────────────────────────────────────────

    getCurrencyMin(currency) {
        return this.currencyLimits[(currency || 'USD').toUpperCase()]?.min || 1;
    }

    getCurrencyMax(currency) {
        return this.currencyLimits[(currency || 'USD').toUpperCase()]?.max || 10000000;
    }

    clamp(amount, currency) {
        const min = this.getCurrencyMin(currency);
        const max = this.getCurrencyMax(currency);
        return Math.min(Math.max(amount, min), max);
    }

    getCurrencySymbol(currency) {
        const map = { NGN: '₦', USD: '$', EUR: '€', GBP: '£', BRL: 'R$' };
        return map[(currency || '').toUpperCase()] || (currency + ' ');
    }

    // ─── State Management ────────────────────────────────────────────────────────

    /**
     * Load state for a user. Priority: memory > DB.
     * If baseAmount changed, reset step to 0.
     */
    _loadState(userId, user, currency) {
        const baseAmount = this.clamp(user.tradeAmount || this.getCurrencyMin(currency), currency);
        let state = this.userState.get(userId);

        if (state && state.currency === currency) {
            // Already in memory for same currency
            if (state.baseAmount !== baseAmount) {
                // User changed their trade amount — reset fully
                console.log(`🔄 [${userId}] tradeAmount changed ${state.baseAmount}→${baseAmount}. Full reset.`);
                state = this._freshState(currency, baseAmount);
                this.userState.set(userId, state);
            }
            return state;
        }

        // Not in memory — load from DB
        const db = user.martingale || {};
        const dbBase = db.base_amount || baseAmount;
        const losses  = db.loss_streak || 0;
        const step    = Math.min(losses, this.MAX_STEPS - 1);
        const amount  = this.clamp(dbBase * this.MULTIPLIERS[step], currency);

        // If user changed their amount since last DB save, ignore the DB step and reset
        if (dbBase !== baseAmount) {
            console.log(`🔄 [${userId}] baseAmount mismatch (DB:${dbBase} vs user:${baseAmount}). Full reset.`);
            state = this._freshState(currency, baseAmount);
        } else {
            state = { step, losses, baseAmount, currentAmount: amount, currency };
        }

        this.userState.set(userId, state);
        console.log(`📊 [${userId}] State loaded — step=${state.step}, losses=${state.losses}, next=${state.currentAmount}`);
        return state;
    }

    _freshState(currency, baseAmount) {
        return { step: 0, losses: 0, baseAmount, currentAmount: baseAmount, currency };
    }

    /** Save martingale state back to DB */
    async _saveState(userId, state) {
        await this.db.updateUser(userId, {
            martingale: {
                current_step:    state.step,
                current_amount:  state.currentAmount,
                loss_streak:     state.losses,
                base_amount:     state.baseAmount,
            }
        });
    }

    /** Reset step to 0 (win) */
    _onWin(userId, state) {
        state.step         = 0;
        state.losses       = 0;
        state.currentAmount = state.baseAmount;
        this.userState.set(userId, state);
        console.log(`✅ [${userId}] WIN → reset to base ${state.baseAmount}`);
    }

    /** Advance to next step (loss) */
    _onLoss(userId, state) {
        state.losses++;
        if (state.losses >= this.MAX_STEPS) {
            // Max losses reached — auto reset
            console.log(`🔄 [${userId}] ${this.MAX_STEPS} losses in a row → auto reset`);
            state.step         = 0;
            state.losses       = 0;
            state.currentAmount = state.baseAmount;
        } else {
            state.step         = Math.min(state.losses, this.MAX_STEPS - 1);
            state.currentAmount = this.clamp(state.baseAmount * this.MULTIPLIERS[state.step], state.currency);
            console.log(`📈 [${userId}] LOSS ${state.losses}/${this.MAX_STEPS} → step=${state.step}, next=${state.currentAmount}`);
        }
        this.userState.set(userId, state);
    }

    clearUserState(userId) {
        this.userState.delete(userId);
        this.openPositions.delete(userId);
        this.lastTradeCloseTime.delete(userId);
        console.log(`🧹 [${userId}] State cleared`);
    }

    getMartingaleStatus(userId) {
        return this.userState.get(userId) || { step: 0, losses: 0, currentAmount: null, baseAmount: null };
    }

    // ─── Execute Trade ───────────────────────────────────────────────────────────

    async executeTrade(userId, client, signal) {
        try {
            // 1. Guard: open position
            if (this.openPositions.has(userId)) {
                console.log(`⏸️ [${userId}] Has open position — skip signal`);
                return { success: false, error: 'User has open position' };
            }

            // 2. Guard: cooldown (10s after close)
            const lastClose = this.lastTradeCloseTime.get(userId);
            if (lastClose && Date.now() - lastClose < 10000) {
                console.log(`⏸️ [${userId}] Cooldown active`);
                return { success: false, error: 'Cooldown active' };
            }

            // 3. Ensure client has a balanceId
            if (!client.balanceId) {
                console.log(`⚠️ [${userId}] No balanceId — refreshing profile`);
                client.refreshProfile();
            }

            // 4. Fetch fresh user from DB
            const user = await this.db.getUser(userId);
            if (!user) return { success: false, error: 'User not found' };

            const martingaleEnabled = user.martingale_enabled !== false;
            const currency = client.currency || user.currency || 'USD';

            // 5. Determine trade amount
            let tradeAmount;
            let state = null;

            if (martingaleEnabled) {
                state = this._loadState(userId, user, currency);
                tradeAmount = state.currentAmount;
            } else {
                tradeAmount = this.clamp(user.tradeAmount || this.getCurrencyMin(currency), currency);
            }

            // 6. Balance check
            if (client.balance < tradeAmount) {
                return { success: false, error: `Insufficient balance: ${client.balance} < ${tradeAmount}` };
            }

            console.log(`💰 [${userId}] Placing ${signal.direction.toUpperCase()} — ${this.getCurrencySymbol(currency)}${tradeAmount} (step ${state?.step ?? '-'})`);

            // 7. Place trade
            const result = await client.placeTrade({
                asset:     signal.asset || 'EURUSD-OTC',
                direction: signal.direction,
                amount:    tradeAmount,
                duration:  signal.duration,
            });

            if (!result.success) {
                console.error(`❌ [${userId}] Trade rejected: ${result.error}`);
                return { success: false, error: result.error };
            }

            // 8. Track open position
            const tradeInfo = {
                userId,
                tradeId:          result.tradeId,
                amount:           tradeAmount,
                direction:        signal.direction,
                duration:         signal.duration,
                currency,
                martingaleEnabled,
                stepAtOpen:       state?.step ?? 0,
                timestamp:        Date.now(),
            };
            this.openPositions.set(userId, tradeInfo);

            // Safety timeout to clear position if close event never fires
            const durationMs = (signal.duration > 0 ? signal.duration : 5) * 60 * 1000;
            setTimeout(() => {
                if (this.openPositions.get(userId)?.tradeId === result.tradeId) {
                    this.openPositions.delete(userId);
                    console.log(`⏰ [${userId}] Safety timeout cleared trade ${result.tradeId}`);
                }
            }, durationMs + 90000);

            return { success: true, tradeId: result.tradeId, amount: tradeAmount };

        } catch (error) {
            console.error(`💥 [${userId}] executeTrade error:`, error.message);
            return { success: false, error: error.message };
        }
    }

    // ─── Handle Trade Result ─────────────────────────────────────────────────────

    /**
     * Called by client.onTradeClosed or bot.handleUserTradeClosed.
     * Updates martingale, saves to DB, sends Telegram notification.
     */
    async handleTradeResult(userId, tradeResultRaw) {
        try {
            // Retrieve the tradeInfo stored at execution time
            let tradeInfo = this.openPositions.get(userId);
            this.openPositions.delete(userId);
            this.lastTradeCloseTime.set(userId, Date.now());

            // Parse win/loss
            const isWin = tradeResultRaw.isWin === true
                || tradeResultRaw.raw_event?.result === 'win'
                || tradeResultRaw.close_reason === 'win';

            // Use tradeInfo for amount if available, then fall back to raw result fields
            const currency  = tradeInfo?.currency || tradeResultRaw.currency || 'USD';
            const investment = tradeInfo?.amount || tradeResultRaw.investment || tradeResultRaw.invest || tradeResultRaw.amount || 0;
            const sym        = this.getCurrencySymbol(currency);

            let profit = 0;
            if (isWin) {
                const payout = tradeResultRaw.profit || tradeResultRaw.close_profit || tradeResultRaw.raw_event?.profit_amount || 0;
                profit = payout > investment ? payout - investment : payout;
            }

            // Get fresh user
            const user = await this.db.getUser(userId);
            const martingaleEnabled = user?.martingale_enabled !== false;

            // Load current state (or create fresh if missing)
            let state = this.userState.get(userId);
            if (!state) {
                const base = this.clamp(user?.tradeAmount || this.getCurrencyMin(currency), currency);
                state = this._freshState(currency, base);
            }

            // Advance or reset martingale
            const prevStep   = state.step;
            const prevLosses = state.losses;

            if (martingaleEnabled) {
                if (isWin) {
                    this._onWin(userId, state);
                } else {
                    this._onLoss(userId, state);
                }
            }

            // Save updated state to DB
            await this._saveState(userId, state);

            // Update user stats
            if (user) {
                const stats = user.stats || { total_trades: 0, wins: 0, losses: 0, total_profit: 0 };
                stats.total_trades++;
                if (isWin) { stats.wins++; stats.total_profit += profit; }
                else        { stats.losses++; stats.total_profit -= investment; }
                await this.db.updateUser(userId, { stats });
            }

            // Build notification message
            const resultIcon  = isWin ? '✅' : '❌';
            const resultLabel = isWin ? 'WIN 🎉' : 'LOSS';

            let martingaleInfo = '';
            if (martingaleEnabled) {
                if (isWin) {
                    martingaleInfo =
                        `\n🔄 *Martingale Reset*\n` +
                        `   ↩️ Back to base: ${sym}${state.baseAmount}`;
                } else {
                    const nextStepNum  = state.step + 1;           // 1-indexed for display
                    const nextAmount   = state.currentAmount;
                    const lossStreak   = state.losses;

                    if (lossStreak === 0) {
                        // Was auto-reset after MAX_STEPS
                        martingaleInfo =
                            `\n🔄 *Martingale Auto-Reset* (5 losses reached)\n` +
                            `   Next trade: ${sym}${nextAmount} (base)`;
                    } else {
                        martingaleInfo =
                            `\n📉 *Martingale Step ${nextStepNum}/${this.MAX_STEPS}*\n` +
                            `   Loss streak: ${lossStreak}/${this.MAX_STEPS}\n` +
                            `   Next trade amount: *${sym}${nextAmount}*\n` +
                            `   Multiplier: ${this.MULTIPLIERS[state.step]}x base`;
                    }
                }
            } else {
                martingaleInfo = '\n🔴 Martingale OFF — fixed amount';
            }

            const message =
                `${resultIcon} *Trade Result: ${resultLabel}*\n` +
                `━━━━━━━━━━━━━━━\n` +
                `📊 Asset: ${tradeResultRaw.asset || 'N/A'}\n` +
                `📈 Direction: ${(tradeInfo?.direction || '').toUpperCase()}\n` +
                `💰 Invested: ${sym}${investment}\n` +
                (isWin
                    ? `💵 Profit: +${sym}${profit.toFixed(2)}\n`
                    : `💸 Loss: -${sym}${investment}\n`) +
                `━━━━━━━━━━━━━━━` +
                martingaleInfo;

            // Send to user
            if (this.telegramBot) {
                try {
                    await this.telegramBot.bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' });
                } catch (e) {
                    console.error(`[${userId}] Failed to notify user:`, e.message);
                }

                // Send to admin (with user email appended)
                const adminId = process.env.ADMIN_CHAT_ID;
                if (adminId && adminId !== userId) {
                    const adminMsg = message + `\n👤 User: ${user?.email || userId}`;
                    try {
                        await this.telegramBot.bot.telegram.sendMessage(adminId, adminMsg, { parse_mode: 'Markdown' });
                    } catch (e) {}
                }
            }

        } catch (error) {
            console.error(`💥 handleTradeResult error for ${userId}:`, error.message);
        }
    }

    // ─── Misc ────────────────────────────────────────────────────────────────────

    formatSignalMessage(signal, userCount) {
        const emoji     = signal.direction === 'call' ? '🟢' : '🔴';
        const direction = signal.direction === 'call' ? 'BUY' : 'SELL';
        return (
            `${emoji} *AUTO-TRADE SIGNAL*\n` +
            `━━━━━━━━━━━━━━━\n` +
            `📊 Asset: ${signal.asset || 'EURUSD-OTC'}\n` +
            `📈 Direction: ${direction}\n` +
            `⏱️ Duration: ${signal.duration || 5} min\n` +
            `👥 Executing for: ${userCount} users\n` +
            `🕐 Time: ${new Date().toLocaleTimeString()}\n` +
            `━━━━━━━━━━━━━━━\n` +
            `🤖 Martingale: 5 steps [1×, 1×, 2×, 4×, 8×] • Auto-reset`
        );
    }
}

module.exports = AutoTrader;