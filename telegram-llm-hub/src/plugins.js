import db from './db.js';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { readdir, readFile, stat } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = join(__dirname, '..', 'plugins');

// Loaded plugin instances
const loadedPlugins = new Map();

export const plugins = {
  // Scan plugins directory and register new ones
  async scan() {
    try {
      await stat(PLUGINS_DIR);
    } catch {
      // Create plugins dir if missing
      const { mkdir } = await import('fs/promises');
      await mkdir(PLUGINS_DIR, { recursive: true });
      // Create example plugin
      const examplePlugin = `// Example plugin: Custom greeting node
// Each plugin exports: name, description, nodeType, execute
export const name = 'greeting';
export const description = 'Generate a custom greeting message';
export const nodeType = {
  emoji: '👋',
  label: 'Greeting',
  desc: 'Generate personalized greetings',
};

// Execute function receives: { inputData, config, env, userId }
export async function execute({ inputData, config }) {
  const name = inputData?.name || config?.name || 'World';
  const style = config?.style || 'formal';
  const greetings = {
    formal: \`Dear \${name}, I hope this message finds you well.\`,
    casual: \`Hey \${name}! What's up?\`,
    fun: \`Yo \${name}! 🎉 Let's gooo!\`,
  };
  return { result: greetings[style] || greetings.formal, outputs: { greeting: greetings[style] } };
}
`;
      const { writeFile } = await import('fs/promises');
      await writeFile(join(PLUGINS_DIR, 'example-greeting.js'), examplePlugin);
      return [{ name: 'greeting', file: 'example-greeting.js', status: 'created' }];
    }

    const files = await readdir(PLUGINS_DIR);
    const jsFiles = files.filter(f => f.endsWith('.js'));
    const results = [];

    for (const file of jsFiles) {
      try {
        const filePath = join(PLUGINS_DIR, file);
        const plugin = await import(`file://${filePath}?t=${Date.now()}`); // cache bust
        if (!plugin.name || !plugin.execute) {
          results.push({ file, status: 'invalid', error: 'Missing name or execute export' });
          continue;
        }

        // Register in DB
        const existing = db.prepare('SELECT id FROM plugins WHERE name = ?').get(plugin.name);
        if (!existing) {
          db.prepare('INSERT INTO plugins (name, file_path, config) VALUES (?, ?, ?)').run(
            plugin.name, file, JSON.stringify(plugin.nodeType || {})
          );
        } else {
          db.prepare('UPDATE plugins SET file_path = ?, config = ?, loaded_at = CURRENT_TIMESTAMP WHERE name = ?').run(
            file, JSON.stringify(plugin.nodeType || {}), plugin.name
          );
        }

        loadedPlugins.set(plugin.name, {
          ...plugin,
          filePath,
          nodeType: plugin.nodeType || { emoji: '🔌', label: plugin.name, desc: plugin.description || '' },
        });

        results.push({ name: plugin.name, file, status: 'loaded' });
      } catch (err) {
        results.push({ file, status: 'error', error: err.message });
      }
    }

    return results;
  },

  // Get loaded plugin
  get(name) {
    return loadedPlugins.get(name);
  },

  // List all plugins
  list() {
    const dbPlugins = db.prepare('SELECT * FROM plugins ORDER BY name').all();
    return dbPlugins.map(p => ({
      ...p,
      config: JSON.parse(p.config || '{}'),
      loaded: loadedPlugins.has(p.name),
    }));
  },

  // Toggle plugin enabled/disabled
  toggle(pluginId) {
    const plugin = db.prepare('SELECT * FROM plugins WHERE id = ?').get(pluginId);
    if (!plugin) throw new Error('Plugin not found');
    const newState = plugin.enabled ? 0 : 1;
    db.prepare('UPDATE plugins SET enabled = ? WHERE id = ?').run(newState, pluginId);
    return { ...plugin, enabled: newState };
  },

  // Execute a plugin node
  async execute(pluginName, context) {
    const plugin = loadedPlugins.get(pluginName);
    if (!plugin) throw new Error(`Plugin '${pluginName}' not loaded`);
    if (!plugin.execute) throw new Error(`Plugin '${pluginName}' has no execute function`);
    return await plugin.execute(context);
  },

  // Get all registered node types from plugins
  getNodeTypes() {
    const types = {};
    for (const [name, plugin] of loadedPlugins) {
      const dbEntry = db.prepare('SELECT enabled FROM plugins WHERE name = ?').get(name);
      if (dbEntry && !dbEntry.enabled) continue;
      types[`plugin:${name}`] = plugin.nodeType;
    }
    return types;
  },

  // Reload a specific plugin
  async reload(pluginName) {
    const dbEntry = db.prepare('SELECT file_path FROM plugins WHERE name = ?').get(pluginName);
    if (!dbEntry) throw new Error('Plugin not found in DB');
    const filePath = join(PLUGINS_DIR, dbEntry.file_path);
    const plugin = await import(`file://${filePath}?t=${Date.now()}`);
    loadedPlugins.set(pluginName, {
      ...plugin,
      filePath,
      nodeType: plugin.nodeType || { emoji: '🔌', label: pluginName, desc: plugin.description || '' },
    });
    return { name: pluginName, status: 'reloaded' };
  },
};
