// 💰 Set trade amount command
this.bot.command('setamount', async (ctx) => {
    if (!ctx.state.user) {
        return ctx.reply('❌ Please login first with /login');
    }

    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
        const currentAmount = ctx.state.user.tradeAmount || 1500;
        return ctx.reply(
            `💰 *Current trade amount:* ${this.getCurrencySymbol(ctx.state.user.currency)}${currentAmount}\n\n` +
            `To change, use: /setamount [amount]\n` +
            `Example: /setamount 2000`,
            { parse_mode: 'Markdown' }
        );
    }

    const amount = parseFloat(args[1]);
    if (isNaN(amount) || amount <= 0) {
        return ctx.reply('❌ Please enter a valid positive number');
    }

    // Update user's trade amount in database
    await this.db.updateUser(ctx.from.id, { tradeAmount: amount });

    const symbol = this.getCurrencySymbol(ctx.state.user.currency || 'NGN');
    await ctx.reply(`✅ Trade amount set to ${symbol}${amount}`);
});