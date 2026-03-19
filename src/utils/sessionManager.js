// Handles SSID storage and retrieval
class SessionManager {
    constructor(db) {
        this.db = db;
    }

    // Store SSID after successful login
    async storeSession(userId, ssid) {
        try {
            await this.db.updateUser(userId, {
                ssid: ssid,
                ssid_updated_at: new Date(),
                connected: true
            });
            console.log(`💾 SSID stored for user ${userId}`);
            return true;
        } catch (error) {
            console.error(`❌ Failed to store SSID for user ${userId}:`, error.message);
            return false;
        }
    }

    // Retrieve stored SSID
    async getSession(userId) {
        try {
            const user = await this.db.getUser(userId);
            if (user && user.ssid) {
                // Check if SSID is still valid (optional: check age)
                console.log(`🔍 Found stored SSID for user ${userId}`);
                return user.ssid;
            }
            return null;
        } catch (error) {
            console.error(`❌ Failed to get SSID for user ${userId}:`, error.message);
            return null;
        }
    }

    // Clear SSID on logout
    async clearSession(userId) {
        try {
            await this.db.updateUser(userId, {
                ssid: null,
                connected: false
            });
            console.log(`🗑️ SSID cleared for user ${userId}`);
            return true;
        } catch (error) {
            console.error(`❌ Failed to clear SSID for user ${userId}:`, error.message);
            return false;
        }
    }

    // Test if SSID is still valid
    async testSession(ssid) {
        return new Promise((resolve) => {
            const WebSocket = require('ws');
            const ws = new WebSocket(`wss://ws.iqoption.com/echo/websocket?ssid=${ssid}`);

            const timeout = setTimeout(() => {
                ws.close();
                resolve(false);
            }, 5000);

            ws.on('open', () => {
                clearTimeout(timeout);
                ws.close();
                resolve(true);
            });

            ws.on('error', () => {
                clearTimeout(timeout);
                resolve(false);
            });
        });
    }
}

module.exports = SessionManager;