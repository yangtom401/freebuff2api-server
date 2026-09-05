const freebuff = require('./freebuff-client');
const { log } = require('./account-manager');

const STATIC_MODELS = [
  { id: 'deepseek/deepseek-v4-flash', session: 'deepseek/deepseek-v4-flash', agent: 'base2-free-deepseek-flash', upstream: 'deepseek/deepseek-v4-flash', category: 'standard', desc: 'DeepSeek V4 Flash (非Premium，额度宽松)' },
  { id: 'mimo/mimo-v2.5', session: 'mimo/mimo-v2.5', agent: 'base2-free-mimo', upstream: 'mimo/mimo-v2.5', category: 'standard', desc: 'MiMo 2.5 (非Premium，额度宽松)' },
  { id: 'deepseek/deepseek-v4-pro', session: 'deepseek/deepseek-v4-pro', agent: 'base2-free-deepseek', upstream: 'deepseek/deepseek-v4-pro', category: 'premium', desc: 'DeepSeek V4 Pro' },
  { id: 'minimax/minimax-m3', session: 'minimax/minimax-m3', agent: 'base2-free-minimax-m3', upstream: 'minimax/minimax-m3', category: 'premium', desc: 'MiniMax M3' },
  { id: 'openai/gpt-5.6-luna', session: 'openai/gpt-5.6-luna', agent: 'base2-free-luna', upstream: 'openai/gpt-5.6-luna', category: 'premium', desc: 'GPT-5.6 Luna' },
  { id: 'poolside/laguna-s-2.1', session: 'poolside/laguna-s-2.1', agent: 'base2-free-laguna-s-2-1', upstream: 'poolside/laguna-s-2.1', category: 'premium', desc: 'Laguna S 2.1' },
  { id: 'openrouter/poolside/laguna-s-2.1', session: 'openrouter/poolside/laguna-s-2.1', agent: 'base2-free-laguna-s-2-1-openrouter', upstream: 'openrouter/poolside/laguna-s-2.1', category: 'premium', desc: 'Laguna S 2.1 (OpenRouter)' },
  { id: 'inclusionai/ling-3.0-flash:free', session: 'inclusionai/ling-3.0-flash:free', agent: 'base2-free-ling-3-flash', upstream: 'inclusionai/ling-3.0-flash:free', category: 'premium', desc: 'Ling 3.0 Flash' },
  { id: 'crof/greg-2-ultra', session: 'crof/greg-2-ultra', agent: 'base2-free-greg-2-ultra', upstream: 'crof/greg-2-ultra', category: 'premium', desc: 'Greg 2 Ultra' },
  { id: 'crof/greg-2-super', session: 'crof/greg-2-super', agent: 'base2-free-greg-2-super', upstream: 'crof/greg-2-super', category: 'premium', desc: 'Greg 2 Super' },
  { id: 'meta/muse-spark-1.2-contributor', session: 'meta/muse-spark-1.2-contributor', agent: 'base2-free-muse-spark', upstream: 'meta/muse-spark-1.2-contributor', category: 'premium', desc: 'Muse Spark 1.2' },
  { id: 'z-ai/glm-5.3-flash', session: 'z-ai/glm-5.3-flash', agent: 'base2-free-glm', upstream: 'z-ai/glm-5.3-flash', category: 'glm', desc: 'GLM 5.3 Flash (需referral资格)' },
  { id: 'anthropic/claude-fable-5', session: 'anthropic/claude-fable-5', agent: 'base2-free-fable', upstream: 'anthropic/claude-fable-5', category: 'special', desc: 'Claude Fable 5 (限量试用)' },
];

let dynamicModels = [];
let lastDynamicFetch = 0;
const DYNAMIC_REFRESH_MS = 6 * 60 * 60 * 1000;

async function refreshDynamicModels() {
  if (Date.now() - lastDynamicFetch < DYNAMIC_REFRESH_MS) return;
  try {
    const resp = await freebuff.fetchWithTimeout(
      'https://raw.githubusercontent.com/CodebuffAI/freebuff/main/common/src/constants/free-agents.ts',
      {}, 10000
    );
    if (resp.ok) {
      const text = await resp.text();
      const match = text.match(/FREEBUFF_ROOT_AGENT_ID_BY_MODEL\s*=\s*\{([^}]+)\}/s);
      if (match) {
        const pairs = [...match[1].matchAll(/["']([^"']+)["']\s*:\s*["']([^"']+)["']/g)];
        dynamicModels = pairs.map(([_, model, agent]) => ({
          id: model, session: model, agent, upstream: model, category: 'dynamic', desc: `${model} (dynamic)`
        }));
        lastDynamicFetch = Date.now();
        log('INFO', `Refreshed ${dynamicModels.length} dynamic models`);
      }
    }
  } catch (e) {
    log('WARN', `Dynamic model refresh failed: ${e.message}`);
  }
}

function getAllModels() {
  return [...STATIC_MODELS, ...dynamicModels];
}

function findModel(id) {
  return getAllModels().find(m => m.id === id);
}

function findModelBySession(sessionModel) {
  return getAllModels().find(m => m.session === sessionModel);
}

module.exports = { STATIC_MODELS, dynamicModels, refreshDynamicModels, getAllModels, findModel, findModelBySession };
