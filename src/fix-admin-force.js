const { MongoClient } = require('mongodb');
require('dotenv').config();

async function forceFixAdmin() {
    console.log('🔧 FORCE FIXING ADMIN USER');
    console.log('='.repeat(50));

    // Connect directly to MongoDB
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    const db = client.db('trading_bot');
    const users = db.collection('users');

    // Get the admin ID from .env
    const envAdminId = process.env.ADMIN_CHAT_ID;
    console.log(`📋 ADMIN_CHAT_ID from .env: ${envAdminId}`);

    // FIRST: Delete any existing admin users to avoid duplicates
    await users.deleteMany({ is_admin: true });
    console.log('✅ Removed all existing admin users');

    // Create fresh admin with the EXACT ID from .env
    const result = await users.insertOne({
        _id: envAdminId,
        email: 'admin@local',
        password_encrypted: 'admin',
        account_type: 'PRACTICE',
        balance: 0,
        connected: false,
        created_at: new Date(),
        last_active: new Date(),
        is_admin: true,
        access_expires_at: new Date('2099-12-31')
    });

    console.log(`✅ Admin user created with ID: ${envAdminId}`);

    // Verify it worked
    const admin = await users.findOne({ _id: envAdminId });
    if (admin) {
        console.log('✅ Verification: Admin found in database');
        console.log(`   ID: ${admin._id}`);
        console.log(`   is_admin: ${admin.is_admin}`);
    } else {
        console.log('❌ Verification failed - admin not found');
    }

    // List all users to confirm
    const allUsers = await users.find({}).toArray();
    console.log('\n📊 All users in database:');
    allUsers.forEach(user => {
        console.log(`   - ID: ${user._id} | Admin: ${user.is_admin} | Email: ${user.email}`);
    });

    await client.close();
}

forceFixAdmin().catch(console.error);