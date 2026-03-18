import { safeSend } from '../bot-helpers.js';

export function registerProviders(bot, shared) {
  const { llm, PROVIDER_REGISTRY, kb, helpers } = shared;

  bot.command('providers', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    await helpers.showProviders(ctx, userId);
  });

  bot.command('setkey', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const parts = ctx.message.text.replace('/setkey', '').trim().split(/\s+/);
    if (parts.length < 2) return ctx.reply('Usage: /setkey <provider> <api_key>\nExample: /setkey openai sk-...');
    const [providerName, apiKey] = parts;
    if (!PROVIDER_REGISTRY[providerName]) {
      return ctx.reply(`Unknown provider: ${providerName}\nAvailable: ${Object.keys(PROVIDER_REGISTRY).filter(k => !PROVIDER_REGISTRY[k].isLocal).join(', ')}`);
    }
    llm.setApiKey(userId, providerName, apiKey);
    await ctx.reply(`\u2705 API key set for *${PROVIDER_REGISTRY[providerName].name}*`, { parse_mode: 'Markdown' });
  });

  bot.command('models', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const provs = llm.getProviders(userId);
    let msg = '\ud83e\udde0 *Available Models*\n\n';
    for (const p of provs) {
      const reg = PROVIDER_REGISTRY[p.name];
      if (!reg) continue;
      const status = p.enabled ? (p.api_key || p.is_local ? '\ud83d\udfe2' : '\ud83d\udfe1') : '\ud83d\udd34';
      msg += `${status} *${p.display_name}*\n`;
      msg += `  Current: \`${p.model}\`\n`;
      msg += `  Options: ${reg.models.slice(0, 4).map(m => `\`${m}\``).join(', ')}\n\n`;
    }
    msg += 'Change: /setmodel <provider> <model>';
    await safeSend(ctx, msg);
  });

  bot.command('setmodel', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const parts = ctx.message.text.split(/\s+/).slice(1);
    if (parts.length < 2) return safeSend(ctx, '\u274c Usage: /setmodel <provider> <model>\nExample: /setmodel openai gpt-4.1');
    const [provName, ...modelParts] = parts;
    const model = modelParts.join(' ');
    try {
      llm.setModel(userId, provName, model);
      await safeSend(ctx, `\u2705 ${provName} model set to \`${model}\``);
    } catch (err) {
      await safeSend(ctx, `\u274c ${err.message}`);
    }
  });

  bot.command('test', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const provName = ctx.message.text.split(/\s+/)[1];
    if (!provName) return safeSend(ctx, '\u274c Usage: /test <provider>\nExample: /test claude');
    await safeSend(ctx, `\ud83c\udfd3 Testing ${provName}...`);
    try {
      const result = await llm.testProvider(userId, provName);
      if (result.ok) {
        await safeSend(ctx, `\u2705 *${provName}* is working!\nLatency: ${result.latency}ms\nModel: ${result.model || 'N/A'}`);
      } else {
        await safeSend(ctx, `\u274c *${provName}* failed: ${result.error}`);
      }
    } catch (err) {
      await safeSend(ctx, `\u274c ${err.message}`);
    }
  });

  // --- Provider callback queries ---
  bot.action('providers', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    await helpers.showProvidersEdit(ctx, userId);
  });

  bot.action(/toggle_prov:(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Toggled');
    llm.toggleProvider(ctx.from.id, ctx.match[1]);
    await helpers.showProvidersEdit(ctx, ctx.from.id);
  });

  bot.action(/prov_up:(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Moved up');
    llm.reorderProvider(ctx.from.id, ctx.match[1], 'up');
    await helpers.showProvidersEdit(ctx, ctx.from.id);
  });

  bot.action(/prov_down:(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Moved down');
    llm.reorderProvider(ctx.from.id, ctx.match[1], 'down');
    await helpers.showProvidersEdit(ctx, ctx.from.id);
  });

  bot.action('set_api_key', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('Select provider to set API key:', kb.providerSelect('setkey'));
  });

  bot.action(/setkey:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const providerName = ctx.match[1];
    const reg = PROVIDER_REGISTRY[providerName];
    shared.userState.setAwaiting(ctx.from.id, `setkey:${providerName}`);
    await ctx.editMessageText(
      `\ud83d\udd11 *Set API Key for ${reg.name}*\n\nSend your API key as the next message.\n\n\ud83d\udcd6 Setup docs: ${reg.docs}`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.action('change_model', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('Select provider to change model:', kb.providerSelect('chmodel'));
  });

  bot.action(/chmodel:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const keyboard = kb.modelSelect(ctx.match[1]);
    if (!keyboard) return ctx.editMessageText('Provider not found.');
    await ctx.editMessageText(`Select model for ${PROVIDER_REGISTRY[ctx.match[1]].name}:`, keyboard);
  });

  // Noop for group header buttons
  bot.action('noop', async (ctx) => { await ctx.answerCbQuery(); });

  bot.action(/select_model:(.+):(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Model updated');
    const [, providerName, model] = ctx.match;
    llm.setModel(ctx.from.id, providerName, model);
    await helpers.showProvidersEdit(ctx, ctx.from.id);
  });
}
