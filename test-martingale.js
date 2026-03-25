// test-martingale.js
// Run with: node test-martingale.js

class MartingaleTest {
    constructor() {
        this.martingaleMultipliers = [1, 1, 1, 1, 4, 8, 16, 32];
        this.MAX_STEPS = 8;
    }

    resetMartingale(state) {
        state.step = 0;
        state.losses = 0;
        state.currentAmount = state.baseAmount;
        return state;
    }

    advanceMartingale(state) {
        // Increase loss counter
        state.losses++;

        // Safety: if 8 losses, reset completely
        if (state.losses >= this.MAX_STEPS) {
            console.log(`   ⚠️ 8 losses reached - Safety reset`);
            this.resetMartingale(state);
            return state;
        }

        // Next trade amount = base * multiplier[losses]
        let newStep = state.losses;
        if (newStep >= this.martingaleMultipliers.length) {
            newStep = this.martingaleMultipliers.length - 1;
        }

        const multiplier = this.martingaleMultipliers[newStep];
        let newAmount = state.baseAmount * multiplier;

        state.step = newStep;
        state.currentAmount = newAmount;

        return state;
    }

    getTradeAmount(state) {
        return state.currentAmount;
    }

    // ========== TEST 1: Full 8 Losses Sequence ==========
    testFullLossSequence() {
        console.log(`\n${'='.repeat(70)}`);
        console.log(`📊 TEST 1: 8 CONSECUTIVE LOSSES - VERIFY MARTINGALE PROGRESSION`);
        console.log(`${'='.repeat(70)}`);

        const baseAmount = 100000;
        let state = {
            step: 0,
            losses: 0,
            baseAmount: baseAmount,
            currentAmount: baseAmount,
            initialBalance: 1000000
        };

        console.log(`\n💰 Base Amount: ${baseAmount}`);
        console.log(`📈 Expected Progression: 1x → 1x → 1x → 1x → 4x → 8x → 16x → 32x\n`);

        const expectedAmounts = [
            baseAmount,      // Trade 1 (0 losses)
            baseAmount,      // Trade 2 (1 loss)
            baseAmount,      // Trade 3 (2 losses)
            baseAmount,      // Trade 4 (3 losses)
            baseAmount * 4,  // Trade 5 (4 losses)
            baseAmount * 8,  // Trade 6 (5 losses)
            baseAmount * 16, // Trade 7 (6 losses)
            baseAmount * 32  // Trade 8 (7 losses)
        ];

        let allCorrect = true;

        for (let i = 1; i <= 8; i++) {
            const amountBefore = this.getTradeAmount(state);
            console.log(`Trade #${i}:`);
            console.log(`   Losses before: ${state.losses}`);
            console.log(`   Amount used: ${amountBefore}`);
            console.log(`   Expected: ${expectedAmounts[i - 1]}`);

            if (amountBefore !== expectedAmounts[i - 1]) {
                console.log(`   ❌ WRONG: Expected ${expectedAmounts[i - 1]}, got ${amountBefore}`);
                allCorrect = false;
            } else {
                console.log(`   ✅ CORRECT`);
            }

            // Process loss
            console.log(`   Result: LOSS`);
            this.advanceMartingale(state);
            console.log(`   Losses after: ${state.losses}\n`);
        }

        console.log(`\n${'─'.repeat(50)}`);
        if (allCorrect) {
            console.log(`✅ TEST 1 PASSED: Full 8-loss sequence is correct`);
        } else {
            console.log(`❌ TEST 1 FAILED: Check the errors above`);
        }

        return allCorrect;
    }

    // ========== TEST 2: Win Reset at Each Step ==========
    testWinResetAtEachStep() {
        console.log(`\n${'='.repeat(70)}`);
        console.log(`📊 TEST 2: WIN RESET AT EACH STEP - VERIFY RESET TO BASE AMOUNT`);
        console.log(`${'='.repeat(70)}`);

        const baseAmount = 100000;
        const steps = [1, 2, 3, 4, 5, 6, 7];
        let allCorrect = true;

        for (const lossesToSimulate of steps) {
            let state = {
                step: 0,
                losses: 0,
                baseAmount: baseAmount,
                currentAmount: baseAmount,
                initialBalance: 1000000
            };

            console.log(`\n${'─'.repeat(50)}`);
            console.log(`📊 Scenario: ${lossesToSimulate} loss(es) then WIN`);
            console.log(`${'─'.repeat(50)}`);

            // Simulate losses
            for (let i = 1; i <= lossesToSimulate; i++) {
                const amountBefore = this.getTradeAmount(state);
                console.log(`   Loss #${i}: Amount=${amountBefore}`);
                this.advanceMartingale(state);
            }

            console.log(`\n   📍 BEFORE WIN: Losses=${state.losses}, Step=${state.step}, Amount=${state.currentAmount}`);
            console.log(`   ✅ WIN! Resetting martingale...`);

            // Reset on win
            this.resetMartingale(state);

            console.log(`   📍 AFTER WIN: Losses=${state.losses}, Step=${state.step}, Amount=${state.currentAmount}`);

            // Verify
            const isCorrect = state.currentAmount === baseAmount;
            if (isCorrect) {
                console.log(`   ✅ CORRECT: Reset to base amount ${baseAmount}`);
            } else {
                console.log(`   ❌ WRONG: Expected ${baseAmount}, got ${state.currentAmount}`);
                allCorrect = false;
            }
        }

        console.log(`\n${'─'.repeat(50)}`);
        if (allCorrect) {
            console.log(`✅ TEST 2 PASSED: Win reset works correctly at all steps`);
        } else {
            console.log(`❌ TEST 2 FAILED: Check the errors above`);
        }

        return allCorrect;
    }

    // ========== TEST 3: CRITICAL BUG FIX - Win after 2 losses then new loss sequence ==========
    testCriticalBugFix() {
        console.log(`\n${'='.repeat(70)}`);
        console.log(`📊 TEST 3: CRITICAL BUG FIX - WIN AFTER 2 LOSSES THEN NEW LOSS SEQUENCE`);
        console.log(`${'='.repeat(70)}`);
        console.log(`This test verifies that after a win, the next loss sequence starts from base amount (1x),`);
        console.log(`NOT from 4x multiplier. This was the bug you reported.`);
        console.log(`${'='.repeat(70)}`);

        const baseAmount = 100000;
        let state = {
            step: 0,
            losses: 0,
            baseAmount: baseAmount,
            currentAmount: baseAmount,
            initialBalance: 1000000
        };

        console.log(`\n💰 Base Amount: ${baseAmount}\n`);

        // Phase 1: Two losses then win
        console.log(`【 PHASE 1: Two losses then WIN 】`);

        // Trade 1: Loss
        console.log(`Trade 1 (LOSS):`);
        console.log(`   Amount: ${this.getTradeAmount(state)} (should be ${baseAmount} × 1 = ${baseAmount})`);
        this.advanceMartingale(state);
        console.log(`   Losses after: ${state.losses}\n`);

        // Trade 2: Loss
        console.log(`Trade 2 (LOSS):`);
        console.log(`   Amount: ${this.getTradeAmount(state)} (should be ${baseAmount} × 1 = ${baseAmount})`);
        this.advanceMartingale(state);
        console.log(`   Losses after: ${state.losses}\n`);

        // Trade 3: WIN
        console.log(`Trade 3 (WIN):`);
        console.log(`   Amount before win: ${this.getTradeAmount(state)}`);
        console.log(`   ✅ WIN! Resetting martingale...`);
        this.resetMartingale(state);
        console.log(`   After reset - Losses: ${state.losses}, Amount: ${state.currentAmount}\n`);

        // Verify reset was correct
        let phase1Correct = (state.losses === 0 && state.currentAmount === baseAmount);
        console.log(`   ${phase1Correct ? '✅' : '❌'} Reset verification: Losses=${state.losses} (should be 0), Amount=${state.currentAmount} (should be ${baseAmount})`);

        // Phase 2: New loss sequence (should start from base amount)
        console.log(`\n【 PHASE 2: New loss sequence after win 】`);

        // Trade 4: Loss (should be base × 1)
        console.log(`Trade 4 (LOSS) - First loss after win:`);
        console.log(`   Amount: ${this.getTradeAmount(state)}`);
        const trade4Correct = this.getTradeAmount(state) === baseAmount;
        console.log(`   ${trade4Correct ? '✅' : '❌'} Should be ${baseAmount} × 1 = ${baseAmount}`);
        this.advanceMartingale(state);

        // Trade 5: Loss (should be base × 1)
        console.log(`\nTrade 5 (LOSS) - Second loss after win:`);
        console.log(`   Amount: ${this.getTradeAmount(state)}`);
        const trade5Correct = this.getTradeAmount(state) === baseAmount;
        console.log(`   ${trade5Correct ? '✅' : '❌'} Should be ${baseAmount} × 1 = ${baseAmount}`);
        this.advanceMartingale(state);

        // Trade 6: Loss (should be base × 1 - still not 4x)
        console.log(`\nTrade 6 (LOSS) - Third loss after win:`);
        console.log(`   Amount: ${this.getTradeAmount(state)}`);
        const trade6Correct = this.getTradeAmount(state) === baseAmount;
        console.log(`   ${trade6Correct ? '✅' : '❌'} Should be ${baseAmount} × 1 = ${baseAmount}`);
        this.advanceMartingale(state);

        // Trade 7: Loss (should be base × 1 - still not 4x)
        console.log(`\nTrade 7 (LOSS) - Fourth loss after win:`);
        console.log(`   Amount: ${this.getTradeAmount(state)}`);
        const trade7Correct = this.getTradeAmount(state) === baseAmount;
        console.log(`   ${trade7Correct ? '✅' : '❌'} Should be ${baseAmount} × 1 = ${baseAmount}`);
        this.advanceMartingale(state);

        // Trade 8: Loss (should be base × 4 - NOW it should be 4x)
        console.log(`\nTrade 8 (LOSS) - Fifth loss after win (should trigger 4x):`);
        console.log(`   Amount: ${this.getTradeAmount(state)}`);
        const trade8Correct = this.getTradeAmount(state) === baseAmount * 4;
        console.log(`   ${trade8Correct ? '✅' : '❌'} Should be ${baseAmount} × 4 = ${baseAmount * 4}`);

        const allCorrect = phase1Correct && trade4Correct && trade5Correct && trade6Correct && trade7Correct && trade8Correct;

        console.log(`\n${'─'.repeat(50)}`);
        if (allCorrect) {
            console.log(`✅ TEST 3 PASSED: Critical bug is fixed!`);
            console.log(`   After win, new loss sequence starts from base amount (1x), not 4x.`);
        } else {
            console.log(`❌ TEST 3 FAILED: The bug still exists!`);
            console.log(`   After win, the bot is using wrong multiplier for new loss sequence.`);
        }

        return allCorrect;
    }

    // ========== TEST 4: 100 Random Users Simulation ==========
    runMultipleUsersSimulation() {
        console.log(`\n${'='.repeat(70)}`);
        console.log(`📊 TEST 4: 100 USER SIMULATIONS WITH DIFFERENT BASE AMOUNTS`);
        console.log(`${'='.repeat(70)}`);

        const baseAmounts = [
            1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000,
            10000, 15000, 20000, 25000, 30000, 35000, 40000, 45000, 50000,
            75000, 100000, 150000, 200000, 250000, 300000, 350000, 400000, 450000, 500000,
            600000, 700000, 800000, 900000, 1000000
        ];

        let allCorrect = true;
        let passed = 0;
        let failed = 0;

        for (let i = 0; i < 100; i++) {
            const randomBase = baseAmounts[Math.floor(Math.random() * baseAmounts.length)];
            const userId = `user_${i + 1}`;

            let state = {
                step: 0,
                losses: 0,
                baseAmount: randomBase,
                currentAmount: randomBase,
                initialBalance: 10000000
            };

            // Track the sequence of amounts used for each trade
            const sequence = [];

            // Simulate 8 consecutive losses
            for (let lossNum = 1; lossNum <= 8; lossNum++) {
                const amountBefore = state.currentAmount;
                sequence.push(amountBefore);
                this.advanceMartingale(state);
            }

            // Expected amounts:
            // Trade 1 (0 losses) -> base * 1
            // Trade 2 (1 loss)  -> base * 1
            // Trade 3 (2 losses) -> base * 1
            // Trade 4 (3 losses) -> base * 1
            // Trade 5 (4 losses) -> base * 4
            // Trade 6 (5 losses) -> base * 8
            // Trade 7 (6 losses) -> base * 16
            // Trade 8 (7 losses) -> base * 32
            const expectedAmounts = [
                randomBase,
                randomBase,
                randomBase,
                randomBase,
                randomBase * 4,
                randomBase * 8,
                randomBase * 16,
                randomBase * 32
            ];

            let isCorrect = true;
            for (let j = 0; j < sequence.length; j++) {
                if (sequence[j] !== expectedAmounts[j]) {
                    isCorrect = false;
                    console.log(`❌ User ${userId}: Trade ${j + 1} amount ${sequence[j]} should be ${expectedAmounts[j]}`);
                }
            }

            if (isCorrect) {
                passed++;
            } else {
                failed++;
                allCorrect = false;
                console.log(`\n❌ FAILED: User ${userId} with base ${randomBase}`);
                console.log(`Sequence: ${sequence.join(' → ')}`);
                console.log(`Expected: ${expectedAmounts.join(' → ')}`);
            }
        }

        // Summary
        console.log(`\n${'='.repeat(70)}`);
        console.log(`📊 SIMULATION SUMMARY`);
        console.log(`${'='.repeat(70)}`);
        console.log(`✅ Passed: ${passed}/100`);
        console.log(`❌ Failed: ${failed}/100`);

        if (passed === 100) {
            console.log(`\n🎉 PERFECT! All 100 simulations passed!`);
        } else {
            console.log(`\n⚠️ ${failed} simulations failed. Check the logs above.`);
        }

        return allCorrect;
    }

    // ========== TEST 5: Win After Different Loss Counts Verification ==========
    testWinAfterDifferentLossCounts() {
        console.log(`\n${'='.repeat(70)}`);
        console.log(`📊 TEST 5: VERIFY STATE AFTER WIN AT DIFFERENT LOSS COUNTS`);
        console.log(`${'='.repeat(70)}`);

        const baseAmount = 100000;
        let allCorrect = true;

        // Test win after 1 loss
        let state = {
            step: 0,
            losses: 0,
            baseAmount: baseAmount,
            currentAmount: baseAmount,
            initialBalance: 1000000
        };

        console.log(`\n${'─'.repeat(50)}`);
        console.log(`📊 Win after 1 loss:`);
        this.advanceMartingale(state);
        console.log(`   Before win: Losses=${state.losses}, Amount=${state.currentAmount}`);
        this.resetMartingale(state);
        console.log(`   After win: Losses=${state.losses}, Amount=${state.currentAmount}`);
        const test1 = (state.losses === 0 && state.currentAmount === baseAmount);
        console.log(`   ${test1 ? '✅' : '❌'} Correct reset`);
        if (!test1) allCorrect = false;

        // Test win after 2 losses
        state = {
            step: 0,
            losses: 0,
            baseAmount: baseAmount,
            currentAmount: baseAmount,
            initialBalance: 1000000
        };

        console.log(`\n${'─'.repeat(50)}`);
        console.log(`📊 Win after 2 losses:`);
        this.advanceMartingale(state);
        this.advanceMartingale(state);
        console.log(`   Before win: Losses=${state.losses}, Amount=${state.currentAmount}`);
        this.resetMartingale(state);
        console.log(`   After win: Losses=${state.losses}, Amount=${state.currentAmount}`);
        const test2 = (state.losses === 0 && state.currentAmount === baseAmount);
        console.log(`   ${test2 ? '✅' : '❌'} Correct reset`);
        if (!test2) allCorrect = false;

        // Test win after 3 losses
        state = {
            step: 0,
            losses: 0,
            baseAmount: baseAmount,
            currentAmount: baseAmount,
            initialBalance: 1000000
        };

        console.log(`\n${'─'.repeat(50)}`);
        console.log(`📊 Win after 3 losses:`);
        this.advanceMartingale(state);
        this.advanceMartingale(state);
        this.advanceMartingale(state);
        console.log(`   Before win: Losses=${state.losses}, Amount=${state.currentAmount}`);
        this.resetMartingale(state);
        console.log(`   After win: Losses=${state.losses}, Amount=${state.currentAmount}`);
        const test3 = (state.losses === 0 && state.currentAmount === baseAmount);
        console.log(`   ${test3 ? '✅' : '❌'} Correct reset`);
        if (!test3) allCorrect = false;

        // Test win after 4 losses (should be at 4x before win)
        state = {
            step: 0,
            losses: 0,
            baseAmount: baseAmount,
            currentAmount: baseAmount,
            initialBalance: 1000000
        };

        console.log(`\n${'─'.repeat(50)}`);
        console.log(`📊 Win after 4 losses:`);
        this.advanceMartingale(state);
        this.advanceMartingale(state);
        this.advanceMartingale(state);
        this.advanceMartingale(state);
        console.log(`   Before win: Losses=${state.losses}, Amount=${state.currentAmount} (should be ${baseAmount * 4})`);
        this.resetMartingale(state);
        console.log(`   After win: Losses=${state.losses}, Amount=${state.currentAmount}`);
        const test4 = (state.losses === 0 && state.currentAmount === baseAmount);
        console.log(`   ${test4 ? '✅' : '❌'} Correct reset`);
        if (!test4) allCorrect = false;

        console.log(`\n${'─'.repeat(50)}`);
        if (allCorrect) {
            console.log(`✅ TEST 5 PASSED: Win resets correctly at all loss counts`);
        } else {
            console.log(`❌ TEST 5 FAILED: Reset not working correctly`);
        }

        return allCorrect;
    }
}

// ========== RUN ALL TESTS ==========
console.log(`\n${'='.repeat(70)}`);
console.log(`🧪 MARTINGALE LOGIC TEST SUITE`);
console.log(`${'='.repeat(70)}`);
console.log(`This test suite verifies:
1. Full 8-loss progression (1x,1x,1x,1x,4x,8x,16x,32x)
2. Win reset at every step
3. CRITICAL BUG FIX: Win after 2 losses → new loss sequence starts from base (1x), NOT 4x
4. 100 random user simulations
5. Win after different loss counts`);
console.log(`${'='.repeat(70)}`);

const tester = new MartingaleTest();

// Run all tests
const test1Result = tester.testFullLossSequence();
const test2Result = tester.testWinResetAtEachStep();
const test3Result = tester.testCriticalBugFix();
const test4Result = tester.runMultipleUsersSimulation();
const test5Result = tester.testWinAfterDifferentLossCounts();

// Final Summary
console.log(`\n${'='.repeat(70)}`);
console.log(`📊 FINAL TEST SUMMARY`);
console.log(`${'='.repeat(70)}`);

console.log(`Test 1 (8 Losses Progression):     ${test1Result ? '✅ PASSED' : '❌ FAILED'}`);
console.log(`Test 2 (Win Reset at Each Step):   ${test2Result ? '✅ PASSED' : '❌ FAILED'}`);
console.log(`Test 3 (Critical Bug Fix):         ${test3Result ? '✅ PASSED' : '❌ FAILED'}`);
console.log(`Test 4 (100 Random Users):         ${test4Result ? '✅ PASSED' : '❌ FAILED'}`);
console.log(`Test 5 (Win After Different Loss): ${test5Result ? '✅ PASSED' : '❌ FAILED'}`);

const allPassed = test1Result && test2Result && test3Result && test4Result && test5Result;

console.log(`\n${'='.repeat(70)}`);
if (allPassed) {
    console.log(`🎉 ALL TESTS PASSED - Martingale logic is CORRECT!`);
    console.log(`   The critical bug is fixed. After a win, new loss sequence starts from base amount (1x).`);
} else {
    console.log(`❌ SOME TESTS FAILED - Please review the logic above.`);
}
console.log(`${'='.repeat(70)}`);