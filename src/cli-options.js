export function parseArguments(args) {
  const options = {}, allowed = new Set(['--repo', '--pr', '--snapshot', '--format', '--output', '--save-snapshot']);
  let prUrl;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      if (prUrl) throw new Error('Provide only one GitHub PR URL.');
      prUrl = arg;
    } else {
      if (!allowed.has(arg) || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(options, arg)) throw new Error('Invalid or duplicate option: ' + arg);
      options[arg] = args[++i];
    }
  }
  if (prUrl) {
    if (options['--repo'] || options['--pr'] || options['--snapshot']) throw new Error('A PR URL cannot be combined with --repo, --pr or --snapshot.');
    // Match the input itself: URL normalization must not accept credentials,
    // ports, escaped path segments, dot segments, queries or other hosts.
    const match = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9_.-]{1,100})\/pull\/([1-9][0-9]*)\/?$/.exec(prUrl);
    if (!match || match[0] !== prUrl || ['.', '..'].includes(match[2]) || !Number.isSafeInteger(Number(match[3]))) throw new Error('Use a standard https://github.com/OWNER/REPO/pull/NUMBER URL with a positive PR number.');
    options['--repo'] = match[1] + '/' + match[2];
    options['--pr'] = match[3];
  }
  if (options['--pr'] && (!/^[1-9][0-9]*$/.test(options['--pr']) || options['--pr'].trim() !== options['--pr'] || !Number.isSafeInteger(Number(options['--pr'])))) throw new Error('Use a positive integer for --pr.');
  if (options['--snapshot'] && (options['--repo'] || options['--pr'])) throw new Error('Choose either a snapshot or a live PR.');
  return options;
}
