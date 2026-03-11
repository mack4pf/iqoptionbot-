# IQ Option Trading Bot - Developer Documentation

This document outlines the architecture, module definitions, and integration workflows for the IQ Option Trading Bot. This project is designed as a multi-service Node.js application that handles real-time trading automation, signal reception, and user management through a Telegram interface.

## 1. Project Architecture

The system follows a modular design pattern to ensure scalability and separation of concerns. The primary logic is split between the trade execution engine and the user interface layers.

### Main Service Entry (`src/index.js`)
The `TradingBot` class acts as the central orchestrator. It is responsible for:
- Environment configuration and validation.
- Initializing the MongoDB connection.
- Bootstrapping the Telegram Bot and the Signal API server.
- Managing user-specific execution locks to ensure thread-safe trading.

---

## 2. Core Modules

### 2.1. Advanced Auto-Trader Engine (`src/core/auto-trader.js`)
The Auto-Trader is the heart of the system, designed to handle high-frequency signals with enterprise-grade stability.

**Core Technical Logic:**
- **Martingale Recovery Strategy**: Implements a sophisticated 8-step recovery system. If a trade is lost, the system automatically calculates the next entry based on a predefined multiplier array `[1, 1, 1, 1, 4, 8, 16, 32]` to recover previous losses efficiently.
- **Dynamic Balance Scaling**: The engine monitors user equity in real-time. Upon detecting a **10% growth** in total balance, it automatically scales the "Base Trade Amount" to compound profits safely.
- **Deduplication & Concurrency**: Uses an in-memory `signalUserTrades` map to ensure that a single signal ID is never executed twice for the same user, even if the API receives multiple hits.

**Safety & Risk Management:**
- **Per-User Locking**: Each user has an execution lock during the trade placement window to prevent race conditions.
- **Open Position Guard**: Before placing any trade, the system queries the active session to verify no other positions are currently open, preventing over-exposure.
- **Execution Cooldown**: A mandatory **10-second cooldown** is enforced after every trade closure to allow the platform's API state to synchronize and prevent "spam" trade entries.
- **Currency-Specific Limits**: Hard-coded floor and ceiling limits are enforced per currency (e.g., ₦1,500 - ₦500,000 for NGN) to protect users from manual setting errors.

### 2.2. Telegram Interface (`src/telegram/`)
The interface layer allows users to interact with the bot in real-time.
- **Command Routing**: Maps user commands for account management and settings.
- **Real-time Socket Integration**: Uses WebSockets to listen for `position-changed` events, ensuring users get instant notifications the second a trade closes.

### 2.3. Signal Receiver (`src/api/`)
A RESTful API endpoint built with Express.js that validates incoming trade signals via a `SIGNAL_SECRET` before broadcasting to the execution engine.

---

## 3. Data Persistence & Security (`src/database/`)

The application uses MongoDB for state management with a strong focus on data privacy.

- **Credential Encryption**: **CRITICAL SECURITY FEATURE.** User credentials (IQ Option passwords) are never stored in plain text. We implement **AES-256-CBC encryption**. Each record is encrypted with a unique, randomly generated **Initialization Vector (IV)** and a system-wide private key stored in environment variables.
- **User Records**: Stores account stats, Martingale progression, and encrypted credentials.
- **Trade Logs**: Persists historical trade data for performance analysis and reporting.

---

## 4. Integration & Development Workflow

### Environment Configuration
The application requires several environment variables for operation:
- `TELEGRAM_BOT_TOKEN`: The API token for the Telegram bot.
- `SIGNAL_SECRET`: Authentication token for the signal API.
- `ENCRYPTION_KEY`: A 64-character hex key used for AES-256 encryption.
- `MONGO_URI`: The connection string for the database.

---

## 5. Deployment Notes

The bot is designed to run in a Node.js environment. It uses `npm start` as the entry point. For production, it is recommended to use a process manager like **PM2** to ensure high availability and automatic restarts.

---
**Built by Mack Iyeritufu**
