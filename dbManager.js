import pkg from "pg";
const {client}


export async function insertIntoDB(emails) {
  try {
    await client.connect();
    console.log('connected to db');

    for (const email of emails) {
      await client.query(`
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

    console.log(`✓ Inserted ${emails.length} emails`);
    await client.end();
  } catch (err) {
    console.error(`✗ Error: ${err.message}`);
    await client.end();
  }
}