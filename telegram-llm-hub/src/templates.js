import db from './db.js';

// Pre-built workflow templates
const BUILT_IN_TEMPLATES = [
  {
    title: 'SEO Content Analyzer',
    description: 'Analyze a URL for SEO best practices, generate improvement suggestions, and create optimized meta tags',
    category: 'marketing',
    tags: ['seo', 'content', 'analysis'],
    nodes: [
      { name: 'URL Input', node_type: 'input', description: 'Enter the URL to analyze', position: 0 },
      { name: 'Fetch Page', node_type: 'api', description: 'Fetch page HTML and metadata', position: 1, config: { method: 'GET' } },
      { name: 'SEO Analysis', node_type: 'process', description: 'Analyze page for SEO issues: title, meta, headings, links, speed', position: 2 },
      { name: 'Generate Fixes', node_type: 'process', description: 'Generate improved meta tags and content suggestions', position: 3 },
      { name: 'Report', node_type: 'output', description: 'Formatted SEO report with scores and recommendations', position: 4 },
    ],
    edges: [[0,1],[1,2],[2,3],[3,4]],
  },
  {
    title: 'Code Review Pipeline',
    description: 'Automated code review: lint, security scan, style check, and generate review comments',
    category: 'development',
    tags: ['code', 'review', 'security', 'lint'],
    nodes: [
      { name: 'Code Input', node_type: 'input', description: 'Paste code or file path to review', position: 0 },
      { name: 'Lint Check', node_type: 'cli', description: 'Run linter on the code', position: 1 },
      { name: 'Security Scan', node_type: 'process', description: 'Scan for security vulnerabilities and injection risks', position: 2 },
      { name: 'Style Review', node_type: 'process', description: 'Check code style and best practices', position: 3 },
      { name: 'Merge Results', node_type: 'merge', description: 'Combine all review findings', position: 4 },
      { name: 'Review Report', node_type: 'output', description: 'Formatted code review with severity ratings', position: 5 },
    ],
    edges: [[0,1],[0,2],[0,3],[1,4],[2,4],[3,4],[4,5]],
  },
  {
    title: 'Content Translation Chain',
    description: 'Translate content to multiple languages with quality verification and cultural adaptation',
    category: 'content',
    tags: ['translation', 'multilingual', 'localization'],
    nodes: [
      { name: 'Source Text', node_type: 'input', description: 'Enter text to translate', position: 0 },
      { name: 'Detect Language', node_type: 'process', description: 'Detect source language automatically', position: 1 },
      { name: 'Translate', node_type: 'process', description: 'Translate to target languages (FR, ES, DE, JA)', position: 2 },
      { name: 'Quality Check', node_type: 'process', description: 'Verify translation quality and flag issues', position: 3 },
      { name: 'Output', node_type: 'output', description: 'All translations with quality scores', position: 4 },
    ],
    edges: [[0,1],[1,2],[2,3],[3,4]],
  },
  {
    title: 'Data ETL Pipeline',
    description: 'Extract data from API, transform with custom logic, and load into output format',
    category: 'data',
    tags: ['etl', 'api', 'data', 'transform'],
    nodes: [
      { name: 'API Config', node_type: 'input', description: 'API endpoint URL and auth config', position: 0 },
      { name: 'Fetch Data', node_type: 'api', description: 'GET data from the API endpoint', position: 1 },
      { name: 'Transform', node_type: 'code', description: 'Transform and clean data with custom JavaScript', position: 2 },
      { name: 'Validate', node_type: 'decision', description: 'Check if data meets quality thresholds', position: 3 },
      { name: 'Save Results', node_type: 'file', description: 'Save processed data to JSON/CSV file', position: 4 },
      { name: 'Error Log', node_type: 'output', description: 'Log validation failures', position: 5 },
    ],
    edges: [[0,1],[1,2],[2,3],[3,4],[3,5]],
  },
  {
    title: 'Email Campaign Builder',
    description: 'Generate personalized email campaigns with A/B testing variants',
    category: 'marketing',
    tags: ['email', 'campaign', 'marketing', 'ab-test'],
    nodes: [
      { name: 'Campaign Brief', node_type: 'input', description: 'Product/service description and target audience', position: 0 },
      { name: 'Generate Subject Lines', node_type: 'process', description: 'Create 5 subject line variants', position: 1 },
      { name: 'Generate Body A', node_type: 'process', description: 'Create email body variant A (formal)', position: 2 },
      { name: 'Generate Body B', node_type: 'process', description: 'Create email body variant B (casual)', position: 3 },
      { name: 'Merge Variants', node_type: 'merge', description: 'Combine all variants into campaign package', position: 4 },
      { name: 'Campaign Output', node_type: 'output', description: 'Complete campaign with all variants', position: 5 },
    ],
    edges: [[0,1],[0,2],[0,3],[1,4],[2,4],[3,4],[4,5]],
  },
  {
    title: 'Research Assistant',
    description: 'Multi-source research pipeline: gather, analyze, summarize, and generate report',
    category: 'research',
    tags: ['research', 'analysis', 'report'],
    nodes: [
      { name: 'Research Topic', node_type: 'input', description: 'Topic or question to research', position: 0 },
      { name: 'Generate Queries', node_type: 'process', description: 'Break down into sub-questions', position: 1 },
      { name: 'Gather Sources', node_type: 'api', description: 'Fetch relevant information', position: 2 },
      { name: 'Analyze', node_type: 'process', description: 'Cross-reference and fact-check findings', position: 3 },
      { name: 'Write Report', node_type: 'process', description: 'Generate structured research report', position: 4 },
      { name: 'Save Report', node_type: 'file', description: 'Save as markdown document', position: 5 },
    ],
    edges: [[0,1],[1,2],[2,3],[3,4],[4,5]],
  },
  {
    title: 'Social Media Scheduler',
    description: 'Generate posts for multiple platforms with platform-specific formatting',
    category: 'marketing',
    tags: ['social', 'content', 'scheduling'],
    nodes: [
      { name: 'Content Idea', node_type: 'input', description: 'Main content idea or announcement', position: 0 },
      { name: 'Twitter Post', node_type: 'process', description: 'Generate concise tweet (280 chars)', position: 1 },
      { name: 'LinkedIn Post', node_type: 'process', description: 'Generate professional LinkedIn post', position: 2 },
      { name: 'Blog Draft', node_type: 'process', description: 'Generate longer blog post draft', position: 3 },
      { name: 'Compile All', node_type: 'merge', description: 'Package all platform variants', position: 4 },
      { name: 'Output Package', node_type: 'output', description: 'All posts ready for scheduling', position: 5 },
    ],
    edges: [[0,1],[0,2],[0,3],[1,4],[2,4],[3,4],[4,5]],
  },
  {
    title: 'Bug Triage Bot',
    description: 'Analyze bug reports, categorize severity, suggest fixes, and create tasks',
    category: 'development',
    tags: ['bug', 'triage', 'debugging'],
    nodes: [
      { name: 'Bug Report', node_type: 'input', description: 'Paste bug report or error log', position: 0 },
      { name: 'Categorize', node_type: 'process', description: 'Identify type: crash, UI, logic, performance', position: 1 },
      { name: 'Severity Check', node_type: 'decision', description: 'Is this critical/high/medium/low?', position: 2 },
      { name: 'Root Cause Analysis', node_type: 'process', description: 'Analyze potential root causes', position: 3 },
      { name: 'Suggest Fix', node_type: 'process', description: 'Generate fix suggestions with code', position: 4 },
      { name: 'Report', node_type: 'output', description: 'Triage report with priority and fix plan', position: 5 },
    ],
    edges: [[0,1],[1,2],[2,3],[3,4],[4,5]],
  },
];

export const templates = {
  // Seed built-in templates if empty
  seedDefaults() {
    const count = db.prepare('SELECT COUNT(*) as c FROM workflow_templates').get().c;
    if (count > 0) return;
    const insert = db.prepare(
      'INSERT INTO workflow_templates (title, description, category, tags, nodes_json, edges_json, author) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const tx = db.transaction(() => {
      for (const t of BUILT_IN_TEMPLATES) {
        insert.run(t.title, t.description, t.category, JSON.stringify(t.tags), JSON.stringify(t.nodes), JSON.stringify(t.edges), 'system');
      }
    });
    tx();
  },

  list(category = null) {
    if (category && category !== 'all') {
      return db.prepare('SELECT * FROM workflow_templates WHERE category = ? ORDER BY uses DESC').all(category);
    }
    return db.prepare('SELECT * FROM workflow_templates ORDER BY uses DESC').all();
  },

  get(templateId) {
    return db.prepare('SELECT * FROM workflow_templates WHERE id = ?').get(templateId);
  },

  getCategories() {
    return db.prepare('SELECT DISTINCT category FROM workflow_templates ORDER BY category').all().map(r => r.category);
  },

  // Create template from existing workflow
  createFromWorkflow(workflowId, title, description, category, tags) {
    const nodes = db.prepare('SELECT name, node_type, description, position, config, custom_script FROM workflow_nodes WHERE workflow_id = ? ORDER BY position').all(workflowId);
    const edges = db.prepare('SELECT from_node_id, to_node_id, from_output, to_input FROM workflow_edges WHERE workflow_id = ?').all(workflowId);
    // Re-map edges to use position indices
    const nodeIdMap = {};
    nodes.forEach((n, i) => { nodeIdMap[n.id] = i; });
    const mappedEdges = edges.map(e => [nodeIdMap[e.from_node_id] ?? 0, nodeIdMap[e.to_node_id] ?? 1]);

    const result = db.prepare(
      'INSERT INTO workflow_templates (title, description, category, tags, nodes_json, edges_json, author) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(title, description, category || 'general', JSON.stringify(tags || []), JSON.stringify(nodes), JSON.stringify(mappedEdges), 'user');
    return this.get(result.lastInsertRowid);
  },

  // Instantiate template into a real workflow for user
  useTemplate(templateId, userId) {
    const tpl = this.get(templateId);
    if (!tpl) throw new Error('Template not found');

    const nodes = JSON.parse(tpl.nodes_json);
    const edges = JSON.parse(tpl.edges_json);

    // Create workflow
    const wf = db.prepare('INSERT INTO workflows (user_id, title, description, status) VALUES (?, ?, ?, ?)').run(userId, tpl.title, tpl.description, 'draft');
    const workflowId = wf.lastInsertRowid;

    // Insert nodes and track new IDs
    const nodeIds = [];
    const insertNode = db.prepare(
      'INSERT INTO workflow_nodes (workflow_id, name, node_type, description, config, custom_script, position) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const n of nodes) {
      const r = insertNode.run(workflowId, n.name, n.node_type, n.description || '', JSON.stringify(n.config || {}), n.custom_script || null, n.position);
      nodeIds.push(r.lastInsertRowid);
    }

    // Insert edges using mapped node IDs
    const insertEdge = db.prepare(
      'INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, from_output, to_input) VALUES (?, ?, ?, ?, ?)'
    );
    for (const e of edges) {
      const [fromIdx, toIdx] = Array.isArray(e) ? e : [0, 1];
      if (nodeIds[fromIdx] && nodeIds[toIdx]) {
        insertEdge.run(workflowId, nodeIds[fromIdx], nodeIds[toIdx], 'default', 'default');
      }
    }

    // Increment usage counter
    db.prepare('UPDATE workflow_templates SET uses = uses + 1 WHERE id = ?').run(templateId);

    return { workflowId, nodeCount: nodes.length, edgeCount: edges.length };
  },

  rate(templateId, score) {
    const tpl = this.get(templateId);
    if (!tpl) throw new Error('Template not found');
    const newCount = tpl.ratings_count + 1;
    const newRating = ((tpl.rating * tpl.ratings_count) + score) / newCount;
    db.prepare('UPDATE workflow_templates SET rating = ?, ratings_count = ? WHERE id = ?').run(Math.round(newRating * 10) / 10, newCount, templateId);
    return { rating: newRating, count: newCount };
  },

  search(query) {
    const q = `%${query}%`;
    return db.prepare('SELECT * FROM workflow_templates WHERE title LIKE ? OR description LIKE ? OR tags LIKE ? ORDER BY uses DESC').all(q, q, q);
  },
};
