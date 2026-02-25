require('dotenv').config();

console.log('🔍 TESTING ENVIRONMENT VARIABLES');
console.log('='.repeat(50));
console.log('ADMIN_CHAT_ID from .env:', process.env.ADMIN_CHAT_ID);
console.log('Length:', process.env.ADMIN_CHAT_ID?.length);
console.log('Characters:', JSON.stringify(process.env.ADMIN_CHAT_ID));
console.log('='.repeat(50));