// Handles proxy rotation for logins
class ProxyManager {
    constructor() {
        this.host = process.env.IPROYAL_HOST;
        this.port = parseInt(process.env.IPROYAL_PORT);
        this.username = process.env.IPROYAL_USERNAME;
        this.password = process.env.IPROYAL_PASSWORD;
        this.protocol = process.env.IPROYAL_PROTOCOL || 'http';
    }

    getAxiosConfig() {
        return {
            proxy: {
                protocol: this.protocol,
                host: this.host,
                port: this.port,
                auth: {
                    username: this.username,
                    password: this.password
                }
            },
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        };
    }

    // Test if proxy is working
    async testProxy() {
        try {
            const axios = require('axios');
            const response = await axios.get('https://api.ipify.org?format=json', this.getAxiosConfig());
            console.log(`✅ Proxy working - IP: ${response.data.ip}`);
            return true;
        } catch (error) {
            console.error('❌ Proxy test failed:', error.message);
            return false;
        }
    }
}

module.exports = ProxyManager;