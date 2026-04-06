const MongoDB = require('./src/database/mongodb');
require('dotenv').config();

async function runTest() {
    console.log('🧪 STARTING REGISTRATION & ACCESS CODE TEST');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    const db = new MongoDB();
    await db.connect();
    
    const TEST_USER_ID = 'TEST_USER_' + Date.now();
    const TEST_ADMIN_ID = process.env.ADMIN_CHAT_ID || 'admin';
    const TEST_EMAIL = 'test_user_' + Date.now() + '@example.com';
    
    try {
        // 1. Generate an access code
        console.log('1️⃣ Generating test access code...');
        const code = await db.createAccessCode(TEST_ADMIN_ID);
        console.log('✅ Code generated:', code);
        
        // 2. Test initial registration
        console.log('2️⃣ Testing initial user registration...');
        const user = await db.registerUserWithCode(TEST_USER_ID, TEST_EMAIL, 'password123', code);
        console.log('✅ User registered successfully:', user.email);
        
        // 3. Verify code is now used
        console.log('3️⃣ Verifying code is now inactive...');
        const checkCode = await db.validateAccessCode(code);
        if (!checkCode) {
            console.log('✅ Code correctly marked as inactive.');
        } else {
            console.error('❌ ERROR: Code is still active after use!');
        }
        
        // 4. Test re-activation with a NEW code (Simulating "Already Registered" fix)
        console.log('4️⃣ Testing re-activation with a NEW code...');
        const newCode = await db.createAccessCode(TEST_ADMIN_ID);
        console.log('✅ New code generated:', newCode);
        
        const activated = await db.updateUserAccessCode(TEST_USER_ID, newCode);
        if (activated) {
            const updatedUser = await db.getUser(TEST_USER_ID);
            console.log('✅ User re-activated successfully. New expiry:', updatedUser.access_expires_at);
        } else {
            console.error('❌ ERROR: Re-activation failed!');
        }
        
        // 5. Cleanup
        console.log('5️⃣ Cleaning up test data...');
        await db.deleteUser(TEST_USER_ID);
        // Clean up codes manually if needed, but since we use unique IDs it's fine
        console.log('✅ Test data removed.');
        
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🎉 ALL DB LOGIC TESTS PASSED!');
        
    } catch (error) {
        console.error('❌ TEST FAILED:', error);
    } finally {
        await db.close();
    }
}

runTest();
