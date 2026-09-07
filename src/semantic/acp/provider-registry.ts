import type { LlmLaunchInput, LlmLaunchSpec, LlmProviderId } from './provider-types.js';
import { sanitizeExecutableSearchPath, validateExecutableCommand } from '../../shared/executable-path.js';

export const COPILOT_CLI_FIXED_ARGUMENTS = [
  '--available-tools=',
  '--disable-builtin-mcps',
  '--no-custom-instructions',
  '--no-auto-update',
  '--no-remote',
  '--no-remote-export',
  '--log-level=none',
] as const;

const COMMON_ENV = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'SHELL',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

const PROVIDER_ENV = {
  copilot: ['GH_TOKEN', 'GITHUB_TOKEN'],
  cursor: ['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN', 'CURSOR_API_ENDPOINT'],
  codex: ['CODEX_API_KEY', 'OPENAI_API_KEY', 'CODEX_HOME'],
  claude: [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
  ],
} as const satisfies Record<LlmProviderId, readonly string[]>;

export type LlmProviderDefinition = {
  id: LlmProviderId;
  displayName: string;
  defaultExecutablePath: string;
  preferredAuthMethodId?: string;
  preferredModeValues: readonly string[];
  installHint: string;
  buildLaunch(input: LlmLaunchInput): LlmLaunchSpec;
};

function filterEnv(
  providerId: LlmProviderId,
  inheritedEnv: NodeJS.ProcessEnv,
  runtimeDirectory: string,
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of COMMON_ENV) {
    const value = inheritedEnv[key];
    if (value !== undefined) env[key] = value;
  }
  for (const key of PROVIDER_ENV[providerId]) {
    const value = inheritedEnv[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    env[key] = value;
  }
  env.PATH = sanitizeExecutableSearchPath(env.PATH, runtimeDirectory);
  return env;
}

function baseLaunch(
  providerId: LlmProviderId,
  input: LlmLaunchInput,
  args: readonly string[],
  envOverrides: Record<string, string> = {},
): LlmLaunchSpec {
  return {
    providerId,
    command: validateExecutableCommand(input.executablePath, input.runtimeDirectory),
    args,
    cwd: input.runtimeDirectory,
    env: filterEnv(providerId, input.inheritedEnv, input.runtimeDirectory, envOverrides),
  };
}

const PROVIDER_DEFINITIONS: Record<LlmProviderId, LlmProviderDefinition> = {
  copilot: {
    id: 'copilot',
    displayName: 'GitHub Copilot',
    defaultExecutablePath: 'copilot',
    preferredModeValues: [],
    installHint: 'GitHub Copilot CLI (`copilot`) をインストールし、CLI でログインしてください。',
    buildLaunch(input) {
      const model = input.modelIdentifier || 'auto';
      return baseLaunch('copilot', input, [
        '--acp',
        '--stdio',
        '--model',
        model,
        ...COPILOT_CLI_FIXED_ARGUMENTS,
      ]);
    },
  },
  cursor: {
    id: 'cursor',
    displayName: 'Cursor',
    defaultExecutablePath: 'agent',
    preferredAuthMethodId: 'cursor_login',
    preferredModeValues: ['ask'],
    installHint: 'Cursor CLI (`agent`) をインストールし、`agent login` または CURSOR_API_KEY を設定してください。',
    buildLaunch(input) {
      return baseLaunch('cursor', input, ['acp']);
    },
  },
  codex: {
    id: 'codex',
    displayName: 'OpenAI Codex',
    defaultExecutablePath: 'codex-acp',
    preferredModeValues: ['read-only'],
    installHint:
      '@agentclientprotocol/codex-acp をグローバルインストールし、advertised 認証 flow でログインしてください。',
    buildLaunch(input) {
      return baseLaunch('codex', input, [], { INITIAL_AGENT_MODE: 'read-only' });
    },
  },
  claude: {
    id: 'claude',
    displayName: 'Claude',
    defaultExecutablePath: 'claude-agent-acp',
    preferredModeValues: ['plan'],
    installHint:
      '@agentclientprotocol/claude-agent-acp をグローバルインストールし、advertised 認証 flow でログインしてください。',
    buildLaunch(input) {
      return baseLaunch('claude', input, []);
    },
  },
};

export function getLlmProviderDefinition(id: LlmProviderId): LlmProviderDefinition {
  return PROVIDER_DEFINITIONS[id];
}

export function listLlmProviderDefinitions(): readonly LlmProviderDefinition[] {
  return Object.values(PROVIDER_DEFINITIONS);
}

export function buildLlmLaunchSpec(providerId: LlmProviderId, input: LlmLaunchInput): LlmLaunchSpec {
  return getLlmProviderDefinition(providerId).buildLaunch(input);
}
