const WebSocket = require('ws');
const axios = require('axios');

class IQOptionClient {
    constructor(email, password, chatId = null) {
        this.email = email;
        this.password = password;
        this.chatId = chatId;
        this.ws = null;
        this.ssid = null;
        this.connected = false;

        // Account info - REAL by default
        this.accountType = 'REAL';
        this.balance = 0;
        this.currency = 'USD';
        this.balanceId = null;

        // Store both balances with their currencies
        this.realBalance = 0;
        this.realCurrency = 'USD';
        this.realBalanceId = null;

        this.practiceBalance = 0;
        this.practiceCurrency = 'USD';
        this.practiceBalanceId = null;

        // IMPORTANT: Store the original currency for each account type
        this.realOriginalCurrency = 'NGN';
        this.practiceOriginalCurrency = 'USD';

        // Callbacks
        this.onTradeOpened = null;
        this.onTradeClosed = null;
        this.onBalanceChanged = null;

        // Asset mapping - CORRECTED
        this.assetMap = {
            // REAL EURUSD (from your logs: 1861)
            1861: 'EURUSD',


            2: 'GBPUSD',
            3: 'USDJPY',
            4: 'AUDUSD',
            5: 'USDCAD',
            6: 'USDCHF',
            7: 'NZDUSD',

            76: 'EURUSD-OTC',
            77: 'GBPUSD-OTC',
            78: 'AUDUSD-OTC',
            79: 'USDCAD-OTC',
            80: 'USDCHF-OTC',
            81: 'NZDUSD-OTC',
            82: 'USDJPY-OTC',

            // Your custom pairs
            2301: 'PENUSD-OTC',
            1961: 'GOLD',
        };
    }

    async login() {
        try {
            console.log(`🔐 Logging in ${this.chatId ? 'user ' + this.chatId : 'admin'}...`);
            const response = await axios.post('https://auth.iqoption.com/api/v1.0/login', {
                email: this.email,
                password: this.password
            });
            this.ssid = response.data.data.ssid;
            console.log(`✅ Login successful for ${this.email}`);
            return true;
        } catch (error) {
            console.error(`❌ Login failed:`, error.response?.data?.message || error.message);
            return false;
        }
    }

    refreshProfile() {
        this.send({ name: 'sendMessage', request_id: Date.now(), msg: { name: 'get-profile', version: '1.0' } });
    }

    getAssetName(activeId) {
        return this.assetMap[activeId] || `Unknown-ID:${activeId}`;
    }

    // ==================== NEW: GET CANDLES METHOD ====================
    async getCandles(assetId, interval, count, endTime) {
        return new Promise((resolve, reject) => {
            const requestId = Date.now();

            this.send({
                name: 'sendMessage',
                request_id: requestId,
                msg: {
                    name: 'get-candles',
                    version: '2.0',
                    body: {
                        active_id: assetId,
                        size: interval,  // 30 for 30-second candles
                        from: endTime - (count * interval), // Calculate start time
                        to: endTime,
                        count: count
                    }
                }
            });

            const messageListener = (data) => {
                try {
                    const msg = JSON.parse(data);

                    if (msg.name === 'candles' && msg.request_id === requestId) {
                        this.ws?.removeListener('message', messageListener);
                        resolve(msg.msg || []);
                    }
                } catch (e) { }
            };

            this.ws?.on('message', messageListener);

            setTimeout(() => {
                this.ws?.removeListener('message', messageListener);
                reject(new Error('Timeout fetching candles'));
            }, 5000);
        });
    }
    // ==================== END GET CANDLES ====================

    async placeTrade(params) {
        return new Promise((resolve) => {
            const { asset, direction, amount, duration } = params;
            const requestId = Date.now();

            // Get asset ID from assetMap - prioritize 1861 for EURUSD
            let activeId = 1861; // Default to REAL EURUSD
            for (const [id, name] of Object.entries(this.assetMap)) {
                if (name === asset) {
                    activeId = parseInt(id);
                    break;
                }
            }

            // IMPORTANT: Check if we have balance ID
            if (!this.balanceId) {
                console.log('❌ No balance ID yet, refreshing profile...');
                this.refreshProfile();
                // Wait a bit and try again
                setTimeout(() => {
                    if (this.balanceId) {
                        this.placeTrade(params).then(resolve);
                    } else {
                        resolve({ success: false, error: 'Balance not ready' });
                    }
                }, 2000);
                return;
            }

            console.log(`🔍 Trading on asset ID: ${activeId} (${asset})`);
            console.log(`💰 Using ${this.accountType} account - Currency: ${this.currency}`);

            // Calculate expiration timestamp
            const now = Math.floor(Date.now() / 1000);
            const expiration = now + (duration * 60);

            console.log(`📤 Placing Blitz trade:`, {
                activeId,
                direction,
                amount,
                currency: this.currency,
                duration: duration + 'min',
                balanceId: this.balanceId
            });

            const durationSeconds = duration * 60;
            const tradeMessage = {
                name: "binary-options.open-option",
                version: "1.0",
                body: {
                    active_id: activeId,
                    option_type_id: 12,
                    option_type: "blitz",
                    direction: direction.toLowerCase(),
                    expired: expiration,
                    price: amount,
                    user_balance_id: this.balanceId,
                    expiration_size: durationSeconds
                }
            };

            console.log('📤 Sending trade request...');
            this.send({ name: 'sendMessage', request_id: requestId, msg: tradeMessage });

            const messageListener = (data) => {
                try {
                    const msg = JSON.parse(data);

                    if (msg.name === 'option-opened' && msg.msg?.option_id) {
                        console.log('✅ Trade successful!', msg.msg);
                        this.ws?.removeListener('message', messageListener);
                        resolve({
                            success: true,
                            tradeId: msg.msg.option_id,
                            data: msg.msg
                        });
                    }

                    if (msg.name === 'option' && msg.msg?.message) {
                        console.log('❌ Trade failed:', msg.msg);
                        this.ws?.removeListener('message', messageListener);
                        resolve({ success: false, error: msg.msg.message });
                    }
                } catch (e) { }
            };

            this.ws?.on('message', messageListener);

            setTimeout(() => {
                this.ws?.removeListener('message', messageListener);
                resolve({ success: false, error: 'Timeout' });
            }, 10000);
        });
    }

    connect() {
        if (!this.ssid) {
            console.error('❌ No SSID. Please login first.');
            return;
        }

        console.log(`🔄 Connecting WebSocket for ${this.email}...`);

        this.ws = new WebSocket(`wss://ws.iqoption.com/echo/websocket?ssid=${this.ssid}`);

        this.ws.on('open', () => {
            console.log(`✅ WebSocket connected for ${this.email}`);
            this.connected = true;
            this.send({ name: 'ssid', msg: this.ssid });

            // Heartbeat every 30 seconds
            setInterval(() => {
                if (this.ws?.readyState === WebSocket.OPEN)
                    this.send({ name: 'heartbeat', msg: Date.now() });
            }, 30000);

            // Request profile immediately
            this.refreshProfile();

            // Also request balances as backup
            setTimeout(() => {
                this.send({
                    name: 'sendMessage',
                    request_id: Date.now(),
                    msg: { name: 'get-balances', version: '1.0' }
                });
            }, 1000);

            // Subscribe to position changes
            setTimeout(() => {
                this.send({
                    name: 'subscribeMessage',
                    msg: {
                        name: 'position-changed',
                        version: '2.0',
                        params: {}
                    }
                });
                console.log(`👂 Listening for trades for ${this.email}`);
            }, 2000);
        });

        this.ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);

                switch (message.name) {
                    case 'profile':
                        this.handleProfile(message);
                        break;

                    case 'balances':
                        this.handleBalances(message);
                        break;

                    case 'position':
                    case 'position-changed':
                        this.handlePositionUpdate(message.msg);
                        break;

                    case 'balance-changed':
                        this.refreshProfile();
                        break;
                }
            } catch (err) {
                // Ignore parse errors
            }
        });

        this.ws.on('error', (error) => {
            console.error(`❌ WebSocket error for ${this.email}:`, error.message);
            this.connected = false;
        });

        this.ws.on('close', () => {
            console.log(`🔌 WebSocket closed for ${this.email}`);
            this.connected = false;
            setTimeout(() => {
                console.log(`🔄 Reconnecting ${this.email}...`);
                this.connect();
            }, 5000);
        });
    }

    handleProfile(message) {
        const profile = message.msg;
        const real = profile.balances?.find(b => b.type === 1);
        const practice = profile.balances?.find(b => b.type === 4);

        if (real) {
            this.realBalance = real.amount;
            this.realCurrency = real.currency;
            this.realBalanceId = real.id;
            this.realOriginalCurrency = real.currency;
        }

        if (practice) {
            this.practiceBalance = practice.amount;
            this.practiceCurrency = practice.currency;
            this.practiceBalanceId = practice.id;
            this.practiceOriginalCurrency = practice.currency;
        }

        if (this.accountType === 'REAL' && real) {
            this.balance = real.amount;
            this.currency = real.currency;
            this.balanceId = real.id;
        } else if (practice) {
            this.balance = practice.amount;
            this.currency = practice.currency;
            this.balanceId = practice.id;
        }

        console.log(`💰 REAL Balance: ${this.realCurrency} ${this.realBalance}`);
        console.log(`💰 PRACTICE Balance: ${this.practiceCurrency} ${this.practiceBalance}`);
        console.log(`🎯 Active for trading: ${this.accountType} (${this.currency}) - ID: ${this.balanceId}`);

        if (this.onBalanceChanged) {
            this.onBalanceChanged({
                amount: this.balance,
                currency: this.currency,
                type: this.accountType
            });
        }
    }

    handleBalances(message) {
        const balances = message.msg;
        const realBal = balances.find(b => b.type === 1);
        const practiceBal = balances.find(b => b.type === 4);

        if (realBal) {
            this.realBalance = realBal.amount;
            this.realCurrency = realBal.currency;
            this.realBalanceId = realBal.id;
        }

        if (practiceBal) {
            this.practiceBalance = practiceBal.amount;
            this.practiceCurrency = practiceBal.currency;
            this.practiceBalanceId = practiceBal.id;
        }

        if (this.accountType === 'REAL' && realBal) {
            this.balance = realBal.amount;
            this.currency = realBal.currency;
            this.balanceId = realBal.id;
        } else if (practiceBal) {
            this.balance = practiceBal.amount;
            this.currency = practiceBal.currency;
            this.balanceId = practiceBal.id;
        }
    }

    handlePositionUpdate(position) {
        const activeId = position.active_id || position.instrument_id;
        const asset = this.getAssetName(activeId);

        console.log(`🔍 RAW ASSET ID: ${activeId} -> maps to: ${asset}`);

        let direction = 'Unknown';
        let displayDirection = 'UNKNOWN';
        let directionEmoji = '⚪';

        if (position.raw_event?.direction) {
            direction = position.raw_event.direction;
        } else if (position.direction) {
            direction = position.direction;
        }

        if (direction === 'call' || direction === 'buy') {
            displayDirection = 'CALL';
            directionEmoji = '🟢';
        } else if (direction === 'put' || direction === 'sell') {
            displayDirection = 'PUT';
            directionEmoji = '🔴';
        }

        let duration = '?';
        if (position.raw_event?.expiration_time && position.raw_event?.open_time) {
            const durationSec = position.raw_event.expiration_time - position.raw_event.open_time;
            duration = Math.round(durationSec / 60);
        }

        if (position.status === 'open') {
            const amount = position.invest || position.raw_event?.amount || 0;
            const tradeData = {
                asset,
                direction: displayDirection,
                amount,
                duration,
                tradeId: position.id || position.external_id,
                openTime: position.open_time || position.raw_event?.open_time_millisecond
            };
            console.log(`\n${directionEmoji} TRADE OPENED: ${asset} ${this.currency}${amount} (${displayDirection})`);
            if (this.onTradeOpened) this.onTradeOpened(tradeData);
        }

        if (position.status === 'closed') {
            const investment = position.invest || position.raw_event?.amount || 0;
            let profit = 0;
            const isWin = position.raw_event?.result === 'win' || position.close_reason === 'win';

            if (isWin) {
                const totalPayout = position.close_profit || position.raw_event?.profit_amount || 0;
                profit = totalPayout > investment ? totalPayout - investment : totalPayout;
            }

            const tradeResult = {
                asset,
                direction: displayDirection,
                investment,
                profit,
                isWin,
                tradeId: position.id || position.external_id
            };
            console.log(`\n${isWin ? '✅' : '❌'} TRADE CLOSED: ${asset} Profit: ${this.currency}${profit.toFixed(2)}`);
            if (this.onTradeClosed) this.onTradeClosed(tradeResult);

            this.refreshProfile();
        }
    }

    send(data) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.connected = false;
        }
    }
}

module.exports = IQOptionClient;