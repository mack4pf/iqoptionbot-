const WebSocket = require('ws');
const axios = require('axios');
const tunnel = require('tunnel');
const { HttpsProxyAgent } = require('https-proxy-agent');

class IQOptionClient {
    constructor(email, password, chatId = null, db = null) {
        this.email = email;
        this.password = password;
        this.chatId = chatId;
        this.db = db;
        this.ws = null;
        this.ssid = null;
        this.connected = false;

        // Account info
        this.accountType = 'REAL';
        this.balance = 0;
        this.currency = 'USD';
        this.balanceId = null;

        // Store both balances
        this.realBalance = 0;
        this.realCurrency = 'USD';
        this.realBalanceId = null;

        this.practiceBalance = 0;
        this.practiceCurrency = 'USD';
        this.practiceBalanceId = null;

        // Callbacks
        this.onTradeOpened = null;
        this.onTradeClosed = null;
        this.onBalanceChanged = null;

        // Asset mapping
        this.assetMap = {
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
            2301: 'PENUSD-OTC',
            1961: 'GOLD',
        };
    }

    // Try to restore session from stored SSID
    async restoreSession() {
        if (!this.db || !this.chatId) return false;

        try {
            console.log(`🔄 Attempting to restore session for user ${this.chatId}`);
            const ssid = await this.db.getUserSsid(this.chatId);
            if (!ssid) return false;

            this.ssid = ssid;
            console.log(`✅ Session restored for user ${this.chatId}`);
            return true;
        } catch (error) {
            console.log(`⚠️ Session restore failed:`, error.message);
            return false;
        }
    }

    // Get proxy config using tunnel
    getProxyConfig() {
        if (!process.env.IPROYAL_HOST) return null;

        return tunnel.httpsOverHttp({
            proxy: {
                host: process.env.IPROYAL_HOST,
                port: parseInt(process.env.IPROYAL_PORT),
                proxyAuth: `${process.env.IPROYAL_USERNAME}:${process.env.IPROYAL_PASSWORD}`
            }
        });
    }

    getWsProxyConfig() {
        if (!process.env.IPROYAL_HOST) return null;
        const proxyUrl = `http://${process.env.IPROYAL_USERNAME}:${process.env.IPROYAL_PASSWORD}@${process.env.IPROYAL_HOST}:${process.env.IPROYAL_PORT}`;
        return new HttpsProxyAgent(proxyUrl);
    }

    async login(useProxy = true) {
        // Try to restore session first
        if (await this.restoreSession()) {
            this.connect();
            return true;
        }

        console.log(`🔐 User ${this.chatId} logging in...`);

        try {
            let config = {
                method: 'post',
                url: 'https://auth.iqoption.com/api/v1.0/login',
                data: {
                    email: this.email,
                    password: this.password
                },
                timeout: 30000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Referer': 'https://iqoption.com/en/login',
                    'Origin': 'https://iqoption.com'
                }
            };
 
            // Add proxy if enabled
            if (useProxy) {
                const httpsAgent = this.getProxyConfig();
                if (httpsAgent) {
                    config.httpsAgent = httpsAgent;
                    config.proxy = false;
                    console.log(`🔄 User ${this.chatId} using proxy for login`);
                }
            }
 
            let response;
            try {
                response = await axios(config);
            } catch (err) {
                // If Proxy error (403, 402, or Bridge/Tunneling error), fallback to direct
                const isProxyError = err.response?.status === 403 || err.response?.status === 402 || err.message?.includes('tunneling socket');
                if (useProxy && isProxyError) {
                    console.warn(`⚠️ User ${this.chatId} proxy failed (${err.response?.status || err.message}). Retrying login DIRECT...`);
                    delete config.httpsAgent;
                    config.proxy = false;
                    response = await axios(config);
                } else {
                    throw err;
                }
            }
 
            if (response.data && response.data.data && response.data.data.ssid) {
                this.ssid = response.data.data.ssid;
 
                // Store SSID in database
                if (this.db && this.chatId) {
                    await this.db.storeUserSsid(this.chatId, this.ssid);
                    console.log(`💾 SSID stored for user ${this.chatId}`);
                }
 
                console.log(`✅ User ${this.chatId} login successful`);
 
                // Connect WebSocket
                this.connect();
                return true;
            }
 
            return false;
 
        } catch (error) {
            console.error(`❌ User ${this.chatId} login failed:`, error.response?.data || error.message);
            return false;
        }
    }

    async logout() {
        if (this.db && this.chatId) {
            await this.db.clearUserSsid(this.chatId);
            console.log(`🗑️ SSID cleared for user ${this.chatId}`);
        }

        if (this.ws) {
            this.ws.close();
            this.connected = false;
        }

        console.log(`👋 User ${this.chatId} logged out`);
    }

    connect() {
        if (!this.ssid) {
            console.error('❌ No SSID. Please login first.');
            return;
        }

        // Prevent duplicate reconnection loops
        if (this._isReconnecting) return;
        this._isReconnecting = true;
        this._isFallbackAttempted = false;

        // Clean up old WebSocket and timers BEFORE creating new ones
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.on('error', () => {}); // Catch late errors to prevent crash
            try { this.ws.close(); } catch (e) {}
            this.ws = null;
        }

        console.log(`🔄 Connecting WebSocket for user ${this.chatId}...`);
        
        const wsUrl = `wss://ws.iqoption.com/echo/websocket?ssid=${this.ssid}`;
        let agent = this.getWsProxyConfig();
        let wsOptions = agent ? { agent } : {};

        console.log(`🔄 Connecting WebSocket for user ${this.chatId}${agent ? ' via Proxy' : ' (Direct)'}...`);

        try {
            this.ws = new WebSocket(wsUrl, wsOptions);
            
            // Handle proxy handshake failure (like 402/403)
            this.ws.on('unexpected-response', (req, res) => {
                if (agent && (res.statusCode === 402 || res.statusCode === 403)) {
                    console.warn(`⚠️ User ${this.chatId} proxy failed with ${res.statusCode}. Switching to DIRECT...`);
                    this.ws.removeAllListeners();
                    try { this.ws.terminate(); } catch (e) { }
                    this.ws = new WebSocket(wsUrl); 
                    this.setupWsHandlers(); 
                }
            });

            this.setupWsHandlers();
            this._isReconnecting = false;
        } catch (e) {
            console.error(`❌ WebSocket creation failed: ${e.message}`);
            // If creation failed due to proxy, try one last time direct
            if (agent && e.message.includes('tunneling socket')) {
                console.warn(`⚠️ User ${this.chatId} tunneling failed. Falling back to DIRECT connection...`);
                try {
                    this.ws = new WebSocket(wsUrl);
                    this.setupWsHandlers();
                } catch (innerError) {
                    console.error(`❌ Direct WebSocket fallback failed: ${innerError.message}`);
                }
            }
            this._isReconnecting = false;
        }
    }

    setupWsHandlers() {
        this.ws.on('open', () => {
            console.log(`✅ WebSocket connected for user ${this.chatId}`);
            this.connected = true;
            this.send({ name: 'ssid', msg: this.ssid });

            // Heartbeat — only check, do NOT reconnect from here
            // Let the 'close' handler handle reconnection to avoid duplicate loops
            this.pingInterval = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.send({ name: 'heartbeat', msg: Date.now() });
                } else {
                    console.log(`⚠️ User ${this.chatId} heartbeat: WebSocket dead, closing...`);
                    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
                    try { this.ws.close(); } catch (e) {}
                }
            }, 10000); // 10s heartbeat for better proxy stability

            // Request profile
            this.refreshProfile();

            // Get balances
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
                console.log(`👂 Listening for trades for user ${this.chatId}`);
            }, 2000);
        });

        this.ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);
                this.handleMessage(message);
            } catch (err) {
                // Ignore parse errors
            }
        });

        this.ws.on('error', (error) => {
            console.error(`❌ WebSocket error for user ${this.chatId}:`, error.message);
            
            // If this is a proxy error and we haven't successfully connected yet, try DIRECT
            const isProxyError = error.message.includes('tunneling socket') || error.message.includes('statusCode=402') || error.message.includes('statusCode=403');
            if (!this.connected && this.ws && !this._isFallbackAttempted && isProxyError) {
                this._isFallbackAttempted = true;
                console.warn(`⚠️ User ${this.chatId} proxy error during connection. Falling back to DIRECT...`);
                this.ws.removeAllListeners();
                try { this.ws.terminate(); } catch (e) { }
                const wsUrl = `wss://ws.iqoption.com/echo/websocket?ssid=${this.ssid}`;
                this.ws = new WebSocket(wsUrl);
                this.setupWsHandlers();
                return;
            }
            
            this.connected = false;
        });

        this.ws.on('close', () => {
            console.log(`🔌 WebSocket closed for user ${this.chatId}`);
            this.connected = false;
            this._isReconnecting = false;
            if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
            if (this.ws) {
                if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
                this._reconnectTimer = setTimeout(() => {
                    console.log(`🔄 Reconnecting user ${this.chatId}...`);
                    this.connect();
                }, 10000); // Increased backoff to 10s
            }
        });
    }

    handleMessage(message) {
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
    }

    handleProfile(message) {
        const profile = message.msg;
        const real = profile.balances?.find(b => b.type === 1);
        const practice = profile.balances?.find(b => b.type === 4);

        if (real) {
            this.realBalance = real.amount;
            this.realCurrency = real.currency;
            this.realBalanceId = real.id;
        }

        if (practice) {
            this.practiceBalance = practice.amount;
            this.practiceCurrency = practice.currency;
            this.practiceBalanceId = practice.id;
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

        console.log(`💰 User ${this.chatId} - REAL Balance: ${this.realCurrency} ${this.realBalance}`);
        console.log(`💰 User ${this.chatId} - PRACTICE Balance: ${this.practiceCurrency} ${this.practiceBalance}`);

        // Initialize last emited variables if they don't exist
        if (this._lastEmittedBalance === undefined) this._lastEmittedBalance = null;
        if (this._lastEmittedType === undefined) this._lastEmittedType = null;

        const hasChanged = this.balance !== this._lastEmittedBalance || this.accountType !== this._lastEmittedType;

        if (hasChanged && this.onBalanceChanged) {
            this._lastEmittedBalance = this.balance;
            this._lastEmittedType = this.accountType;
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

        const hasChanged = this.balance !== this._lastEmittedBalance || this.accountType !== this._lastEmittedType;

        if (hasChanged && this.onBalanceChanged) {
            this._lastEmittedBalance = this.balance;
            this._lastEmittedType = this.accountType;
            this.onBalanceChanged({
                amount: this.balance,
                currency: this.currency,
                type: this.accountType
            });
        }
    }

    handlePositionUpdate(position) {
        const activeId = position.active_id || position.instrument_id;
        const asset = this.getAssetName(activeId);

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

        if (position.status === 'open') {
            const amount = position.invest || position.raw_event?.amount || 0;
            const tradeData = {
                asset,
                direction: displayDirection,
                amount,
                duration: position.duration || '?',
                tradeId: position.id || position.external_id,
                openTime: position.open_time || position.raw_event?.open_time_millisecond
            };
            console.log(`\n${directionEmoji} User ${this.chatId} TRADE OPENED: ${asset} ${this.currency}${amount}`);
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
            console.log(`\n${isWin ? '✅' : '❌'} User ${this.chatId} TRADE CLOSED: ${asset} Profit: ${this.currency}${profit.toFixed(2)}`);
            if (this.onTradeClosed) this.onTradeClosed(tradeResult);

            this.refreshProfile();
        }
    }

    refreshProfile() {
        this.send({ name: 'sendMessage', request_id: Date.now(), msg: { name: 'get-profile', version: '1.0' } });
    }

    getAssetName(activeId) {
        return this.assetMap[activeId] || `Unknown-ID:${activeId}`;
    }

    async placeTrade(params) {
        return new Promise((resolve) => {
            const { asset, direction, amount, duration } = params;
            const requestId = Date.now();

            let activeId = 1861;
            for (const [id, name] of Object.entries(this.assetMap)) {
                if (name === asset) {
                    activeId = parseInt(id);
                    break;
                }
            }

            if (!this.balanceId) {
                console.log('❌ No balance ID yet');
                return resolve({ success: false, error: 'Balance not ready' });
            }

            const now = Math.floor(Date.now() / 1000);
            const expiration = now + (duration * 60);
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

            this.send({ name: 'sendMessage', request_id: requestId, msg: tradeMessage });

            const messageListener = (data) => {
                try {
                    const msg = JSON.parse(data);
                    if (msg.name === 'option-opened' && msg.msg?.option_id) {
                        this.ws?.removeListener('message', messageListener);
                        resolve({ success: true, tradeId: msg.msg.option_id });
                    }
                    if (msg.name === 'option' && msg.msg?.message) {
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

    send(data) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    disconnect() {
        if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.on('error', () => {}); // Catch late errors
            try { this.ws.close(); } catch (e) {}
            this.ws = null;
        }
        this.connected = false;
    }
}

module.exports = IQOptionClient;