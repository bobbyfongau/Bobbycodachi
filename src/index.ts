#!/usr/bin/env node
import { readStdin, getContextPercent, getModelName, getFiveHourUsage, getSevenDayUsage, getModelScopedUsage, getTokenSummary, getSessionCost } from './stdin.js';
import { getGitStatus } from './git.js';
import { getAnimalType, getPetColors } from './identity.js';
import { initSession, animTick, moodTick, sessionAgeTick, recordContextPercent, getContextVelocity, getContextTimeRemaining, getMemory, getRelationshipTier, didTierUpgrade } from './state.js';
import { loadConfig, getConfig } from './config.js';
import { getEventContext } from './events.js';
import { getAnimalName } from './animals/index.js';
import { render } from './render/index.js';
import { logError } from './log.js';

async function main(): Promise<void> {
  // Handle subcommands
  const arg = process.argv[2];
  if (arg === 'init') {
    const { runInit } = await import('./init.js');
    runInit();
    return;
  }
  if (arg === 'uninstall' || arg === 'remove') {
    const { runUninstall } = await import('./init.js');
    runUninstall();
    return;
  }
  if (arg === '--demo' || arg === 'demo') {
    const { runDemo } = await import('./demo.js');
    await runDemo();
    return;
  }
  if (arg === 'config' || arg === 'configure') {
    const { runConfigure } = await import('./configure.js');
    await runConfigure();
    return;
  }
  if (arg === 'stats') {
    const { runStats } = await import('./stats.js');
    runStats();
    return;
  }
  if (arg === 'plugins') {
    const { LOADED_PLUGINS } = await import('./plugin-store.js');
    // Touch i18n so plugin loading runs its top-level await.
    await import('./i18n.js');
    const loaded = LOADED_PLUGINS;
    if (!loaded.length) {
      console.log('No plugins loaded.');
      console.log('Drop .mjs files into ~/.config/codachi/plugins/ — see');
      console.log('https://github.com/vincent-k2026/codachi#plugins');
      return;
    }
    console.log(`${loaded.length} plugin(s) loaded:`);
    for (const p of loaded) {
      console.log(`  • ${p.name}  (${p.path})`);
      if (p.messageKeys.length) console.log(`      messages: ${p.messageKeys.join(', ')}`);
      if (p.paletteCount)       console.log(`      palettes: ${p.paletteCount}`);
    }
    return;
  }

  try {
    const stdin = await readStdin();

    if (!stdin) {
      console.log('[codachi] Initializing... restart Claude Code to see your pet!');
      return;
    }

    loadConfig();
    const petEnabled = getConfig().showPet !== false;
    // Pet disabled = no state/event tracking at all: no session state writes,
    // no memory, no mood. Velocity depends on that state, so it goes too.
    if (petEnabled) initSession(stdin.transcript_path, stdin.session_id);

    const cfg = getConfig();
    const contextPercent = getContextPercent(stdin);
    if (petEnabled) recordContextPercent(contextPercent);

    const animalType = getAnimalType();
    const petName = cfg.name || getAnimalName(animalType);
    const NO_EVENT = { category: null, freshness: 'none', detail: '',
      consecutiveFailures: 0, sessionEditCount: 0, sessionActionCount: 0 } as const;

    render({
      contextPercent,
      modelName: getModelName(stdin),
      animalType,
      colors: getPetColors(),
      git: cfg.showGit !== false ? getGitStatus(stdin.cwd) : null,
      fiveHourUsage: getFiveHourUsage(stdin),
      sevenDayUsage: getSevenDayUsage(stdin),
      modelScopedUsage: getModelScopedUsage(),
      contextVelocity: petEnabled && cfg.showVelocity !== false ? getContextVelocity() : 0,
      tokenSummary: cfg.showTokens !== false ? getTokenSummary(stdin) : null,
      sessionCost: getSessionCost(stdin),
      relationshipTier: petEnabled ? getRelationshipTier() : 'stranger',
      sessionNumber: petEnabled ? getMemory().totalSessions : 0,
      animTick: animTick(cfg.animationSpeed),
      moodTick: moodTick(),
      sessionTick: petEnabled ? sessionAgeTick() : 0,
      eventContext: petEnabled ? getEventContext() : NO_EVENT,
      petName,
      contextTimeRemaining: petEnabled && cfg.showVelocity !== false ? getContextTimeRemaining(contextPercent) : null,
      tierUpgraded: petEnabled ? didTierUpgrade() : false,
      showPet: petEnabled,
    });
  } catch (error) {
    logError('index.main', error);
    // Degrade gracefully: keep statusline quiet (empty) so Claude Code's UI stays clean.
    // Users can `tail ~/.claude/plugins/codachi/codachi.log` to diagnose.
  }
}

main();
