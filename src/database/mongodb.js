const { MongoClient } = require('mongodb');
require('dotenv').config();

class MongoDB {
    constructor() {
        this.uri = process.env.MONGODB_URI;
        this.dbName = 'trading_bot';
        this.client = null;
        this.db = null;
    }

    async connect() {
        try {
            this.client = new MongoClient(this.uri);
            await this.client.connect();
            this.db = this.client.db(this.dbName);

            console.log('✅ Connected to MongoDB Atlas');
            await this.createIndexes();
            await this.ensureAdminUser();

            return this.db;
        } catch (error) {
            console.error('❌ MongoDB connection failed:', error);
            throw error;
        }
    }

    async createIndexes() {
        try {
            const users = this.db.collection('users');
            const codes = this.db.collection('access_codes');
            const channels = this.db.collection('signal_channels');
            const trades = this.db.collection('trades');

            // Users collection indexes
            try {
                await users.createIndex({ "email": 1 }, { unique: false, name: "email_index" });
            } catch (err) {
                if (err.codeName === 'IndexKeySpecsConflict') console.log('ℹ️ Email index exists');
            }

            try {
                await users.createIndex({ "last_active": -1 }, { name: "last_active_index" });
            } catch (err) {
                if (err.codeName === 'IndexKeySpecsConflict') console.log('ℹ️ Last active index exists');
            }

            try {
                await users.createIndex({ "access_expires_at": 1 }, { name: "access_expires_index" });
            } catch (err) {
                if (err.codeName === 'IndexKeySpecsConflict') console.log('ℹ️ Access expires index exists');
            }

            // Access codes collection indexes
            try {
                await codes.createIndex({ "code": 1 }, { unique: true, name: "code_unique_index" });
            } catch (err) {
                if (err.codeName === 'IndexKeySpecsConflict') console.log('ℹ️ Code index exists');
            }

            try {
                await codes.createIndex({ "expires_at": 1 }, { name: "code_expires_index" });
            } catch (err) {
                if (err.codeName === 'IndexKeySpecsConflict') console.log('ℹ️ Code expires index exists');
            }

            try {
                await codes.createIndex({ "used_by": 1 }, { name: "code_used_by_index" });
            } catch (err) {
                if (err.codeName === 'IndexKeySpecsConflict') console.log('ℹ️ Code used_by index exists');
            }

            // Signal channels collection indexes
            try {
                await channels.createIndex({ "channel_id": 1 }, { unique: true, name: "channel_id_unique_index" });
            } catch (err) {
                if (err.codeName === 'IndexKeySpecsConflict') console.log('ℹ️ Channel ID index exists');
            }

            // Trades collection indexes
            try {
                await trades.createIndex({ "user_id": 1, "close_time": -1 }, { name: "user_trades_index" });
            } catch (err) {
                if (err.codeName === 'IndexKeySpecsConflict') console.log('ℹ️ User trades index exists');
            }

            try {
                await trades.createIndex({ "trade_id": 1 }, { unique: true, name: "trade_id_unique_index" });
            } catch (err) {
                if (err.codeName === 'IndexKeySpecsConflict') console.log('ℹ️ Trade ID index exists');
            }

            console.log('✅ Indexes verified');
        } catch (error) {
            console.error('❌ Error creating indexes:', error);
            throw error;
        }
    }

    async ensureAdminUser() {
        const adminChatId = process.env.ADMIN_CHAT_ID;
        if (!adminChatId) {
            console.log('⚠️ ADMIN_CHAT_ID not set in .env');
            return;
        }

        const users = this.db.collection('users');

        try {
            const admin = await users.findOne({ _id: adminChatId });

            if (!admin) {
                await users.insertOne({
                    _id: adminChatId,
                    email: 'admin@local',
                    password_encrypted: 'admin',
                    account_type: 'PRACTICE',
                    tradeAmount: 1500, // Default trade amount for admin
                    balance: 0,
                    copyAdminEnabled: false,
                    autoTraderEnabled: true,
                    connected: false,
                    created_at: new Date(),
                    last_active: new Date(),
                    is_admin: true,
                    access_expires_at: new Date('2099-12-31')
                });
                console.log('✅ Admin user created');
            } else {
                if (!admin.is_admin) {
                    await users.updateOne(
                        { _id: adminChatId },
                        { $set: { is_admin: true, access_expires_at: new Date('2099-12-31') } }
                    );
                    console.log('✅ Admin privileges updated');
                } else {
                    console.log('✅ Admin user already exists');
                }
            }
        } catch (error) {
            if (error.code === 11000) {
                console.log('✅ Admin user already exists (duplicate ignored)');
            } else {
                console.error('❌ Error ensuring admin user:', error);
                throw error;
            }
        }
    }

    generateUniqueCode() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const segments = [];
        for (let i = 0; i < 3; i++) {
            let segment = '';
            for (let j = 0; j < 4; j++) {
                segment += chars[Math.floor(Math.random() * chars.length)];
            }
            segments.push(segment);
        }
        return `IQ-${segments.join('-')}`;
    }

    async createAccessCode(adminChatId, daysValid = 30) {
        const collection = this.db.collection('access_codes');
        const code = this.generateUniqueCode();

        const now = new Date();
        const expiresAt = new Date(now);
        expiresAt.setDate(expiresAt.getDate() + daysValid);

        const accessCode = {
            code,
            created_by: adminChatId.toString(),
            created_at: now,
            expires_at: expiresAt,
            used_by: null,
            used_at: null,
            active: true
        };

        await collection.insertOne(accessCode);
        return code;
    }

    async validateAccessCode(code) {
        const collection = this.db.collection('access_codes');
        return await collection.findOne({
            code: code,
            active: true,
            used_by: null,
            expires_at: { $gt: new Date() }
        });
    }

    async useAccessCode(code, userChatId) {
        const collection = this.db.collection('access_codes');
        const result = await collection.updateOne(
            { code: code, used_by: null },
            {
                $set: {
                    used_by: userChatId.toString(),
                    used_at: new Date(),
                    active: false
                }
            }
        );
        return result.modifiedCount > 0;
    }

    async getActiveCodes() {
        const collection = this.db.collection('access_codes');
        return await collection.find({
            active: true,
            expires_at: { $gt: new Date() }
        }).toArray();
    }

    // ✅ UPDATED: registerUserWithCode now includes tradeAmount field
    async registerUserWithCode(chatId, email, password, code) {
        const accessCode = await this.validateAccessCode(code);
        if (!accessCode) {
            throw new Error('Invalid or expired access code');
        }

        await this.useAccessCode(code, chatId);

        const encrypted = this.encrypt(password);
        const users = this.db.collection('users');

        const existing = await users.findOne({ _id: chatId.toString() });
        if (existing) {
            throw new Error('User already registered');
        }

        const user = {
            _id: chatId.toString(),
            email,
            password_encrypted: encrypted,
            account_type: 'PRACTICE',
            tradeAmount: 1500, // ✅ DEFAULT TRADE AMOUNT (1500 NGN)
            copyAdminEnabled: false,
            autoTraderEnabled: true,
            balance: 0,
            connected: false,
            created_at: new Date(),
            last_active: new Date(),
            access_code: code,
            access_expires_at: accessCode.expires_at,
            is_admin: false,
            stats: {
                total_trades: 0,
                wins: 0,
                losses: 0,
                total_profit: 0
            },
            martingale: {
                current_step: 0,
                current_amount: 1,
                loss_streak: 0
            }
        };

        await users.insertOne(user);
        return user;
    }

    async getUser(chatId) {
        const users = this.db.collection('users');
        return await users.findOne({ _id: chatId.toString() });
    }

    async updateUser(chatId, updates) {
        const users = this.db.collection('users');
        updates.last_active = new Date();
        return await users.updateOne(
            { _id: chatId.toString() },
            { $set: updates }
        );
    }

    async getAllUsers() {
        const users = this.db.collection('users');
        return await users.find({}).toArray();
    }

    async hasValidAccess(chatId) {
        const users = this.db.collection('users');
        const user = await users.findOne({ _id: chatId.toString() });

        if (!user) return false;
        if (user.is_admin) return true;

        return user.access_expires_at && new Date(user.access_expires_at) > new Date();
    }

    async revokeUserAccess(chatId) {
        const users = this.db.collection('users');
        return await users.updateOne(
            { _id: chatId.toString() },
            { $set: { access_expires_at: new Date() } }
        );
    }

    async addSignalChannel(adminChatId, channelId, channelName) {
        const collection = this.db.collection('signal_channels');

        const channel = {
            channel_id: channelId,
            channel_name: channelName,
            added_by: adminChatId.toString(),
            added_at: new Date(),
            active: true,
            signal_count: 0
        };

        await collection.insertOne(channel);
        return channel;
    }

    async removeSignalChannel(channelId) {
        const collection = this.db.collection('signal_channels');
        return await collection.deleteOne({ channel_id: channelId });
    }

    async getActiveChannels() {
        const collection = this.db.collection('signal_channels');
        return await collection.find({ active: true }).toArray();
    }

    async incrementChannelSignalCount(channelId) {
        const collection = this.db.collection('signal_channels');
        return await collection.updateOne(
            { channel_id: channelId },
            { $inc: { signal_count: 1 } }
        );
    }

    encrypt(text) {
        const crypto = require('crypto');
        const algorithm = 'aes-256-cbc';
        const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
        const iv = crypto.randomBytes(16);

        const cipher = crypto.createCipheriv(algorithm, key, iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');

        return iv.toString('hex') + ':' + encrypted;
    }

    decrypt(encryptedText) {
        const crypto = require('crypto');
        const algorithm = 'aes-256-cbc';
        const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
        const [ivHex, encrypted] = encryptedText.split(':');
        const iv = Buffer.from(ivHex, 'hex');

        const decipher = crypto.createDecipheriv(algorithm, key, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    }

    async close() {
        if (this.client) {
            await this.client.close();
            console.log('🔌 MongoDB connection closed');
        }
    }
}

module.exports = MongoDB;