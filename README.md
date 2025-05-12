# Solana Interaction Counter API (Database Backed)

This project provides an API to track Solana wallet interactions with a specific program, storing the counts in a PostgreSQL database for efficient querying.

## Architecture

1.  **PostgreSQL Database:** Stores wallet addresses and their interaction counts with the target program.
2.  **Indexer (`indexer.js`):** A background Node.js script that runs continuously.
    *   Connects to a Solana RPC node.
    *   Periodically (every 5 minutes by default) fetches the latest transactions involving the target program ID.
    *   Processes these transactions to identify interacting wallets (signers).
    *   Updates the `interaction_count` for each wallet in the PostgreSQL database.
    *   Keeps track of the last processed transaction signature (currently in-memory, needs persistence for production).
3.  **API Server (`server.js`):** An Express.js application that serves the API endpoints.
    *   Connects to the PostgreSQL database.
    *   `/api/score/:walletAddress`: Retrieves the interaction count for a specific wallet directly from the database.
    *   `/api/scoreboard?n=<number>`: Retrieves the top N wallets with the highest interaction counts from the database.

## Setup

1.  **Prerequisites:**
    *   Node.js (v16 or later recommended)
    *   npm (usually comes with Node.js)
    *   PostgreSQL server running and accessible.

2.  **Clone the Repository:**
    ```bash
    git clone <your-repo-url>
    cd shitcoincleaner-backend
    ```

3.  **Install Dependencies:**
    ```bash
    npm install
    ```

4.  **Setup PostgreSQL:**
    *   Create a PostgreSQL database (e.g., `solana_scores`).
    *   Create a user/role with permissions to create tables and read/write data in that database.
    *   Run the SQL script to create the necessary table and indexes:
        ```bash
        # Example using psql client
        psql -U your_db_user -d your_db_name -f database.sql 
        ```
        (Enter password when prompted)

5.  **Configure Environment Variables:**
    *   Copy the example environment file:
        ```bash
        cp .env.example .env
        ```
    *   Edit the `.env` file and fill in your actual values:
        *   `DATABASE_URL`: Your PostgreSQL connection string (e.g., `postgresql://user:password@host:port/database`).
        *   `SOLANA_RPC_ENDPOINT`: Your Solana RPC node URL (e.g., your Alchemy, QuickNode, or public endpoint).
        *   `SOLANA_PROGRAM_ID`: The base58 encoded address of the Solana program you want to monitor.
        *   `PORT` (Optional): The port for the API server (defaults to 3000).

6.  **Run the Indexer:**
    *   This script needs to run continuously in the background to keep the database updated.
    ```bash
    npm run start-indexer
    ```
    *   You should see logs indicating it's connecting and checking for transactions.
    *   For production, use a process manager like `pm2` or run it as a system service to ensure it stays running and restarts if it crashes.
        ```bash
        # Example using pm2
        npm install pm2 -g
        pm2 start npm --name solana-indexer -- run start-indexer
        ```

7.  **Run the API Server:**
    *   In a separate terminal:
    ```bash
    npm start
    ```
    *   The API server will start (default: `http://localhost:3000`).

## API Endpoints

*   `GET /api/score/:walletAddress`
    *   Returns the interaction count for the specified wallet address.
    *   Example: `http://localhost:3000/api/score/HPDiTWTRrLDjsmKNrj3BgfWYjNrfPXe74M79A3G3tAXj`
    *   Response (Success):
        ```json
        {
          "walletAddress": "HPDiTWTRrLDjsmKNrj3BgfWYjNrfPXe74M79A3G3tAXj",
          "programId": "8q6fEiMQYG1o3WgZyb9BTmo57zUDSmn2nTD9gcVoEo7",
          "interactionCount": 15
        }
        ```
    *   Response (Wallet not found in DB):
        ```json
        {
          "walletAddress": "NotFoundWalletAddress...",
          "programId": "8q6fEiMQYG1o3WgZyb9BTmo57zUDSmn2nTD9gcVoEo7",
          "interactionCount": 0
        }
        ```
*   `GET /api/scoreboard?n=<number>`
    *   Returns the top `n` wallets based on interaction count. Defaults to `n=10` if not specified.
    *   Example: `http://localhost:3000/api/scoreboard?n=5`
    *   Response:
        ```json
        {
          "scoreboard": [
            {
              "rank": 1,
              "walletAddress": "WalletAddress1...",
              "score": 150
            },
            {
              "rank": 2,
              "walletAddress": "WalletAddress2...",
              "score": 125
            },
            // ... up to n entries
          ]
        }
        ```

## Important Considerations

*   **Indexer Persistence:** The current `indexer.js` uses an in-memory variable (`lastProcessedSignature`) to track its progress. If the indexer restarts, it loses this state. For production, this state **must** be persisted (e.g., written to a file or a dedicated database table) so the indexer can resume where it left off.
*   **Error Handling:** Robust error handling should be added, especially around RPC calls (retries, backoff) and database operations.
*   **Identifying Interacting Wallet:** The indexer currently assumes the first signer (`accountKeys.find(acc => acc.signer)`) is the primary interacting wallet. This is often true but might not be correct for all programs. You might need to adjust this logic based on the specific program you are tracking.
*   **Scalability:** While much better than the previous version, if the program is extremely high-volume, you might need further optimizations (e.g., more sophisticated batching, potentially multiple indexer instances if RPC limits allow, or using dedicated indexer services like Helius/Shyft). 