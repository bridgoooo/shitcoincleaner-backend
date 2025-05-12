const { Pool } = require('pg');
require('dotenv').config(); // Load environment variables from .env file

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Optional: SSL configuration if your database requires it (e.g., on platforms like Heroku)
    // ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('connect', () => {
    console.log('Connected to PostgreSQL database!');
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