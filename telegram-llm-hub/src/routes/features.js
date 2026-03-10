/**
 * Feature routes: templates, arena, memory, costs, challenges,
 * collaboration, vault, plugins, debugger, leaderboard.
 *
 * Extracted from dashboard.js for readability.
 */
import express from 'express';
import db from '../db.js';
import { templates } from '../templates.js';
import { arena } from '../arena.js';
import { memory } from '../memory.js';
import { costTracker } from '../cost-tracker.js';
import { challenges } from '../challenges.js';
import { collaboration } from '../collaboration.js';
import { vault } from '../vault.js';
import { plugins } from '../plugins.js';
import { gamification } from '../gamification.js';
import { workflows } from '../workflows.js';

const router = express.Router();

// Helper — attached by parent
let _getUserId;
export function setUserIdResolver(fn) { _getUserId = fn; }
function getUserId(req) { return _getUserId(req); }

// ==================== TEMPLATES MARKETPLACE ====================
router.get('/templates', (req, res) => {
  res.json(templates.list(req.query.category || null));
});

router.get('/templates/categories', (_req, res) => {
  res.json(templates.getCategories());
});

router.get('/templates/search/:q', (req, res) => {
  res.json(templates.search(req.params.q));
});

router.get('/templates/:id', (req, res) => {
  const tpl = templates.get(parseInt(req.params.id));
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  res.json(tpl);
});

router.post('/templates/:id/use', (req, res) => {
  const userId = getUserId(req);
  try {
    const result = templates.useTemplate(parseInt(req.params.id), userId);
    challenges.trackAction(userId, 'template_used');
    gamification.addXP(userId, 'template_used');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/templates', (req, res) => {
  const { workflowId, title, description, category, tags } = req.body;
  try {
    res.json(templates.createFromWorkflow(workflowId, title, description, category, tags));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/templates/:id/rate', (req, res) => {
  try {
    res.json(templates.rate(parseInt(req.params.id), req.body.score || 5));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== MULTI-MODEL ARENA ====================
router.post('/arena/battle', async (req, res) => {
  const userId = getUserId(req);
  const { prompt, providers: provs } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });
  try {
    const result = await arena.battle(userId, prompt, provs || []);
    challenges.trackAction(userId, 'arena_battle');
    gamification.addXP(userId, 'arena_battle');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/arena/:id/vote', (req, res) => {
  try {
    res.json(arena.vote(parseInt(req.params.id), req.body.winner));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/arena/history', (req, res) => {
  res.json(arena.listByUser(getUserId(req)));
});

router.get('/arena/stats', (req, res) => {
  res.json(arena.getStats(getUserId(req)));
});

// ==================== PERSISTENT MEMORY ====================
router.get('/memory', (req, res) => {
  res.json(memory.list(getUserId(req), req.query.category));
});

router.post('/memory', (req, res) => {
  const userId = getUserId(req);
  const { key, value, category } = req.body;
  if (!key || !value) return res.status(400).json({ error: 'Key and value required' });
  try {
    const item = memory.set(userId, key, value, category || 'general');
    challenges.trackAction(userId, 'memory_added');
    gamification.addXP(userId, 'memory_added');
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/memory/:id', (req, res) => {
  memory.delete(getUserId(req), parseInt(req.params.id));
  res.json({ ok: true });
});

router.get('/memory/search', (req, res) => {
  res.json(memory.search(getUserId(req), req.query.q || ''));
});

router.get('/memory/categories', (req, res) => {
  res.json(memory.getCategories(getUserId(req)));
});

router.post('/memory/import', (req, res) => {
  try {
    res.json({ imported: memory.importMemories(getUserId(req), req.body.entries || []) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/memory/export', (req, res) => {
  res.json(memory.exportMemories(getUserId(req)));
});

// ==================== COST TRACKER ====================
router.get('/costs', (req, res) => {
  res.json(costTracker.getSummary(getUserId(req), parseInt(req.query.days) || 30));
});

router.get('/costs/daily', (req, res) => {
  res.json(costTracker.getDaily(getUserId(req), parseInt(req.query.days) || 7));
});

router.get('/costs/by-action', (req, res) => {
  res.json(costTracker.getByAction(getUserId(req), parseInt(req.query.days) || 30));
});

router.get('/costs/recent', (req, res) => {
  res.json(costTracker.getRecent(getUserId(req)));
});

// ==================== DAILY CHALLENGES ====================
router.get('/challenges', (req, res) => {
  res.json(challenges.getDailyChallenges(getUserId(req)));
});

router.get('/challenges/history', (req, res) => {
  res.json(challenges.getHistory(getUserId(req)));
});

router.get('/challenges/streak', (req, res) => {
  res.json(challenges.getStreak(getUserId(req)));
});

// ==================== WORKFLOW COLLABORATION ====================
router.post('/workflows/:id/share', (req, res) => {
  const userId = getUserId(req);
  try {
    const share = collaboration.share(parseInt(req.params.id), userId, req.body.isPublic || false);
    gamification.addXP(userId, 'workflow_shared');
    res.json(share);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/workflows/:id/share', (req, res) => {
  collaboration.unshare(parseInt(req.params.id), getUserId(req));
  res.json({ ok: true });
});

router.get('/shared/:token', (req, res) => {
  const data = collaboration.getByToken(req.params.token);
  if (!data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

router.post('/shared/:token/fork', (req, res) => {
  try {
    res.json(collaboration.fork(req.params.token, getUserId(req)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/shared', (_req, res) => {
  res.json(collaboration.listPublic());
});

router.get('/my-shares', (req, res) => {
  res.json(collaboration.listByUser(getUserId(req)));
});

// ==================== API KEY VAULT ====================
router.get('/vault', (req, res) => {
  res.json(vault.list(getUserId(req), req.query.scope));
});

router.post('/vault', (req, res) => {
  const userId = getUserId(req);
  const { keyName, value, scope, description } = req.body;
  if (!keyName || !value) return res.status(400).json({ error: 'keyName and value required' });
  try {
    res.json(vault.set(userId, keyName, value, scope || 'global', description || ''));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/vault/:id', (req, res) => {
  vault.delete(getUserId(req), parseInt(req.params.id));
  res.json({ ok: true });
});

// ==================== PLUGINS ====================
router.get('/plugins', (_req, res) => {
  res.json(plugins.list());
});

router.post('/plugins/scan', async (_req, res) => {
  try {
    res.json(await plugins.scan());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/plugins/:id/toggle', (req, res) => {
  try {
    res.json(plugins.toggle(parseInt(req.params.id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/plugins/:name/reload', async (req, res) => {
  try {
    res.json(await plugins.reload(req.params.name));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/plugin-node-types', (_req, res) => {
  res.json(plugins.getNodeTypes());
});

// ==================== WORKFLOW DEBUGGER ====================
router.post('/workflows/:id/debug', async (req, res) => {
  const userId = getUserId(req);
  const workflowId = parseInt(req.params.id);
  const { breakpoints } = req.body;
  const breakpointSet = new Set(breakpoints || []);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const nodeResults = await workflows.executeWorkflow(userId, workflowId, async (node, status, result) => {
      send('node', { nodeId: node.id, name: node.name, type: node.node_type, status, result: result ? JSON.stringify(result).substring(0, 1000) : null });
      if (breakpointSet.has(node.id) && status === 'running') {
        send('breakpoint', { nodeId: node.id, name: node.name, inputData: result });
      }
    });

    send('complete', { nodeCount: nodeResults.size || 0 });
  } catch (err) {
    send('error', { message: err.message });
  }
  res.end();
});

// ==================== LEADERBOARD ====================
router.get('/leaderboard', (req, res) => {
  const type = req.query.type || 'speed';

  if (type === 'speed') {
    const rows = db.prepare(`
      SELECT w.title, wrh.workflow_id,
        ROUND((julianday(wrh.finished_at) - julianday(wrh.started_at)) * 86400, 1) as duration_sec,
        wrh.passed_count, wrh.node_count
      FROM workflow_run_history wrh JOIN workflows w ON wrh.workflow_id = w.id
      WHERE wrh.status = 'done' AND wrh.finished_at IS NOT NULL
      ORDER BY duration_sec ASC LIMIT 20
    `).all();
    return res.json({ type: 'speed', entries: rows });
  }

  if (type === 'reliability') {
    const rows = db.prepare(`
      SELECT w.title, wrh.workflow_id,
        COUNT(*) as total_runs,
        SUM(CASE WHEN wrh.status = 'done' THEN 1 ELSE 0 END) as successful,
        ROUND(SUM(CASE WHEN wrh.status = 'done' THEN 1.0 ELSE 0.0 END) / COUNT(*) * 100, 1) as success_rate
      FROM workflow_run_history wrh JOIN workflows w ON wrh.workflow_id = w.id
      GROUP BY wrh.workflow_id HAVING total_runs >= 2
      ORDER BY success_rate DESC, total_runs DESC LIMIT 20
    `).all();
    return res.json({ type: 'reliability', entries: rows });
  }

  if (type === 'popular') {
    const rows = db.prepare(`
      SELECT w.title, wrh.workflow_id, COUNT(*) as total_runs,
        MAX(wrh.started_at) as last_run
      FROM workflow_run_history wrh JOIN workflows w ON wrh.workflow_id = w.id
      GROUP BY wrh.workflow_id ORDER BY total_runs DESC LIMIT 20
    `).all();
    return res.json({ type: 'popular', entries: rows });
  }

  res.json({ type, entries: [] });
});

export default router;
