#!/usr/bin/env node
import {readFileSync, statSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {writePrivate} from '../src/write-private.js';
import {analyze} from '../src/analyze.js';
import {collect} from '../src/github.js';
import {html, markdown} from '../src/render.js';

const help = [
  'PR Check Explainer',
  '',
  'gh-pr-check-explainer --repo OWNER/REPO --pr NUMBER [--format text|json|markdown|html]',
  'gh-pr-check-explainer --snapshot FILE [--format html] [--output FILE]',
  '',
  '--save-snapshot FILE   Save collected evidence for repeatable local analysis',
  '--output FILE          Write the report to a file',
  '--help                 Show this help',
  '',
  'Live mode uses existing gh authentication and read-only requests.',
  'Exit codes: 0 = observed checks satisfied/no requirements, 1 = blocker, 2 = incomplete evidence/error.',
  'The verdict covers required status checks, not overall merge readiness.'
].join('\n');

try {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log(help);
  } else {
    const options = {};
    const allowed = new Set(['--repo', '--pr', '--snapshot', '--format', '--output', '--save-snapshot']);
    for (let i = 0; i < args.length; i += 2) {
      if (!allowed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]]) throw new Error('Invalid or duplicate option: ' + args[i]);
      options[args[i]] = args[i + 1];
    }
    const format = options['--format'] || 'text';
    if (!['text', 'json', 'markdown', 'html'].includes(format)) throw new Error('Unsupported report format.');
    if (options['--snapshot'] && (options['--repo'] || options['--pr'])) throw new Error('Choose either a snapshot or a live PR.');
    const paths = ['--snapshot', '--output', '--save-snapshot'].filter(key => options[key]);
    for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
      const left = options[paths[i]], right = options[paths[j]];
      let same = resolve(left) === resolve(right);
      if (!same && existsSync(left) && existsSync(right)) {const a = statSync(left), b = statSync(right); same = a.dev === b.dev && a.ino === b.ino;}
      if (same) throw new Error('Snapshot input, saved evidence and report output must be different files.');
    }
    const snapshot = options['--snapshot'] ? JSON.parse(readFileSync(options['--snapshot'], 'utf8')) :
      collect(options['--repo'] || '', Number(options['--pr']));
    if (options['--save-snapshot']) writePrivate(options['--save-snapshot'], JSON.stringify(snapshot, null, 2) + '\n');
    const report = analyze(snapshot);
    const output = format === 'json' ? JSON.stringify(report, null, 2) + '\n' :
      format === 'html' ? html(report) : markdown(report);
    if (options['--output']) writePrivate(options['--output'], output);
    else process.stdout.write(output);
    process.exitCode = report.overall === 'blocked' ? 1 : report.overall === 'unknown' ? 2 : 0;
  }
} catch (error) {
  console.error('PR Check Explainer: ' + error.message);
  process.exitCode = 2;
}
