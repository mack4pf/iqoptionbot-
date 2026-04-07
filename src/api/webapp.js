const crypto = require('crypto');
const axios = require('axios');

class WebAppClient {
  constructor() {
    this.baseUrl = process.env.WEBAPP_URL;
    this.apiKey = process.env.WEBAPP_API_KEY;
    this.botId = process.env.WEBAPP_BOT_ID;
    this.encryptionKey = process.env.ENCRYPTION_KEY;
    this.enabled = this.baseUrl && this.apiKey && this.botId;

    // Simple in-memory cache to reduce CPU and network overhead
    this.cache = new Map();
    this.CACHE_TTL = 10 * 60 * 1000; // 10 minutes

    this.api = axios.create({
      baseURL: this.baseUrl,
      timeout: 5000,
      headers: {
        'X-Bot-API-Key': this.apiKey,
        'Content-Type': 'application/json'
      }
    });
  }

  // Helper to get from cache or fetch
  async getCachedOrFetch(key, fetchFn) {
    const cached = this.cache.get(key);
    const now = Date.now();
    if (cached && (now - cached.timestamp < this.CACHE_TTL)) {
      return cached.data;
    }
    const data = await fetchFn();
    this.cache.set(key, { data, timestamp: now });
    // Cleanup old cache occasionally
    if (this.cache.size > 1000) this.cache.clear();
    return data;
  }

  // Decrypt password
  decryptPassword(encryptedHex) {
    if (!encryptedHex || !this.encryptionKey) return null;
    try {
      const key = Buffer.from(this.encryptionKey, 'hex');
      const [ivHex, encrypted] = encryptedHex.split(':');
      const iv = Buffer.from(ivHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (error) {
      return null;
    }
  }

  async getUserSettings(email) {
    if (!this.enabled) return null;
    const cacheKey = `settings_${email}`;
    return this.getCachedOrFetch(cacheKey, async () => {
      try {
        const response = await this.api.get(`/api/internal/bot/${this.botId}/user/${encodeURIComponent(email)}/credentials`);
        return response.data;
      } catch (error) {
        return null;
      }
    });
  }

  async checkSubscription(email) {
    if (!this.enabled) return null;
    const cacheKey = `sub_${email}`;
    return this.getCachedOrFetch(cacheKey, async () => {
      try {
        const response = await this.api.get(`/api/internal/bot/${this.botId}/user/${encodeURIComponent(email)}/subscription`);
        return response.data?.valid === true;
      } catch (error) {
        return null;
      }
    });
  }

  async syncUserSettings(email, settings) {
    if (!this.enabled) return false;
    // We clear cache on sync so next fetch has latest
    this.cache.delete(`settings_${email}`);
    try {
      const response = await this.api.post(`/api/internal/bot/${this.botId}/user/${encodeURIComponent(email)}/settings`, settings);
      return response.status === 200 || response.status === 201;
    } catch (error) {
      return false;
    }
  }

  async getUserCredentials(email) {
    return this.getUserSettings(email);
  }
}

module.exports = new WebAppClient();
