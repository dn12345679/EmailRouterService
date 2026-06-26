import pg from "pg";
import dotenv from 'dotenv';
const {Pool, Client} = pg

// https://node-postgres.com/features/connecting
const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PW,
  port: process.env.DB_PORT,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME
})

export async function insertIntoDB(emails) {
  try {
    console.log('connected to db');
    const seenIds = new Set();
    for (const email of emails) {
      // this isnt fully optimized but guarantees that there is no local duplicate searches.
      // a further optimization could be to have seenIds be instead the ids that exist within the database, but that could introduce some issues
      if (seenIds.has(email.conversationId)) continue;
      seenIds.add(email.conversationId);
      await pool.query(`
        INSERT INTO email (
          id, conversation_id, status, created, updated,
          sender, subject, body, in_reply_to
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO NOTHING
      `, [
        email.id,
        email.conversationId || null,
        email.status,
        email.created || null,
        email.updated,
        email.sender,
        email.subject,
        email.body,
        email.in_reply_to || null
      ]);
    }

    console.log(`Inserted ${emails.length} emails`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
  }
}