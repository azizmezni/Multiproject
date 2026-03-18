/**
 * Smart Fix Engine — pre-coded patterns for common errors that don't need LLM.
 * Returns { matched, diagnosis, fix_commands, retry_cmd } or null if no pattern matches.
 */

const PATTERNS = [
  // ---- Node.js / npm ----
  {
    test: /Cannot find module '([^']+)'/,
    fix: (m) => ({
      diagnosis: `Missing Node module: ${m[1]}`,
      fix_commands: [`npm install ${m[1].split('/')[0]}`],
      retry_cmd: null,
    }),
  },
  {
    test: /ERR!.*node-gyp|gyp ERR/i,
    fix: () => ({
      diagnosis: 'node-gyp build failure — native addon needs C++ build tools',
      fix_commands: ['npm install --ignore-scripts'],
      retry_cmd: null,
      skip_ok: true,
    }),
  },
  {
    test: /ENOENT.*npm/i,
    fix: () => ({
      diagnosis: 'npm not found or broken node_modules',
      fix_commands: ['rmdir /s /q node_modules 2>nul', 'npm install'],
      retry_cmd: null,
    }),
  },
  {
    test: /ERR!.*peer dep|ERESOLVE/i,
    fix: () => ({
      diagnosis: 'npm peer dependency conflict',
      fix_commands: ['npm install --legacy-peer-deps'],
      retry_cmd: null,
    }),
  },
  {
    test: /Error: listen EADDRINUSE.*:(\d+)/,
    fix: (m) => ({
      diagnosis: `Port ${m[1]} already in use`,
      fix_commands: [`powershell -Command "Get-Process -Id (Get-NetTCPConnection -LocalPort ${m[1]}).OwningProcess | Stop-Process -Force" 2>nul`],
      retry_cmd: null,
    }),
  },

  // ---- Python ----
  {
    test: /ModuleNotFoundError: No module named '([^']+)'/,
    fix: (m) => ({
      diagnosis: `Missing Python module: ${m[1]}`,
      fix_commands: [`py -m pip install ${m[1].replace(/\./g, '-')}`],
      retry_cmd: null,
    }),
  },
  {
    test: /requires Python [><=!]+\s*([\d.]+).*but.*?([\d.]+)/i,
    fix: (m) => ({
      diagnosis: `Python version mismatch: needs ${m[1]}, have ${m[2]}`,
      fix_commands: ['py -m pip install --ignore-requires-python -r requirements.txt'],
      retry_cmd: null,
    }),
  },
  {
    test: /error: Microsoft Visual C\+\+.*required|cl\.exe.*not found/i,
    fix: () => ({
      diagnosis: 'C++ build tools required for native extension',
      fix_commands: ['py -m pip install --only-binary :all: -r requirements.txt'],
      retry_cmd: null,
      skip_ok: true,
    }),
  },
  {
    test: /error: subprocess-exited-with-error.*setup\.py/i,
    fix: () => ({
      diagnosis: 'Package build failed during setup.py — trying binary-only install',
      fix_commands: ['py -m pip install --only-binary :all: --ignore-requires-python -r requirements.txt'],
      retry_cmd: null,
    }),
  },
  {
    test: /SyntaxError.*f["']|walrus operator|:=|match .+:/,
    fix: () => ({
      diagnosis: 'Code uses modern Python syntax — may need Python 3.10+',
      fix_commands: [],
      retry_cmd: null,
      skip_ok: true,
      unfixable_reason: 'Requires newer Python version than installed',
    }),
  },

  // ---- File / Path ----
  {
    test: /ENOENT.*no such file.*'([^']+)'/i,
    fix: (m) => ({
      diagnosis: `File not found: ${m[1]}`,
      fix_commands: [],
      retry_cmd: null,
    }),
  },
  {
    test: /FileNotFoundError.*'([^']+)'/,
    fix: (m) => ({
      diagnosis: `File not found: ${m[1]} — may need config setup`,
      fix_commands: [],
      retry_cmd: null,
    }),
  },

  // ---- Config / Env ----
  {
    test: /\.env.*not found|ENOENT.*\.env|Missing.*environment|dotenv/i,
    fix: () => ({
      diagnosis: '.env file missing — copying from example if available',
      fix_commands: [
        'if exist .env.example copy .env.example .env',
        'if exist .env.sample copy .env.sample .env',
        'if exist env.example copy env.example .env',
      ],
      retry_cmd: null,
    }),
  },
  {
    test: /API.?KEY|SECRET.?KEY|TOKEN.*required|unauthorized.*api/i,
    fix: () => ({
      diagnosis: 'API key or secret required — needs manual configuration',
      fix_commands: [],
      retry_cmd: null,
      skip_ok: true,
      unfixable_reason: 'Requires API keys or secrets that must be configured manually',
    }),
  },

  // ---- Permissions ----
  {
    test: /EPERM|EACCES|Permission denied/i,
    fix: () => ({
      diagnosis: 'Permission denied — trying to fix',
      fix_commands: ['rmdir /s /q node_modules 2>nul'],
      retry_cmd: null,
    }),
  },

  // ---- Rust ----
  {
    test: /error\[E\d+\].*linker.*not found/i,
    fix: () => ({
      diagnosis: 'Rust linker not found — needs Visual Studio Build Tools',
      fix_commands: [],
      retry_cmd: null,
      skip_ok: true,
      unfixable_reason: 'Needs Visual Studio Build Tools installed',
    }),
  },
];

/**
 * Try to match error output against known patterns.
 * @param {string} errorOutput - stderr/stdout from failed command
 * @returns {object|null} - fix info or null if no pattern matched
 */
export function matchKnownError(errorOutput) {
  for (const pattern of PATTERNS) {
    const match = errorOutput.match(pattern.test);
    if (match) {
      return { matched: true, ...pattern.fix(match) };
    }
  }
  return null;
}

/**
 * Classify a step as skippable or critical.
 * The last step (run command) is always critical.
 * Install/setup steps can be skipped if they fail.
 */
export function isStepSkippable(step, isLastStep) {
  if (isLastStep) return false;
  const label = (step.label || '').toLowerCase();
  // Config copy, env setup, optional installs are skippable
  if (/copy|config|env|optional|venv|virtual/i.test(label)) return true;
  // Install steps are semi-skippable (might still work without)
  if (/install|setup|build/i.test(label)) return true;
  return false;
}
