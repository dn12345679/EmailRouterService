import dotenv from 'dotenv';
dotenv.config();
const settings = {
  clientId: process.env.EML_CLIENT_ID,
  tenantId: process.env.EML_TENANT_ID,
  clientSecret: process.env.EML_CLIENT_SECRET,
  graphUserScopes: ['user.read', 'mail.read', 'mail.send'],
  userEmail: process.env.userEmail
};

export default settings;