import db from './db.js';
import crypto from 'crypto';

export const collaboration = {
  // Share a workflow (generate unique token)
  share(workflowId, userId, isPublic = false) {
    const existing = db.prepare('SELECT * FROM workflow_shares WHERE workflow_id = ? AND user_id = ?').get(workflowId, userId);
    if (existing) return existing;

    const shareToken = crypto.randomBytes(12).toString('hex');
    const result = db.prepare(
      'INSERT INTO workflow_shares (workflow_id, user_id, share_token, is_public) VALUES (?, ?, ?, ?)'
    ).run(workflowId, userId, shareToken, isPublic ? 1 : 0);

    return db.prepare('SELECT * FROM workflow_shares WHERE id = ?').get(result.lastInsertRowid);
  },

  // Get shared workflow by token
  getByToken(shareToken) {
    const share = db.prepare('SELECT * FROM workflow_shares WHERE share_token = ?').get(shareToken);
    if (!share) return null;

    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(share.workflow_id);
    const nodes = db.prepare('SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY position').all(share.workflow_id);
    const edges = db.prepare('SELECT * FROM workflow_edges WHERE workflow_id = ?').all(share.workflow_id);

    return { share, workflow, nodes, edges };
  },

  // Fork a shared workflow
  fork(shareToken, userId) {
    const data = this.getByToken(shareToken);
    if (!data) throw new Error('Shared workflow not found');

    // Create new workflow
    const wf = db.prepare('INSERT INTO workflows (user_id, title, description, status) VALUES (?, ?, ?, ?)').run(
      userId, `${data.workflow.title} (Fork)`, data.workflow.description, 'draft'
    );
    const newWorkflowId = wf.lastInsertRowid;

    // Copy nodes with ID remapping
    const nodeIdMap = {};
    const insertNode = db.prepare(
      'INSERT INTO workflow_nodes (workflow_id, name, node_type, description, config, custom_script, position) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const node of data.nodes) {
      const r = insertNode.run(newWorkflowId, node.name, node.node_type, node.description, node.config, node.custom_script, node.position);
      nodeIdMap[node.id] = r.lastInsertRowid;
    }

    // Copy edges with remapped IDs
    const insertEdge = db.prepare(
      'INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, from_output, to_input) VALUES (?, ?, ?, ?, ?)'
    );
    for (const edge of data.edges) {
      const newFrom = nodeIdMap[edge.from_node_id];
      const newTo = nodeIdMap[edge.to_node_id];
      if (newFrom && newTo) {
        insertEdge.run(newWorkflowId, newFrom, newTo, edge.from_output, edge.to_input);
      }
    }

    // Increment fork count
    db.prepare('UPDATE workflow_shares SET fork_count = fork_count + 1 WHERE share_token = ?').run(shareToken);

    return { workflowId: newWorkflowId, nodeCount: data.nodes.length };
  },

  // Unshare a workflow
  unshare(workflowId, userId) {
    return db.prepare('DELETE FROM workflow_shares WHERE workflow_id = ? AND user_id = ?').run(workflowId, userId);
  },

  // List public workflows
  listPublic(limit = 20) {
    return db.prepare(`
      SELECT ws.*, w.title, w.description,
        (SELECT COUNT(*) FROM workflow_nodes WHERE workflow_id = w.id) as node_count
      FROM workflow_shares ws JOIN workflows w ON ws.workflow_id = w.id
      WHERE ws.is_public = 1 ORDER BY ws.fork_count DESC LIMIT ?
    `).all(limit);
  },

  // List user's shared workflows
  listByUser(userId) {
    return db.prepare(`
      SELECT ws.*, w.title, w.description
      FROM workflow_shares ws JOIN workflows w ON ws.workflow_id = w.id
      WHERE ws.user_id = ? ORDER BY ws.created_at DESC
    `).all(userId);
  },
};
