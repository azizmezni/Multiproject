import db from './db.js';
import crypto from 'crypto';

// Simple encryption using AES-256-GCM with a derived key
// In production, use a proper KMS. Here we derive from a machine-specific salt.
const VAULT_KEY = crypto.createHash('sha256').update(`hub-vault-${process.env.VAULT_SECRET || 'default-dev-key'}`).digest();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', VAULT_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

function decrypt(encryptedText) {
  const [ivHex, tagHex, data] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', VAULT_KEY, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export const vault = {
  // Store a secret
  set(userId, keyName, value, scope = 'global', description = '') {
    const encrypted = encrypt(value);
    const existing = db.prepare('SELECT id FROM vault WHERE user_id = ? AND key_name = ?').get(userId, keyName);
    if (existing) {
      db.prepare('UPDATE vault SET encrypted_value = ?, scope = ?, description = ? WHERE id = ?').run(encrypted, scope, description, existing.id);
      return this.getMeta(existing.id);
    }
    const result = db.prepare('INSERT INTO vault (user_id, key_name, encrypted_value, scope, description) VALUES (?, ?, ?, ?, ?)').run(userId, keyName, encrypted, scope, description);
    return this.getMeta(result.lastInsertRowid);
  },

  // Get decrypted value (internal use only)
  getValue(userId, keyName) {
    const row = db.prepare('SELECT encrypted_value FROM vault WHERE user_id = ? AND key_name = ?').get(userId, keyName);
    if (!row) return null;
    try {
      return decrypt(row.encrypted_value);
    } catch {
      return null;
    }
  },

  // Get metadata (no decryption)
  getMeta(vaultId) {
    const row = db.prepare('SELECT id, user_id, key_name, scope, description, created_at FROM vault WHERE id = ?').get(vaultId);
    return row;
  },

  // List all keys (metadata only, never expose values)
  list(userId, scope = null) {
    if (scope && scope !== 'all') {
      return db.prepare('SELECT id, key_name, scope, description, created_at FROM vault WHERE user_id = ? AND scope = ? ORDER BY key_name').all(userId, scope);
    }
    return db.prepare('SELECT id, key_name, scope, description, created_at FROM vault WHERE user_id = ? ORDER BY key_name').all(userId);
  },

  // Delete a key
  delete(userId, vaultId) {
    return db.prepare('DELETE FROM vault WHERE id = ? AND user_id = ?').run(vaultId, userId);
  },

  // Get all secrets for a workflow execution (by scope)
  getForWorkflow(userId, workflowId) {
    const globals = db.prepare('SELECT key_name, encrypted_value FROM vault WHERE user_id = ? AND scope = ?').all(userId, 'global');
    const scoped = db.prepare('SELECT key_name, encrypted_value FROM vault WHERE user_id = ? AND scope = ?').all(userId, `workflow:${workflowId}`);
    const env = {};
    for (const row of [...globals, ...scoped]) {
      try { env[row.key_name] = decrypt(row.encrypted_value); } catch {}
    }
    return env;
  },

  // Check if a key exists
  exists(userId, keyName) {
    return !!db.prepare('SELECT 1 FROM vault WHERE user_id = ? AND key_name = ?').get(userId, keyName);
  },

  // Rename a key
  rename(userId, vaultId, newName) {
    db.prepare('UPDATE vault SET key_name = ? WHERE id = ? AND user_id = ?').run(newName, vaultId, userId);
    return this.getMeta(vaultId);
  },
};
