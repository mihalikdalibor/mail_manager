import { input, password } from '@inquirer/prompts';
import type { Command } from 'commander';
import type { AuthService, LogoutResult } from '../../core/auth.js';
import { ConfigError, loadEnvFiles } from '../../core/config.js';
import { errorText } from '../error-text.js';
import {
  createSupabaseServices,
  FileSessionStorage,
  sessionDir,
} from '../../core/db/supabase/index.js';

function authService(): AuthService {
  loadEnvFiles();
  return createSupabaseServices(process.env, new FileSessionStorage(sessionDir(process.env))).auth;
}

/** Last resort for logout when no client can be built (e.g. broken config). */
function clearLocalSession(): LogoutResult {
  const storage = new FileSessionStorage(sessionDir(process.env));
  const hadSession = !storage.isEmpty();
  storage.clear();
  return hadSession ? 'logged-out' : 'not-logged-in';
}

/** Ctrl+C in an inquirer prompt → exit 130 quietly; other errors → message + exit 1. */
function handleError(err: unknown): void {
  if (err instanceof Error && err.name === 'ExitPromptError') {
    process.exitCode = 130;
    return;
  }
  // Only core errors written for users (AuthError, ConfigError, …) show their message.
  console.error(errorText(err));
  process.exitCode = 1;
}

export function registerAuth(program: Command): void {
  program
    .command('login')
    .description('Log in to Mail Manager (users are created by the admin in Supabase)')
    .option('--email <email>', 'account email (prompted when omitted)')
    .action(async (opts: { email?: string }) => {
      if (!process.stdin.isTTY) {
        console.error('login needs an interactive terminal (password prompt)');
        process.exitCode = 1;
        return;
      }
      try {
        const auth = authService();
        const email = (opts.email ?? (await input({ message: 'Email:' }))).trim();
        if (email === '') {
          console.error('Email is required');
          process.exitCode = 1;
          return;
        }
        // No mask: nothing is echoed, so the password length isn't revealed either.
        const pass = await password({ message: 'Password:' });
        const user = await auth.login(email, pass);
        console.log(`Logged in as ${user.email}`);
      } catch (err) {
        handleError(err);
      }
    });

  program
    .command('logout')
    .description('Log out and delete the local session')
    .action(async () => {
      try {
        let auth: AuthService | undefined;
        try {
          auth = authService();
        } catch (err) {
          if (!(err instanceof ConfigError)) throw err;
        }
        // Without a usable config there's no server to notify; still delete the local session.
        const result = auth ? await auth.logout() : clearLocalSession();
        // Idempotent: "Not logged in" is not an error (exit 0).
        console.log(result === 'logged-out' ? 'Logged out' : 'Not logged in');
      } catch (err) {
        handleError(err);
      }
    });

  program
    .command('whoami')
    .description('Show the logged-in user')
    .action(async () => {
      try {
        const user = await authService().currentUser();
        if (!user) {
          console.error('Not logged in — run `mm login`');
          process.exitCode = 1;
          return;
        }
        console.log(`${user.email || '(no email)'} (${user.userId})`);
      } catch (err) {
        handleError(err);
      }
    });
}
