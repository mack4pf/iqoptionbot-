require('dotenv').config();
const axios = require('axios');
const IQOptionClient = require('./src/client');

// Function to test raw axios requests directly
async function testDirectLogin() {
    console.log('\n🔍 TESTING DIRECT AXIOS LOGIN');
    console.log('='.repeat(50));

    const email = process.env.IQ_EMAIL;
    const password = process.env.IQ_PASSWORD;

    if (!email || !password) {
        console.error('❌ Credentials not found in .env');
        return null;
    }

    // Test different endpoint variations
    const tests = [
        {
            name: 'Endpoint v1.0 (Standard)',
            url: 'https://auth.iqoption.com/api/v1.0/login',
            data: { email, password }
        },
        {
            name: 'Endpoint v1.0 with User-Agent',
            url: 'https://auth.iqoption.com/api/v1.0/login',
            data: { email, password },
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Origin': 'https://iqoption.com',
                'Referer': 'https://iqoption.com/'
            }
        },
        {
            name: 'Endpoint v2.0 (identifier format)',
            url: 'https://auth.iqoption.com/api/v2.0/login',
            data: { identifier: email, password }
        },
        {
            name: 'Endpoint v2.0 with headers',
            url: 'https://auth.iqoption.com/api/v2.0/login',
            data: { identifier: email, password },
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        },
        {
            name: 'Login with ssid check',
            url: 'https://auth.iqoption.com/api/v1.0/login',
            data: { email, password },
            params: { ssid: true }
        }
    ];

    for (const test of tests) {
        console.log(`\n📡 Testing: ${test.name}`);
        console.log('-'.repeat(40));

        try {
            const start = Date.now();

            const config = {
                method: 'post',
                url: test.url,
                data: test.data,
                headers: test.headers || {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: 15000
            };

            if (test.params) config.params = test.params;

            const response = await axios(config);
            const duration = Date.now() - start;

            console.log(`✅ Status: ${response.status}`);
            console.log(`⏱️  Time: ${duration}ms`);

            if (response.data?.data?.ssid) {
                console.log(`✅ SSID FOUND: ${response.data.data.ssid.substring(0, 20)}...`);
                console.log(`🎉 SUCCESS! This endpoint works.`);
                return response.data.data.ssid;
            } else {
                console.log(`⚠️ Response structure:`, Object.keys(response.data));
            }

        } catch (error) {
            console.log(`❌ Failed: ${error.message}`);
            if (error.response) {
                console.log(`   Status: ${error.response.status}`);
                console.log(`   Status Text: ${error.response.statusText}`);
                if (error.response.data) {
                    console.log(`   Data:`, JSON.stringify(error.response.data).substring(0, 200));
                }
            } else if (error.code) {
                console.log(`   Error Code: ${error.code}`);
            }
        }
    }

    return null;
}

// Test your existing client
async function testClientLogin() {
    console.log('\n🔍 TESTING YOUR CLIENT LOGIN');
    console.log('='.repeat(50));

    const email = process.env.IQ_EMAIL;
    const password = process.env.IQ_PASSWORD;

    if (!email || !password) {
        console.error('❌ Credentials not found in .env');
        return;
    }

    const client = new IQOptionClient(email, password, 'test-chat-id');

    try {
        console.log(`Starting login test for ${email}...`);
        const start = Date.now();
        const result = await client.login();
        const duration = Date.now() - start;

        console.log(`⏱️  Time: ${duration}ms`);

        if (result) {
            console.log('✅ LOGIN SUCCESSFUL');
            console.log('SSID:', client.ssid ? client.ssid.substring(0, 30) + '...' : 'Not set');

            // Check if balance was loaded
            if (client.balance) {
                console.log(`💰 Balance: ${client.currency} ${client.balance}`);
            }

            return true;
        } else {
            console.error('❌ Login returned false');
            return false;
        }
    } catch (error) {
        console.error('❌ Login error:', error.message);
        return false;
    }
}

// Main test function
async function runTests() {
    console.log('🚀 IQ OPTION LOGIN DIAGNOSTIC TEST');
    console.log('='.repeat(60));
    console.log(`Testing with email: ${process.env.IQ_EMAIL}`);
    console.log('='.repeat(60));

    // Test direct axios first
    const ssid = await testDirectLogin();

    // Then test your client
    const clientResult = await testClientLogin();

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 TEST SUMMARY');
    console.log('='.repeat(60));
    console.log(`Direct axios login: ${ssid ? '✅ WORKING' : '❌ FAILED'}`);
    console.log(`Your client login: ${clientResult ? '✅ WORKING' : '❌ FAILED'}`);

    if (ssid && !clientResult) {
        console.log('\n🔧 DIAGNOSIS: Direct login works but client fails.');
        console.log('   This means your client.login() method needs updating.');
    } else if (!ssid && clientResult) {
        console.log('\n🔧 DIAGNOSIS: Client works but direct test fails.');
        console.log('   This means your client has custom headers/cookies that work.');
    } else if (!ssid && !clientResult) {
        console.log('\n🔧 DIAGNOSIS: Neither method works.');
        console.log('   Possible issues:');
        console.log('   • Network/IP blocking');
        console.log('   • Invalid credentials');
        console.log('   • 2FA required');
        console.log('   • API endpoint changed completely');
    } else {
        console.log('\n🎉 Both methods work! Login is fine.');
    }
}

// Run the tests
runTests().catch(console.error);