import {createHash} from 'node:crypto';
import {copyScript} from './copy.js';

const scriptHash = createHash('sha256').update(copyScript).digest('base64');

function escape(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function link(item) {
  try {
    const url = new URL(item.url);
    if (url.protocol === 'https:' && ['github.com', 'docs.github.com'].includes(url.hostname)) {
      return '<a href="' + escape(url.href) + '" target="_blank" rel="noopener noreferrer">' + escape(item.label) + '</a>';
    }
  } catch {}
  return escape(item.label);
}
const VERDICTS = {blocked: 'Required checks are blocking', unknown: 'More evidence is needed', satisfied: 'Observed required checks passed', none: 'No required status checks found'};
export function markdown(report, {example = false} = {}) {
  const lines = ['# PR Check Explainer', '', report.repository + ' #' + report.number,
    '', VERDICTS[report.overall], ...(report.draft ? ['', 'Draft PR: results are compared with merge-time requirements.'] : []), '', 'Evaluated ' + report.evaluation + ': ' + report.evaluatedSha, '', report.scope];
  for (const check of report.checks) {
    lines.push('', '## ' + check.context + ': ' + check.state, '', ...check.details.map(detail => '- ' + detail));
    for (const item of check.evidence) lines.push('- ' + (example ? 'Example evidence: ' : 'Evidence: ') + item.label + (item.detail ? ' (' + item.detail + ')' : '') + (!example && item.url ? ': ' + item.url : ''));
  }
  if (report.limitations.length) lines.push('', '## Coverage notes', '', ...report.limitations.map(note => '- ' + note));
  return lines.join('\n') + '\n';
}
export function html(report, {example = false} = {}) {
  const cards = report.checks.map(check => '<article><div class="row"><h2>' + escape(check.context) + '</h2><span class="badge ' + check.state + '">' + check.state + '</span></div>' +
    '<p class="code">' + escape(check.code.replaceAll('_', ' ')) + '</p>' +
    check.details.map(detail => '<p>' + escape(detail) + '</p>').join('') +
    '<details open><summary>' + (example ? 'Example evidence' : 'Evidence') + '</summary><ul>' + check.evidence.map(item => '<li>' + (example ? '<span>Example evidence: ' + escape(item.label) + '</span>' : link(item)) +
      (item.detail ? '<small>' + escape(item.detail) + '</small>' : '') + '</li>').join('') + '</ul></details></article>').join('');
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'sha256-' + scriptHash + '\'; connect-src \'none\'; img-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">' +
    '<title>PR Check Explainer · ' + escape(report.repository) + '</title><style>' +
    'body{margin:0;background:#f5f7fa;color:#172235;font:16px/1.6 system-ui,sans-serif}main{max-width:880px;margin:44px auto;padding:0 24px}header{margin-bottom:26px}h1{font-size:34px;letter-spacing:-1px;margin:4px 0}h2{font-size:20px;margin:0}.eyebrow{color:#52637c;font-size:12px;letter-spacing:2px;text-transform:uppercase}.verdict{font-size:24px;font-weight:650;margin:16px 0 4px}.row{display:flex;justify-content:space-between;gap:16px;align-items:start}.badge{font-size:12px;padding:4px 10px;border-radius:12px;background:#e8edf4}.blocked{background:#ffebe8;color:#922d21}.unknown{background:#fff2d0;color:#795812}.satisfied{background:#e3f4e9;color:#256343}article,.notes{background:white;border:1px solid #dce3eb;border-radius:14px;padding:22px;margin:14px 0}.code{font-size:13px;color:#68748a;text-transform:uppercase;letter-spacing:1px}a{color:#174bb6}small{display:block;color:#68748a;overflow-wrap:anywhere}li{margin:10px 0}summary{cursor:pointer;font-weight:600}footer{color:#68748a;font-size:13px;margin:28px 0}.sha{font-family:monospace;overflow-wrap:anywhere;font-size:13px}textarea{width:100%;height:180px;box-sizing:border-box;border:1px solid #dce3eb;border-radius:8px;padding:12px;font:12px/1.5 monospace;background:#fbfcfe}@media(max-width:500px){main{margin:22px auto;padding:0 14px}h1{font-size:28px}.row{display:block}.badge{display:inline-block;margin-top:8px}}' +
    'button{font:inherit;cursor:pointer;border:1px solid #174bb6;border-radius:8px;background:#174bb6;color:white;padding:8px 14px;margin:10px 0}button:focus-visible,a:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #5987e2;outline-offset:3px}nav{display:flex;flex-wrap:wrap;gap:20px;margin-bottom:20px}.copy-status{min-height:1.6em;margin:4px 0}' +
    '</style><main>' + (example ? '<nav aria-label="Example report navigation"><a href="./">Back to overview</a><a href="./#try">Try on your PR</a></nav><p>This is a synthetic example. To analyze your own PR, run the read-only CLI on your computer.</p>' : '') + '<header><div class="eyebrow">PR Check Explainer · ' + (example ? 'synthetic example' : 'evidence report') + '</div><h1>' + escape(report.repository) + ' #' + report.number +
    '</h1><p class="verdict">' + VERDICTS[report.overall] + '</p>' + (report.draft ? '<p><strong>Draft PR</strong> · Results are compared with merge-time requirements. Missing results may wait until the PR is ready.</p>' : '') + '<div class="sha">' + escape(report.evaluation + ' · ' + report.evaluatedSha) +
    '</div><p>' + escape(report.scope) + '</p></header>' + cards +
    (report.checks.length ? '' : '<article><p>No required status-check contexts were returned by the observed policies.</p></article>') +
    (report.limitations.length ? '<aside class="notes"><h2>Coverage notes</h2><ul>' + report.limitations.map(note => '<li>' + escape(note) + '</li>').join('') + '</ul></aside>' : '') +
    '<details class="notes"><summary>Copyable Markdown report</summary><p>Select the text below to copy it, or use the button.</p><textarea id="markdown-report" readonly aria-label="Markdown report">' + escape(markdown(report, {example})) + '</textarea><button type="button" data-copy-target="markdown-report" data-copy-status="copy-status" aria-describedby="copy-status">Copy Markdown</button><p id="copy-status" class="copy-status" role="status" aria-live="polite"></p></details>' +
    '<footer>Snapshot: ' + escape(report.collectedAt || 'synthetic demonstration') + '. This report does not change repository settings or run workflows.</footer></main><script>' + copyScript + '</script></html>';
}
