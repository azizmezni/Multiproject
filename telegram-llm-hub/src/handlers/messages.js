import https from 'https';
import http from 'http';
import { writeFile, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { safeSend, stripMd } from '../bot-helpers.js';

const __msgDirname = dirname(fileURLToPath(import.meta.url));

export function registerMessages(bot, shared) {
  const { llm, sessions, userState, boards, drafts, workflows, NODE_TYPES, qa, kb,
          PROVIDER_REGISTRY, costTracker, gamification, challenges,
          pendingDevRequests, helpers } = shared;
  const { extractUrl, detectLinkType, fetchLinkMeta } = shared.draftUtils;

  // --- Main text handler ---
  bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const text = ctx.message.text;
    llm.initDefaults(userId);
    const state = userState.get(userId);

    // Handle API key input
    if (state.awaiting_input?.startsWith('setkey:')) {
      const providerName = state.awaiting_input.split(':')[1];
      llm.setApiKey(userId, providerName, text.trim());
      userState.clearAwaiting(userId);
      return ctx.reply(`\u2705 API key set for *${PROVIDER_REGISTRY[providerName]?.name || providerName}*`, { parse_mode: 'Markdown' });
    }

    // Handle task answer
    if (state.awaiting_input?.startsWith('task_answer:')) {
      const taskId = parseInt(state.awaiting_input.split(':')[1]);
      boards.answerTaskInput(taskId, text);
      userState.clearAwaiting(userId);
      const task = boards.getTask(taskId);
      await ctx.reply(`\u2705 Answer recorded for: *${task.title}*`, { parse_mode: 'Markdown' });
      if (boards.isReadyForExecution(task.board_id)) {
        const board = boards.get(task.board_id);
        await ctx.reply(`\u2705 All questions answered! Board *${board.title}* is ready.\n\nHit Execute to start!`,
          { parse_mode: 'Markdown', ...kb.boardView(task.board_id, boards.getTasks(task.board_id), 'planning') });
      } else {
        const summary = boards.getSummary(task.board_id);
        if (summary.needsInput.length > 0) {
          const next = summary.needsInput[0];
          userState.setAwaiting(userId, `task_answer:${next.id}`);
          await ctx.reply(`\u2753 *Next question - ${next.title}:*\n\n${next.input_question}`, { parse_mode: 'Markdown' });
        }
      }
      return;
    }

    // Handle task discussion
    if (state.awaiting_input?.startsWith('discuss_task:')) {
      const taskId = parseInt(state.awaiting_input.split(':')[1]);
      const task = boards.getTask(taskId);
      try {
        const result = await llm.chat(userId, [
          { role: 'system', content: `You are helping with a project task.\nTask: ${task.title}\nDescription: ${task.description}` },
          { role: 'user', content: text },
        ]);
        await safeSend(ctx, `\ud83d\udcac ${result.text}\n\n_via ${result.provider}_`, kb.taskDetail(task));
      } catch (err) {
        await ctx.reply(`\u274c Error: ${err.message}`);
      }
      return;
    }

    // Handle dev assistant inputs
    if (state.awaiting_input === 'dev_feature' || state.awaiting_input === 'dev_bugfix') {
      const type = state.awaiting_input === 'dev_feature' ? 'feature' : 'bugfix';
      userState.clearAwaiting(userId);
      await shared.handleDevRequest(ctx, userId, type, text);
      return;
    }

    // Handle dev assistant refinement
    if (state.awaiting_input?.startsWith('dev_refine_msg:')) {
      const requestId = parseInt(state.awaiting_input.split(':')[1]);
      userState.clearAwaiting(userId);
      const request = pendingDevRequests.get(requestId);
      if (!request) return ctx.reply('Request expired. Use /feature or /bugfix again.');
      const refinedDesc = `${request.description}\n\nAdditional context: ${text}`;
      pendingDevRequests.delete(requestId);
      await shared.handleDevRequest(ctx, userId, request.type, refinedDesc);
      return;
    }

    // Handle env var addition
    if (state.awaiting_input?.startsWith('wf_env_add:')) {
      const nodeId = parseInt(state.awaiting_input.split(':')[1]);
      userState.clearAwaiting(userId);
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const node = workflows.getNode(nodeId);
      if (!node) return ctx.reply('Node not found.');
      const config = node._config || {};
      const env = { ...(config.env || {}) };
      let added = 0;
      for (const line of lines) {
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;
        const key = line.substring(0, eqIdx).trim();
        const val = line.substring(eqIdx + 1).trim();
        if (key) { env[key] = val; added++; }
      }
      if (added === 0) return ctx.reply('Invalid format. Use `KEY=value`', { parse_mode: 'Markdown' });
      workflows.setNodeConfig(nodeId, { ...config, env });
      await ctx.reply(`\u2705 Added ${added} env var(s) to *${node.name}*\n\nKeys: ${Object.keys(env).map(k => `\`${k}\``).join(', ')}`, { parse_mode: 'Markdown' });
      return;
    }

    // Handle auto-fix with user problem description
    if (state.awaiting_input?.startsWith('wf_fix_msg:')) {
      const wfId = parseInt(state.awaiting_input.split(':')[1]);
      userState.clearAwaiting(userId);
      await shared.runAutoFix(ctx, userId, wfId, text);
      return;
    }

    // Handle workflow node addition
    if (state.awaiting_input?.startsWith('wf_addnode:')) {
      const parts = state.awaiting_input.split(':');
      const wfId = parseInt(parts[1]);
      const nodeType = parts[2];
      userState.clearAwaiting(userId);
      const nodeParts = text.split('|').map(s => s.trim());
      const name = nodeParts[0] || 'Node';
      const desc = nodeParts[1] || '';
      workflows.addNode(wfId, name, nodeType, desc, ['default'], ['default']);
      const rendered = workflows.renderWorkflow(wfId);
      const nodes = workflows.getNodes(wfId);
      return ctx.reply(rendered, { parse_mode: 'Markdown', ...helpers.workflowKeyboard(wfId, nodes) });
    }

    // Handle workflow input/output editing
    if (state.awaiting_input?.startsWith('wf_edit_inputs:') || state.awaiting_input?.startsWith('wf_edit_outputs:')) {
      const parts = state.awaiting_input.split(':');
      const field = parts[0].replace('wf_edit_', '');
      const nodeId = parseInt(parts[1]);
      userState.clearAwaiting(userId);
      const values = text.split(',').map(s => s.trim()).filter(Boolean);
      if (field === 'inputs') workflows.setNodeInputs(nodeId, values);
      else workflows.setNodeOutputs(nodeId, values);
      return ctx.reply(`\u2705 ${field} updated: ${values.join(', ')}`);
    }

    // Handle CLI command for draft
    if (state.awaiting_input?.startsWith('draft_cli:')) {
      userState.clearAwaiting(userId);
      await ctx.reply(`\u25b6\ufe0f Running: \`${text}\``, { parse_mode: 'Markdown' });
      const result = await qa.runCommand(text);
      const emoji = result.ok ? '\u2705' : '\u274c';
      let output = result.stdout || result.stderr || 'No output';
      if (output.length > 3500) output = output.substring(0, 3500) + '...(truncated)';
      return ctx.reply(`${emoji}\n\`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
    }

    // Check if message contains a URL -> smart link handling
    const url = extractUrl(text);
    if (url && !text.startsWith('/')) {
      const linkType = detectLinkType(url);
      const typeLabels = {
        github_repo: '\ud83d\udce6 GitHub Repo', github_issue: '\ud83d\udc1b GitHub Issue', github_code: '\ud83d\udcbb GitHub Code',
        github: '\ud83d\udc19 GitHub', youtube: '\ud83d\udcfa YouTube Video', youtube_playlist: '\ud83d\udcfa YouTube Playlist',
        npm: '\ud83d\udce6 npm Package', pypi: '\ud83d\udce6 PyPI Package', docs: '\ud83d\udcd6 Documentation',
        article: '\ud83d\udcf0 Article', stackoverflow: '\ud83d\udca1 StackOverflow', api: '\ud83c\udf10 API',
        docker: '\ud83d\udc33 Docker Image', website: '\ud83d\udd17 Website',
      };
      const typeLabel = typeLabels[linkType] || '\ud83d\udd17 Link';
      await ctx.reply(`${typeLabel} detected! Fetching info...`);
      const meta = await fetchLinkMeta(url);
      const draft = drafts.add(userId, url, meta.title, meta.description, meta.bodyText || '');
      let contextMsg = `\ud83d\udce5 *Saved to Drafts*\n\n*${stripMd(meta.title || url)}*\n`;
      if (meta.description) contextMsg += `${stripMd(meta.description).substring(0, 200)}\n`;
      contextMsg += `\nType: ${typeLabel}\n`;
      if (linkType === 'github_repo' && meta.extra?.language) contextMsg += `Language: ${meta.extra.language}\n`;
      contextMsg += `\nI detected this as a *${typeLabel}*. Pick a smart action:`;
      return safeSend(ctx, contextMsg, kb.draftActions(draft.id, linkType));
    }

    // Normal chat mode
    let session = sessions.getActive(userId);
    if (!session) session = sessions.create(userId, 'Chat');
    sessions.addMessage(session.id, 'user', text);
    const history = sessions.getRecentMessages(session.id);
    const chatMessages = history.map(m => ({ role: m.role, content: m.content }));
    try {
      await ctx.sendChatAction('typing');
      const result = await llm.chat(userId, chatMessages);
      sessions.addMessage(session.id, 'assistant', result.text);
      let response = result.text;
      if (response.length > 4000) response = response.substring(0, 4000) + '\n\n...(truncated)';
      response += `\n\n_${result.provider} \u2022 ${result.model}_`;
      await safeSend(ctx, response);
    } catch (err) {
      await ctx.reply(`\u274c ${err.message}`);
    }
  });

  // --- Photo handler (vision QA) ---
  bot.on('photo', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const caption = ctx.message.caption || 'What do you see in this image?';
    try {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const fileLink = await ctx.telegram.getFileLink(photo.file_id);
      const response = await fetch(fileLink.href);
      const buffer = Buffer.from(await response.arrayBuffer());
      const base64 = buffer.toString('base64');
      await ctx.sendChatAction('typing');
      const result = await llm.vision(userId, base64, caption);
      await safeSend(ctx, `${result.text}\n\n_${result.provider} \u2022 ${result.model}_`);
    } catch (err) {
      await ctx.reply(`\u274c Vision error: ${err.message}`);
    }
  });

  // --- Inline query handler ---
  bot.on('inline_query', async (ctx) => {
    const query = ctx.inlineQuery.query.trim();
    const userId = ctx.from.id;
    if (!query) return ctx.answerInlineQuery([]);
    llm.initDefaults(userId);
    const results = [];
    try {
      const response = await llm.chat(userId, [{ role: 'user', content: query }]);
      const respText = response.text || 'No response';
      results.push({
        type: 'article', id: 'llm-' + Date.now(),
        title: `\ud83d\udca1 AI: ${respText.substring(0, 50)}...`,
        description: respText.substring(0, 100),
        input_message_content: { message_text: respText.substring(0, 4096) },
      });
    } catch {}

    const userBoards = boards.listByUser(userId).filter(b => b.title.toLowerCase().includes(query.toLowerCase())).slice(0, 3);
    for (const b of userBoards) {
      results.push({
        type: 'article', id: `board-${b.id}`,
        title: `\ud83d\udccb Board: ${b.title}`,
        description: b.description || `Status: ${b.status}`,
        input_message_content: { message_text: `\ud83d\udccb *${b.title}*\nStatus: ${b.status}\n${b.description || ''}` },
      });
    }

    const userWf = workflows.listByUser(userId).filter(w => w.title.toLowerCase().includes(query.toLowerCase())).slice(0, 3);
    for (const w of userWf) {
      results.push({
        type: 'article', id: `wf-${w.id}`,
        title: `\ud83d\udd00 Workflow: ${w.title}`,
        description: w.description || `Status: ${w.status}`,
        input_message_content: { message_text: `\ud83d\udd00 *${w.title}*\nStatus: ${w.status}\n${w.description || ''}` },
      });
    }
    await ctx.answerInlineQuery(results.slice(0, 10), { cache_time: 10 });
  });

  // --- Voice handler ---
  bot.on('voice', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    await ctx.reply('\ud83c\udfa4 Processing voice message...');
    try {
      const file = await ctx.telegram.getFile(ctx.message.voice.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${bot.telegram.token}/${file.file_path}`;
      const tempPath = join(__msgDirname, '..', `temp_voice_${userId}.ogg`);
      await new Promise((resolve, reject) => {
        const proto = fileUrl.startsWith('https') ? https : http;
        proto.get(fileUrl, (res) => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', async () => { await writeFile(tempPath, Buffer.concat(chunks)); resolve(); });
          res.on('error', reject);
        }).on('error', reject);
      });

      let transcript = '';
      const providers = llm.getEnabledProviders(userId);
      const openaiProv = providers.find(p => p.name === 'openai');
      if (openaiProv?.api_key) {
        const { readFile: readF } = await import('fs/promises');
        const audioData = await readF(tempPath);
        const boundary = '----FormBoundary' + Date.now();
        const body = Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.ogg"\r\nContent-Type: audio/ogg\r\n\r\n`),
          audioData,
          Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--\r\n`),
        ]);
        const result = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${openaiProv.api_key}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
          body,
        });
        const data = await result.json();
        transcript = data.text || '';
      } else {
        transcript = '[Voice transcription requires OpenAI API key for Whisper]';
      }

      try { await unlink(tempPath); } catch {}
      if (!transcript || transcript.startsWith('[')) return safeSend(ctx, `\ud83c\udfa4 ${transcript || 'Could not transcribe audio'}`);

      const response = await llm.chat(userId, [
        { role: 'system', content: 'The user sent a voice message. Here is the transcript. Respond helpfully.' },
        { role: 'user', content: transcript },
      ]);
      costTracker.log(userId, response.provider, response.model, transcript, response.text, 'voice');
      gamification.addXP(userId, 'voice_processed');
      challenges.trackAction(userId, 'message_sent');
      await safeSend(ctx, `\ud83c\udfa4 *Transcript:*\n${transcript}\n\n\ud83d\udca1 *Response:*\n${response.text}`);
    } catch (err) {
      await ctx.reply(`\u274c Voice processing error: ${err.message}`);
    }
  });
}
