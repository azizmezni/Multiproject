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

// Detect link type from URL pattern
export function detectLinkType(url) {
  const u = url.toLowerCase();

  // GitHub
  if (/github\.com\/[\w-]+\/[\w.-]+\/?$/i.test(url)) return 'github_repo';
  if (/github\.com\/[\w-]+\/[\w.-]+\/(issues|pull|discussions)/i.test(url)) return 'github_issue';
  if (/github\.com\/[\w-]+\/[\w.-]+\/(blob|tree)/i.test(url)) return 'github_code';
  if (u.includes('github.com')) return 'github';

  // YouTube
  if (u.includes('youtube.com/watch') || u.includes('youtu.be/')) return 'youtube';
  if (u.includes('youtube.com/playlist')) return 'youtube_playlist';
  if (u.includes('youtube.com')) return 'youtube';

  // Package managers
  if (u.includes('npmjs.com/package/')) return 'npm';
  if (u.includes('pypi.org/project/')) return 'pypi';

  // Documentation / tutorials
  if (u.includes('docs.') || u.includes('/docs/') || u.includes('/documentation')) return 'docs';
  if (u.includes('medium.com') || u.includes('dev.to') || u.includes('hashnode.')) return 'article';
  if (u.includes('stackoverflow.com') || u.includes('stackexchange.com')) return 'stackoverflow';

  // API endpoints
  if (u.includes('/api/') || u.includes('swagger') || u.includes('openapi')) return 'api';

  // Docker
  if (u.includes('hub.docker.com')) return 'docker';

  // Generic website
  return 'website';
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

    const linkType = detectLinkType(url);

    // Extract extra metadata based on type
    let extra = {};
    if (linkType === 'github_repo') {
      // Try to find repo description, stars, language from page
      const langMatch = html.match(/itemprop="programmingLanguage">([^<]+)</i);
      extra.language = langMatch?.[1]?.trim() || '';
      // Extract README preview from body text
      extra.readme = bodyText.substring(0, 2000);
    }
    if (linkType === 'npm') {
      const installMatch = bodyText.match(/npm\s+i(?:nstall)?\s+[\w@/-]+/);
      extra.installCmd = installMatch?.[0] || '';
    }

    return {
      url,
      title: titleMatch?.[1]?.trim() || url,
      description: descMatch?.[1]?.trim() || '',
      bodyText,
      linkType,
      extra,
    };
  } catch {
    return { url, title: url, description: '', bodyText: '', linkType: detectLinkType(url), extra: {} };
  }
}
