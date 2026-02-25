const MongoDB = require('./database/mongodb');
require('dotenv').config();

async function checkAdmin() {
    console.log('🔍 Checking Admin User...');
    console.log('='.repeat(50));

    const db = new MongoDB();
    await db.connect();

    const adminId = process.env.ADMIN_CHAT_ID;
    console.log(`📋 ADMIN_CHAT_ID from .env: ${adminId}`);

    // Check if admin exists in database
    const admin = await db.getUser(adminId);

    if (admin) {
        console.log('✅ Admin user found in database:');
        console.log(`   ID: ${admin._id}`);
        console.log(`   Email: ${admin.email}`);
        console.log(`   is_admin: ${admin.is_admin}`);
        console.log(`   Account Type: ${admin.account_type}`);
    } else {
        console.log('❌ Admin user NOT found in database');
        console.log('   Creating admin user now...');

        // Create admin user
        const users = db.db.collection('users');
        await users.insertOne({
            _id: adminId,
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
        console.log('✅ Admin user created successfully');
    }

    const users = await db.db.collection('users').find({}).toArray();
    console.log('\n📊 All users in database:');
    users.forEach(user => {
        console.log(`   - ${user._id} | Admin: ${user.is_admin} | Email: ${user.email}`);
    });

    await db.close();
}

checkAdmin().catch(console.error);