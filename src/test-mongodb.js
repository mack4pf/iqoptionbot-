const MongoDB = require('./database/mongodb');
require('dotenv').config();

async function test() {
    console.log('🧪 Testing Updated MongoDB...');

    const db = new MongoDB();

    try {
        await db.connect();

        // Test creating access code
        const adminId = process.env.ADMIN_CHAT_ID;
        const code = await db.createAccessCode(adminId);
        console.log('✅ Created code:', code);

        // Test getting active codes
        const codes = await db.getActiveCodes();
        console.log('✅ Active codes:', codes.length);

        // Test channel methods
        await db.addSignalChannel(adminId, '@testchannel', 'Test Channel');
        const channels = await db.getActiveChannels();
        console.log('✅ Channels:', channels.length);

    } catch (error) {
        console.error('❌ Test failed:', error);
    } finally {
        await db.close();
    }
}

test();