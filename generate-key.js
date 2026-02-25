const crypto = require('crypto');
const key = crypto.randomBytes(32).toString('hex');
console.log('Add this to your .env file:');
console.log(`ENCRYPTION_KEY=${key}`);