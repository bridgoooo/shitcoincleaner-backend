require('dotenv').config();
const express = require('express');
const db = require('./db'); // Import the database connection setup
const { PublicKey } = require('@solana/web3.js'); // Still needed for validating address format

const app = express();
const port = process.env.PORT || 3000;
const SOLANA_PROGRAM_ID_STRING = process.env.SOLANA_PROGRAM_ID;

if (!SOLANA_PROGRAM_ID_STRING) {
    console.error('Missing SOLANA_PROGRAM_ID in .env file for the server');
    process.exit(1);
}

// Middleware to parse JSON bodies
app.use(express.json());

// Validate Solana address format (basic check)
function isValidSolanaAddress(address) {
    try {
        new PublicKey(address);
        return true;
    } catch (error) {
        return false;
    }
}

// Get score by wallet address (from database)
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

        console.log(`Score requested for ${walletAddress}: ${interactionCount}`);
        res.status(200).json({
            walletAddress: walletAddress,
            programId: SOLANA_PROGRAM_ID_STRING, // Get from env
            interactionCount: interactionCount
        });

    } catch (error) {
        console.error(`Error fetching score from DB for wallet ${walletAddress}:`, error);
        res.status(500).json({ error: 'Failed to fetch wallet score from database.' });
    }
});

// Get the scoreboard (top N wallets from database)
app.get('/api/scoreboard', async (req, res) => {
    const topN = parseInt(req.query.n) || 10;

    if (isNaN(topN) || topN <= 0) {
        return res.status(400).json({ error: 'Invalid value for query parameter \'n\', must be a positive integer.' });
    }

    console.log(`Scoreboard requested (Top ${topN})`);

    try {
        const queryText = `
            SELECT wallet_address, interaction_count 
            FROM wallet_scores 
            ORDER BY interaction_count DESC, updated_at ASC -- Sort by score, then oldest update for ties
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

app.get('/', (req, res) => {
    res.send('Solana Wallet Interaction Counter API (DB Powered) is running!');
});

app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
    console.log(`Monitoring program ID: ${SOLANA_PROGRAM_ID_STRING}`);
    console.log('Endpoints are now served from the PostgreSQL database.');
});

module.exports = app; // Export for potential testing or other uses 