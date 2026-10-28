/**
 * CLI for running jobs manually: pnpm job:run <task>   |   pnpm integrity:run
 */

import { tasks } from './tasks';
import { closePool } from '@/server/db/client';

async function main() {
  const taskName = process.argv[2];
  if (!taskName || !(taskName in tasks)) {
    console.error('Usage: pnpm job:run <task>');
    console.error('Available tasks:', Object.keys(tasks).join(', '));
    process.exit(1);
  }
  try {
    const r = await tasks[taskName]!();
    console.log(`Task ${taskName} completed`, r);
  } catch (error) {
    console.error(`Task ${taskName} failed:`, error);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

void main();
