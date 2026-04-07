require('dotenv').config();
const webapp = require('./src/api/webapp');

async function test() {
    console.log('Testing webapp client...');
    console.log('Base URL:', webapp.baseUrl);
    console.log('Enabled:', webapp.enabled);
    
    // Testing a dummy call
    try {
        const sub = await webapp.checkSubscription('test@example.com');
        console.log('Subscription check for test@example.com:', sub);
    } catch (e) {
        console.error('Error in test:', e.message);
    }
}

test();
