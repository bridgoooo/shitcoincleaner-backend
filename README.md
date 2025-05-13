# Solana Interaction Counter API (Database Backed)

This project provides an API to track Solana wallet interactions with a specific program, storing the counts in a PostgreSQL database for efficient querying.

## Architecture

1.  **PostgreSQL Database:** Stores wallet addresses and their interaction counts with the target program.
2.  **API Server + Indexer (`server.js`):** An Express.js application that runs as a single process.
    *   **API Server:** Serves the API endpoints.
        *   Connects to the PostgreSQL database.
        *   `/api/score/:walletAddress`: Retrieves the interaction count for a specific wallet directly from the database.
        *   `/api/scoreboard?n=<number>`: Retrieves the top N wallets with the highest interaction counts from the database.
    *   **Internal Indexer:** Runs in the background within the same process.
        *   Connects to a Solana RPC node.
        *   Periodically (every 5 minutes by default) fetches the latest transactions involving the target program ID.
        *   Processes these transactions to identify interacting wallets (signers).
        *   Updates the `interaction_count` for each wallet in the PostgreSQL database.
        *   Keeps track of the last processed transaction signature (currently in-memory, needs persistence for production).

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
        *   `DATABASE_URL`: Your PostgreSQL connection string (e.g., `postgresql://user:password@host:port/database`). **Make sure to include `?ssl=true` if your DB requires SSL.**
        *   `SOLANA_RPC_ENDPOINT`: Your Solana RPC node URL (e.g., your Alchemy, QuickNode, or public endpoint). **Using a third-party provider (Alchemy, QuickNode) is highly recommended over public nodes due to rate limits.**
        *   `SOLANA_PROGRAM_ID`: The base58 encoded address of the Solana program you want to monitor.
        *   `PORT` (Optional): The port for the API server (defaults to 3000).

6.  **Run the Server (includes Indexer):**
    *   This single command starts the API server and the background indexing process.
    ```bash
    npm start
    ```
    *   You should see logs indicating the server is listening, the database is connected, and the indexer is starting its checks.
    *   For production, use a process manager like `pm2` to ensure the server stays running and restarts if it crashes:
        ```bash
        # Example using pm2
        npm install pm2 -g
        pm2 start npm --name solana-counter-api -- run start
        # Or: pm2 start server.js --name solana-counter-api
        ```

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
            // ... up to n entries
          ]
        }
        ```

## Important Considerations

*   **Indexer Persistence:** The current implementation uses an in-memory variable (`lastProcessedSignature`) to track indexing progress. If the server restarts, it loses this state. For production, this state **must** be persisted (e.g., written to a file or a dedicated database table) so the indexer can resume where it left off.
*   **Resource Usage:** The API server and the indexer now share the same Node.js process resources (CPU, memory). Monitor performance under load. If indexing becomes resource-intensive, it could potentially slow down API responses, and vice-versa. Separating them back into two processes might be necessary for very high-traffic scenarios.
*   **Error Handling:** Robust error handling should be added, especially around RPC calls (retries, backoff) and database operations within the indexer logic.
*   **Identifying Interacting Wallet:** The indexer currently assumes the first signer (`accountKeys.find(acc => acc.signer)`) is the primary interacting wallet. This is often true but might not be correct for all programs. You might need to adjust this logic based on the specific program you are tracking.
*   **Scalability:** While simpler to deploy, this single-process model is less scalable than separate processes if either the API or the indexer requires independent scaling. 