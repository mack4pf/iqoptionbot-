const axios = require('axios');
const tunnel = require('tunnel');

const proxy = {
    host: 'geo.iproyal.com',
    port: 12321,
    proxyAuth: 'q0oQNqQcBkABxd1M:ryLtLu1bIVYuzTac'
};

const agent = tunnel.httpsOverHttp({
    proxy: proxy
});

async function testProxy() {
    try {
        console.log('Testing proxy connection...');
        const response = await axios.get('https://api.ipify.org?format=json', {
            httpsAgent: agent,
            proxy: false,
            timeout: 10000
        });
        console.log('Proxy connection successful!');
        console.log('Proxy IP:', response.data.ip);
    } catch (error) {
        console.error('Proxy test failed!');
        console.error('Error message:', error.message);
        if (error.response) {
            console.error('Status:', error.response.status);
        }
    }
}

testProxy();
