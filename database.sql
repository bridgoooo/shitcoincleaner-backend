-- Table to store wallet interaction scores
CREATE TABLE IF NOT EXISTS wallet_scores (
    id SERIAL PRIMARY KEY,
    wallet_address VARCHAR(44) NOT NULL UNIQUE, -- Solana addresses are base58 encoded, typically 32-44 chars
    interaction_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index for faster lookups by wallet address
CREATE INDEX IF NOT EXISTS idx_wallet_address ON wallet_scores(wallet_address);

-- Index for faster sorting for the scoreboard
CREATE INDEX IF NOT EXISTS idx_interaction_count ON wallet_scores(interaction_count DESC);

-- Optional: Trigger to automatically update updated_at timestamp (syntax may vary slightly by PG version)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = NOW();
   RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_wallet_scores_updated_at
BEFORE UPDATE ON wallet_scores
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column(); 