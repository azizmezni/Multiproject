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

  // Social Media
  if (u.includes('twitter.com/') || u.includes('x.com/')) return 'twitter';
  if (u.includes('reddit.com/r/') || u.includes('redd.it/')) return 'reddit';
  if (u.includes('instagram.com/p/') || u.includes('instagram.com/reel/')) return 'instagram';
  if (u.includes('facebook.com/') || u.includes('fb.com/') || u.includes('fb.watch')) return 'facebook';
  if (u.includes('linkedin.com/posts/') || u.includes('linkedin.com/feed/')) return 'linkedin';
  if (u.includes('tiktok.com/') || u.includes('tiktok.com/@')) return 'tiktok';
  if (u.includes('threads.net/')) return 'threads';
  if (u.includes('mastodon.') || u.includes('/@') && u.includes('/statuses/')) return 'mastodon';

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

// Fetch social media post content using alternative frontends and APIs
export async function fetchSocialContent(url, linkType) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };

  try {
    // Twitter/X — use fxtwitter.com or vxtwitter.com (returns OG tags with full text)
    if (linkType === 'twitter') {
      const fxUrl = url.replace(/https?:\/\/(twitter\.com|x\.com)/i, 'https://api.fxtwitter.com');
      try {
        const res = await fetch(fxUrl, { signal: controller.signal, headers });
        if (res.ok) {
          const data = await res.json();
          const tweet = data.tweet || data;
          clearTimeout(timeout);
          return {
            author: tweet.author?.name || tweet.author?.screen_name || 'Unknown',
            handle: tweet.author?.screen_name ? `@${tweet.author.screen_name}` : '',
            text: tweet.text || '',
            likes: tweet.likes || 0,
            retweets: tweet.retweets || 0,
            replies: tweet.replies || 0,
            date: tweet.created_at || '',
            media: tweet.media?.photos?.map(p => p.url) || [],
            platform: 'Twitter/X',
          };
        }
      } catch {}
      // Fallback: use vxtwitter OG embed
      const vxUrl = url.replace(/https?:\/\/(twitter\.com|x\.com)/i, 'https://vxtwitter.com');
      try {
        const res = await fetch(vxUrl, { signal: controller.signal, headers, redirect: 'follow' });
        const html = await res.text();
        const desc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
        const title = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
        clearTimeout(timeout);
        return {
          author: title?.[1] || 'Unknown',
          handle: '',
          text: desc?.[1]?.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') || '',
          platform: 'Twitter/X',
        };
      } catch {}
    }

    // Reddit — use .json endpoint (public, no auth needed)
    if (linkType === 'reddit') {
      let jsonUrl = url.replace(/\?.*$/, '').replace(/\/$/, '') + '.json';
      try {
        const res = await fetch(jsonUrl, { signal: controller.signal, headers: { ...headers, 'Accept': 'application/json' } });
        if (res.ok) {
          const data = await res.json();
          const post = data?.[0]?.data?.children?.[0]?.data;
          if (post) {
            const topComments = (data?.[1]?.data?.children || [])
              .filter(c => c.kind === 't1')
              .slice(0, 5)
              .map(c => ({ author: c.data.author, text: c.data.body?.substring(0, 500), score: c.data.score }));
            clearTimeout(timeout);
            return {
              author: post.author || 'Unknown',
              handle: `u/${post.author}`,
              subreddit: post.subreddit_name_prefixed || '',
              title: post.title || '',
              text: post.selftext?.substring(0, 3000) || '',
              score: post.score || 0,
              comments: post.num_comments || 0,
              url: post.url,
              topComments,
              platform: 'Reddit',
            };
          }
        }
      } catch {}
    }

    // Instagram, Facebook, LinkedIn, TikTok, Threads — use OG tags (works for public posts)
    if (['instagram', 'facebook', 'linkedin', 'tiktok', 'threads', 'mastodon'].includes(linkType)) {
      try {
        const res = await fetch(url, { signal: controller.signal, headers, redirect: 'follow' });
        const html = await res.text();
        const ogTitle = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
        const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
        const ogImage = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
        // Try Twitter card tags too
        const twDesc = html.match(/<meta[^>]*name=["']twitter:description["'][^>]*content=["']([^"']+)["']/i);
        const twTitle = html.match(/<meta[^>]*name=["']twitter:title["'][^>]*content=["']([^"']+)["']/i);

        const decode = (s) => s?.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'") || '';

        // For Instagram, try to extract more from LD+JSON
        let extraText = '';
        if (linkType === 'instagram') {
          const ldJson = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
          if (ldJson) {
            try {
              const ld = JSON.parse(ldJson[1]);
              extraText = ld.articleBody || ld.description || ld.caption || '';
            } catch {}
          }
        }

        clearTimeout(timeout);
        const platformNames = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', tiktok: 'TikTok', threads: 'Threads', mastodon: 'Mastodon' };
        return {
          author: decode(ogTitle?.[1] || twTitle?.[1]) || 'Unknown',
          text: decode(ogDesc?.[1] || twDesc?.[1]) || extraText || '',
          image: ogImage?.[1] || '',
          platform: platformNames[linkType] || linkType,
        };
      } catch {}
    }

    clearTimeout(timeout);
    return null;
  } catch {
    clearTimeout(timeout);
    return null;
  }
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
