require('dotenv').config();
const express = require('express');
const db = require('./db'); // Import the database connection setup
const { Connection, PublicKey } = require('@solana/web3.js'); // Required for indexer logic now
const cors = require('cors'); // Import CORS middleware

const app = express();
const port = process.env.PORT || 3000;
const SOLANA_PROGRAM_ID_STRING = process.env.SOLANA_PROGRAM_ID;
const SOLANA_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT; // Needed for indexer

// --- Basic Server Setup ---
if (!SOLANA_PROGRAM_ID_STRING || !SOLANA_RPC_ENDPOINT) { // Check RPC endpoint too
    console.error('Missing SOLANA_PROGRAM_ID or SOLANA_RPC_ENDPOINT in .env file');
    process.exit(1);
}

app.use(express.json()); // Middleware to parse JSON bodies

// Configure CORS for shitcoincleaner.com domains
app.use(cors({
    origin: ['https://shitcoincleaner.com', 'https://www.shitcoincleaner.com'],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// --- Solana/Indexer Setup ---
const SOLANA_PROGRAM_ID = new PublicKey(SOLANA_PROGRAM_ID_STRING);
const connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BATCH_FETCH_SIZE = 20; // How many transactions to fetch details for in one go
const SIGNATURE_FETCH_LIMIT = 100; // How many recent signatures to check for the program

// In-memory store for the last processed signature.
// IMPORTANT: For production, persist this value (DB or file) to resume correctly after restarts.
let lastProcessedSignature = null;

// --- API Endpoints --- (Keep existing endpoints as they are)

// Validate Solana address format (basic check)
function isValidSolanaAddress(address) {
    try {
        new PublicKey(address);
        return true;
    } catch (error) {
        return false;
    }
}

// GET /api/score/:walletAddress (from database)
app.get('/api/score/:walletAddress', async (req, res) => {
    const { walletAddress } = req.params;

    if (!walletAddress) {
        return res.status(400).json({ error: 'walletAddress parameter is required' });
    }

    if (!isValidSolanaAddress(walletAddress)) {
        return res.status(400).json({ error: 'Invalid wallet address format.' });
    }

    try {
        const queryText = 'SELECT interaction_count FROM wallet_scores WHERE wallet_address = $1';
        const { rows } = await db.query(queryText, [walletAddress]);

        let interactionCount = 0;
        if (rows.length > 0) {
            interactionCount = rows[0].interaction_count;
        }

        // console.log(`Score requested for ${walletAddress}: ${interactionCount}`); // Less verbose logging
        res.status(200).json({
            walletAddress: walletAddress,
            programId: SOLANA_PROGRAM_ID_STRING,
            interactionCount: interactionCount
        });

    } catch (error) {
        console.error(`Error fetching score from DB for wallet ${walletAddress}:`, error);
        res.status(500).json({ error: 'Failed to fetch wallet score from database.' });
    }
});

// GET /api/scoreboard (top N wallets from database)
app.get('/api/scoreboard', async (req, res) => {
    const topN = parseInt(req.query.n) || 10;

    if (isNaN(topN) || topN <= 0) {
        return res.status(400).json({ error: 'Invalid value for query parameter \'n\', must be a positive integer.' });
    }

    // console.log(`Scoreboard requested (Top ${topN})`); // Less verbose logging

    try {
        const queryText = `
            SELECT wallet_address, interaction_count
            FROM wallet_scores
            ORDER BY interaction_count DESC, updated_at ASC
            LIMIT $1
        `;
        const { rows } = await db.query(queryText, [topN]);

        const scoreboard = rows.map((row, index) => ({
            rank: index + 1,
            walletAddress: row.wallet_address,
            score: row.interaction_count
        }));

        if (scoreboard.length === 0) {
             return res.status(200).json({ message: 'Scoreboard is currently empty.' , scoreboard: [] });
        }

        res.status(200).json({ scoreboard: scoreboard });

    } catch (error) {
        console.error('Error generating scoreboard from DB:', error);
        res.status(500).json({ error: 'Failed to generate scoreboard from database.' });
    }
});

// GET /
app.get('/', (req, res) => {
    res.send('Solana Wallet Interaction Counter API (DB Powered) is running! Indexing occurs in the background.');
});

// --- Indexer Logic --- (Copied and adapted from indexer.js)

async function processNewTransactions() {
    console.log(`[${new Date().toISOString()}] Indexer: Checking for new transactions for program ${SOLANA_PROGRAM_ID.toBase58()}...`);

    let signaturesInfo = [];
    try {
        signaturesInfo = await connection.getSignaturesForAddress(
            SOLANA_PROGRAM_ID,
            { limit: SIGNATURE_FETCH_LIMIT, until: lastProcessedSignature },
            'confirmed'
        );

        if (!signaturesInfo || signaturesInfo.length === 0) {
            console.log('[Indexer] No new signatures found since last check or within limit.');
            if (!lastProcessedSignature && signaturesInfo && signaturesInfo.length > 0) {
                lastProcessedSignature = signaturesInfo[0].signature;
            }
            return;
        }

        let newSignaturesToProcess = [];
        if (lastProcessedSignature) {
            const lastKnownIndex = signaturesInfo.findIndex(s => s.signature === lastProcessedSignature);
            newSignaturesToProcess = (lastKnownIndex > -1) ? signaturesInfo.slice(0, lastKnownIndex) : signaturesInfo;
        } else {
            newSignaturesToProcess = signaturesInfo;
        }

        if (newSignaturesToProcess.length === 0) {
            console.log('[Indexer] No effectively new signatures to process after filtering.');
            if (signaturesInfo.length > 0) lastProcessedSignature = signaturesInfo[0].signature;
            return;
        }

        console.log(`[Indexer] Found ${newSignaturesToProcess.length} potentially new transaction signature(s). Fetching details...`);
        const walletInteractionCounts = new Map();

        for (let i = 0; i < newSignaturesToProcess.length; i += BATCH_FETCH_SIZE) {
            const batchSignatures = newSignaturesToProcess.slice(i, i + BATCH_FETCH_SIZE).map(s => s.signature);
            if (batchSignatures.length === 0) continue;

            console.log(`[Indexer] Processing batch of ${batchSignatures.length} transactions (total ${i + batchSignatures.length}/${newSignaturesToProcess.length})`);
            const transactions = await connection.getParsedTransactions(batchSignatures, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });

            for (const tx of transactions) {
                if (tx && tx.transaction && tx.meta && tx.meta.err === null) {
                    const firstSignerAccount = tx.transaction.message.accountKeys.find(acc => acc.signer);
                    if (firstSignerAccount) {
                        const walletAddress = firstSignerAccount.pubkey.toBase58();
                        const programInteracted = tx.transaction.message.instructions.some(ix => ix.programId.equals(SOLANA_PROGRAM_ID));
                        if (programInteracted) {
                            walletInteractionCounts.set(walletAddress, (walletInteractionCounts.get(walletAddress) || 0) + 1);
                        }
                    }
                }
            }
            if (newSignaturesToProcess.length > BATCH_FETCH_SIZE) await new Promise(resolve => setTimeout(resolve, 500)); // Delay
        }

        if (walletInteractionCounts.size > 0) {
            const client = await db.getClient();
            try {
                await client.query('BEGIN');
                for (const [walletAddress, count] of walletInteractionCounts) {
                    console.log(`[Indexer] Updating DB score for ${walletAddress} by ${count}`);
                    const queryText = `
                        INSERT INTO wallet_scores (wallet_address, interaction_count)
                        VALUES ($1, $2)
                        ON CONFLICT (wallet_address) DO UPDATE
                        SET interaction_count = wallet_scores.interaction_count + $2, updated_at = NOW();
                    `;
                    await client.query(queryText, [walletAddress, count]);
                }
                await client.query('COMMIT');
                console.log('[Indexer] Successfully updated wallet scores in the database.');
            } catch (dbError) {
                await client.query('ROLLBACK');
                console.error('[Indexer] Database update failed, rolled back transaction:', dbError);
            } finally {
                client.release();
            }
        }

        lastProcessedSignature = newSignaturesToProcess[0].signature;
        console.log(`[Indexer] Finished processing batch. Last processed signature for next cycle: ${lastProcessedSignature}`);

    } catch (error) {
        console.error('[Indexer] Error in processNewTransactions:', error);
        if (error.message && error.message.includes('429')) {
            console.warn('[Indexer] Rate limited by RPC. Will retry next cycle.');
        }
    }
}

// --- Server Start & Indexer Initialization ---

app.listen(port, async () => { // Make the callback async
    console.log(`Server listening at http://localhost:${port}`);
    console.log(`Monitoring program ID: ${SOLANA_PROGRAM_ID_STRING}`);
    console.log('API endpoints served from PostgreSQL database.');
    console.log('Starting initial background indexer run...');
    try {
        await processNewTransactions(); // Run once on startup
        console.log('Initial indexer run complete. Scheduling periodic checks.');
        setInterval(processNewTransactions, CHECK_INTERVAL_MS); // Then run periodically
        console.log(`Indexer scheduled to run every ${CHECK_INTERVAL_MS / 60000} minutes.`);
    } catch (err) {
        console.error('Initial indexer run failed:', err);
        // Decide if the server should exit or continue without indexing
        // process.exit(1); 
    }
});

module.exports = app; // Export for potential testing or other uses 