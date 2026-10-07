require('dotenv').config();
const { Client } = require('pg');

const client = new Client({ connectionString: process.env.DATABASE_URL });
client.connect()
  .then(() => client.query('select now()'))
  .then((r) => console.log('Connected:', r.rows[0]))
  .catch((e) => console.error('Failed:', e.message))
  .finally(() => client.end());