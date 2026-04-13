const IQOptionClient = require('./src/client');
require('dotenv').config();

async function testTrade() {
    const email = process.env.IQ_EMAIL;
    const password = process.env.IQ_PASSWORD;
    
    console.log(`🧪 Testing trade for ${email}...`);
    
    // Create client WITHOUT proxy to bypass the 402 error for testing
    const client = new IQOptionClient(email, password, 'TEST_ADMIN');
    
    // Force direct connection for test
    process.env.IPROYAL_HOST = ''; 

    try {
        const loggedIn = await client.login(false);
        if (!loggedIn) {
            console.error('❌ Login failed');
            return;
        }
        
        console.log('✅ Logged in. Waiting for balance...');
        client.accountType = 'PRACTICE';
        
        // Wait for profile/balances to load
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        console.log(`💰 Practice Balance: ${client.practiceBalance}`);
        
        if (!client.practiceBalanceId) {
            console.error('❌ Practice balance not found');
            return;
        }

        console.log('🚀 Placing a $1 practice trade on EURUSD-OTC (Call)...');
        const result = await client.placeTrade({
            asset: 'EURUSD-OTC',
            direction: 'call',
            amount: 1,
            duration: 1
        });
        
        if (result.success) {
            console.log(`✅ TRADE PLACED SUCCESSFULLY! Trade ID: ${result.tradeId}`);
        } else {
            console.error(`❌ Trade failed:`, result.error);
        }
        
        client.ws.close();
    } catch (error) {
        console.error('❌ Test failed:', error.message);
    }
}

testTrade();
