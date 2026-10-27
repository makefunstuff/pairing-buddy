// What each provider's terms say about using its subscription from a tool like Pair: one line before a subscription
// login, and the page to read. docs/config.md has the longer version; both were checked in October 2026.

const TERMS = {
  'anthropic': {
    note: 'Anthropic allows a Claude subscription login (Free, Pro, Max, Team, Enterprise) only in Claude Code and its own apps; other tools must use an API key, and Anthropic may block them without notice.',
    url: 'https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use',
  },
  'openai': {
    note: 'OpenAI lets a ChatGPT Plus/Pro plan be used in apps you allow, up to a weekly limit you set per app (ChatGPT: Settings > Usage).',
    url: 'https://learn.chatgpt.com/docs/sign-in-with-chatgpt',
  },
  'openai-codex': {
    note: 'This login sends requests as the Codex CLI; OpenAI\'s plan covers Codex itself. Prefer `pair auth login openai` (Sign in with ChatGPT) or an API key.',
    url: 'https://help.openai.com/en/articles/11369540-codex-product-information',
  },
  'github-copilot': {
    note: 'GitHub offers no Copilot API for other tools: this login sends requests as Copilot Chat in an editor, and GitHub may suspend Copilot for scripted or heavy use.',
    url: 'https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies',
  },
  'kimi-coding': {
    note: 'Kimi Code\'s plan may be used in other tools only with an API key from the Kimi Code Console; this sign-in is the official client\'s, so choose the API key instead.',
    url: 'https://www.kimi.ai/help/kimi-code/membership-guide',
  },
  'xai': {
    note: 'xAI publishes no terms on using a SuperGrok or X Premium plan from other tools, and its servers refuse some plans.',
    url: 'https://x.ai/legal/terms-of-service',
  },
  'meta': {
    note: 'Meta publishes no terms on using a Muse plan from other tools; its own terms apply.',
    url: 'https://www.meta.com/legal/',
  },
};

/** `{note, url}`: what `provider`'s terms say about using its subscription here, in one line. */
export function subscriptionTerms(provider) {
  return TERMS[provider.id] ?? {
    note: `Whether a ${provider.name} subscription may be used from Pair is up to ${provider.name}'s terms: read them first; an API key is the route every provider supports.`,
  };
}
