// test-local.js - USING TUNNEL INSTEAD OF HTTPS-PROXY-AGENT
require('dotenv').config();
const axios = require('axios');
const tunnel = require('tunnel');

// Mock database for testing
class MockDB {
    constructor() {
        this.storage = new Map();
        this.users = new Map();
    }

    async storeUserSsid(userId, ssid) {
        this.storage.set(userId, { ssid, updated: new Date() });
        return true;
    }

    async getUserSsid(userId) {
        const data = this.storage.get(userId);
        return data ? data.ssid : null;
    }

    async getUser(userId) {
        return this.users.get(userId) || null;
    }

    async updateUser(userId, updates) {
        let user = this.users.get(userId) || {};
        this.users.set(userId, { ...user, ...updates });
        return true;
    }

    async clearUserSsid(userId) {
        this.storage.delete(userId);
        return true;
    }
}

// Proxy manager using tunnel (more stable)
class ProxyManager {
    constructor() {
        this.host = process.env.IPROYAL_HOST;
        this.port = parseInt(process.env.IPROYAL_PORT);
        this.username = process.env.IPROYAL_USERNAME;
        this.password = process.env.IPROYAL_PASSWORD;
    }

    getAxiosConfig() {
        // Create tunneling agent
        const agent = tunnel.httpsOverHttp({
            proxy: {
                host: this.host,
                port: this.port,
                proxyAuth: `${this.username}:${this.password}`
            }
        });

        return {
            httpsAgent: agent,
            proxy: false, // Disable axios proxy
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        };
    }

    async testProxy() {
        try {
            const config = this.getAxiosConfig();
            const response = await axios.get('https://api.ipify.org?format=json', config);
            console.log(`✅ Proxy working - IP: ${response.data.ip}`);
            return true;
        } catch (error) {
            console.error('❌ Proxy test failed:', error.message);
            if (error.response) {
                console.log('Response status:', error.response.status);
            }
            if (error.code) {
                console.log('Error code:', error.code);
            }
            return false;
        }
    }
}

// Simplified IQOptionClient for testing
class TestIQOptionClient {
    constructor(email, password, chatId = null, db = null) {
        this.email = email;
        this.password = password;
        this.chatId = chatId;
        this.db = db;
        this.ws = null;
        this.ssid = null;
        this.connected = false;
        this.proxyManager = new ProxyManager();
    }

    async restoreSession() {
        if (!this.db || !this.chatId) return false;

        try {
            const ssid = await this.db.getUserSsid(this.chatId);
            if (!ssid) return false;

            console.log(`🔄 Attempting to restore session for ${this.email}`);
            this.ssid = ssid;
            return true;
        } catch (error) {
            return false;
        }
    }

    async login(useProxy = false) {
        if (await this.restoreSession()) {
            console.log('✅ Session restored!');
            return true;
        }

        console.log(`🔐 Logging in ${this.chatId || 'test-user'}...`);

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
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            };

            if (useProxy) {
                const proxyConfig = this.proxyManager.getAxiosConfig();
                config = { ...config, ...proxyConfig };
                console.log('🔄 Using tunnel proxy');
            }

            const response = await axios(config);

            if (response.data && response.data.data && response.data.data.ssid) {
                this.ssid = response.data.data.ssid;

                if (this.db && this.chatId) {
                    await this.db.storeUserSsid(this.chatId, this.ssid);
                }

                console.log(`✅ Login successful`);
                console.log(`SSID: ${this.ssid.substring(0, 20)}...`);
                return true;
            }

            return false;

        } catch (error) {
            console.error(`❌ Login failed:`, error.message);
            if (error.response) {
                console.log('Response status:', error.response.status);
                console.log('Response data:', error.response.data);
            }
            if (error.code) {
                console.log('Error code:', error.code);
            }
            return false;
        }
    }
}

async function runLocalTests() {
    console.log('\n🔍 IQ OPTION LOCAL TEST SUITE (TUNNEL VERSION)');
    console.log('='.repeat(60));

    const email = process.env.IQ_EMAIL;
    const password = process.env.IQ_PASSWORD;

    if (!email || !password) {
        console.error('❌ Credentials not found in .env');
        return;
    }

    console.log(`Testing with email: ${email}`);
    console.log('='.repeat(60));

    // Test 1: Proxy Connection
    console.log('\n📡 TEST 1: Proxy Connection');
    console.log('-'.repeat(40));

    const proxyManager = new ProxyManager();
    const proxyWorks = await proxyManager.testProxy();

    if (proxyWorks) {
        console.log('✅ Proxy test passed');
    } else {
        console.log('⚠️ Proxy test failed');
    }

    // Test 2: Direct Login
    console.log('\n🔐 TEST 2: Direct Login');
    console.log('-'.repeat(40));

    const mockDB = new MockDB();
    const directClient = new TestIQOptionClient(email, password, 'test-user-1', mockDB);

    const directStart = Date.now();
    const directResult = await directClient.login(false);
    const directTime = Date.now() - directStart;

    if (directResult) {
        console.log(`✅ Direct login successful in ${directTime}ms`);
    } else {
        console.log(`❌ Direct login failed in ${directTime}ms`);
    }

    // Test 3: Proxy Login
    console.log('\n🔄 TEST 3: Login with Proxy');
    console.log('-'.repeat(40));

    const proxyClient = new TestIQOptionClient(email, password, 'test-user-2', mockDB);

    const proxyStart = Date.now();
    const proxyResult = await proxyClient.login(true);
    const proxyTime = Date.now() - proxyStart;

    if (proxyResult) {
        console.log(`✅ Proxy login successful in ${proxyTime}ms`);
    } else {
        console.log(`❌ Proxy login failed in ${proxyTime}ms`);
    }

    // Test 4: Session Restoration
    console.log('\n💾 TEST 4: Session Restoration');
    console.log('-'.repeat(40));

    if (directClient.ssid) {
        await mockDB.storeUserSsid('test-user-3', directClient.ssid);
        const restoreClient = new TestIQOptionClient(email, password, 'test-user-3', mockDB);

        const restoreStart = Date.now();
        const restoreResult = await restoreClient.login(false);
        const restoreTime = Date.now() - restoreStart;

        if (restoreResult) {
            console.log(`✅ Session restored in ${restoreTime}ms`);
        } else {
            console.log(`❌ Session restoration failed`);
        }
    } else {
        console.log('⚠️ No SSID to test session restoration');
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 TEST SUMMARY');
    console.log('='.repeat(60));
    console.log(`Proxy: ${proxyWorks ? '✅ Working' : '❌ Failed'}`);
    console.log(`Direct Login: ${directResult ? '✅ Success' : '❌ Failed'}`);
    console.log(`Proxy Login: ${proxyResult ? '✅ Success' : '❌ Failed'}`);

    if (directResult && !proxyResult) {
        console.log('\n✅ Your IP is NOT blocked - direct login works!');
        console.log('❌ Proxy needs configuration');
        console.log('\n📝 NEXT STEPS:');
        console.log('1. Check your IPRoyal dashboard - ensure "Randomize IP" is enabled');
        console.log('2. Verify proxy credentials in .env file');
        console.log('3. Make sure proxy host and port are correct');
    } else if (!directResult) {
        console.log('\n❌ Direct login failed - check your credentials in .env');
    } else if (proxyResult) {
        console.log('\n🎉 PROXY WORKING! Your setup is complete.');
    }
}

// Run tests
runLocalTests().catch(console.error);