import dotenv from 'dotenv';
dotenv.config();
const settings = {
  clientId: process.env.CLIENT_ID,
  tenantId: process.env.TENANT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  graphUserScopes: ['user.read', 'mail.read', 'mail.send'],
};

export default settings;