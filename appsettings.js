import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });


import userConfig from './config/config.js';

export const SUBJECT_BUCKETS = userConfig.SUBJECT_BUCKETS;
export const CONDITION_BUCKETS = userConfig.CONDITION_BUCKETS;
export const REMINDER_CONFIG = userConfig.REMINDER_CONFIG;
export const ROUTING_CONFIG = userConfig.ROUTING_CONFIG;
export const REMOVE_SENDER_ON_ESCALATION = userConfig.REMOVE_SENDER_ON_ESCALATION;
export const NEEDS_INFO_CONFIG = userConfig.NEEDS_INFO_CONFIG;

const settings = {
  clientId: process.env.EML_CLIENT_ID,
  tenantId: process.env.EML_TENANT_ID,
  clientSecret: process.env.EML_CLIENT_SECRET,
  graphUserScopes: ['offline_access', 'user.read', 'mail.read', 'mail.send', 'mail.readwrite'],
  userEmail: process.env.userEmail,
};

export default settings;
