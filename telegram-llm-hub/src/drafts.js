import db from './db.js';

export const drafts = {
  add(userId, url, title = '', description = '', content = '') {
    const result = db.prepare(
      'INSERT INTO drafts (user_id, url, title, description, content, source_type) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId, url, title, description, content, url ? 'link' : 'text');
    return this.get(result.lastInsertRowid);
  },

  get(draftId) {
    return db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
  },

  listByUser(userId, limit = 20) {
    return db.prepare(
      'SELECT * FROM drafts WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(userId, limit);
  },

  getNew(userId) {
    return db.prepare(
      "SELECT * FROM drafts WHERE user_id = ? AND status = 'new' ORDER BY created_at DESC"
    ).all(userId);
  },

  updateStatus(draftId, status) {
    db.prepare('UPDATE drafts SET status = ? WHERE id = ?').run(status, draftId);
  },

  updateContent(draftId, title, description, content) {
    db.prepare('UPDATE drafts SET title = ?, description = ?, content = ? WHERE id = ?')
      .run(title, description, content, draftId);
  },

  delete(draftId) {
    db.prepare('DELETE FROM drafts WHERE id = ?').run(draftId);
  },
};

// Extract URL from Telegram message text
export function extractUrl(text) {
  const urlRegex = /https?:\/\/[^\s<>'"]+/gi;
  const match = text?.match(urlRegex);
  return match ? match[0] : null;
}

// Simple metadata extraction from URL
export async function fetchLinkMeta(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'TelegramLLMHub/1.0' },
    });
    clearTimeout(timeout);

    if (!res.ok) return { url, title: url, description: '', bodyText: '' };

    const html = await res.text();
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);

    // Extract readable body text (strip tags, collapse whitespace, truncate)
    const bodyText = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 3000);

    return {
      url,
      title: titleMatch?.[1]?.trim() || url,
      description: descMatch?.[1]?.trim() || '',
      bodyText,
    };
  } catch {
    return { url, title: url, description: '', bodyText: '' };
  }
}
