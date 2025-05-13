const { Pool } = require('pg');
require('dotenv').config(); // Load environment variables from .env file

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Enable SSL and disable certificate authority verification
    // This is common for managed databases or when using self-signed certs
    // Set rejectUnauthorized to true if you have the CA cert and want full verification
    ssl: {
        rejectUnauthorized: false 
    }
});

pool.on('connect', () => {
    console.log('Connected to PostgreSQL database (SSL)!');
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
    process.exit(-1);
});

// Test the connection
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('Database connection error:', err);
    } else {
        console.log('Database connected successfully');
    }
});

module.exports = {
    query: (text, params) => pool.query(text, params),
    getClient: () => pool.connect(), // To use transactions
    pool: pool // Export pool if direct access is needed
};