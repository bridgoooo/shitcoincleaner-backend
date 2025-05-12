require('dotenv').config();
const { Connection, PublicKey, ConfirmedSignatureInfo } = require('@solana/web3.js');
const db = require('./db');

const SOLANA_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT;
const SOLANA_PROGRAM_ID_STRING = process.env.SOLANA_PROGRAM_ID;

if (!SOLANA_RPC_ENDPOINT || !SOLANA_PROGRAM_ID_STRING) {
    console.error('Missing SOLANA_RPC_ENDPOINT or SOLANA_PROGRAM_ID in .env file');
    process.exit(1);
}

const SOLANA_PROGRAM_ID = new PublicKey(SOLANA_PROGRAM_ID_STRING);
const connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BATCH_FETCH_SIZE = 20; // How many transactions to fetch details for in one go
const SIGNATURE_FETCH_LIMIT = 100; // How many recent signatures to check for the program

// In-memory store for the last processed signature.
// For production, this should be persisted (e.g., in the database or a file)
// to resume correctly after restarts.
let lastProcessedSignature = null;

async function getLastProcessedSignatureFromDB() {
    // Placeholder: In a robust setup, you might fetch this from a dedicated table or a config store.
    // For now, we'll try to get the signature of the latest transaction we know about from our scores.
    // This is a simplification and might not be the absolute latest if a new wallet interacts.
    try {
        const res = await db.query(
            `SELECT s.signature FROM transaction_meta s
             JOIN wallet_scores ws ON ws.wallet_address = s.wallet_address -- Assuming you add a way to link them or just get ANY recent
             ORDER BY s.processed_at DESC LIMIT 1` // You'll need a table to store signatures if you do it this way
        );
        // THIS IS A COMPLEXITY. For simplicity now, we start fresh or rely on in-memory 'lastProcessedSignature' from previous run within same process.
        // A better approach: store last processed signature in a dedicated key-value table or a simple file.
        console.log('Attempt to get last signature from DB - this part needs proper implementation for persistence.');
        return null; // Forcing null to use the logic that fetches from the program's history initially.
    } catch (err) {
        console.error('Error fetching last processed signature from DB:', err);
        return null;
    }
}

async function storeSignatureProcessed(signature, client) {
    // Placeholder: If you have a table to track processed signatures.
    // await client.query('INSERT INTO processed_signatures (signature, processed_at) VALUES ($1, NOW()) ON CONFLICT (signature) DO NOTHING', [signature]);
}

async function processNewTransactions() {
    console.log(`[${new Date().toISOString()}] Checking for new transactions for program ${SOLANA_PROGRAM_ID.toBase58()}...`);

    let signaturesInfo = [];
    try {
        // Fetch recent signatures for the program.
        // If lastProcessedSignature exists, we try to fetch signatures *until* that one.
        // Note: getSignaturesForAddress `until` fetches transactions *older* than the signature.
        // We want transactions *newer*. So, we fetch a batch and see if we've processed them.
        // A more robust way for large volume is to use `before` and paginate backwards from newest,
        // stopping when lastProcessedSignature is found.
        signaturesInfo = await connection.getSignaturesForAddress(
            SOLANA_PROGRAM_ID,
            { limit: SIGNATURE_FETCH_LIMIT, until: lastProcessedSignature }, // 'until' means older than. This helps avoid reprocessing if indexer restarts.
            'confirmed'
        );

        if (!signaturesInfo || signaturesInfo.length === 0) {
            console.log('No new signatures found since last check or within limit.');
            // If this was the first check in this run and we got results, store the latest signature
            if (!lastProcessedSignature && signaturesInfo && signaturesInfo.length > 0) {
                lastProcessedSignature = signaturesInfo[0].signature;
            }
            return;
        }

        // Filter out any signatures we might have already processed if `until` was not effective or not used
        // This is a simple in-memory check. If lastProcessedSignature was from a previous run, this helps.
        // The signatures are typically returned newest first.
        let newSignaturesToProcess = [];
        if (lastProcessedSignature) {
            const lastKnownIndex = signaturesInfo.findIndex(s => s.signature === lastProcessedSignature);
            if (lastKnownIndex > -1) {
                newSignaturesToProcess = signaturesInfo.slice(0, lastKnownIndex);
            } else {
                newSignaturesToProcess = signaturesInfo; // All are new or last one aged out of limit
            }
        } else {
            newSignaturesToProcess = signaturesInfo;
        }

        if (newSignaturesToProcess.length === 0) {
            console.log('No effectively new signatures to process after filtering.');
            // Still update the last seen signature to the newest from this fetch
            if (signaturesInfo.length > 0) lastProcessedSignature = signaturesInfo[0].signature;
            return;
        }

        console.log(`Found ${newSignaturesToProcess.length} potentially new transaction signature(s). Fetching details...`);

        const walletInteractionCounts = new Map();

        for (let i = 0; i < newSignaturesToProcess.length; i += BATCH_FETCH_SIZE) {
            const batchSignatures = newSignaturesToProcess.slice(i, i + BATCH_FETCH_SIZE).map(s => s.signature);
            if (batchSignatures.length === 0) continue;

            console.log(`Processing batch of ${batchSignatures.length} transactions (total ${i + batchSignatures.length}/${newSignaturesToProcess.length})`);

            // Use getParsedTransactions for easier access to instruction data
            const transactions = await connection.getParsedTransactions(batchSignatures, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });

            for (const tx of transactions) {
                if (tx && tx.transaction && tx.meta && tx.meta.err === null) {
                    // Identify the primary interacting wallet (usually the fee payer or first signer)
                    const firstSignerAccount = tx.transaction.message.accountKeys.find(acc => acc.signer);
                    if (firstSignerAccount) {
                        const walletAddress = firstSignerAccount.pubkey.toBase58();
                        // Check if this transaction actually invoked our target program
                        const programInteracted = tx.transaction.message.instructions.some(ix =>
                            ix.programId.equals(SOLANA_PROGRAM_ID)
                        );
                        if (programInteracted) {
                            walletInteractionCounts.set(walletAddress, (walletInteractionCounts.get(walletAddress) || 0) + 1);
                        }
                    } // else: No signer found? Should be unlikely for successful tx.
                } else if (tx && tx.meta && tx.meta.err) {
                    // Optional: Log skipped transactions due to on-chain errors
                    // console.log(`Skipping transaction ${tx.transaction?.signatures[0]} due to error: ${JSON.stringify(tx.meta.err)}`);
                } else if (!tx) {
                    // Optional: Log if a transaction in the batch wasn't found (RPC issue?)
                    // console.log('Skipping null transaction object returned in batch.');
                }
            }
            // Add a small delay between batches to be kind to the RPC node
            if (newSignaturesToProcess.length > BATCH_FETCH_SIZE) await new Promise(resolve => setTimeout(resolve, 500));
        }

        if (walletInteractionCounts.size > 0) {
            const client = await db.getClient();
            try {
                await client.query('BEGIN');
                for (const [walletAddress, count] of walletInteractionCounts) {
                    console.log(`Updating score for ${walletAddress} by ${count}`);
                    const queryText = `
                        INSERT INTO wallet_scores (wallet_address, interaction_count)
                        VALUES ($1, $2)
                        ON CONFLICT (wallet_address) DO UPDATE
                        SET interaction_count = wallet_scores.interaction_count + $2, updated_at = NOW();
                    `;
                    await client.query(queryText, [walletAddress, count]);
                }
                await client.query('COMMIT');
                console.log('Successfully updated wallet scores in the database.');
            } catch (dbError) {
                await client.query('ROLLBACK');
                console.error('Database update failed, rolled back transaction:', dbError);
            } finally {
                client.release();
            }
        }

        // Update lastProcessedSignature to the newest signature from this processed batch
        lastProcessedSignature = newSignaturesToProcess[0].signature;
        console.log(`Finished processing batch. Last processed signature for next cycle: ${lastProcessedSignature}`);

    } catch (error) {
        console.error('Error in processNewTransactions:', error);
        if (error.message && error.message.includes('429')) {
            console.warn('Rate limited by RPC. Will retry next cycle.');
        }
        // Potentially add more specific error handling here
    }
}

async function runIndexer() {
    console.log('Starting Solana Indexer...');
    // Persisted state loading would go here:
    // lastProcessedSignature = await getLastProcessedSignatureFromDB();
    // console.log(`Initial lastProcessedSignature: ${lastProcessedSignature || 'None (will fetch latest as baseline)'}`);

    await processNewTransactions(); // Run once on start to catch up
    setInterval(processNewTransactions, CHECK_INTERVAL_MS); // Then run periodically
}

runIndexer().catch(err => {
    console.error('Indexer failed to start or encountered an unhandled error:', err);
    process.exit(1);
}); 