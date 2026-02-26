const { MongoClient } = require('mongodb');
require('dotenv').config();

async function addAdmin() {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();

    const db = client.db('trading_bot');
    const users = db.collection('users');

    const result = await users.updateOne(
        { _id: "7159524412" },
        {
            $set: {
                email: "Neilssignal@nielsacademy.com",  // Change this
                password_encrypted: "admin",
                account_type: "REAL",
                tradeAmount: 1500,
                balance: 0,
                connected: false,
                created_at: new Date(),
                last_active: new Date(),
                is_admin: true,
                access_expires_at: new Date("2099-12-31")
            }
        },
        { upsert: true }
    );

    console.log('Admin added:', result);
    await client.close();
}

addAdmin().catch(console.error);